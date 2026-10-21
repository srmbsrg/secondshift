'use strict';
// Model router + chat fallback (no network: fake providers and a local fake OpenAI-compatible server).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createRouter, createBudget, createAlerts, chainFromEnv, costUsd, outOfCredit, createRoutersFromEnv } = require('../src/brain/router');
const { createLlm } = require('../src/brain/llm');

// A fake provider with the llm.js contract. behave(meta) -> result; fills meta like llm.js does.
const fake = (provider, model, paid, behave) => ({
  provider, model, paid, calls: 0,
  async json(s, u, meta) { this.calls++; return behave(meta || {}); },
  async chatJson(s, m, o = {}) { this.calls++; return behave(o.meta || {}); },
  async warm() { return null; },
});

test('router: local first; paid only when local fails; spend metered on paid only', async () => {
  const budget = createBudget({ capUsd: 5 }); const alerts = createAlerts({});
  const local = fake('local', 'llama3.1:8b', false, m => { m.status = 500; m.error = 'boom'; return null; });
  const paid = fake('abacus', 'claude-haiku-5-5', true, m => { m.status = 200; m.usage = { input: 1000, output: 100 }; return { ok: 1 }; });
  const r = createRouter({ task: 'chat', providers: [local, paid], budget, alerts });
  assert.deepEqual(await r.chatJson('sys', [{ role: 'user', content: 'hi' }]), { ok: 1 });
  assert.equal(local.calls, 1); assert.equal(paid.calls, 1);
  assert.ok(Math.abs(budget.state().spentUsd - costUsd('claude-haiku-5-5', { input: 1000, output: 100 })) < 1e-9);
  const okLocal = fake('local', 'llama3.1:8b', false, m => { m.usage = { input: 9e6, output: 9e6 }; return { from: 'local' }; });
  const r2 = createRouter({ task: 'call', providers: [okLocal, paid], budget, alerts });
  const before = budget.state().spentUsd;
  assert.deepEqual(await r2.json('sys', 'u'), { from: 'local' });
  assert.equal(budget.state().spentUsd, before); // free model never touches the budget
});

test('router: out-of-credit -> Telegram alert once (cooldown), falls back, returns null at end of chain', async () => {
  const sent = []; let t = 1e12;
  const alerts = createAlerts({ telegram: { send: async x => { sent.push(x); return 1; } }, now: () => t });
  const dry = fake('abacus', 'claude-haiku-5-5', true, m => { m.status = 429; m.error = '{"error":{"code":"insufficient_quota","message":"You have no remaining credits"}}'; return null; });
  const r = createRouter({ task: 'chat', providers: [dry], budget: createBudget({ capUsd: 5 }), alerts });
  assert.equal(await r.chatJson('s', []), null);
  assert.equal(await r.chatJson('s', []), null);
  assert.equal(sent.length, 1); assert.match(sent[0], /OUT OF CREDIT[\s\S]*canned answers/);
  t += 7 * 3600e3; await r.chatJson('s', []); assert.equal(sent.length, 2); // re-alerts after the cooldown
  assert.ok(outOfCredit({ status: 402 })); assert.ok(!outOfCredit({ status: 500, error: 'oops' }));
  assert.equal(r.status().lastError.status, 429);
});

test('router: monthly budget cap stops paid calls, alerts at 80% and 100%, resets next month', async () => {
  const sent = []; let t = Date.parse('2026-10-21T12:00:00Z');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-budget-')), 'ai-budget.json');
  const budget = createBudget({ file, capUsd: 0.001, now: () => t });
  const alerts = createAlerts({ telegram: { send: async x => { sent.push(x); return 1; } }, now: () => t });
  const paid = fake('abacus', 'claude-haiku-5-5', true, m => { m.usage = { input: 4000, output: 0 }; return { ok: 1 }; }); // $0.0004 each
  const r = createRouter({ task: 'call', providers: [paid], budget, alerts });
  await r.json('s', 'u'); await r.json('s', 'u'); // 0.0008 -> 80%
  assert.match(sent.join('\n'), /80% of the monthly cap/);
  await r.json('s', 'u'); // 0.0012 -> capped
  assert.match(sent.join('\n'), /hit the monthly cap/);
  assert.equal(await r.json('s', 'u'), null); assert.equal(paid.calls, 3); // 4th call never reaches the paid model
  assert.equal(createBudget({ file, capUsd: 0.001, now: () => t }).state().capped, true); // persisted across restarts
  t = Date.parse('2026-11-01T12:00:00Z');
  assert.deepEqual(await r.json('s', 'u'), { ok: 1 }); // new month, budget reset
  assert.equal(createBudget({ capUsd: 0 }).allow(), false); // cap 0 = paid models off
});

