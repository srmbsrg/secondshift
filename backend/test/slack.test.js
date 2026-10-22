'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSlack, isRealCaller, parseExclude } = require('../src/notify/slack');

test('slack: off without a webhook URL', () => {
  assert.strictEqual(createSlack({ webhookUrl: '' }), null);
});

test('slack: Scott\'s test number excluded by default, real callers pass', () => {
  const ex = parseExclude(undefined);
  assert.strictEqual(isRealCaller('+19034747930', ex), false);
  assert.strictEqual(isRealCaller('(903) 474-7930', ex), false);
  assert.strictEqual(isRealCaller('+18328458515', ex), true);
  assert.strictEqual(isRealCaller('', ex), false);
  assert.strictEqual(isRealCaller('anonymous', ex), false);
});

test('slack: custom exclude list', () => {
  const ex = parseExclude('+12815550100, 713-555-0199');
  assert.strictEqual(isRealCaller('+12815550100', ex), false);
  assert.strictEqual(isRealCaller('+17135550199', ex), false);
  assert.strictEqual(isRealCaller('+19034747930', ex), true);
});

test('slack: send posts JSON text to the webhook and surfaces HTTP errors', async () => {
  const calls = [];
  const ok = createSlack({ webhookUrl: 'https://hooks.example/x', fetchImpl: async (u, o) => { calls.push([u, JSON.parse(o.body)]); return { ok: true }; } });
  assert.ok(ok.shouldPost('+18328458515'));
  await ok.send('hello');
  assert.deepStrictEqual(calls, [['https://hooks.example/x', { text: 'hello' }]]);
  const bad = createSlack({ webhookUrl: 'https://hooks.example/x', fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(bad.send('x'), /slack 404/);
});
