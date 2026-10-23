'use strict';
// Agent door: demo-only tokens, decision packet (JSON + PDF), test-drive privacy filter, Stripe TEST guard, MCP.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createServer } = require('../src/server');
const { createTestCheckout } = require('../src/agent/checkout');
const { normalizeNeeds, quote } = require('../src/agent/packet');

const QA = { callSid: 'CAqa000000000000000000000000abcd1234', tenant: 'carborundum', from: '+17135550148', startedAt: '2026-10-23T16:00:00.000Z', endedAt: '2026-10-23T16:01:30.000Z',
  outcome: 'booked', slots: { name: 'QA Test Jordan', issue: 'AC stopped working', address: '1412 Willow Bend Drive', when: 'tomorrow 8 AM', phone: '+17135550148' }, emergency: false,
  booking: { id: 'b1', when: 'Sat Oct 24, 8 AM', calendar: 'silicon' }, storeAudio: false,
  transcript: [{ at: 0, who: 'agent', text: 'Thanks for calling Carborundum - this call is recorded and answered by an automated assistant.' }, { at: 1, who: 'caller', text: 'My AC stopped working.' }] };
const REAL = { ...QA, callSid: 'CAreal0000000000000000000000realcall', from: '+18328458515', slots: { name: 'Real Prospect' }, transcript: [{ who: 'caller', text: 'PRIVATE customer words' }] };

async function withServer(opts, fn, calls = [QA, REAL]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-agent-'));
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
  const { server } = createServer({ dataDir, googleAuth: null, llm: null, telegram: null, secrets: {}, env: { PUBLIC_BASE_URL: 'https://ss.test' }, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, p, body, token) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: /json/.test(r.headers.get('content-type') || '') ? await r.json() : await r.arrayBuffer() }; };
  try { return await fn({ base, j, dataDir }); } finally { server.close(); }
}

test('agent: index is public; everything else needs a token', async () => {
  await withServer({}, async ({ j }) => {
    assert.equal((await j('GET', '/agent')).status, 200);
    assert.equal((await j('POST', '/agent/decision-packet', { needs: [] })).status, 401);
    assert.equal((await j('GET', '/agent/test-drive')).status, 401);
    assert.equal((await j('POST', '/agent/decision-packet', { needs: [] }, 'ssd_forged')).status, 401);
  });
});

test('agent: token -> packet JSON + PDF, pinned to the QA call, never real callers', async () => {
  await withServer({}, async ({ j, dataDir }) => {
    const t = await j('POST', '/agent/token', { label: 'film' });
    assert.equal(t.status, 201); assert.match(t.body.token, /^ssd_/); assert.equal(t.body.tenant, 'demo');
    const pk = await j('POST', '/agent/decision-packet', { needs: ['after_hours_calls', 'booking', { crm_sync: { system: 'QuickBooks' } }] }, t.body.token);
    assert.equal(pk.status, 201);
    const p = pk.body;
    assert.equal(p.test_drive.call_ref, 'abcd1234');
    assert.equal(p.test_drive.transcript.length, 2);
    assert.ok(!JSON.stringify(p).includes('PRIVATE'), 'real caller data must never appear');
    assert.ok(!JSON.stringify(p).includes('+18328458515'));
    assert.ok(!JSON.stringify(p).includes(t.body.token), 'token never echoed');
    assert.equal(p.quote.monthly_after_free_month, 69.99);
    assert.equal(p.quote.one_time_build_fees, 199);
    assert.equal(p.escalation.email, 'scott@carborundum.ai');
    assert.match(p.record.sha256, /^[0-9a-f]{64}$/);
    const pdf = await j('GET', `/agent/decision-packet/${p.id}.pdf`);
    assert.equal(pdf.status, 200); const s = Buffer.from(pdf.body).toString('latin1');
    assert.ok(s.startsWith('%PDF-1.4') && s.includes('/Count 1') && s.trimEnd().endsWith('%%EOF'));
    assert.ok(s.includes('QA test caller'));
    assert.equal((await j('GET', `/agent/decision-packet/${p.id}.json`)).body.id, p.id);
    assert.equal((await j('GET', '/agent/decision-packet/pk_doesnotexist000.json')).status, 404);
    const audit = fs.readFileSync(path.join(dataDir, 'agent', 'audit.jsonl'), 'utf8');
    assert.ok(audit.includes(t.body.id) && !audit.includes(t.body.token), 'audit has token id, never the token');
  });
});

test('agent: test-drive returns only QA-number calls; none -> null', async () => {
  await withServer({}, async ({ j }) => {
    const t = (await j('POST', '/agent/token')).body.token;
    const r = await j('GET', '/agent/test-drive', null, t);
    assert.equal(r.body.call, null);
  }, [REAL]);
});

test('agent: revoked token stops working', async () => {
  await withServer({}, async ({ j }) => {
    const t = (await j('POST', '/agent/token')).body.token;
    assert.equal((await j('GET', '/agent/test-drive', null, t)).status, 200);
    assert.equal((await j('DELETE', '/agent/token', null, t)).status, 200);
    assert.equal((await j('GET', '/agent/test-drive', null, t)).status, 401);
  });
});

