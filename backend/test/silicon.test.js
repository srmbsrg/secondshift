'use strict';
// SecondShift -> Silicon integration: idempotent post, retries, standalone fallback, outbox, switch.
//   node --test test/silicon.test.js
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createSiliconClient, siliconCalendar, callSummaryText } = require('../src/integrations/silicon');
const { siliconSettings } = require('../src/config');
const { createScheduler } = require('../src/booking/scheduler');
const { fileCalendar } = require('../src/booking/calendar');
const tenant = require('../tenants/carborundum.json');

/** A tiny in-memory Silicon: same idempotency rule as the real route (one job per externalRef). */
function fakeSilicon({ failTimes = 0, status = 500, disabled = false } = {}) {
  const jobs = new Map(); const calls = [];
  let fails = failTimes;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
    const res = (code, j) => ({ ok: code < 400, status: code, json: async () => j });
    if (init.headers.authorization !== 'Bearer tok') return res(401, { ok: false, error: 'unauthorized' });
    if (disabled) return res(403, { ok: false, error: 'off', disabled: true });
    if (fails > 0) { fails--; return res(status, { ok: false, error: 'boom' }); }
    if (url.includes('/availability')) return res(200, { ok: true, busy: [{ start: '2026-10-20T13:00:00Z', end: '2026-10-20T15:00:00Z' }] });
    const b = calls[calls.length - 1].body;
    const existing = jobs.get(b.externalRef);
    if (existing) { Object.assign(existing, { callSummary: b.call && b.call.summary, callTranscript: b.call && b.call.transcript }); return res(200, { ok: true, created: false, job: existing }); }
    const job = { id: 'job' + (jobs.size + 1), jobNumber: 'J-' + (jobs.size + 1), externalRef: b.externalRef, scheduledFor: b.scheduledFor, customerName: b.customer.name };
    jobs.set(b.externalRef, job);
    return res(201, { ok: true, created: true, job });
  };
  return { jobs, calls, fetchImpl };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-silicon-'));
const ev = (callSid = 'CA1') => ({
  summary: 'x', description: 'Booked by SecondShift', location: '1 Main', start: new Date('2026-10-20T14:00:00Z'), end: new Date('2026-10-20T16:00:00Z'),
  data: { name: 'Jordan Avery', phone: '7135550148', address: '1 Main', issue: 'AC out' }, callSid, callerNumber: '+17135550148',
});

test('switch: integrated mode is OFF unless turned on (standalone by default)', () => {
  assert.equal(siliconSettings(tenant, {}).post_to_silicon, false);
  assert.equal(siliconSettings({ integrations: { silicon: { post_to_silicon: true, url: 'https://s' } } }, {}).post_to_silicon, true);
  assert.equal(siliconSettings({ integrations: { silicon: { post_to_silicon: true } } }, { SECONDSHIFT_POST_TO_SILICON: 'false' }).post_to_silicon, false, 'env wins');
  assert.equal(siliconSettings(tenant, { SECONDSHIFT_POST_TO_SILICON: 'true', SILICON_URL: 'https://s' }).url, 'https://s');
});

test('booking creates exactly one Silicon job; retries of the same call never double-book', async () => {
  const s = fakeSilicon();
  const client = createSiliconClient({ url: 'https://silicon.test/', token: 'tok', fetchImpl: s.fetchImpl, backoffMs: 1 });
  const cal = siliconCalendar({ client, fallback: fileCalendar({ file: path.join(tmp(), 'cal.json') }), tenant });
  const a = await cal.create(ev('CAsame'));
  const b = await cal.create(ev('CAsame'));
  assert.equal(s.jobs.size, 1);
  assert.equal(a.id, b.id);
  assert.equal(a.calendarKind, 'silicon');
  const body = s.calls[0].body;
  assert.equal(body.externalRef, 'secondshift:CAsame');
  assert.equal(body.customer.phone, '7135550148');
  assert.equal(body.durationMinutes, 120);
  assert.equal(s.calls[0].url, 'https://silicon.test/api/integrations/secondshift/jobs');
});

test('transient Silicon errors are retried', async () => {
  const s = fakeSilicon({ failTimes: 2, status: 503 });
  const client = createSiliconClient({ url: 'https://silicon.test', token: 'tok', fetchImpl: s.fetchImpl, backoffMs: 1 });
  const r = await client.postJob({ externalRef: 'secondshift:CAr', customer: { name: 'A' } });
  assert.equal(r.created, true);
  assert.equal(s.calls.length, 3);
});

