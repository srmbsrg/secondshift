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
  r = await a.onUtterance('1412 Willow Bend Drive in Spring.'); assert.match(r.say, /When/); // caller ID is the callback number: not asked
  r = await a.onUtterance('Tomorrow morning if you can.'); assert.match(r.say, /tomorrow, Tuesday, October 13 at 8 AM, and we’ll call you at the number you’re calling from\. Does that work\?/);
  r = await a.onUtterance('Yes, that works.'); assert.equal(r.end, 'hangup'); assert.match(r.say, /all set/);
  assert.equal(sch.booked.length, 1);
  const b = sch.booked[0];
  assert.deepEqual([b.name, b.address, b.phone], ['Jordan Avery', '1412 Willow Bend Drive in Spring', '7135550148']);
  assert.equal(a.outcome, 'booked');
});

test('agent: rejecting the slot re-asks and books a later one', async () => {
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+17135550148', scheduler: sch, now: () => NOW });
  for (const u of ['my water heater is leaking', 'Sam Lee', '22 Oak Street', 'tomorrow morning']) await a.onUtterance(u);
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
  for (const u of ['Pat Kim', '9 Elm Court']) r = await a.onUtterance(u);
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

test('llm: anthropic provider speaks the Messages API and falls back to null on errors', async () => {
  const http = require('http');
  const { createLlm } = require('../src/brain/llm');
  let seen = null, mode = 'ok';
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      seen = { path: req.url, key: req.headers['x-api-key'], ver: req.headers['anthropic-version'], body: JSON.parse(b) };
      if (mode === 'err') { res.writeHead(529); return res.end('{}'); }
      if (mode === 'slow') return setTimeout(() => res.end('{}'), 500);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: '{"name":"Scott Murphy","when":"tomorrow"}' }] }));
    });
  });
  await new Promise(r => srv.listen(0, r));
  const llm = createLlm({ provider: 'anthropic', apiKey: 'test-key', baseUrl: `http://127.0.0.1:${srv.address().port}`, timeoutMs: 200 });
  assert.equal(llm.model, 'claude-haiku-5-5');
  assert.deepEqual(await llm.json('sys', 'user'), { name: 'Scott Murphy', when: 'tomorrow' });
  assert.deepEqual([seen.path, seen.key, seen.ver, seen.body.system, seen.body.messages[0].content], ['/v1/messages', 'test-key', '2023-06-01', 'sys', 'user']);
  mode = 'err'; assert.equal(await llm.json('s', 'u'), null);
  mode = 'slow'; assert.equal(await llm.json('s', 'u'), null);
  srv.close();
  assert.equal(createLlm({ provider: 'anthropic', apiKey: '' }), null); // no key -> rules only
});

test('agent + model: one-breath voicemail-style message -> only the missing question, then books', async () => {
  // Stands in for Claude's reply to the first utterance; the grounding guard still checks it.
  const llm = { async json(sys, user) {
    if (/22 Oak/.test(user)) return { address: '22 Oak Street', yes: false };
    if (/kitchen sink/.test(user)) return { issue: 'kitchen sink is backed up', name: 'Scott Murphy', phone: '9034747930', when: 'tomorrow morning' };
    return {};
  } };
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+19034747930', scheduler: sch, now: () => NOW, llm });
  let r = await a.onUtterance("Yeah hi, uh, so my kitchen sink is backed up, it's been like that since last night, I'm Scott Murphy, you can reach me at 903 474 7930, tomorrow morning would be great if somebody could come out.");
  assert.match(r.say, /address/);
  r = await a.onUtterance("It's 22 Oak Street in Tyler, the blue house.");
  assert.match(r.say, /tomorrow, Tuesday, October 13 at 8 AM/);
  r = await a.onUtterance('Yep, that works.'); assert.equal(a.outcome, 'booked');
  const b = sch.booked[0];
  assert.deepEqual([b.issue, b.name, b.phone, b.address], ['Kitchen sink is backed up', 'Scott Murphy', '9034747930', '22 Oak Street']);
});

