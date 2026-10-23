'use strict';
// Agent test-drive: a REAL call into the public demo line, played by a synthetic QA caller.
// - read side: the newest call in logs/calls.jsonl whose caller number is a QA test number (default the
//   fictional 555 number tools/live-sim.js uses). Calls from any other number are never returned, so no
//   customer or prospect data can leak through this path.
// - run side: the same flow as tools/live-sim.js (signed Twilio webhook + Media Stream with synthesized caller
//   speech) against this service's own public URL. Rate-limited by the caller of this module.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const QA_FROM = '+17135550148';
const QA_LINES = [
  "Hi, my air conditioner stopped working and it's really hot in the house.",
  'QA Test Jordan.',
  '1412 Willow Bend Drive in Spring.',
  "Yes, that's right.",
  'Tomorrow morning if you can.',
  'Yes, that works.',
];

const qaNumbers = (env = process.env) => (env.SECONDSHIFT_QA_NUMBERS || QA_FROM).split(',').map((s) => s.trim()).filter(Boolean);

function readCalls(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, 'logs', 'calls.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Public shape of a QA call. Whitelisted fields only. */
function shapeCall(c) {
  return {
    call_ref: String(c.callSid || '').slice(-8),
    line: 'SecondShift demo line (346) 220-4138',
    caller: 'synthetic QA test caller (scripted, not a customer)',
    started_at: c.startedAt, ended_at: c.endedAt, outcome: c.outcome || null, emergency: !!c.emergency,
    captured: c.slots ? { name: c.slots.name || null, issue: c.slots.issue || null, address: c.slots.address || null, when: c.slots.when || null } : null,
    booking: c.booking ? { when: c.booking.when || null, calendar: c.booking.calendar || null } : null,
    audio_stored: !!c.storeAudio,
    transcript: Array.isArray(c.transcript) ? c.transcript.map((l) => ({ who: l.who === 'agent' ? 'SecondShift' : 'Caller', text: l.text })) : null,
  };
}

function latestQaCall(dataDir, { env = process.env, callSid, callRef } = {}) {
  const nums = qaNumbers(env);
  const qa = readCalls(dataDir).filter((c) => nums.includes(c.from) && (!callSid || c.callSid === callSid) && (!callRef || String(c.callSid || '').endsWith(callRef)));
  return qa.length ? shapeCall(qa[qa.length - 1]) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function twilioPost(fetchImpl, token, url, params) {
  const sig = crypto.createHmac('sha1', token).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
  return fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params) });
}

/** Place one synthetic QA call into the live demo line. Resolves { ok, callSid, linesSpoken }. */
async function runQaCall({ base, tenant, twilioAuthToken, tts, fetchImpl = fetch, WS = globalThis.WebSocket, log = () => {} }) {
  if (!twilioAuthToken || !tts) throw new Error('test-drive needs the Twilio auth token and TTS configured');
  if (!WS) throw new Error('no WebSocket implementation');
  base = base.replace(/\/$/, '');
  const callSid = 'CA' + crypto.randomBytes(16).toString('hex');
  const twiml = await (await twilioPost(fetchImpl, twilioAuthToken, `${base}/voice/twilio?tenant=${tenant}`, { CallSid: callSid, From: QA_FROM, To: '+13462204138' })).text();
  const m = twiml.match(/<Stream url="([^"]+)"/);
  if (!m) throw new Error('demo line did not return a media stream');
  const audio = []; for (const l of QA_LINES) audio.push(await tts.speak(l));
  const SILENCE = Buffer.alloc(160, 0xff);
  const ws = new WS(m[1].replace(/&amp;/g, '&'));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('media stream connect failed')); });
  const streamSid = 'MZ' + callSid.slice(2);
  let botBytes = 0, idx = 0, closed = false; const q = [];
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify({ event: 'start', sequenceNumber: '1', start: { streamSid, callSid, accountSid: 'ACsim', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { tenant, from: QA_FROM, callSid } }, streamSid }));
  const tick = setInterval(() => { if (closed) return; const c = q.length ? q.shift() : SILENCE; try { ws.send(JSON.stringify({ event: 'media', streamSid, media: { track: 'inbound', payload: c.toString('base64') } })); } catch { /* closed */ } }, 20);
  const speak = (buf) => { for (let i = 0; i < buf.length; i += 160) { const c = Buffer.alloc(160, 0xff); buf.copy(c, 0, i, Math.min(i + 160, buf.length)); q.push(c); } };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event === 'media') botBytes += Buffer.from(msg.media.payload, 'base64').length;
    else if (msg.event === 'clear') botBytes = 0;
    else if (msg.event === 'mark') {
      const playMs = (botBytes / 8000) * 1000; botBytes = 0; await sleep(playMs);
      try { ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: msg.mark.name } })); } catch { return; }
      while (q.length) await sleep(50);
      if (idx < audio.length) { await sleep(400); speak(audio[idx++]); }
    }
  };
  await new Promise((res) => { ws.onclose = () => { closed = true; res(); }; setTimeout(res, 150000); });
  closed = true; clearInterval(tick); try { ws.close(); } catch { /* */ }
  await twilioPost(fetchImpl, twilioAuthToken, `${base}/voice/twilio/after?tenant=${tenant}`, { CallSid: callSid }).catch(() => {});
  log(`test-drive call ${callSid.slice(-8)} done, caller lines ${idx}/${QA_LINES.length}`);
  return { ok: idx === QA_LINES.length, callSid, linesSpoken: idx };
}

module.exports = { latestQaCall, runQaCall, shapeCall, qaNumbers, QA_FROM, QA_LINES };
