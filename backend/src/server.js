'use strict';
/*
 * SecondShift backend (MVP).
 *   POST /voice/twilio            Twilio "A call comes in" webhook -> TwiML that streams the call to us
 *   WS   /media/twilio            Twilio Media Stream (the live conversation)
 *   POST /voice/twilio/after      Twilio follows this when the stream ends -> <Dial> on-call (emergency) or <Hangup>
 *   GET  /health                  readiness: which modules are live vs falling back
 */
const http = require('http'), path = require('path');
const { attachWebSocket } = require('./phone/ws');
const twilio = require('./phone/twilio');
const { CallSession } = require('./call/session');
const { loadTenants, loadSecrets } = require('./config');
const { createTts } = require('./brain/tts-deepgram');
const { openDeepgramStream } = require('./brain/stt-deepgram');
const { createLlm } = require('./brain/llm');
const { createTelegram } = require('./notify/telegram');
const { createLeads } = require('./leads');
const { createChat } = require('./chat');
// Brain selection: SECONDSHIFT_LLM_PROVIDER wins; otherwise Claude when an Anthropic key exists,
// then Abacus.AI RouteLLM, then any OpenAI-compatible key, else rules only.
function createLlmFromEnv(env, secrets) {
  const provider = env.SECONDSHIFT_LLM_PROVIDER || (secrets.anthropicKey ? 'anthropic' : secrets.abacusKey ? 'abacus' : secrets.llmKey ? 'openai' : 'none');
  const apiKey = { anthropic: secrets.anthropicKey, abacus: secrets.abacusKey }[provider] || secrets.llmKey;
  return createLlm({ provider, baseUrl: env.SECONDSHIFT_LLM_BASE_URL, model: env.SECONDSHIFT_LLM_MODEL, apiKey, timeoutMs: +env.SECONDSHIFT_LLM_TIMEOUT_MS || undefined, reasoningEffort: env.SECONDSHIFT_LLM_REASONING });
}
const { createGoogleAuth } = require('./google/auth');
const { googleCalendar, fileCalendar } = require('./booking/calendar');
const { gmailMailer, fileMailer, resendMailer } = require('./notify/email');

const ROOT = path.join(__dirname, '..');

