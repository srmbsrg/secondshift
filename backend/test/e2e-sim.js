'use strict';
// End-to-end call simulation. Stands in for TWILIO ONLY: speaks the real Twilio Media Streams
// protocol to the real server over a WebSocket, in real time, with continuous line audio.
// Real inside the server: Deepgram streaming STT, the booking agent, Deepgram TTS, slot search,
// calendar write (local file calendar here — Google needs Scott's OAuth consent first), and the
// owner email (local outbox here — Gmail needs the same consent).
// The caller's voice is real synthesized speech (a different Deepgram voice), not text injection.
//
//   node test/e2e-sim.js              booking scenario
//   node test/e2e-sim.js emergency    emergency -> transfer scenario
const fs = require('fs'), os = require('os'), path = require('path');
const { createServer } = require('../src/server');
const { loadSecrets } = require('../src/config');
const { createTts } = require('../src/brain/tts-deepgram');

const SCENARIOS = {
  booking: {
    lines: [
      "Hi, my air conditioner stopped working and it's really hot in the house.",
      'Jordan Avery.',
      '1412 Willow Bend Drive in Spring.',
      "Yes, that's the best number.",
      'Tomorrow morning if you can.',
      'Yes, that works.',
    ],
    expect: { outcome: 'booked', after: '<Hangup/>', slots: { name: /^Jordan Avery$/, address: /1412 Willow Bend/i, phone: /^7135550148$/, issue: /air condition/i } },
  },
  emergency: {
    lines: ['I smell gas in my kitchen and I am really worried.'],
    expect: { outcome: 'transfer', after: '<Dial>+18325550123</Dial>' },
    transferNumber: '+18325550123',
  },
};

