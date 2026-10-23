'use strict';
// Live demo-line check: plays a real caller (synthesized speech) into the DEPLOYED service exactly the
// way Twilio does - signed "call comes in" webhook, then the Media Streams WebSocket in real time -
// and reports what came back. Use after every SecondShift deploy:
//
//   node tools/live-sim.js              booking scenario against https://secondshift-production.up.railway.app
//   LIVE_BASE=https://... node tools/live-sim.js
//
// The caller is named "QA Test ..." so the booking it creates in Silicon is easy to find and cancel.
// Confirm the outcome in the service log: railway logs | findstr "<callSid tail>" (END ... booked).
const crypto = require('crypto');
const { loadSecrets } = require('../src/config');
const { createTts } = require('../src/brain/tts-deepgram');

const BASE = (process.env.LIVE_BASE || 'https://secondshift-production.up.railway.app').replace(/\/$/, '');
const TENANT = process.env.SECONDSHIFT_TENANT || 'carborundum';
const LINES = [
  "Hi, my air conditioner stopped working and it's really hot in the house.",
  'QA Test Jordan.',
  '1412 Willow Bend Drive in Spring.',
  "Yes, that's right.",
  'Tomorrow morning if you can.',
  'Yes, that works.',
];
const SILENCE = Buffer.alloc(160, 0xff);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function twilioPost(token, url, params) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  headers['x-twilio-signature'] = crypto.createHmac('sha1', token).update(url + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
  return fetch(url, { method: 'POST', headers, body: new URLSearchParams(params) });
}

async function main() {
  const secrets = loadSecrets();
  if (!secrets.deepgramKey || !secrets.twilioAuthToken) throw new Error('needs Deepgram key + Twilio auth token in the secrets dir');
  const health = await (await fetch(BASE + '/health', { headers: secrets.siliconToken ? { authorization: 'Bearer ' + (process.env.HEALTH_TOKEN || secrets.siliconToken) } : {} })).json();
  console.log('[live] health ok=%s llm=%s', health.ok, health.modules && health.modules.llm);
  const callSid = 'CA' + crypto.randomBytes(16).toString('hex'), from = '+17135550148';
  const twiml = await (await twilioPost(secrets.twilioAuthToken, `${BASE}/voice/twilio?tenant=${TENANT}`, { CallSid: callSid, From: from, To: '+13462204138' })).text();
  const m = twiml.match(/<Stream url="([^"]+)"/);
  if (!m) throw new Error('bad TwiML (signature or tenant?): ' + twiml.slice(0, 300));
  console.log('[live] TwiML ok -> stream', m[1], '| callSid', callSid);

  const voice = createTts({ apiKey: secrets.deepgramKey, model: 'aura-orion-en' });
  const audio = []; for (const l of LINES) audio.push(await voice.speak(l));
  const ws = new WebSocket(m[1].replace(/&amp;/g, '&'));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const streamSid = 'MZ' + callSid.slice(2);
  const t0 = Date.now(); let first = null, botBytes = 0, idx = 0, closed = false, q = [], lastEnd = null; const lat = [];
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify({ event: 'start', sequenceNumber: '1', start: { streamSid, callSid, accountSid: 'ACsim', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { tenant: TENANT, from, callSid } }, streamSid }));
  const tick = setInterval(() => { if (closed) return; const real = q.length > 0; const c = real ? q.shift() : SILENCE; if (real && !q.length) lastEnd = Date.now(); try { ws.send(JSON.stringify({ event: 'media', streamSid, media: { track: 'inbound', payload: c.toString('base64') } })); } catch { /* closed */ } }, 20);
  const speak = buf => { for (let i = 0; i < buf.length; i += 160) { const c = Buffer.alloc(160, 0xff); buf.copy(c, 0, i, Math.min(i + 160, buf.length)); q.push(c); } lastEnd = null; };
  ws.onmessage = async e => {
    const msg = JSON.parse(e.data);
    if (msg.event === 'media') { if (first === null) first = Date.now() - t0; if (lastEnd && botBytes === 0) { lat.push(Date.now() - lastEnd); lastEnd = null; } botBytes += Buffer.from(msg.media.payload, 'base64').length; }
    else if (msg.event === 'clear') botBytes = 0;
    else if (msg.event === 'mark') {
      const playMs = (botBytes / 8000) * 1000; botBytes = 0; await sleep(playMs);
      ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: msg.mark.name } }));
      while (q.length) await sleep(50);
      if (idx < audio.length) { await sleep(400); speak(audio[idx++]); }
    }
  };
  await new Promise(res => { ws.onclose = () => { closed = true; res(); }; setTimeout(res, 150000); });
  clearInterval(tick);
  const after = await (await twilioPost(secrets.twilioAuthToken, `${BASE}/voice/twilio/after?tenant=${TENANT}`, { CallSid: callSid })).text();
  console.log('[live] caller lines spoken: %d/%d | first bot audio %d ms | turn latencies %s ms', idx, LINES.length, first, lat.join(','));
  console.log('[live] after-stream TwiML:', after.replace(/<\?xml[^>]*>/, ''));
  const ok = idx === LINES.length && /<Hangup\/>/.test(after);
  console.log(`[live] ${ok ? 'PASS' : 'FAIL'} (confirm "END ... booked" for call ${callSid.slice(-6)} / ${callSid.slice(2, 8)} in railway logs)`);
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error('[live] error:', e); process.exit(1); });
