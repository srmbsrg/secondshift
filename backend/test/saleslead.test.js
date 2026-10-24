'use strict';
// Demo-line caller -> Carborundum sales lead in Silicon (flag SILICON_SALES_LEADS, default OFF).
const test = require('node:test');
const assert = require('node:assert');
const { createSiliconClient, salesLeadPayload } = require('../src/integrations/silicon');
const sessionMod = require('../src/call/session');
const CallSession = sessionMod.CallSession || sessionMod;

test('saleslead: payload keys on caller ID, null for sim/anonymous ids', () => {
  const p = salesLeadPayload({ callSid: 'CA1', from: '+18328458515', outcome: 'booked', slots: { name: 'Jordan', issue: 'AC out' } });
  assert.strictEqual(p.event, 'call');
  assert.strictEqual(p.externalRef, 'secondshift:CA1:saleslead');
  assert.strictEqual(p.lead.phone, '+18328458515');
  assert.strictEqual(p.lead.source, 'secondshift-demo-line');
  assert.match(p.text, /demo line/);
  assert.match(p.text, /AC out/);
  assert.strictEqual(salesLeadPayload({ callSid: 'CA2', from: 'anonymous' }), null);
});

test('saleslead: client posts to the Silicon sales endpoint', async () => {
  const calls = [];
  const c = createSiliconClient({ url: 'https://sil.example/', token: 't', retries: 1, fetchImpl: async (u, o) => { calls.push([u, JSON.parse(o.body)]); return { ok: true, status: 201, json: async () => ({ ok: true, created: true }) }; } });
  await c.postSalesLead({ externalRef: 'x', event: 'call', lead: { phone: '8328458515' } });
  assert.strictEqual(calls[0][0], 'https://sil.example/api/integrations/sales/leads');
});

function fakeSession({ from, tenant = 'carborundum', on = true, sid = 'CA9' }) {
  const posted = [];
  const silicon = { postSalesLead: async p => { posted.push(p); return { ok: true }; }, enqueue() {} };
  return { posted, self: { callSid: sid, from, tenant: { id: tenant }, deps: { silicon, siliconSalesLeads: on, salesLeadTenants: new Set(['carborundum']) } } };
}
const run = (f, rec = { outcome: 'callback', slots: {} }) => CallSession.prototype._postSalesLead.call(f.self, rec);

test('saleslead: real caller on the demo line is posted', async () => {
  const f = fakeSession({ from: '+18328458515' }); await run(f);
  assert.strictEqual(f.posted.length, 1);
});
test("saleslead: Scott's phone, sim calls, other shops' lines and flag-off are never posted", async () => {
  for (const f of [fakeSession({ from: '+19034747930' }), fakeSession({ from: '+18328458515', sid: 'CApilotselftest1' }),
    fakeSession({ from: '+18328458515', tenant: 'joes-hvac' }), fakeSession({ from: '+18328458515', on: false })]) {
    await run(f); assert.strictEqual(f.posted.length, 0);
  }
});
