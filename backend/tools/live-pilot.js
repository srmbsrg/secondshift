'use strict';
// Live pilot harness: one command to put SecondShift on a real phone line for a test call.
//
//   node tools/live-pilot.js --dry          tunnel + server + a signed fake call through the tunnel (no Twilio changes)
//   node tools/live-pilot.js                same, then list the account's Twilio numbers and exit
//   node tools/live-pilot.js +1XXXXXXXXXX   wire that EXISTING number to the tunnel and stay up for test calls
//   node tools/live-pilot.js --restore      put the number's previous voice setting back (also runs on Ctrl+C)
//
// Never buys numbers or changes billing. The previous voice config is saved to data/pilot-previous.json
// BEFORE the number is changed. A quick tunnel's URL changes every run, so restore when done.
const { spawn } = require('child_process');
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { loadSecrets } = require('../src/config');
const { api } = require('./twilio-wire');

const ROOT = path.join(__dirname, '..');
const PREV = path.join(ROOT, 'data', 'pilot-previous.json');
const CLOUDFLARED = process.env.CLOUDFLARED || 'C:\\Users\\scott\\tools\\cloudflared\\cloudflared.exe';
const PORT = +(process.env.PORT || 8790);
const TENANT = process.env.SECONDSHIFT_TENANT || 'carborundum';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const children = [];

async function restore(secrets) {
  if (!fs.existsSync(PREV)) return console.log('[pilot] nothing to restore');
  const p = JSON.parse(fs.readFileSync(PREV, 'utf8'));
  await api(secrets.twilioAccountSid, secrets.twilioAuthToken, `/IncomingPhoneNumbers/${p.sid}.json`,
    { VoiceUrl: p.voice_url || '', VoiceMethod: p.voice_method || 'POST', VoiceApplicationSid: p.voice_application_sid || '', VoiceFallbackUrl: p.voice_fallback_url || '' });
  fs.unlinkSync(PREV);
  console.log(`[pilot] restored ${p.phone_number} -> ${p.voice_application_sid ? 'app ' + p.voice_application_sid : p.voice_url || '(none)'}`);
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    const cf = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { windowsHide: true });
    children.push(cf);
    const t = setTimeout(() => reject(new Error('cloudflared gave no URL in 60 s')), 60000);
    const scan = d => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(t); resolve(m[0]); } };
    cf.stdout.on('data', scan); cf.stderr.on('data', scan);
    cf.on('exit', c => { if (!shuttingDown) { console.error('[pilot] cloudflared exited', c); reject(new Error('cloudflared exited ' + c)); } });
  });
}

function startServer(publicUrl) {
  const s = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT: String(PORT), PUBLIC_BASE_URL: publicUrl, SECONDSHIFT_VERBOSE: '1' } });
  children.push(s);
  s.on('exit', c => { if (!shuttingDown) { console.error('[pilot] server exited', c); shutdown(1); } });
}

async function waitHealth(base, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2000)) {
    try { const r = await fetch(base + '/health'); if (r.ok) return r.json(); } catch {}
  }
  throw new Error('health check failed at ' + base);
}

// A signed fake "call comes in" plus a media stream, all through the public tunnel URL:
// proves Twilio will be able to reach both the webhook and the WebSocket.
async function selfTest(pub, token) {
  const url = `${pub}/voice/twilio?tenant=${TENANT}`;
  const params = { CallSid: 'CApilotselftest' + Date.now(), From: '+15555550100', To: '+15555550199' };
  const sign = p => crypto.createHmac('sha1', token).update(url + Object.keys(p).sort().map(k => k + p[k]).join('')).digest('base64');
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (token) headers['x-twilio-signature'] = sign(params);
  const twiml = await (await fetch(url, { method: 'POST', headers, body: new URLSearchParams(params) })).text();
  const ws = (twiml.match(/<Stream url="([^"]+)"/) || [])[1];
  if (!ws || !ws.startsWith('wss://')) throw new Error('webhook via tunnel did not return a wss Stream: ' + twiml.slice(0, 200));
  if (token) {
    const bad = await fetch(url, { method: 'POST', headers: { ...headers, 'x-twilio-signature': 'forged' }, body: new URLSearchParams(params) });
    if (bad.status !== 403) throw new Error('forged signature was not rejected');
  }
  const sock = new WebSocket(ws); const t0 = Date.now();
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('wss via tunnel failed')); });
  const start = { streamSid: 'MZselftest', callSid: params.CallSid, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { tenant: TENANT, from: params.From, callSid: params.CallSid } };
  sock.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  sock.send(JSON.stringify({ event: 'start', sequenceNumber: '1', streamSid: 'MZselftest', start }));
  const firstAudio = await new Promise((res, rej) => { sock.onmessage = e => { if (JSON.parse(e.data).event === 'media') res(Date.now() - t0); }; setTimeout(() => rej(new Error('no greeting audio via tunnel')), 15000); });
  sock.send(JSON.stringify({ event: 'stop', streamSid: 'MZselftest' })); sock.close();
  console.log(`[pilot] self-test OK: webhook ${token ? '(signed; forged signature rejected)' : '(unsigned; no auth token yet)'} -> wss stream -> greeting audio in ${firstAudio} ms over the tunnel`);
}

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return; shuttingDown = true;
  try { const s = loadSecrets(); if (fs.existsSync(PREV) && s.twilioAccountSid) await restore(s); } catch (e) { console.error('[pilot] RESTORE FAILED; run: node tools/live-pilot.js --restore  (' + e.message + ')'); }
  for (const c of children) try { c.kill(); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));

