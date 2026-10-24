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
const { loadTenants, loadSecrets, siliconSettings } = require('./config');
const { createSiliconClient, siliconCalendar } = require('./integrations/silicon');
const { createTts } = require('./brain/tts-deepgram');
const { openDeepgramStream } = require('./brain/stt-deepgram');
const { createRoutersFromEnv } = require('./brain/router');
const { createTelegram } = require('./notify/telegram');
const { createSlack } = require('./notify/slack');
const { createLeads } = require('./leads');
const { createChat } = require('./chat');
const { createGoogleAuth } = require('./google/auth');
const { googleCalendar, fileCalendar } = require('./booking/calendar');
const { gmailMailer, fileMailer, resendMailer } = require('./notify/email');
const { createAgentApi } = require('./agent/api');

const ROOT = path.join(__dirname, '..');

function createServer(opts = {}) {
  const env = opts.env || process.env;
  const secrets = opts.secrets || loadSecrets(env);
  // Local dev escape hatch only: production must have TWILIO_AUTH_TOKEN, otherwise /voice/twilio rejects everything.
  const ALLOW_UNSIGNED_TWILIO = env.SECONDSHIFT_ALLOW_UNSIGNED_TWILIO === '1';
  if (!secrets.twilioAuthToken) console.warn(ALLOW_UNSIGNED_TWILIO ? 'WARNING: no TWILIO_AUTH_TOKEN and SECONDSHIFT_ALLOW_UNSIGNED_TWILIO=1 - unsigned Twilio webhooks ACCEPTED (dev only)' : 'WARNING: no TWILIO_AUTH_TOKEN - all /voice/twilio requests will be rejected (fail closed)');
  const healthToken = env.HEALTH_TOKEN || secrets.siliconToken || '';
  const healthAuthorized = req => {
    if (!healthToken) return false;
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(got), b = Buffer.from(healthToken);
    return a.length === b.length && require('crypto').timingSafeEqual(a, b);
  };
  const { tenants, problems } = loadTenants(opts.tenantDir || path.join(ROOT, 'tenants'));
  const dataDir = opts.dataDir || env.SECONDSHIFT_DATA_DIR || path.join(ROOT, 'data');
  const firstTenant = Object.values(tenants)[0];

  const google = opts.googleAuth !== undefined ? opts.googleAuth : createGoogleAuth(secrets.googleTokenFile);
  const ownCalendar = opts.calendar || (google && firstTenant && firstTenant.calendar && firstTenant.calendar.provider === 'google'
    ? googleCalendar({ auth: google, calendarId: firstTenant.calendar.calendarId || 'primary', timeZone: firstTenant.timezone })
    : fileCalendar({ file: path.join(dataDir, 'calendar.json') }));
  // Integrated mode: Silicon is the schedule (availability + job records); our own calendar stays
  // as the fallback so a Silicon outage never drops a booking. Off by default = standalone.
  const sil = siliconSettings(firstTenant, env);
  let silicon = opts.silicon || null, siliconStatus = 'off';
  if (!silicon && sil.post_to_silicon) {
    if (sil.url && secrets.siliconToken) {
      silicon = createSiliconClient({ url: sil.url, token: secrets.siliconToken, fetchImpl: opts.fetch || fetch, outboxFile: path.join(dataDir, 'silicon-outbox.jsonl'), log: (...a) => console.error(...a) });
    } else siliconStatus = 'MISCONFIGURED (needs SILICON_URL + SILICON_INTEGRATION_TOKEN) - standalone';
  }
  if (silicon) siliconStatus = `on:${silicon.url}`;
  const siliconFollowups = !!silicon && (opts.siliconFollowups !== undefined ? !!opts.siliconFollowups : sil.post_followups);
  // Carborundum sales CRM (default OFF): real callers on the listed tenants' lines (the demo line) become
  // Silicon sales leads. SILICON_SALES_LEADS=on; SILICON_SALES_LEAD_TENANTS defaults to the demo shop only,
  // so a paying shop's customers can never land in Carborundum's pipeline.
  const siliconSalesLeads = !!silicon && (opts.siliconSalesLeads !== undefined ? !!opts.siliconSalesLeads : env.SILICON_SALES_LEADS === 'on');
  const salesLeadTenants = new Set(String(env.SILICON_SALES_LEAD_TENANTS || 'carborundum').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const calendar = silicon ? siliconCalendar({ client: silicon, fallback: ownCalendar, tenant: firstTenant, log: (...a) => console.error(...a) }) : ownCalendar;
  if (silicon && opts.siliconFlushMs !== 0) {
    const h = setInterval(() => silicon.flushOutbox().catch(() => {}), opts.siliconFlushMs || 60_000); if (h.unref) h.unref();
  }
  // Outbound owner notifications. Prefer Resend (sends from the verified carborundum.ai domain) when a
  // RESEND_API_KEY is configured; CC the existing gmail so nothing is missed mid-switch. Falls back to
  // the Gmail API (if Google consent granted) and finally to writing .eml files locally.
  // SECONDSHIFT_EMAIL=off forces the local outbox (tests/sims must never mail anyone).
  const mailer = opts.mailer || (env.SECONDSHIFT_EMAIL === 'off' ? fileMailer({ dir: path.join(dataDir, 'outbox') }) : secrets.resendKey
    ? resendMailer({ apiKey: secrets.resendKey,
                     from: env.SECONDSHIFT_EMAIL_FROM || 'SecondShift <no-reply@carborundum.ai>',
                     cc: env.SECONDSHIFT_EMAIL_CC || 'scottroymurphy.carb@gmail.com' })
    : (google && (google.scopes || []).some(s => /gmail\.send/.test(s))
      ? gmailMailer({ auth: google, from: (firstTenant && firstTenant.owner && firstTenant.owner.email) || 'me' })
      : fileMailer({ dir: path.join(dataDir, 'outbox') })));
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
  // Model router (brain/router.js): local/free models first, paid fallback behind a monthly budget cap,
  // Telegram alert when a paid provider runs out of credit. One router per task (phone call, site chat).
  // AI alerts use the owner's Telegram channel (SECONDSHIFT_AI_ALERTS=off silences them, =on forces them).
  const aiTelegram = opts.aiTelegram !== undefined ? opts.aiTelegram : (env.SECONDSHIFT_AI_ALERTS === 'off' ? null : telegram || (env.SECONDSHIFT_AI_ALERTS === 'on' ? createTelegram({ token: secrets.telegramToken, chatId: secrets.telegramChatId }) : null));
  const ai = createRoutersFromEnv(env, secrets, { telegram: aiTelegram, dataDir, now: opts.now });
  const llm = opts.llm !== undefined ? opts.llm : ai.call;
  const leads = createLeads({ dataDir, telegram, mailer, ownerEmail: env.SECONDSHIFT_LEADS_EMAIL || (firstTenant && firstTenant.owner && firstTenant.owner.email) });
  // Browsers may post leads only from the Carborundum site.
  const LEAD_ORIGINS = (env.SECONDSHIFT_LEAD_ORIGINS || 'https://carborundum.ai,https://www.carborundum.ai').split(',');
  // Website helper: same brain, same lead store. SECONDSHIFT_CHAT=off disables it.
  const chat = opts.chat !== undefined ? opts.chat : (env.SECONDSHIFT_CHAT === 'off' ? null : createChat({ llm: opts.chatLlm !== undefined ? opts.chatLlm : (opts.llm !== undefined ? opts.llm : ai.chat), leads }));
  // Team alert: every real inbound call (not Scott's test numbers) -> Slack #agents via incoming webhook.
  // Off unless SLACK_AGENTS_WEBHOOK_URL is set; SECONDSHIFT_SLACK_EXCLUDE = comma list of test numbers.
  const slack = opts.slack !== undefined ? opts.slack : createSlack({ webhookUrl: env.SLACK_AGENTS_WEBHOOK_URL, exclude: env.SECONDSHIFT_SLACK_EXCLUDE });
  // Agent door (demo shop only): decision packet, test-drive, Stripe TEST checkout, MCP. SECONDSHIFT_AGENT=off disables.
  const agentApi = opts.agentApi !== undefined ? opts.agentApi : (env.SECONDSHIFT_AGENT === 'off' ? null
    : createAgentApi({ dataDir, env, secrets, tts, demoTenant: env.SECONDSHIFT_DEMO_TENANT || (firstTenant && firstTenant.id), fetchImpl: opts.fetch || fetch, runCall: opts.agentRunCall }));
  const deps = { tts, openStt, calendar, mailer, llm, telegram, slack, silicon, siliconFollowups, siliconSalesLeads, salesLeadTenants, logDir: path.join(dataDir, 'logs'), now: opts.now, onRecord: r => records.push(r) };

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
        // Public callers get liveness only. Module/config detail needs Authorization: Bearer <HEALTH_TOKEN>
        // (falls back to the Silicon integration token so ops tooling works without a new secret).
        const healthOk = !!tts && Object.keys(tenants).length > 0;
        if (!healthAuthorized(req)) return send(200, { ok: healthOk });
        return send(200, {
          ok: !!tts && Object.keys(tenants).length > 0, tenants: Object.keys(tenants), tenantProblems: problems,
          modules: { stt: secrets.deepgramKey ? 'deepgram' : 'MISSING KEY', tts: tts ? `deepgram:${tts.model}` : 'MISSING KEY', llm: llm ? (llm.chain ? llm.chain.join(' -> ') : `${llm.provider}:${llm.model}`) : 'off (rules only)', ai: { call: ai.call ? ai.call.status() : 'rules only', chat: ai.chat ? ai.chat.status() : 'canned answers only', budget: ai.budget.state() }, calendar: calendar.kind, silicon: siliconStatus, siliconFollowups: siliconFollowups ? 'on' : 'off', siliconSalesLeads: siliconSalesLeads ? 'on' : 'off', email: mailer.kind, twilioSignatureCheck: secrets.twilioAuthToken ? 'on' : 'off (no auth token)', alerts: telegram ? 'telegram' : 'off', slackCallAlerts: slack ? 'on' : 'off', leadsStore: leads.file, chat: chat ? 'on' : 'off' },
        });
      }
      if (req.method === 'GET' && url.pathname === '/shop/status') {
        // Silicon's SecondShift module (read-only, phase 1): one shop's answering settings + module health.
        // Same bearer as /health detail (HEALTH_TOKEN, else the Silicon integration token). No secrets returned.
        if (!healthAuthorized(req)) return send(401, { ok: false, error: 'unauthorized' });
        const t = tenants[String(url.searchParams.get('tenant') || '').toLowerCase()];
        if (!t) return send(404, { ok: false, error: 'unknown shop' });
        const ts = siliconSettings(t, env);
        return send(200, {
          ok: true,
          shop: { id: t.id, name: t.shopName, timezone: t.timezone, hours: t.hours, slotMinutes: t.slotMinutes || null, leadMinutes: t.leadMinutes || null, maxCallSeconds: t.maxCallSeconds || null, recording: !!t.recording, disclosure: t.disclosure || null },
          emergency: t.emergency ? { action: t.emergency.action || null, transfers: !!t.emergency.transferNumber, keywords: Array.isArray(t.emergency.keywords) ? t.emergency.keywords.length : 0 } : null,
          integrations: { postToSilicon: !!silicon && !!ts.post_to_silicon, followups: siliconFollowups, salesLeads: siliconSalesLeads && salesLeadTenants.has(String(t.id).toLowerCase()) },
          health: { ok: !!tts, stt: !!secrets.deepgramKey, tts: !!tts, llm: llm ? 'on' : 'rules only', twilioSignatureCheck: !!secrets.twilioAuthToken },
        });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/voice/twilio')) {
        const raw = await readBody(req); const p = Object.fromEntries(new URLSearchParams(raw));
        if (!twilio.validSignature(secrets.twilioAuthToken, req.headers['x-twilio-signature'], publicBase(req) + req.url, p, { allowUnsigned: ALLOW_UNSIGNED_TWILIO })) return send(403, 'bad signature', 'text/plain');
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
      if (agentApi && (url.pathname === '/agent' || url.pathname.startsWith('/agent/'))) return await agentApi.handle(req, res, url);
      return send(404, { error: 'not found' });
    } catch (e) { return send(500, { error: e.message }); }
  });

  attachWebSocket(server, '/media/twilio', conn => {
    new CallSession({ conn, provider: twilio, tenants, deps, onEnd: (sid, end) => endActions.set(sid, end) });
  });
  return { server, tenants, problems, records, endActions, silicon, modules: { calendar: calendar.kind, silicon: siliconStatus, mailer: mailer.kind, llm, tts: !!tts } };
}

if (require.main === module) {
  const port = +(process.env.PORT || 8790);
  const { server, problems } = createServer();
  if (Object.keys(problems).length) console.error('Tenant config problems:', problems);
  server.listen(port, () => console.log(`SecondShift backend on :${port}`));
}

module.exports = { createServer };