test('agent: live test-drive is rate-limited and reports 503 when not configured', async () => {
  let calls = 0;
  const runCall = async () => { calls++; return { ok: true, callSid: QA.callSid }; };
  await withServer({ agentRunCall: runCall }, async ({ j }) => {
    const t = (await j('POST', '/agent/token')).body.token;
    assert.equal((await j('POST', '/agent/test-drive', {}, t)).status, 503); // no twilio token / tts in tests
  });
  await withServer({ agentRunCall: runCall, secrets: { twilioAuthToken: 'x' }, tts: { speak: async () => Buffer.alloc(0), model: 'm' }, warmup: false }, async ({ j }) => {
    const t1 = (await j('POST', '/agent/token')).body.token, t2 = (await j('POST', '/agent/token')).body.token;
    const r = await j('POST', '/agent/test-drive', {}, t1); assert.equal(r.status, 202);
    assert.equal((await j('POST', '/agent/test-drive', {}, t1)).status, 202);
    assert.equal((await j('POST', '/agent/test-drive', {}, t1)).status, 429); // 2/hour per token
    assert.equal((await j('POST', '/agent/test-drive', {}, t2)).status, 202);
    assert.equal((await j('POST', '/agent/test-drive', {}, t2)).status, 429); // 3/hour overall
    await new Promise((res) => setTimeout(res, 20));
    const st = await j('GET', '/agent/test-drive/' + r.body.run_id, null, t1);
    assert.equal(st.body.status, 'done'); assert.equal(st.body.call.call_ref, 'abcd1234');
    assert.equal(calls, 3);
  });
});

test('agent: checkout refuses live keys and is 503 when unset', async () => {
  assert.equal(createTestCheckout({ key: 'sk_live_abc' }).enabled, false);
  assert.equal(createTestCheckout({ key: 'sk_test_abc' }).enabled, true);
  await withServer({}, async ({ j }) => {
    const t = (await j('POST', '/agent/token')).body.token;
    assert.equal((await j('POST', '/agent/checkout', {}, t)).status, 503);
  });
});

test('agent: checkout + receipt land in the packet (Stripe mocked)', async () => {
  const fakeFetch = async (url, o) => {
    if (/checkout\/sessions$/.test(url)) { const f = new URLSearchParams(o.body); return new Response(JSON.stringify({ id: 'cs_test_abc123456789', url: 'https://checkout.stripe.com/c/pay/cs_test_abc', metadata: { agent_token_id: f.get('metadata[agent_token_id]') } })); }
    return new Response(JSON.stringify({ id: 'cs_test_abc123456789', status: 'complete', payment_status: 'no_payment_required', amount_total: 0, currency: 'usd', subscription: 'sub_123', created: 1792790000, metadata: { agent_token_id: globalThis.__tok, packet_id: '' } }));
  };
  await withServer({ fetch: fakeFetch, env: { PUBLIC_BASE_URL: 'https://ss.test', STRIPE_TEST_SECRET_KEY: 'sk_test_x' } }, async ({ base, j }) => {
    const tk = await j('POST', '/agent/token'); globalThis.__tok = tk.body.id;
    const c = await j('POST', '/agent/checkout', {}, tk.body.token);
    assert.equal(c.status, 201); assert.equal(c.body.mode, 'test');
    const done = await fetch(base + '/agent/checkout/done?session_id=cs_test_abc123456789');
    const html = await done.text(); assert.match(html, /TEST MODE/);
    const p = (await j('POST', '/agent/decision-packet', { needs: ['after_hours_calls'] }, tk.body.token)).body;
    assert.equal(p.record.receipt.mode, 'test'); assert.equal(p.record.receipt.status, 'complete'); assert.equal(p.version, 2);
    assert.equal((await fetch(base + '/agent/checkout/done?session_id=cs_live_zzz')).status, 400);
  });
});

test('agent: MCP initialize, scoped tools/list, tools/call', async () => {
  await withServer({}, async ({ j }) => {
    const t = (await j('POST', '/agent/token')).body.token;
    const init = await j('POST', '/agent/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, t);
    assert.equal(init.body.result.serverInfo.name, 'secondshift-agent-door');
    assert.equal((await j('POST', '/agent/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, t)).status, 202);
    const list = await j('POST', '/agent/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, t);
    assert.deepEqual(list.body.result.tools.map((x) => x.name).sort(), ['create_test_checkout', 'get_decision_packet', 'get_test_drive', 'run_test_drive']);
    const call = await j('POST', '/agent/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_decision_packet', arguments: { needs: ['booking'] } } }, t);
    assert.equal(call.body.result.structuredContent.test_drive.call_ref, 'abcd1234');
    assert.equal((await j('POST', '/agent/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' })).status, 401);
  });
});

test('packet: needs parsing + honest quote tiers', () => {
  assert.deepEqual(normalizeNeeds(undefined).after_hours_calls, true);
  assert.equal(quote(normalizeNeeds([{ crm_sync: { system: 'Google Sheets' } }])).one_time_build_fees, 49);
  const q = quote(normalizeNeeds({ crm_sync: { system: 'ServiceTitan' } }));
  assert.equal(q.one_time_tier_to_confirm, true);
  assert.ok(q.lines.every((l) => l.status));
});
