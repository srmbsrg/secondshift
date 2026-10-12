'use strict';
// Live console trace for pilot calls (SECONDSHIFT_VERBOSE=1). Same content as the transcript log.
const live = (sid, type, data) => { if (process.env.SECONDSHIFT_VERBOSE) console.log(`[call ${String(sid || '').slice(-6)}] ${type}${data === undefined ? '' : ' ' + (typeof data === 'string' ? data : JSON.stringify(data))}`); };
// One live phone call: carrier media stream <-> Deepgram STT -> BookingAgent -> Deepgram TTS.
// Phone manners from Tiny Paws: the disclosure greeting is pre-rendered so the first word is
// immediate, and if the caller starts talking while we're speaking we stop (barge-in / "clear").
const fs = require('fs'), path = require('path');
const { BookingAgent } = require('../brain/agent');
const { createScheduler } = require('../booking/scheduler');
const { encodeWavMulaw } = require('./wav');

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
      scheduler: createScheduler({ tenant: this.tenant, calendar: this.deps.calendar, now, callerNumber: this.from }),
    });
    this.stt = this.deps.openStt({ model: (this.tenant.voice && this.tenant.voice.sttModel) || undefined });
    this.stt.on('speech-started', () => { if (this.speaking) { this._send(this.provider.clear(this.streamSid)); const s = this.speaking; this.speaking = null; s.done(); this._log('barge-in'); } });
    this.stt.on('utterance', text => { this.queue = this.queue.then(() => this._turn(text)).catch(e => this._log('error', e.message)); });
    this.stt.on('error', e => this._log('error', 'stt: ' + (e && e.message)));
    this.maxTimer = setTimeout(() => this._hangup('max-duration'), (this.tenant.maxCallSeconds || 300) * 1000);
    this._log('start', { from: this.from, tenant: this.tenant.id });
    await this._say(this.agent.greeting());
  }

  async _turn(text) {
    if (this.closed || this.endAction) return;
    this.transcript.push({ at: this._t(), who: 'caller', text }); live(this.callSid, 'caller', text);
    const r = await this.agent.onUtterance(text);
    if (r.say) await this._say(r.say);
    if (r.end) this._hangup(r.end === 'transfer' ? 'transfer' : 'hangup');
  }

  /** Speak text; resolves when the carrier reports playback finished (mark) or on barge-in. */
  async _say(text) {
    if (this.closed) return;
    this.transcript.push({ at: this._t(), who: 'agent', text }); live(this.callSid, 'agent', text);
    let audio;
    try { audio = await this.deps.tts.speak(text); } catch (e) { this._log('error', 'tts: ' + e.message); return; }
    if (this.closed) return;
    const mark = `say-${++this.markSeq}`;
    await new Promise(done => {
      this.speaking = { mark, done };
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
    try { await this._email(rec); live(this.callSid, 'email', 'sent'); } catch (e) { live(this.callSid, 'email', 'FAILED: ' + e.message); fs.appendFileSync(path.join(dir, 'errors.log'), `${new Date().toISOString()} email: ${e.message}\n`); }
    this.record = rec;
    if (this.deps.onRecord) this.deps.onRecord(rec);
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
