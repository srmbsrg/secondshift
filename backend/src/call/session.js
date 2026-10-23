'use strict';
// Live console trace for pilot calls (SECONDSHIFT_VERBOSE=1). Same content as the transcript log.
const live = (sid, type, data) => { if (process.env.SECONDSHIFT_VERBOSE) console.log(`[call ${String(sid || '').slice(-6)}] ${type}${data === undefined ? '' : ' ' + (typeof data === 'string' ? data : JSON.stringify(data))}`); };
// Telegram alert text.
const clock = (d, tz) => new Date(d).toLocaleString('en-US', { timeZone: tz || 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
function callSummary(rec, tenant) {
  const s = rec.slots || {};
  const outcome = rec.outcome === 'booked' ? `✅ Booked: ${rec.booking && rec.booking.when}`
    : rec.outcome === 'transfer' ? '🚨 EMERGENCY — transferred to on-call'
    : rec.outcome === 'callback' ? '↩️ Needs a callback'
    : '↩️ Caller hung up before booking — left details, needs a callback';
  const secs = Math.round((new Date(rec.endedAt) - new Date(rec.startedAt)) / 1000);
  return [`☎️ SecondShift call ended (${secs}s) — ${tenant.shopName}`, outcome,
    `Caller: ${s.name || 'not given'} · ${s.phone || rec.from || 'unknown'}`,
    s.address ? `Address: ${s.address}` : null,
    `Problem: ${s.issue || 'not stated'}`,
    rec.emergency ? `Emergency: ${rec.emergency.reason}` : null].filter(Boolean).join('\n');
}
// One live phone call: carrier media stream <-> Deepgram STT -> BookingAgent -> Deepgram TTS.
// Phone manners from Tiny Paws: the disclosure greeting is pre-rendered so the first word is
// immediate, and if the caller starts talking while we're speaking we stop (barge-in / "clear").
const fs = require('fs'), path = require('path');
const { BookingAgent } = require('../brain/agent');
const { createScheduler } = require('../booking/scheduler');
const { encodeWavMulaw } = require('./wav');
const { callSummaryText, followUpPayload } = require('../integrations/silicon');

class CallSession {
  /**
   * @param {object} o conn (ws), provider (twilio adapter), tenants, deps {tts, openStt, calendar, mailer, llm, logDir, now},
   *                   onEnd(callSid, endAction)
   */
  constructor(o) {
    Object.assign(this, { conn: o.conn, provider: o.provider, tenants: o.tenants, deps: o.deps, onEnd: o.onEnd || (() => {}) });
    this.transcript = []; this.queue = Promise.resolve(); this.markSeq = 0; this.speaking = null;
    this.endAction = null; this.closed = false; this.startedAt = new Date(); this.audioIn = [];
    this.conn.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } const ev = this.provider.parse(m); if (ev) this._on(ev); });
    this.conn.on('close', () => this._finish('ws-closed'));
    this.conn.on('error', e => this._log('error', 'ws: ' + (e && e.message)));
  }

  _send(msgs) { for (const m of msgs) this.conn.send(JSON.stringify(m)); }

  _on(ev) {
    if (ev.type === 'start') return this._start(ev);
    if (ev.type === 'audio') { if (this.stt) this.stt.send(ev.mulaw); if (this.tenant && this.tenant.recording && this.tenant.recording.storeAudio) this.audioIn.push(ev.mulaw); return; }
    if (ev.type === 'played') { if (this.speaking && ev.name === this.speaking.mark) { const s = this.speaking; this.speaking = null; s.done(); } return; }
    if (ev.type === 'stop') return this._finish('carrier-stop');
  }

  async _start(ev) {
    this.callSid = ev.params.callSid || ev.callId; this.streamSid = ev.streamId;
    this.tenant = this.tenants[ev.params.tenant] || Object.values(this.tenants)[0];
    this.from = ev.params.from || '';
    const now = this.deps.now || (() => new Date());
    this.agent = new BookingAgent({
      tenant: this.tenant, callerNumber: this.from, llm: this.deps.llm, now,
      scheduler: createScheduler({ tenant: this.tenant, calendar: this.deps.calendar, now, callerNumber: this.from, callSid: this.callSid }),
    });
    this.stt = this.deps.openStt({ model: (this.tenant.voice && this.tenant.voice.sttModel) || undefined });
    // Barge-in only on real words (2+), not on raw voice activity: line noise, breathing or an
    // "mm-hm" used to cut the agent off mid-question (live call 2), leaving the caller confused.
    this.wordsSeq = 0;
    this.stt.on('speech-words', words => {
      this.wordsSeq++;
      if (this.speaking && words.split(/\s+/).length >= 2) { this._send(this.provider.clear(this.streamSid)); const s = this.speaking; this.speaking = null; s.done({ bargedAfterMs: Date.now() - s.startedAt }); this._log('barge-in', words); }
    });
    this.stt.on('utterance', text => { const seq = this.wordsSeq; this.queue = this.queue.then(() => this._turn(text, seq)).catch(e => this._log('error', e.message)); });
    this.stt.on('error', e => this._log('error', 'stt: ' + (e && e.message)));
    this.maxTimer = setTimeout(() => this._hangup('max-duration'), (this.tenant.maxCallSeconds || 300) * 1000);
    this._log('start', { from: this.from, tenant: this.tenant.id });
    if (this.deps.llm && this.deps.llm.warm) this.deps.llm.warm(); // non-blocking
    this._alert(`📞 SecondShift call in progress — ${this.tenant.shopName} line, from ${this.from || 'unknown number'}, ${clock(this.startedAt, this.tenant.timezone)}`);
    this._setHold();
    await this._say(this.agent.greeting());
  }

  async _turn(text, seqAtUtterance = this.wordsSeq) {
    if (this.closed || this.endAction) return;
    // A held-back first half of this turn (see below) is joined to what the caller said next.
    if (this.carry) {
      text = `${this.carry} ${text}`; this.carry = null;
      const t = this.transcript;
      while (t.length && t[t.length - 1].cut) t.pop();           // our reply that was cut off at once
      if (t.length && t[t.length - 1].who === 'caller') t.pop(); // replaced by the merged line below
    }
    this.transcript.push({ at: this._t(), who: 'caller', text }); live(this.callSid, 'caller', text);
    const snap = this.agent.snapshot();
    const t0 = Date.now();
    const r = await this.agent.onUtterance(text);
    this.lastThinkMs = Date.now() - t0;
    // If the caller kept talking while we worked out the reply, they had not finished: drop the
    // reply (never speak over them), undo the step, and treat both parts as one turn (live call 2).
    const stillTalking = () => !r.end && this.wordsSeq !== seqAtUtterance;
    const spoke = r.say ? await this._say(r.say, stillTalking) : true;
    // The caller talking over the first ~2 s of our reply is the same thing one beat later: they
    // had not finished (live sim: "So my kitchen" / "sink is backed up..."). Undo and merge.
    const cutEarly = spoke && spoke.bargedAfterMs !== undefined && spoke.bargedAfterMs < 2000 && !r.end;
    if (spoke === false || cutEarly || (!r.say && stillTalking())) {
      this.agent.restore(snap); this.carry = text;
      if (cutEarly) { const last = this.transcript[this.transcript.length - 1]; if (last && last.who === 'agent') last.cut = true; }
      this._log('continuation', text); return;
    }
    if (r.end) this._hangup(r.end === 'transfer' ? 'transfer' : 'hangup');
    else this._setHold();
  }

  /** Wait after a pause, by what we just asked (ms). A too-early reply is still caught by the merge above. */
  _setHold() {
    const HOLD = { issue: 750, name: 450, address: 1000, readback: 450, phone: 600, when: 500, confirm: 450 };
    if (this.stt && this.stt.setHold) this.stt.setHold(HOLD[this.agent.state] || 1000);
  }

  /** Speak text; resolves when the carrier reports playback finished (mark) or on barge-in. */
  /** Returns false (nothing played) if `abortIf()` turns true before playback starts. */
  async _say(text, abortIf = () => false) {
    if (this.closed) return;
    if (abortIf()) return false;
    let audio; const t1 = Date.now();
    try { audio = await this.deps.tts.speak(text); } catch (e) { this._log('error', 'tts: ' + e.message); return; }
    if (this.closed) return;
    if (abortIf()) return false;
    this.transcript.push({ at: this._t(), who: 'agent', text }); live(this.callSid, 'agent', text);
    this._log('timing', { thinkMs: this.lastThinkMs || 0, ttsMs: Date.now() - t1 }); this.lastThinkMs = 0;
    const mark = `say-${++this.markSeq}`;
    return new Promise(done => {
      this.speaking = { mark, done, startedAt: Date.now() };
      this._send(this.provider.audio(this.streamSid, audio));
      this._send(this.provider.mark(this.streamSid, mark));
    });
  }

  _hangup(action) {
    if (this.endAction) return;
    this.endAction = action;
    // Wait for the goodbye/transfer line to finish playing, then close the stream; the carrier then
    // follows the <Redirect> to /voice/twilio/after, which dials the owner (transfer) or hangs up.
    const close = () => { try { this.conn.close(); } catch {} this._finish(action); };
    if (this.speaking) { const s = this.speaking; this.speaking = { ...s, done: () => { s.done(); close(); } }; } else close();
  }

  /** Fire-and-forget Telegram alert; failures go to the call log, never into the call. */
  _alert(text) {
    const tg = this.deps.telegram; if (!tg) return;
    if (/^CApilotselftest/.test(this.callSid || '')) return; // the pilot harness's own wiring check
    if (process.env.SECONDSHIFT_ALERT_TAG) text = `[${process.env.SECONDSHIFT_ALERT_TAG}] ${text}`;
    tg.send(text).then(() => this._log('alert', 'sent')).catch(e => { this._log('error', 'telegram: ' + e.message); live(this.callSid, 'alert', 'FAILED: ' + e.message); });
  }

  /** Fire-and-forget Slack #agents post for a real (non-test) caller; failures go to the call log. */
  _slack(rec) {
    const sl = this.deps.slack; if (!sl) return;
    if (/^CApilotselftest/.test(this.callSid || '') || !sl.shouldPost(rec.from)) return;
    const text = `:telephone_receiver: *Real inbound call* on the ${this.tenant.shopName} line from ${rec.from}\n`
      + '```' + callSummary(rec, this.tenant) + '```\nFollow up within the hour.';
    sl.send(text).then(() => this._log('slack', 'sent')).catch(e => this._log('error', 'slack: ' + e.message));
  }

  _t() { return Date.now() - this.startedAt.getTime(); }
  _log(type, data) { (this.events || (this.events = [])).push({ at: this._t(), type, data }); live(this.callSid, type, data); }

  async _finish(reason) {
    if (this.closed) return; this.closed = true;
    clearTimeout(this.maxTimer);
    if (this.stt) this.stt.close();
    // Caller hung up mid-sentence: no playback mark will ever arrive, so release the pending line
    // or the turn queue (and with it the call log + owner email) waits forever.
    if (this.speaking) { const sp = this.speaking; this.speaking = null; sp.done(); }
    try { await Promise.race([this.queue, new Promise(r => setTimeout(r, 5000))]); } catch {}
    if (!this.agent) return;
    const sum = this.agent.summary();
    const endAction = this.endAction || 'hangup';
    const transferNumber = this.tenant.emergency && this.tenant.emergency.transferNumber;
    this.onEnd(this.callSid, { action: endAction, transferNumber: endAction === 'transfer' ? transferNumber : null });
    const rec = {
      callSid: this.callSid, tenant: this.tenant.id, from: this.from, startedAt: this.startedAt.toISOString(), endedAt: new Date().toISOString(),
      endReason: reason, endAction, outcome: sum.outcome, slots: sum.slots, emergency: sum.emergency,
      booking: sum.booking ? { id: sum.booking.id, when: sum.booking.when, calendar: sum.booking.calendar, link: sum.booking.link } : null,
      storeAudio: !!(this.tenant.recording && this.tenant.recording.storeAudio),
      transcript: this.tenant.recording && this.tenant.recording.storeTranscript === false ? null : this.transcript,
      events: this.events || [],
    };
    const dir = this.deps.logDir; fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(rec) + '\n');
    if (rec.storeAudio && this.audioIn.length) fs.writeFileSync(path.join(dir, `${this.callSid}-caller.wav`), encodeWavMulaw(Buffer.concat(this.audioIn)));
    live(this.callSid, 'END', { outcome: rec.outcome, endAction, booking: rec.booking && rec.booking.when, calendar: rec.booking && rec.booking.calendar });
    this._alert(callSummary(rec, this.tenant));
    this._slack(rec);
    await this._postToSilicon(rec, sum).catch(e => live(this.callSid, 'silicon', 'FAILED: ' + e.message));
    await this._postFollowUp(rec).catch(e => live(this.callSid, 'silicon-followup', 'FAILED: ' + e.message));
    try { await this._email(rec); live(this.callSid, 'email', 'sent'); } catch (e) { live(this.callSid, 'email', 'FAILED: ' + e.message); fs.appendFileSync(path.join(dir, 'errors.log'), `${new Date().toISOString()} email: ${e.message}\n`); }
    this.record = rec;
    if (this.deps.onRecord) this.deps.onRecord(rec);
  }

  /**
   * Integrated mode only: attach the call summary + transcript to the Silicon job this call booked.
   * Carries the full booking too (same externalRef), so if the booking post was queued during an
   * outage, whichever arrives first creates the complete job and the other just fills it in.
   */
  async _postToSilicon(rec, sum) {
    const silicon = this.deps.silicon;
    if (!silicon || rec.outcome !== 'booked' || !sum.booking || !sum.booking.event) return;
    const ev = sum.booking.event, d = ev.data || {};
    const payload = {
      externalRef: `secondshift:${this.callSid}`,
      tenant: this.tenant.id,
      customer: { name: d.name || null, phone: d.phone || null, address: d.address || null },
      issue: d.issue || null,
      emergency: d.emergency ? { reason: d.emergency.reason } : null,
      scheduledFor: ev.start.toISOString(), durationMinutes: Math.round((ev.end - ev.start) / 60000),
      call: {
        sid: this.callSid, from: this.from, outcome: rec.outcome,
        summary: callSummaryText({ slots: rec.slots, outcome: rec.outcome, emergency: rec.emergency, from: this.from }),
        transcript: rec.transcript ? rec.transcript.map(l => ({ who: l.who, text: l.text })) : undefined,
      },
    };
    try { await silicon.postJob(payload); live(this.callSid, 'silicon', 'call details posted'); }
    catch (e) { if (!e.disabled) silicon.enqueue(payload, e.message); throw e; }
  }

  /**
   * Follow-ups flag only (default OFF): a callback request or a hang-up becomes an item on Silicon's
   * follow-up list (not a job). Telegram/email alerts are unchanged either way.
   */
  async _postFollowUp(rec) {
    const silicon = this.deps.silicon;
    if (!silicon || !this.deps.siliconFollowups) return;
    const payload = followUpPayload({ callSid: this.callSid, tenantId: this.tenant.id, from: this.from, outcome: rec.outcome, slots: rec.slots, emergency: rec.emergency, transcript: rec.transcript });
    if (!payload) return;
    try { await silicon.postFollowUp(payload); live(this.callSid, 'silicon-followup', `${payload.kind} posted`); }
    catch (e) { if (!e.disabled) silicon.enqueue(payload, e.message, 'followup'); throw e; }
  }

  async _email(rec) {
    const to = this.tenant.owner && this.tenant.owner.email;
    if (!to || !this.deps.mailer) return;
    const s = rec.slots || {};
    const head = rec.outcome === 'booked' ? `Booked: ${rec.booking.when}` : rec.outcome === 'transfer' ? 'EMERGENCY — transferred to on-call' : rec.outcome === 'callback' ? 'Needs a callback'
      : 'Caller hung up before booking — left details, needs a callback';
    const subject = `${rec.emergency ? '[URGENT] ' : ''}SecondShift: ${head} — ${s.name || rec.from || 'caller'}`;
    const lines = [
      `${this.tenant.shopName} — SecondShift call summary`, '',
      `Outcome: ${head}`, rec.emergency ? `Emergency flagged: ${rec.emergency.reason} ("${rec.emergency.text}")` : null,
      `Caller: ${s.name || 'not given'}`, `Phone: ${s.phone || rec.from || 'unknown'} (caller ID ${rec.from || 'unknown'})`,
      `Address: ${s.address || 'not given'}`, `Problem: ${s.issue || 'not stated'}`,
      rec.booking ? `Appointment: ${rec.booking.when} (${rec.booking.calendar} calendar${rec.booking.link ? ': ' + rec.booking.link : ''})` : null,
      '', 'Transcript:', ...(rec.transcript || []).map(l => `  ${l.who === 'agent' ? 'SecondShift' : 'Caller'}: ${l.text}`),
      '', `Recording: ${rec.storeAudio ? 'audio stored' : 'transcript only (no audio stored)'}.`,
    ].filter(l => l !== null);
    await this.deps.mailer.send({ to, subject, text: lines.join('\n') });
  }
}

module.exports = { CallSession };