test('router: chain from env (default local-first, legacy provider, explicit, per task, none)', () => {
  assert.deepEqual(chainFromEnv({}, { abacusKey: 'k' }, 'chat'), ['local', 'abacus']);
  assert.deepEqual(chainFromEnv({ SECONDSHIFT_LLM_PROVIDER: 'abacus' }, { abacusKey: 'k' }, 'call'), ['abacus']);
  assert.deepEqual(chainFromEnv({ SECONDSHIFT_LLM_PROVIDER: 'none' }, { abacusKey: 'k' }, 'call'), []);
  assert.deepEqual(chainFromEnv({ SECONDSHIFT_LLM_CHAIN: 'local,abacus', SECONDSHIFT_LLM_CHAIN_CALL: 'abacus' }, {}, 'call'), ['abacus']);
  assert.deepEqual(chainFromEnv({ SECONDSHIFT_LLM_CHAIN: 'local,abacus' }, {}, 'chat'), ['local', 'abacus']);
  // No LOCAL_LLM_BASE_URL -> "local" is skipped; legacy abacus env keeps today's live behaviour.
  const a = createRoutersFromEnv({ SECONDSHIFT_LLM_PROVIDER: 'abacus', SECONDSHIFT_LLM_MODEL: 'claude-haiku-5-5' }, { abacusKey: 'k' });
  assert.deepEqual(a.call.chain, ['abacus:claude-haiku-5-5']); assert.deepEqual(a.chat.chain, ['abacus:claude-haiku-5-5']);
  const b = createRoutersFromEnv({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1/v1', SECONDSHIFT_LLM_CHAIN: 'local,abacus' }, { abacusKey: 'k' });
  assert.deepEqual(b.chat.chain, ['local:llama3.1:8b', 'abacus:claude-haiku-5-5']);
  assert.equal(createRoutersFromEnv({ SECONDSHIFT_LLM_PROVIDER: 'none' }, { abacusKey: 'k' }).call, null);
});

test('llm.js fills meta (status, usage, error) without changing its return contract', async () => {
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      if (mode === 'credit') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"insufficient_quota","message":"You have no remaining credits"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"reply":"hi"}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    });
  });
  await new Promise(r => srv.listen(0, r));
  const llm = createLlm({ provider: 'abacus', apiKey: 'k', baseUrl: `http://127.0.0.1:${srv.address().port}/v1` });
  const m1 = {}; assert.deepEqual(await llm.chatJson('s', [{ role: 'user', content: 'x' }], { meta: m1 }), { reply: 'hi' });
  assert.deepEqual(m1.usage, { input: 12, output: 3 }); assert.equal(m1.status, 200); assert.equal(llm.paid, true);
  mode = 'credit'; const m2 = {}; assert.equal(await llm.json('s', 'u', m2), null);
  assert.equal(m2.status, 429); assert.ok(outOfCredit(m2));
  assert.deepEqual(await llm.json('s', 'u'), null); // meta is optional
  assert.equal(createLlm({ provider: 'local', baseUrl: 'http://x/v1' }).paid, false);
  srv.close();
});

test('chat: no model / model fails -> grounded canned answer (200), never a 502', async () => {
  const { createChat, fallbackReply, FALLBACK, SYSTEM } = require('../src/chat');
  const chat = createChat({ llm: { async chatJson() { return null; } }, leads: null });
  let r = await chat.handle({ messages: [{ role: 'user', content: 'How much is SecondShift?' }] }, { ip: '9.9.9.1' });
  assert.equal(r.status, 200); assert.equal(r.body.fallback, true); assert.match(r.body.reply, /\$59\.99/);
  const off = createChat({ llm: null, leads: null });
  r = await off.handle({ messages: [{ role: 'user', content: 'does it sync with google calendar' }] }, { ip: '9.9.9.2' });
  assert.equal(r.status, 200); assert.match(r.body.reply, /does not sync/);
  assert.match(fallbackReply([{ role: 'user', content: 'can I hear a demo' }]), /\(346\) 220-4138/);
  assert.match(fallbackReply([{ role: 'user', content: 'tell me about carbon' }]), /in progress/);
  assert.equal(fallbackReply([{ role: 'user', content: 'asdf' }]), FALLBACK.default);
  // Canned answers may only state facts the grounded prompt states.
  for (const fact of ['$59.99', '(346) 220-4138', 'first month']) assert.ok(SYSTEM.includes(fact), fact);
});