async function main() {
  const arg = process.argv[2];
  const secrets = loadSecrets();
  const haveTwilio = !!(secrets.twilioAccountSid && secrets.twilioAuthToken);
  if (arg === '--restore') return restore(secrets);
  if (!secrets.deepgramKey) throw new Error('Deepgram key missing');
  if (!haveTwilio && arg !== '--dry') throw new Error(`Twilio API creds not found. Save twilio_account_sid.txt (AC...) and twilio_auth_token.txt in ${secrets.dir}, or run with --dry.`);
  // A restart keeps the ORIGINAL saved config (from before the first wiring) and simply re-points the
  // number at the new tunnel, so the line never flips back mid-pilot. --restore puts the original back.
  if (fs.existsSync(PREV)) console.log('[pilot] keeping the original saved config from ' + JSON.parse(fs.readFileSync(PREV, 'utf8')).savedAt);
  if (!fs.existsSync(CLOUDFLARED)) throw new Error('cloudflared not found at ' + CLOUDFLARED);

  const pub = await startTunnel(); console.log('[pilot] tunnel:', pub);
  startServer(pub);
  const h = await waitHealth(`http://127.0.0.1:${PORT}`, 20000);
  console.log('[pilot] modules:', JSON.stringify(h.modules));
  await waitHealth(pub, 90000); // quick-tunnel DNS can take a few seconds
  await selfTest(pub, secrets.twilioAuthToken);

  if (arg === '--dry') { console.log('[pilot] dry run complete'); return shutdown(0); }
  const nums = (await api(secrets.twilioAccountSid, secrets.twilioAuthToken, '/IncomingPhoneNumbers.json?PageSize=100')).incoming_phone_numbers;
  if (!arg) {
    console.log('[pilot] numbers on this account:');
    for (const n of nums) console.log(`  ${n.phone_number}  "${n.friendly_name}"  voice: ${n.voice_application_sid ? 'app ' + n.voice_application_sid : n.voice_url || '(none)'}${n.trunk_sid ? '  [SIP trunk]' : ''}`);
    console.log('[pilot] pick one and run: node tools/live-pilot.js +1XXXXXXXXXX');
    return shutdown(0);
  }
  const n = nums.find(x => x.phone_number === arg);
  if (!n) throw new Error(`${arg} is not on this account`);
  if (n.trunk_sid) throw new Error(`${arg} is on a SIP trunk; its voice URL is ignored. Pick another number.`);
  fs.mkdirSync(path.dirname(PREV), { recursive: true });
  if (!fs.existsSync(PREV)) fs.writeFileSync(PREV, JSON.stringify({ sid: n.sid, phone_number: n.phone_number, voice_url: n.voice_url, voice_method: n.voice_method, voice_application_sid: n.voice_application_sid, voice_fallback_url: n.voice_fallback_url, savedAt: new Date().toISOString() }, null, 2));
  console.log(`[pilot] original config of ${arg} is saved in ${PREV}`);
  const u = await api(secrets.twilioAccountSid, secrets.twilioAuthToken, `/IncomingPhoneNumbers/${n.sid}.json`, { VoiceUrl: `${pub}/voice/twilio?tenant=${TENANT}`, VoiceMethod: 'POST', VoiceApplicationSid: '' });
  console.log(`[pilot] ${u.phone_number} -> ${u.voice_url}`);
  console.log(`\n[pilot] READY. Call ${u.phone_number} now. Ctrl+C (or --restore) puts the old setting back.\n`);
}
main().catch(e => { console.error('[pilot]', e.message); shutdown(1); });