test('agent: live call 2 replay -> no phone question, address must be real, repeated time = agreement', async () => {
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+19034747930', scheduler: sch, now: () => NOW });
  let r = await a.onUtterance('Yeah. My name is Scott Mercer. We have a backed up toilet.');
  assert.match(r.say, /address/);
  r = await a.onUtterance('Need someone to come out and take a look at it.');
  assert.match(r.say, /street address, with the house number/); // not accepted as an address, no jump to phone
  r = await a.onUtterance('1412');
  assert.match(r.say, /1412 — and what’s the street name/);
  r = await a.onUtterance('Willow Bend Drive.');
  assert.match(r.say, /When would you like/); // caller ID used, phone never asked
  r = await a.onUtterance('Tomorrow morning.');
  assert.match(r.say, /8 AM, and we’ll call you at the number you’re calling from\. Does that work/);
  r = await a.onUtterance('Tomorrow morning.');
  assert.match(r.say, /Great — that’s Tuesday, October 13 at 8 AM\. Shall I book it/);
  r = await a.onUtterance('Yes.'); assert.equal(a.outcome, 'booked');
  assert.deepEqual([sch.booked[0].address, sch.booked[0].phone], ['1412 Willow Bend Drive', '9034747930']);
});

test('agent: a different number said at the offer replaces the caller ID', async () => {
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+19034747930', scheduler: sch, now: () => NOW });
  for (const u of ['my dryer vent is clogged', 'Ana Ruiz', '7 Pine Lane', 'tomorrow morning']) await a.onUtterance(u);
  const r = await a.onUtterance('call my cell instead, 832 555 0199');
  assert.match(r.say, /Got it, I’ll use that number\..*Does that work/);
  assert.ok(!/number you’re calling from/.test(r.say));
  await a.onUtterance('yes'); assert.equal(sch.booked[0].phone, '8325550199');
});

test('stt: a pause mid-thought does not end the turn; finished sentence does', async () => {
  const { openDeepgramStream, UNFINISHED } = require('../src/brain/stt-deepgram');
  assert.ok(UNFINISHED.test('my address is 1412')); assert.ok(UNFINISHED.test('the toilet and')); assert.ok(!UNFINISHED.test('We have a backed up toilet.'));
  let sock = null;
  const Real = global.WebSocket;
  global.WebSocket = class { constructor() { sock = this; this.l = {}; } addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); } send() {} close() {} };
  try {
    const stt = openDeepgramStream({ apiKey: 'k', holdMs: 120, unfinishedHoldMs: 400 });
    const got = []; stt.on('utterance', t => got.push(t));
    const fire = m => sock.l.message.forEach(f => f({ data: JSON.stringify(m) }));
    const res = (text, fin, sf) => fire({ type: 'Results', is_final: fin, speech_final: sf, channel: { alternatives: [{ transcript: text }] } });
    sock.l.open.forEach(f => f());
    res('My name is Scott. We have a backed up toilet.', true, true);
    await new Promise(r => setTimeout(r, 60)); res('need someone', false, false); // keeps talking inside the hold
    res('Need someone to come out.', true, true);
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(got, ['My name is Scott. We have a backed up toilet. Need someone to come out.']);
    res('It is 1412', true, true); // unfinished: longer hold
    await new Promise(r => setTimeout(r, 200)); assert.equal(got.length, 1);
    res('Willow Bend Drive.', true, true);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(got[1], 'It is 1412 Willow Bend Drive.');
    sock.l.close.forEach(f => f({ code: 1000 })); // stops the keep-alive timer
  } finally { global.WebSocket = Real; }
});

test('understand + agent: address in pieces, Deepgram "$14.12" house number, street first', async () => {
  const sch = fakeScheduler(tenant);
  const a = new BookingAgent({ tenant, callerNumber: '+19034747930', scheduler: sch, now: () => NOW });
  for (const u of ['my toilet is backed up', 'Scott Murphy']) await a.onUtterance(u);
  let r = await a.onUtterance('Yeah. It is $14.12.'); assert.match(r.say, /1412 — and what’s the street name/);
  r = await a.onUtterance('Willow Bend Drive in Spring.'); assert.match(r.say, /When would you like/);
  assert.equal(a.slots.address, '1412 Willow Bend Drive in Spring');
  const b = new BookingAgent({ tenant, callerNumber: '+19034747930', scheduler: fakeScheduler(tenant), now: () => NOW });
  for (const u of ['my toilet is backed up', 'Scott Murphy']) await b.onUtterance(u);
  r = await b.onUtterance('Willow Bend Drive.'); assert.match(r.say, /house number on Willow Bend Drive/);
  r = await b.onUtterance('1412.'); assert.match(r.say, /When would you like/);
  assert.equal(b.slots.address, '1412 Willow Bend Drive');
});