// Signs requests like Twilio does when an auth token is configured (the server then enforces it).
const crypto = require('crypto');
function twilioPost(secrets, url, params) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (secrets.twilioAuthToken) headers['x-twilio-signature'] = crypto.createHmac('sha1', secrets.twilioAuthToken).update(url + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
  return fetch(url, { method: 'POST', headers, body: new URLSearchParams(params) });
}
const SILENCE = Buffer.alloc(160, 0xff); // 20 ms of mu-law silence
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const name = process.argv[2] || 'booking'; const sc = SCENARIOS[name];
  const secrets = loadSecrets();
  if (!secrets.deepgramKey) throw new Error('no Deepgram key');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'secondshift-e2e-'));
  const tenantDir = path.join(work, 'tenants'); fs.mkdirSync(tenantDir);
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tenants', 'carborundum.json'), 'utf8'));
  if (sc.transferNumber) t.emergency.transferNumber = sc.transferNumber;
  fs.writeFileSync(path.join(tenantDir, 'carborundum.json'), JSON.stringify(t));

  const { server, records } = createServer({ tenantDir, dataDir: path.join(work, 'data'), secrets, googleAuth: null, env: { ...process.env } });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  console.log(`[sim] server :${port}  data: ${work}`);
  console.log('[sim] health:', JSON.stringify((await (await fetch(base + '/health')).json()).modules));

  // 1) Twilio webhook: an inbound call arrives.
  const callSid = 'CA' + Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32), from = '+17135550148';
  const twiml = await (await twilioPost(secrets, base + '/voice/twilio', { CallSid: callSid, From: from, To: '+18325550000' })).text();
  if (!/<Connect><Stream url="ws:\/\/127\.0\.0\.1:\d+\/media\/twilio">/.test(twiml) || !/<Redirect/.test(twiml)) throw new Error('bad TwiML: ' + twiml);
  console.log('[sim] TwiML ok (Connect/Stream + Redirect to /voice/twilio/after)');

  // 2) Caller audio, synthesized once up front.
  const callerVoice = createTts({ apiKey: secrets.deepgramKey, model: 'aura-orion-en' });
  const callerAudio = [];
  for (const l of sc.lines) callerAudio.push(await callerVoice.speak(l));

  // 3) Media stream, real time.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/media/twilio`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const streamSid = 'MZ' + callSid.slice(2);
  const t0 = Date.now(); let firstBotAudioAt = null;
  let outQueue = []; let botBytes = 0; let lineIdx = 0; let closed = false; const turnLatencies = []; let lastCallerEndAt = null;
  const params = Object.fromEntries(new URL(twiml.match(/url="([^"]+)"/)[1]).searchParams); void params;
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify({ event: 'start', sequenceNumber: '1', start: { streamSid, callSid, accountSid: 'ACsim', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { tenant: 'carborundum', from, callSid } }, streamSid }));

  const ticker = setInterval(() => {
    if (closed) return;
    const chunk = outQueue.length ? outQueue.shift() : SILENCE;
    ws.send(JSON.stringify({ event: 'media', streamSid, media: { track: 'inbound', payload: chunk.toString('base64') } }));
  }, 20);
  const speakLine = buf => {
    const frames = [];
    for (let i = 0; i < buf.length; i += 160) { const c = Buffer.alloc(160, 0xff); buf.copy(c, 0, i, Math.min(i + 160, buf.length)); frames.push(c); }
    outQueue.push(...Array(15).fill(SILENCE), ...frames);
    lastCallerEndAt = Date.now() + (15 + frames.length) * 20;
  };

  ws.onmessage = async e => {
    const m = JSON.parse(e.data);
    if (m.event === 'media') {
      if (firstBotAudioAt === null) firstBotAudioAt = Date.now() - t0;
      if (lastCallerEndAt && botBytes === 0) { turnLatencies.push(Date.now() - lastCallerEndAt); lastCallerEndAt = null; }
      botBytes += Buffer.from(m.media.payload, 'base64').length;
    } else if (m.event === 'clear') { botBytes = 0; console.log('[sim] server sent clear (barge-in)'); }
    else if (m.event === 'mark') {
      const playMs = (botBytes / 8000) * 1000; botBytes = 0;
      await sleep(playMs); // simulate the caller hearing the whole line
      ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: m.mark.name } }));
      if (lineIdx < callerAudio.length) { await sleep(400); speakLine(callerAudio[lineIdx++]); }
    }
  };
  await new Promise(res => { ws.onclose = () => { closed = true; res(); }; setTimeout(res, 150000); });
  clearInterval(ticker);

  // 4) Twilio follows the <Redirect> after the stream ends.
  const after = await (await twilioPost(secrets, `${base}/voice/twilio/after?tenant=carborundum`, { CallSid: callSid })).text();
  for (let i = 0; i < 50 && !records.length; i++) await sleep(100);
  const rec = records[0];
  server.close();

  console.log('\n===== TRANSCRIPT (what Deepgram heard / what SecondShift said) =====');
  for (const l of (rec && rec.transcript) || []) console.log(`${l.who === 'agent' ? 'SecondShift' : 'Caller     '} [${(l.at / 1000).toFixed(1)}s]: ${l.text}`);
  console.log('\n===== RESULT =====');
  console.log('outcome:', rec && rec.outcome, '| endAction:', rec && rec.endAction, '| emergency:', JSON.stringify(rec && rec.emergency));
  console.log('time to first word (stream start -> first bot audio):', firstBotAudioAt, 'ms');
  console.log('caller-finished -> bot-starts-speaking per turn (ms):', turnLatencies.join(', '));
  console.log('after-stream TwiML:', after.replace(/<\?xml[^>]*>/, ''));
  const calFile = path.join(work, 'data', 'calendar.json');
  if (fs.existsSync(calFile)) { const ev = JSON.parse(fs.readFileSync(calFile, 'utf8')); console.log('calendar events:', ev.length); for (const x of ev) console.log('  ', x.start, '->', x.end, '|', x.summary, '|', x.location); }
  const outbox = path.join(work, 'data', 'outbox');
  if (fs.existsSync(outbox)) for (const f of fs.readdirSync(outbox)) { const txt = fs.readFileSync(path.join(outbox, f), 'utf8'); console.log('\n===== OWNER EMAIL (outbox) =====\n' + txt.split('\n').slice(0, 14).join('\n')); }
  const logs = path.join(work, 'data', 'logs');
  console.log('\nstored audio files:', fs.existsSync(logs) ? fs.readdirSync(logs).filter(f => f.endsWith('.wav')).length : 0, '(storeAudio=false expected 0)');

  let ok = rec && rec.outcome === sc.expect.outcome && after.includes(sc.expect.after);
  for (const [k, re] of Object.entries(sc.expect.slots || {})) {
    const v = rec && rec.slots && rec.slots[k];
    const good = re.test(String(v || ''));
    console.log(`check slot ${k}: ${JSON.stringify(v)} ${good ? 'OK' : 'WRONG'}`);
    ok = ok && good;
  }
  console.log(`\nE2E ${name}: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error('E2E error:', e); process.exit(1); });