function createServer(opts = {}) {
  const env = opts.env || process.env;
  const secrets = opts.secrets || loadSecrets(env);
  const { tenants, problems } = loadTenants(opts.tenantDir || path.join(ROOT, 'tenants'));
  const dataDir = opts.dataDir || env.SECONDSHIFT_DATA_DIR || path.join(ROOT, 'data');
  const firstTenant = Object.values(tenants)[0];

  const google = opts.googleAuth !== undefined ? opts.googleAuth : createGoogleAuth(secrets.googleTokenFile);
  const calendar = opts.calendar || (google && firstTenant && firstTenant.calendar && firstTenant.calendar.provider === 'google'
    ? googleCalendar({ auth: google, calendarId: firstTenant.calendar.calendarId || 'primary', timeZone: firstTenant.timezone })
    : fileCalendar({ file: path.join(dataDir, 'calendar.json') }));
  // Outbound owner notifications. Prefer Resend (sends from the verified carborundum.ai domain) when a
  // RESEND_API_KEY is configured; CC the existing gmail so nothing is missed mid-switch. Falls back to
  // the Gmail API (if Google consent granted) and finally to writing .eml files locally.
  const mailer = opts.mailer || (secrets.resendKey
    ? resendMailer({ apiKey: secrets.resendKey,
                     from: env.SECONDSHIFT_EMAIL_FROM || 'SecondShift <no-reply@carborundum.ai>',
                     cc: env.SECONDSHIFT_EMAIL_CC || 'scottroymurphy.carb@gmail.com' })
    : (google && (google.scopes || []).some(s => /gmail\.send/.test(s))
      ? gmailMailer({ auth: google, from: (firstTenant && firstTenant.owner && firstTenant.owner.email) || 'me' })
      : fileMailer({ dir: path.join(dataDir, 'outbox') })));
  const llm = opts.llm !== undefined ? opts.llm : createLlmFromEnv(env, secrets);
  const tts = opts.tts || (secrets.deepgramKey ? createTts({ apiKey: secrets.deepgramKey, model: (firstTenant && firstTenant.voice && firstTenant.voice.ttsModel) || undefined }) : null);
  const openStt = opts.openStt || (o => openDeepgramStream({ apiKey: secrets.deepgramKey, ...o }));

  // Pre-render the fixed lines (greeting + standard questions) so those turns play instantly.
  if (tts && opts.warmup !== false) {
    const fixed = ['What’s going on that you need help with?', 'I can get that on the schedule. What’s your name?', 'When would you like a technician to come out?',
      'What’s the best number to reach you?', 'Sorry — what day and time works best? For example, tomorrow morning.', 'Sorry, I didn’t catch that. What’s your name?',
      'Sorry, what’s the street address for the service?', 'No problem. What day and time would work better?'];
    for (const t of Object.values(tenants)) fixed.push(t.disclosure.replace(/\{shop\}/g, t.shopName), (t.emergency && t.emergency.transferMessage) || '');
    Promise.all(fixed.filter(Boolean).map(l => tts.speak(l).catch(() => null))).catch(() => {});
  }

  const endActions = new Map(); // callSid -> {action, transferNumber}
  const records = [];
  // Call alerts to the owner's Telegram (start + end of every call). SECONDSHIFT_TELEGRAM=off disables (tests).
  const telegram = opts.telegram !== undefined ? opts.telegram : (env.SECONDSHIFT_TELEGRAM === 'off' ? null : createTelegram({ token: secrets.telegramToken, chatId: secrets.telegramChatId }));
  const leads = createLeads({ dataDir, telegram, mailer, ownerEmail: env.SECONDSHIFT_LEADS_EMAIL || (firstTenant && firstTenant.owner && firstTenant.owner.email) });
  // Browsers may post leads only from the Carborundum site.
  const LEAD_ORIGINS = (env.SECONDSHIFT_LEAD_ORIGINS || 'https://carborundum.ai,https://www.carborundum.ai').split(',');
  // Website helper: same brain, same lead store. SECONDSHIFT_CHAT=off disables it.
  const chat = opts.chat !== undefined ? opts.chat : (env.SECONDSHIFT_CHAT === 'off' ? null : createChat({ llm: opts.chatLlm !== undefined ? opts.chatLlm : llm, leads }));
  const deps = { tts, openStt, calendar, mailer, llm, telegram, logDir: path.join(dataDir, 'logs'), now: opts.now, onRecord: r => records.push(r) };

  const publicBase = req => env.PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const readBody = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b)); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      if (url.pathname === '/chat') {
        const origin = req.headers.origin;
        if (origin && LEAD_ORIGINS.includes(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin'); }
        if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-methods', 'POST'); res.setHeader('access-control-allow-headers', 'content-type'); res.writeHead(204); return res.end(); }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
        if (origin && !LEAD_ORIGINS.includes(origin)) return send(403, { ok: false, error: 'origin not allowed' });
        if (!chat) return send(503, { ok: false, error: 'chat disabled' });
        const raw = await readBody(req); if (raw.length > 40000) return send(413, { ok: false, error: 'Conversation too long.' });
        let body; try { body = JSON.parse(raw); } catch { return send(400, { ok: false, error: 'bad request' }); }
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const r = await chat.handle(body, { ip, ua: req.headers['user-agent'] });
        return send(r.status, r.body);
      }
      if (url.pathname === '/leads') {
        const origin = req.headers.origin;
        if (origin && LEAD_ORIGINS.includes(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin'); }
        if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-methods', 'POST'); res.setHeader('access-control-allow-headers', 'content-type'); res.writeHead(204); return res.end(); }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
        if (origin && !LEAD_ORIGINS.includes(origin)) return send(403, { ok: false, error: 'origin not allowed' });
        const raw = await readBody(req); if (raw.length > 20000) return send(413, { ok: false, error: 'too large' });
        let body; try { body = /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { return send(400, { ok: false, error: 'bad request' }); }
        try {
          const r = await leads.submit(body, { ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, ua: req.headers['user-agent'] });
          return send(r.ok ? 200 : r.status || 400, r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error });
        } catch (e) { console.error('lead store failed', e); return send(500, { ok: false, error: 'Could not save your request — please call or try again.' }); }
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, {
          ok: !!tts && Object.keys(tenants).length > 0, tenants: Object.keys(tenants), tenantProblems: problems,
          modules: { stt: secrets.deepgramKey ? 'deepgram' : 'MISSING KEY', tts: tts ? `deepgram:${tts.model}` : 'MISSING KEY', llm: llm ? `${llm.provider}:${llm.model}` : 'off (rules only)', calendar: calendar.kind, email: mailer.kind, twilioSignatureCheck: secrets.twilioAuthToken ? 'on' : 'off (no auth token)', alerts: telegram ? 'telegram' : 'off', leadsStore: leads.file, chat: chat ? 'on' : 'off' },
        });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/voice/twilio')) {
        const raw = await readBody(req); const p = Object.fromEntries(new URLSearchParams(raw));
        if (!twilio.validSignature(secrets.twilioAuthToken, req.headers['x-twilio-signature'], publicBase(req) + req.url, p)) return send(403, 'bad signature', 'text/plain');
        const tenantId = url.searchParams.get('tenant') || (firstTenant && firstTenant.id);
        if (url.pathname === '/voice/twilio/after') {
          const end = endActions.get(p.CallSid); endActions.delete(p.CallSid);
          if (end && end.action === 'transfer' && end.transferNumber) return send(200, twilio.dialTwiml(end.transferNumber), 'text/xml');
          return send(200, twilio.hangupTwiml(), 'text/xml');
        }
        if (!tts) return send(200, twilio.sayHangupTwiml('Sorry, this line is not available right now. Please call back later.'), 'text/xml');
        const base = publicBase(req), wsBase = base.replace(/^http/, 'ws');
        return send(200, twilio.answerTwiml({ wsUrl: `${wsBase}/media/twilio`, afterUrl: `${base}/voice/twilio/after?tenant=${encodeURIComponent(tenantId)}`, tenant: tenantId, from: p.From, callSid: p.CallSid }), 'text/xml');
      }
      return send(404, { error: 'not found' });
    } catch (e) { return send(500, { error: e.message }); }
  });

  attachWebSocket(server, '/media/twilio', conn => {
    new CallSession({ conn, provider: twilio, tenants, deps, onEnd: (sid, end) => endActions.set(sid, end) });
  });
  return { server, tenants, problems, records, endActions, modules: { calendar: calendar.kind, mailer: mailer.kind, llm, tts: !!tts } };
}

if (require.main === module) {
  const port = +(process.env.PORT || 8790);
  const { server, problems } = createServer();
  if (Object.keys(problems).length) console.error('Tenant config problems:', problems);
  server.listen(port, () => console.log(`SecondShift backend on :${port}`));
}

module.exports = { createServer };
