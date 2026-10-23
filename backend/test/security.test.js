'use strict';
// Security hardening (2026-10-23 audit): Twilio signature check fails closed; /health hides config.
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const twilio = require('../src/phone/twilio');
const { createServer } = require('../src/server');

const sign = (token, url, p) => crypto.createHmac('sha1', token).update(url + Object.keys(p).sort().map(k => k + p[k]).join('')).digest('base64');

test('twilio signature: no auth token -> rejected (fail closed)', () => {
  assert.equal(twilio.validSignature('', 'anything', 'https://x/voice/twilio', { CallSid: 'CA1' }), false);
  assert.equal(twilio.validSignature(undefined, undefined, 'https://x/voice/twilio', {}), false);
});

test('twilio signature: explicit dev opt-in allows unsigned only when no token', () => {
  assert.equal(twilio.validSignature('', '', 'https://x/v', {}, { allowUnsigned: true }), true);
  assert.equal(twilio.validSignature('tok', 'forged', 'https://x/v', {}, { allowUnsigned: true }), false);
});

test('twilio signature: valid signature accepted, forged rejected', () => {
  const url = 'https://x/voice/twilio?tenant=carborundum', p = { CallSid: 'CA1', From: '+1713' };
  assert.equal(twilio.validSignature('tok', sign('tok', url, p), url, p), true);
  assert.equal(twilio.validSignature('tok', sign('other', url, p), url, p), false);
});

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sec-'));
  const { server } = createServer({ dataDir, googleAuth: null, llm: null, telegram: null, ...opts });
  await new Promise(r => server.listen(0, r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('server: /voice/twilio with no auth token returns 403', async () => {
  await withServer({ secrets: {}, env: {} }, async base => {
    const r = await fetch(base + '/voice/twilio', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'CallSid=CA1&From=%2B1713' });
    assert.equal(r.status, 403);
  });
});

test('server: /health public = liveness only; detail needs bearer token', async () => {
  await withServer({ secrets: { siliconToken: 'sekrit' }, env: {} }, async base => {
    const pub = await (await fetch(base + '/health')).json();
    assert.deepEqual(Object.keys(pub), ['ok']);
    const bad = await (await fetch(base + '/health', { headers: { authorization: 'Bearer nope' } })).json();
    assert.deepEqual(Object.keys(bad), ['ok']);
    const full = await (await fetch(base + '/health', { headers: { authorization: 'Bearer sekrit' } })).json();
    assert.ok(full.modules && 'twilioSignatureCheck' in full.modules);
  });
});
