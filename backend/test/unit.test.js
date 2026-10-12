'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseWhen, zoned, localParts } = require('../src/brain/time');
const { findSlot } = require('../src/booking/slots');
const { BookingAgent } = require('../src/brain/agent');
const { lintTenant } = require('../src/config');
const tenant = require('../tenants/carborundum.json');

const TZ = 'America/Chicago';
// Monday 2026-10-12, 9:30 PM Central — the classic after-hours call.
const NOW = zoned(2026, 9, 12, 21, 30, TZ);

test('time: tomorrow morning -> Tue 8:00-12:00 Central', () => {
  const w = parseWhen('tomorrow morning if you can', NOW, TZ);
  const s = localParts(w.start, TZ), e = localParts(w.end, TZ);
  assert.deepEqual([s.d, s.h, e.h], [13, 8, 12]);
});
test('time: "Thursday at 2" -> Thu 14:00', () => {
  const w = parseWhen('can you do Thursday at 2', NOW, TZ); const s = localParts(w.start, TZ);
  assert.deepEqual([s.d, s.h], [15, 14]);
});
test('time: ASAP and nothing-said', () => {
  assert.equal(parseWhen('as soon as possible please', NOW, TZ).asap, true);
  assert.equal(parseWhen('my name is Jordan', NOW, TZ), null);
});

test('slots: skips busy blocks and honours business hours', () => {
  const pref = parseWhen('tomorrow morning', NOW, TZ);
  const busy = [{ start: zoned(2026, 9, 13, 8, 0, TZ), end: zoned(2026, 9, 13, 10, 0, TZ) }];
  const s = findSlot({ now: NOW, tz: TZ, hours: tenant.hours, slotMinutes: 120, leadMinutes: 60, busy, pref });
  assert.equal(localParts(s.start, TZ).h, 10); assert.equal(s.matchedPreference, true);
});
test('slots: Saturday closes at noon, Sunday closed', () => {
  const sat = zoned(2026, 9, 17, 11, 30, TZ); // Sat 11:30 -> next slot is Monday 8:00
  const s = findSlot({ now: sat, tz: TZ, hours: tenant.hours, slotMinutes: 120, leadMinutes: 60, busy: [], pref: null });
  const p = localParts(s.start, TZ); assert.deepEqual([p.d, p.h], [19, 8]);
});

function fakeScheduler(t) {
  const booked = [];
  return {
    booked,
    // Mirrors src/booking/scheduler.js: a rejected slot's end is a floor, never earlier than the new preference.
    async findSlot(pref, excludeBefore) {
      let p = pref && pref.asap ? null : pref;
      if (excludeBefore) p = { ...(p || {}), start: new Date(Math.max(excludeBefore.getTime(), p && p.start ? p.start.getTime() : 0)), end: p ? p.end : null };
      return findSlot({ now: NOW, tz: TZ, hours: t.hours, slotMinutes: 120, leadMinutes: 60, busy: [], pref: p });
    },
    async book(d) { booked.push(d); return { id: 'x', when: 'w', calendar: 'test' }; },
  };
}

test('agent: full booking conversation (rules only, no LLM)', async () => {
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+17135550148', scheduler: sch, now: () => NOW });
  assert.match(a.greeting(), /Carborundum.*recorded.*automated assistant/);
  let r = await a.onUtterance('Hi, my air conditioner stopped working and it is really hot in here.');
  assert.match(r.say, /name/);
  r = await a.onUtterance('Jordan Avery.'); assert.match(r.say, /address/);
  r = await a.onUtterance('1412 Willow Bend Drive in Spring.'); assert.match(r.say, /7 1 3, 5 5 5, 0 1 4 8/);
  r = await a.onUtterance("Yes, that's the best number."); assert.match(r.say, /When/);
  r = await a.onUtterance('Tomorrow morning if you can.'); assert.match(r.say, /tomorrow, Tuesday, October 13 at 8 AM\. Does that work\?/);
  r = await a.onUtterance('Yes, that works.'); assert.equal(r.end, 'hangup'); assert.match(r.say, /all set/);
  assert.equal(sch.booked.length, 1);
  const b = sch.booked[0];
  assert.deepEqual([b.name, b.address, b.phone], ['Jordan Avery', '1412 Willow Bend Drive in Spring', '7135550148']);
  assert.equal(a.outcome, 'booked');
});

test('agent: rejecting the slot re-asks and books a later one', async () => {
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+17135550148', scheduler: sch, now: () => NOW });
  for (const u of ['my water heater is leaking', 'Sam Lee', '22 Oak Street', 'yes', 'tomorrow morning']) await a.onUtterance(u);
  let r = await a.onUtterance('no, that does not work'); assert.match(r.say, /work better/);
  r = await a.onUtterance('Wednesday afternoon'); assert.match(r.say, /Wednesday, October 14 at 12 PM/);
  r = await a.onUtterance('yes'); assert.equal(a.outcome, 'booked');
});