test('Silicon down: the call is still booked locally and the post is queued, then delivered once', async () => {
  const dir = tmp();
  const s = fakeSilicon({ failTimes: 3, status: 502 });
  const client = createSiliconClient({ url: 'https://silicon.test', token: 'tok', fetchImpl: s.fetchImpl, backoffMs: 1, outboxFile: path.join(dir, 'outbox.jsonl') });
  const cal = siliconCalendar({ client, fallback: fileCalendar({ file: path.join(dir, 'cal.json') }), tenant });
  const r = await cal.create(ev('CAdown'));
  assert.equal(r.calendarKind, 'file');
  assert.equal(r.siliconQueued, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cal.json'), 'utf8')).length, 1, 'booked in the local calendar');
  assert.equal(s.jobs.size, 0);
  const f = await client.flushOutbox();
  assert.deepEqual(f, { sent: 1, kept: 0 });
  assert.equal(s.jobs.size, 1);
  assert.equal((await client.flushOutbox()).sent, 0, 'outbox empties after delivery');
});

test('integration switched off in Silicon: book locally, do NOT queue (standalone)', async () => {
  const dir = tmp();
  const s = fakeSilicon({ disabled: true });
  const client = createSiliconClient({ url: 'https://silicon.test', token: 'tok', fetchImpl: s.fetchImpl, backoffMs: 1, outboxFile: path.join(dir, 'outbox.jsonl') });
  const cal = siliconCalendar({ client, fallback: fileCalendar({ file: path.join(dir, 'cal.json') }), tenant });
  const r = await cal.create(ev('CAoff'));
  assert.equal(r.calendarKind, 'file');
  assert.equal(fs.existsSync(path.join(dir, 'outbox.jsonl')), false);
  assert.equal(s.calls.length, 1, '403 is not retried');
});

test('availability comes from Silicon; falls back to the own calendar if Silicon is unreachable', async () => {
  const ok = createSiliconClient({ url: 'https://s', token: 'tok', fetchImpl: fakeSilicon().fetchImpl });
  const fb = { kind: 'file', busy: async () => [{ start: new Date(0), end: new Date(1) }], create: async () => ({}) };
  const busy = await siliconCalendar({ client: ok, fallback: fb, tenant }).busy(new Date(), new Date(Date.now() + 86400000));
  assert.equal(busy[0].start.toISOString(), '2026-10-20T13:00:00.000Z');
  const bad = createSiliconClient({ url: 'https://s', token: 'wrong', fetchImpl: fakeSilicon().fetchImpl, backoffMs: 1 });
  const fbBusy = await siliconCalendar({ client: bad, fallback: fb, tenant }).busy(new Date(), new Date());
  assert.equal(fbBusy[0].end.getTime(), 1);
});

test('scheduler hands the structured booking + call id to the calendar', async () => {
  let seen;
  const cal = { kind: 'silicon', busy: async () => [], create: async e => { seen = e; return { id: 'j1', calendarKind: 'silicon' }; } };
  const sch = createScheduler({ tenant, calendar: cal, callerNumber: '+17135550148', callSid: 'CAx' });
  const r = await sch.book({ name: 'A', phone: '7135550148', address: '1 Main', issue: 'leak', slot: { start: new Date('2026-10-20T14:00:00Z'), end: new Date('2026-10-20T16:00:00Z') } });
  assert.equal(seen.callSid, 'CAx');
  assert.equal(seen.data.issue, 'leak');
  assert.equal(r.calendar, 'silicon');
});

test('call summary text is plain English with the key facts', () => {
  const t = callSummaryText({ slots: { name: 'Jordan', phone: '7135550148', address: '1 Main', issue: 'AC out' }, outcome: 'booked', emergency: null });
  assert.match(t, /Booked by SecondShift/); assert.match(t, /Jordan/); assert.match(t, /AC out/);
});

// -- Follow-ups (callbacks / hang-ups -> Silicon follow-up list) --
const { followUpPayload } = require('../src/integrations/silicon');

test('follow-ups flag is OFF by default, and needs integrated mode', () => {
  assert.equal(siliconSettings(tenant, {}).post_followups, false);
  assert.equal(siliconSettings(tenant, { SECONDSHIFT_POST_TO_SILICON: 'true' }).post_followups, false, 'integrated alone does not turn follow-ups on');
  assert.equal(siliconSettings(tenant, { SECONDSHIFT_POST_TO_SILICON: 'true', SECONDSHIFT_POST_FOLLOWUPS: 'true' }).post_followups, true);
  assert.equal(siliconSettings(tenant, { SECONDSHIFT_POST_FOLLOWUPS: 'true' }).post_followups, false, 'standalone: nothing to post to');
});

test('only callbacks and hang-ups become follow-ups (never booked calls or emergency transfers)', () => {
  const base = { callSid: 'CAf', tenantId: 'carborundum', from: '+17135550148', slots: { name: 'Pat', issue: 'no heat' } };
  assert.equal(followUpPayload({ ...base, outcome: 'booked' }), null);
  assert.equal(followUpPayload({ ...base, outcome: 'transfer' }), null);
  const cb = followUpPayload({ ...base, outcome: 'callback' });
  assert.equal(cb.kind, 'callback'); assert.equal(cb.externalRef, 'secondshift:CAf:followup');
  assert.equal(cb.customer.phone, '+17135550148', 'falls back to caller ID'); assert.equal(cb.reason, 'no heat');
  assert.equal(followUpPayload({ ...base, outcome: 'in-progress' }).kind, 'hangup');
});

test('follow-up posts go to the follow-ups endpoint; queued ones are retried to the same endpoint', async () => {
  const calls = []; let down = true;
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (down) return { ok: false, status: 503, json: async () => ({ ok: false, error: 'down' }) };
    return { ok: true, status: 201, json: async () => ({ ok: true, created: true, followUp: { id: 'f1' } }) };
  };
  const outboxFile = path.join(tmp(), 'outbox.jsonl');
  const client = createSiliconClient({ url: 'https://silicon.test', token: 'tok', fetchImpl, backoffMs: 1, retries: 1, outboxFile });
  const payload = followUpPayload({ callSid: 'CAq', tenantId: 'carborundum', from: '+1', outcome: 'callback', slots: {} });
  await assert.rejects(client.postFollowUp(payload));
  client.enqueue(payload, 'down', 'followup');
  down = false;
  const r = await client.flushOutbox();
  assert.deepEqual(r, { sent: 1, kept: 0 });
  assert.ok(calls.every(u => u === 'https://silicon.test/api/integrations/secondshift/followups'));
});
