'use strict';
/*
 * Agent door (demo shop only). Everything an owner's AI agent needs to evaluate SecondShift for its human:
 *   GET    /agent                          index: endpoints, what is live, rules
 *   POST   /agent/token                    get a scoped demo token (24h, revocable). Body {label?}
 *   DELETE /agent/token                    revoke your token
 *   POST   /agent/decision-packet          {needs} -> JSON packet + PDF link            scope packet:create
 *   GET    /agent/decision-packet/<id>.json|.pdf   capability URL to hand to the human (unguessable id)
 *   GET    /agent/test-drive               newest real QA call to the demo line + transcript   scope testdrive:read
 *   POST   /agent/test-drive               place a new QA call now (~1-2 min, rate-limited)    scope testdrive:run
 *   GET    /agent/test-drive/<runId>       status of a call you placed
 *   POST   /agent/checkout                 Stripe TEST-mode checkout URL                       scope checkout:create
 *   GET    /agent/checkout/done            Stripe redirect target; records the receipt (TEST MODE page)
 *   POST   /agent/mcp                      the same actions as MCP tools (JSON-RPC, Streamable HTTP, stateless)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTokenStore, createLimiter, createAudit } = require('./tokens');
const { latestQaCall, runQaCall } = require('./testdrive');
const { buildPacket, packetPdf } = require('./packet');
const { createTestCheckout } = require('./checkout');

function createAgentApi({ dataDir, env = process.env, secrets = {}, tts = null, demoTenant = 'carborundum', fetchImpl = fetch, runCall = runQaCall, now = () => Date.now() }) {
  const dir = path.join(dataDir, 'agent');
  const tokens = createTokenStore({ file: path.join(dir, 'tokens.json'), now });
  const limiter = createLimiter({ now });
  const audit = createAudit(path.join(dir, 'audit.jsonl'));
  const checkout = createTestCheckout({ key: env.STRIPE_TEST_SECRET_KEY, fetchImpl });
  const stateFile = path.join(dir, 'state.json');
  let state = { packets: {}, receipts: {} };
  try { state = { packets: {}, receipts: {}, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* fresh */ }
  const saveState = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) { console.error('agent state save failed', e.message); } };
  const runs = new Map();

  const baseOf = (req) => (env.PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
  const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  const readJson = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 10000) req.destroy(); }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res(null); } }); });

  // ---- actions (shared by REST and MCP) ----
  const testDrive = (callSid, callRef) => latestQaCall(dataDir, { env, callSid, callRef });
  function makePacket(principal, needs, base) {
    const id = 'pk_' + crypto.randomBytes(12).toString('base64url');
    const td = testDrive(); // pin the packet to the call it was built from
    state.packets[id] = { needs, tokenId: principal.tokenId, tenant: principal.tenant, createdAt: new Date(now()).toISOString(), callRef: td ? td.call_ref : null };
    const ids = Object.keys(state.packets); if (ids.length > 2000) delete state.packets[ids[0]];
    saveState();
    return renderPacket(id, base);
  }
  function renderPacket(id, base) {
    const p = state.packets[id]; if (!p) return null;
    const receipt = state.receipts[p.tokenId] || null;
    return buildPacket({ id, needsInput: p.needs, testDrive: p.callRef ? testDrive(null, p.callRef) : null, receipt, principal: { tokenId: p.tokenId, tenant: p.tenant }, base, now: new Date(now()), version: receipt ? 2 : 1 });
  }
  function startRun(principal, base) {
    if (!secrets.twilioAuthToken || !tts) return { status: 503, body: { ok: false, error: 'live test-drive calls are not configured on this server; GET /agent/test-drive returns the latest recorded QA call' } };
    const limits = [['global:h', 3, 36e5], ['global:d', 10, 864e5], ['tok:' + principal.tokenId, 2, 36e5]];
    for (const [key, max, win] of limits) {
      const r = limiter.peek(key, max, win); if (!r.ok) return { status: 429, body: { ok: false, error: 'test-drive call limit reached (2/hour per token, 3/hour and 10/day overall). GET /agent/test-drive returns the latest call.', retry_after_sec: r.retryAfterSec } };
    }
    for (const [key, max, win] of limits) limiter.take(key, max, win);
    const runId = 'run_' + crypto.randomBytes(6).toString('hex');
    const run = { runId, status: 'calling', startedAt: new Date(now()).toISOString(), tokenId: principal.tokenId };
    runs.set(runId, run);
    runCall({ base, tenant: demoTenant, twilioAuthToken: secrets.twilioAuthToken, tts, fetchImpl, log: (m) => console.log('[agent] ' + m) })
      .then((r) => Object.assign(run, { status: r.ok ? 'done' : 'incomplete', callSid: r.callSid, finishedAt: new Date(now()).toISOString() }))
      .catch((e) => Object.assign(run, { status: 'failed', error: e.message, finishedAt: new Date(now()).toISOString() }));
    return { status: 202, body: { ok: true, run_id: runId, status: 'calling', poll: `${base}/agent/test-drive/${runId}`, note: 'A scripted QA caller is calling the live demo line now. Takes about 1-2 minutes.' } };
  }
  function runStatus(runId) {
    const run = runs.get(runId); if (!run) return null;
    const call = run.callSid ? testDrive(run.callSid) : null;
    return { run_id: run.runId, status: run.status, started_at: run.startedAt, finished_at: run.finishedAt || null, error: run.error || null, call };
  }
  async function makeCheckout(principal, base, packetId) {
    const c = await checkout.create({ base, tokenId: principal.tokenId, packetId });
    return { ok: true, mode: 'test', label: 'DEMO - Stripe TEST mode. Use card 4242 4242 4242 4242, any future date, any CVC. No real charge.', ...c };
  }

  const index = (base) => ({
    service: 'SecondShift agent door (demo shop only)',
    rules: ['Demo shop only: no real shop or customer data is reachable here.', 'Tokens are scoped, expire in 24h, are revocable, and every use is audited.', 'Checkout is Stripe TEST mode: no real charge.', 'A human (Scott Murphy, scott@carborundum.ai) closes every real sale.'],
    start: `POST ${base}/agent/token`,
    endpoints: {
      token: 'POST /agent/token  |  DELETE /agent/token',
      decision_packet: 'POST /agent/decision-packet {"needs":["after_hours_calls","booking",{"crm_sync":{"system":"QuickBooks"}}]}',
      test_drive: 'GET /agent/test-drive  |  POST /agent/test-drive (places a live QA call)  |  GET /agent/test-drive/<run_id>',
      checkout: 'POST /agent/checkout' + (checkout.enabled ? '' : '  (not configured yet: returns 503)'),
      mcp: 'POST /agent/mcp (tools: get_decision_packet, get_test_drive, run_test_drive, create_test_checkout)',
    },
    human_page: 'https://www.carborundum.ai/agents',
  });

  // ---- MCP (stateless Streamable HTTP, JSON responses) ----
  const MCP_TOOLS = [
    { name: 'get_decision_packet', scope: 'packet:create', description: 'Build the SecondShift decision packet (JSON + 1-page PDF link) for the needs your human listed. Demo shop only.',
      inputSchema: { type: 'object', properties: { needs: { description: 'e.g. ["after_hours_calls","booking",{"crm_sync":{"system":"QuickBooks"}}]' } } } },
    { name: 'get_test_drive', scope: 'testdrive:read', description: 'Newest real call to the demo line placed by our scripted QA caller, with transcript.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' } } } },
    { name: 'run_test_drive', scope: 'testdrive:run', description: 'Place a live scripted QA call into the demo line now (1-2 min). Poll with get_test_drive {run_id}.', inputSchema: { type: 'object', properties: {} } },
    { name: 'create_test_checkout', scope: 'checkout:create', description: 'Stripe TEST-mode checkout URL (no real charge). The receipt lands in your decision packet.', inputSchema: { type: 'object', properties: { packet_id: { type: 'string' } } } },
  ];
  async function mcp(msg, principal, base) {
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'Invalid Request');
    if (msg.id === undefined) return null; // notification
    if (msg.method === 'initialize') return ok({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'secondshift-agent-door', version: '1.0.0' }, instructions: 'Demo shop only. Start with get_decision_packet.' });
    if (msg.method === 'ping') return ok({});
    if (msg.method === 'tools/list') return ok({ tools: MCP_TOOLS.filter((t) => principal.scopes.includes(t.scope)).map(({ scope, ...t }) => t) });
    if (msg.method !== 'tools/call') return err(-32601, 'Method not found');
    const name = msg.params && msg.params.name, args = (msg.params && msg.params.arguments) || {};
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) return err(-32602, 'Unknown tool');
    if (!principal.scopes.includes(tool.scope)) return err(-32001, 'Token lacks scope ' + tool.scope);
    const text = (o, isError = false) => ok({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }], structuredContent: o, isError });
    try {
      if (name === 'get_decision_packet') return text(makePacket(principal, args.needs, base));
      if (name === 'get_test_drive') return text(args.run_id ? (runStatus(args.run_id) || { error: 'unknown run_id' }) : (testDrive() || { status: 'no QA test call on record yet; call run_test_drive' }));
      if (name === 'run_test_drive') { const r = startRun(principal, base); return text(r.body, r.status >= 400); }
      if (name === 'create_test_checkout') return text(await makeCheckout(principal, base, args.packet_id));
    } catch (e) { return text({ ok: false, error: e.message }, true); }
    return err(-32603, 'Internal error');
  }

  // ---- HTTP ----
  async function handle(req, res, url) {
    const send = (code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body, null, 2)); };
    const base = baseOf(req), p = url.pathname.replace(/\/+$/, '') || '/agent', m = req.method;
    const auth = (scope) => { const v = tokens.verify(bearer(req), scope); audit.log({ route: `${m} ${p.replace(/pk_[\w-]+|run_\w+/, ':id')}`, token_id: v.ok ? v.principal.tokenId : null, ok: v.ok, error: v.ok ? undefined : v.error }); return v; };

    if (p === '/agent' && m === 'GET') return send(200, index(base));
    if (p === '/agent/token' && m === 'POST') {
      const r = limiter.take('ip:' + ipOf(req), 5, 36e5); if (!r.ok) return send(429, { ok: false, error: 'too many tokens from this address', retry_after_sec: r.retryAfterSec });
      const body = (await readJson(req)) || {};
      const t = tokens.issue({ label: body.label });
      audit.log({ route: 'POST /agent/token', token_id: t.id, ok: true });
      return send(201, { ok: true, ...t, use: 'Authorization: Bearer <token>', revoke: `DELETE ${base}/agent/token`, shown_once: true });
    }
    if (p === '/agent/token' && m === 'DELETE') { const ok = tokens.revoke(bearer(req)); audit.log({ route: 'DELETE /agent/token', ok }); return send(ok ? 200 : 404, { ok, revoked: ok }); }

    let mm = p.match(/^\/agent\/decision-packet\/(pk_[\w-]{10,40})\.(json|pdf)$/);
    if (mm && m === 'GET') {
      const pk = renderPacket(mm[1], base); if (!pk) return send(404, { ok: false, error: 'unknown packet' });
      audit.log({ route: `GET packet.${mm[2]}`, packet: mm[1].slice(0, 8), ok: true });
      if (mm[2] === 'json') return send(200, pk);
      return send(200, packetPdf(pk).buffer, 'application/pdf', { 'content-disposition': `inline; filename="SecondShift-decision-packet-${mm[1].slice(3, 11)}.pdf"` });
    }
    if (p === '/agent/decision-packet' && m === 'POST') {
      const v = auth('packet:create'); if (!v.ok) return send(v.status, { ok: false, error: v.error });
      const r = limiter.take('pk:' + v.principal.tokenId, 30, 36e5); if (!r.ok) return send(429, { ok: false, error: 'rate limited', retry_after_sec: r.retryAfterSec });
      const body = await readJson(req); if (body === null) return send(400, { ok: false, error: 'bad JSON' });
      return send(201, makePacket(v.principal, body.needs, base));
    }
    if (p === '/agent/test-drive' && m === 'GET') {
      const v = auth('testdrive:read'); if (!v.ok) return send(v.status, { ok: false, error: v.error });
      const c = testDrive(); return send(200, c ? { ok: true, call: c } : { ok: true, call: null, note: `No QA test call on record since the last deploy. POST ${base}/agent/test-drive to place one.` });
    }
    if (p === '/agent/test-drive' && m === 'POST') {
      const v = auth('testdrive:run'); if (!v.ok) return send(v.status, { ok: false, error: v.error });
      const r = startRun(v.principal, base); return send(r.status, r.body);
    }
    mm = p.match(/^\/agent\/test-drive\/(run_[0-9a-f]{12})$/);
    if (mm && m === 'GET') {
      const v = auth('testdrive:read'); if (!v.ok) return send(v.status, { ok: false, error: v.error });
      const s = runStatus(mm[1]); return send(s ? 200 : 404, s || { ok: false, error: 'unknown run' });
    }
    if (p === '/agent/checkout' && m === 'POST') {
      const v = auth('checkout:create'); if (!v.ok) return send(v.status, { ok: false, error: v.error });
      const body = (await readJson(req)) || {};
      try { return send(201, await makeCheckout(v.principal, base, body.packet_id)); } catch (e) { return send(e.status || 502, { ok: false, error: e.message }); }
    }
    if (p === '/agent/checkout/done' && m === 'GET') {
      const page = (title, lines) => send(200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px"><div style="background:#b45309;color:#fff;padding:8px 12px;border-radius:6px;font-weight:700">DEMO / STRIPE TEST MODE - no real charge</div><h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join('')}</body>`, 'text/html; charset=utf-8');
      if (url.searchParams.get('cancelled')) return page('Checkout cancelled', ['Nothing was recorded.']);
      try {
        const r = await checkout.receipt(url.searchParams.get('session_id'));
        if (r.agent_token_id) { state.receipts[r.agent_token_id] = r; saveState(); }
        audit.log({ route: 'GET /agent/checkout/done', token_id: r.agent_token_id, ok: true });
        const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
        return page('Test purchase recorded', [`Session ${esc(r.session_ref)}: ${esc(r.status)} / ${esc(r.payment_status)}`, `${esc(r.plan)}. Due today: $${r.amount_due_today.toFixed(2)} ${esc(r.currency)}.`,
          r.packet_id ? `The receipt is now in decision packet <a href="${base}/agent/decision-packet/${esc(r.packet_id)}.pdf">${esc(r.packet_id)}</a>.` : 'The receipt is now in this agent token\'s decision packets.',
          'A real purchase is closed by a human: scott@carborundum.ai.']);
      } catch (e) { return send(e.status || 502, { ok: false, error: e.message }); }
    }
    if (p === '/agent/mcp') {
      if (m === 'GET') return send(405, { error: 'POST JSON-RPC to this endpoint (stateless; no SSE stream)' }, 'application/json', { allow: 'POST' });
      if (m !== 'POST') return send(405, { error: 'POST only' });
      const v = tokens.verify(bearer(req));
      if (!v.ok) { audit.log({ route: 'POST /agent/mcp', ok: false, error: v.error }); return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: v.error } }, 'application/json', { 'www-authenticate': 'Bearer' }); }
      const body = await readJson(req); if (body === null) return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      const r = limiter.take('mcp:' + v.principal.tokenId, 60, 6e4); if (!r.ok) return send(429, { jsonrpc: '2.0', id: null, error: { code: -32002, message: 'rate limited' } });
      const msgs = Array.isArray(body) ? body : [body];
      const out = []; for (const msg of msgs) { const o = await mcp(msg, v.principal, base); if (o) out.push(o); }
      audit.log({ route: 'POST /agent/mcp', token_id: v.principal.tokenId, ok: true, methods: msgs.map((x) => x && (x.method === 'tools/call' ? 'call:' + (x.params && x.params.name) : x.method)).join(',').slice(0, 120) });
      if (!out.length) return send(202, '', 'text/plain');
      return send(200, Array.isArray(body) ? out : out[0]);
    }
    return send(404, { ok: false, error: 'not found', see: `${base}/agent` });
  }

  return { handle, tokens, state, runs, checkoutEnabled: checkout.enabled };
}

module.exports = { createAgentApi };