test('session: caller keeps talking while the reply is being prepared -> reply dropped, both parts one turn', async () => {
  const { EventEmitter } = require('events');
  const fs = require('fs'), os = require('os'), path = require('path');
  const { CallSession } = require('../src/call/session');
  const twilio = require('../src/phone/twilio');
  const conn = new EventEmitter(); const sent = []; conn.send = m => sent.push(JSON.parse(m)); conn.close = () => {};
  const stt = new EventEmitter(); stt.send = () => {}; stt.close = () => {};
  let releaseTts; const slowTts = { speak: async t => { if (/address/.test(t) && !releaseTts) await new Promise(r => { releaseTts = r; }); return Buffer.alloc(160, 0xff); } };
  const s = new CallSession({ conn, provider: twilio, tenants: { carborundum: { ...tenant, id: 'carborundum' } }, deps: {
    now: () => NOW, openStt: () => stt, tts: slowTts, calendar: { kind: 't', busy: async () => [], create: async () => ({ id: 'x' }) },
    mailer: { kind: 't', send: async () => {} }, logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cont-')) } });
  conn.emit('message', JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { streamSid: 'MZ1', callSid: 'CA2', customParameters: { tenant: 'carborundum', from: '+19034747930', callSid: 'CA2' } } }));
  await new Promise(r => setTimeout(r, 20));
  conn.emit('message', JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: { name: 'say-1' } })); // greeting heard
  stt.emit('utterance', 'Yeah. My name is Scott Murphy. We have a backed up toilet.');
  await new Promise(r => setTimeout(r, 20));
  stt.emit('speech-words', 'need someone to come'); // caller continues while the address question is being synthesized
  releaseTts();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!s.transcript.some(l => l.who === 'agent' && /address/.test(l.text)), 'address question must not be played over the caller');
  stt.emit('utterance', 'Need someone to come out and take a look at it.');
  await new Promise(r => setTimeout(r, 50));
  const callerLines = s.transcript.filter(l => l.who === 'caller').map(l => l.text);
  assert.deepEqual(callerLines, ['Yeah. My name is Scott Murphy. We have a backed up toilet. Need someone to come out and take a look at it.']);
  assert.match(s.transcript[s.transcript.length - 1].text, /address/);
  assert.equal(s.agent.slots.name, 'Scott Murphy');
  conn.emit('close');
});

test('understand: a model-proposed time must be grounded in what the caller said', async () => {
  const { understand } = require('../src/brain/understand');
  const llm = { async json() { return { when: 'as soon as possible', issue: 'toilet backed up' }; } };
  const u = await understand('Need someone to come out and take a look at it.', 'address', { now: NOW, tz: TZ, emergencyKeywords: [], llm });
  assert.equal(u.when, undefined);
  const v = await understand('could somebody come as soon as possible', 'when', { now: NOW, tz: TZ, emergencyKeywords: [], llm });
  assert.equal(v.when.asap, true);
});

test('understand: house numbers spoken as words', async () => {
  const { understand } = require('../src/brain/understand');
  const ctx = { now: NOW, tz: TZ, emergencyKeywords: [] };
  assert.equal((await understand('Yeah. It is fourteen twelve.', 'address', ctx)).houseNumber, '1412');
  assert.equal((await understand('one oh five Main Street', 'address', ctx)).address, '105 Main Street');
  assert.equal((await understand('twenty two Oak Street in Tyler', 'address', ctx)).address, '22 Oak Street in Tyler');
  assert.equal((await understand('Need someone to come out and take a look at it.', 'address', ctx)).address, undefined);
});

test('agent: the town arriving as its own fragment joins the address', async () => {
  for (const [addr, frag, want] of [['1412 Willow Bend Drive', 'In Spring.', '1412 Willow Bend Drive in Spring'], ['1412 Willow Bend Drive in', 'Spring.', '1412 Willow Bend Drive in Spring']]) {
    const a = new BookingAgent({ tenant, callerNumber: '+19034747930', scheduler: fakeScheduler(tenant), now: () => NOW });
    for (const u of ['my toilet is backed up', 'Scott Murphy', addr]) await a.onUtterance(u);
    const r = await a.onUtterance(frag);
    assert.match(r.say, /When would you like/); assert.equal(a.slots.address, want);
  }
});