test('agent: emergency with a transfer number -> transfer', async () => {
  const t = { ...tenant, emergency: { ...tenant.emergency, transferNumber: '+18325550123' } };
  const a = new BookingAgent({ tenant: t, callerNumber: '+17135550148', scheduler: fakeScheduler(t), now: () => NOW });
  const r = await a.onUtterance('I smell gas in the kitchen');
  assert.equal(r.end, 'transfer'); assert.match(r.say, /connecting you/); assert.equal(a.emergency.reason, 'smell gas');
});

test('agent: emergency with NO transfer number -> earliest slot, flagged urgent', async () => {
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+17135550148', scheduler: sch, now: () => NOW });
  let r = await a.onUtterance('there is a burst pipe and water everywhere');
  assert.ok(!r.end); assert.match(r.say, /name/);
  for (const u of ['Pat Kim', '9 Elm Court', 'yes']) r = await a.onUtterance(u);
  assert.match(r.say, /tomorrow, Tuesday, October 13 at 8 AM/); // no "when" question: ASAP
  r = await a.onUtterance('yes please'); assert.equal(a.outcome, 'booked'); assert.ok(sch.booked[0].emergency);
});

test('config: disclosure lint', () => {
  assert.deepEqual(lintTenant(tenant), []);
  assert.ok(lintTenant({ ...tenant, disclosure: 'Hi, how can I help?' }).length >= 2);
  assert.ok(lintTenant({ ...tenant, disclosure: 'Thanks for calling {shop}, an automated assistant here.' }).some(e => /recorded/.test(e)));
});

test('understand: model output must be grounded in what the caller said', async () => {
  const { understand } = require('../src/brain/understand');
  const echoLlm = { async json() { return { name: "caller's name", address: 'their preferred day/time', issue: 'what is wrong' }; } };
  const u = await understand('my AC stopped working', 'issue', { now: NOW, tz: TZ, emergencyKeywords: [], llm: echoLlm });
  assert.equal(u.name, undefined); assert.equal(u.address, undefined);
  const goodLlm = { async json() { return { name: 'Jordan Avery', address: '1412 Willow Bend' }; } };
  const v = await understand('this is Jordan Avery at 1412 Willow Bend, my AC is out', 'issue', { now: NOW, tz: TZ, emergencyKeywords: [], llm: goodLlm });
  assert.equal(v.name, 'Jordan Avery'); assert.equal(v.address, '1412 Willow Bend');
});

test('agent: voicemail-style first sentence (live pilot call 1) keeps name, number and day', async () => {
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+19034747930', scheduler: sch, now: () => NOW });
  let r = await a.onUtterance('I need a plumber out here tomorrow. Phone number is (903) 474-7930. My name is Scott Murphy. Please call me at your earliest convenience. Thank you.');
  assert.match(r.say, /Thanks, Scott\. What’s the address/);
  r = await a.onUtterance('22 Oak Street in Tyler.');
  assert.match(r.say, /tomorrow, Tuesday, October 13 at 8 AM/); // no name, number or day questions
  r = await a.onUtterance('yes'); assert.equal(a.outcome, 'booked');
  assert.deepEqual([sch.booked[0].name, sch.booked[0].phone], ['Scott Murphy', '9034747930']);
});

test('session: caller hangs up while the agent is talking -> call log + owner email still written', async () => {
  const { EventEmitter } = require('events');
  const fs = require('fs'), os = require('os'), path = require('path');
  const { CallSession } = require('../src/call/session');
  const twilio = require('../src/phone/twilio');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sess-'));
  const conn = new EventEmitter(); conn.send = () => {}; conn.close = () => {};
  const stt = new EventEmitter(); stt.send = () => {}; stt.close = () => {};
  const mails = []; let rec = null;
  new CallSession({ conn, provider: twilio, tenants: { carborundum: { ...tenant, id: 'carborundum' } }, deps: {
    now: () => NOW, openStt: () => stt, tts: { speak: async () => Buffer.alloc(160, 0xff) },
    calendar: { kind: 'test', busy: async () => [], create: async () => ({ id: 'x' }) },
    mailer: { kind: 'test', send: async m => { mails.push(m); } }, logDir: dir, onRecord: r => { rec = r; } } });
  conn.emit('message', JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { tenant: 'carborundum', from: '+19034747930', callSid: 'CA1' } } }));
  await new Promise(r => setTimeout(r, 20));
  stt.emit('utterance', 'my furnace is making a loud banging noise'); // agent replies, no playback mark ever comes back
  await new Promise(r => setTimeout(r, 20));
  conn.emit('error', new Error('read ECONNRESET')); conn.emit('close');
  for (let i = 0; i < 100 && !rec; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(rec, 'call record written'); assert.equal(rec.transcript.filter(l => l.who === 'caller').length, 1);
  assert.ok(fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').includes('furnace'));
  assert.equal(mails.length, 1);
});
