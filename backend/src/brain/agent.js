'use strict';
// The booking conversation. Pure logic: no audio, no network — talks to the outside world only
// through the injected `scheduler` (find + book a slot). That keeps it unit-testable and lets the
// same agent run behind any phone layer.
const { understand, cleanAddress } = require('./understand');
const { sayDateTime, relativeDay } = require('./time');

const spellPhone = d => d ? `${d.slice(0, 3).split('').join(' ')}, ${d.slice(3, 6).split('').join(' ')}, ${d.slice(6).split('').join(' ')}` : '';
const fill = (tpl, v) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (v[k] !== undefined ? v[k] : `{${k}}`));

class BookingAgent {
  /**
   * @param {object} o tenant, callerNumber (E.164 or digits), scheduler {findSlot(pref) -> slot|null, book(details) -> {id,link}},
   *                   llm (optional), now () => Date
   */
  constructor(o) {
    this.tenant = o.tenant; this.scheduler = o.scheduler; this.llm = o.llm || null;
    this.now = o.now || (() => new Date());
    const caller = String(o.callerNumber || '').replace(/[^\d]/g, '');
    this.callerDigits = caller.length >= 10 ? caller.slice(-10) : null;
    this.slots = { issue: null, name: null, address: null, phone: null, when: null };
    // Twilio already gives us the caller's number: use it as the callback number and never make the
    // caller recite it (live call 2 asked for it while the caller was mid-address). It is mentioned
    // once in the slot offer, and any number the caller says replaces it.
    if (this.callerDigits) { this.slots.phone = this.callerDigits; this.phoneSource = 'caller-id'; }
    this.houseNumber = null;
    this.state = 'issue'; this.tries = {}; this.proposed = null; this.booking = null;
    this.emergency = null; this.outcome = 'in-progress'; this.excludeBefore = null;
  }
  get shop() { return this.tenant.shopName; }
  greeting() { return fill(this.tenant.disclosure, { shop: this.shop }); }

  _ask(field) {
    this.state = field;
    switch (field) {
      case 'issue': return 'What’s going on that you need help with?';
      case 'name': return 'I can get that on the schedule. What’s your name?';
      case 'address': return `Thanks${this.slots.name ? ', ' + this.slots.name.split(' ')[0] : ''}. What’s the address where you need service?`;
      case 'phone': return this.callerDigits ? `Is ${spellPhone(this.callerDigits)} the best number to reach you?` : 'What’s the best number to reach you?';
      case 'when': return 'When would you like a technician to come out?';
      default: return '';
    }
  }
  _next() {
    for (const f of ['issue', 'name', 'address', 'phone', 'when']) if (!this.slots[f]) return f; // phone only when there is no caller ID
    return null;
  }
  _retry(field) { this.tries[field] = (this.tries[field] || 0) + 1; return this.tries[field]; }

  _end(outcome, say) { this.outcome = outcome; this.state = 'done'; return { say, end: outcome === 'transfer' ? 'transfer' : 'hangup' }; }
  _callback(reason) {
    return this._end('callback', `No problem. I’ll have someone from ${this.shop} call you back to get you scheduled. Thanks for calling. Goodbye.`);
  }

  async _propose() {
    const slot = await this.scheduler.findSlot(this.slots.when, this.excludeBefore);
    if (!slot) return this._callback('no-slot');
    this.proposed = slot; this.state = 'confirm';
    const rel = relativeDay(slot.start, this.now(), this.tenant.timezone);
    const when = sayDateTime(slot.start, this.tenant.timezone);
    const lead = slot.matchedPreference ? 'I can have a technician there' : 'The closest opening I have is';
    const callback = this.phoneSource === 'caller-id' ? ', and we’ll call you at the number you’re calling from' : '';
    return { say: `${lead} ${rel ? rel + ', ' : ''}${when}${callback}. Does that work?` };
  }

  /** Handle one caller utterance; returns {say, end?: 'hangup'|'transfer'}. */
  async onUtterance(text) {
    if (this.state === 'done') return { say: '' };
    const u = await understand(text, this.state, {
      now: this.now(), tz: this.tenant.timezone, llm: this.llm,
      emergencyKeywords: (this.tenant.emergency && this.tenant.emergency.keywords) || [], slots: this.slots,
    });

    // Emergencies can be raised at any point in the call.
    if (u.emergency && !this.emergency) {
      this.emergency = { reason: u.emergencyReason || 'reported', text };
      if (!this.slots.issue) this.slots.issue = u.issue || text;
      const em = this.tenant.emergency || {};
      if (em.action === 'transfer' && em.transferNumber) {
        return this._end('transfer', fill(em.transferMessage || 'That sounds urgent. I’m connecting you to our on-call technician right now. Please hold.', { shop: this.shop }));
      }
      // No transfer number configured: book the earliest slot and flag it urgent.
      this.slots.when = { asap: true, start: this.now(), end: null, label: 'as soon as possible' };
    }
    if (u.bye && this.state !== 'confirm') return this._callback('caller-ended');

    // Fill anything the caller gave us, then handle the field we asked for.
    for (const k of ['issue', 'name', 'address']) if (u[k] && !this.slots[k]) this.slots[k] = u[k];
    if (u.when && !this.slots.when && this.state !== 'confirm') this.slots.when = u.when;
    if (u.phone && this.state !== 'phone' && this.state !== 'confirm' && u.phone !== this.slots.phone) { this.slots.phone = u.phone; this.phoneSource = 'said'; } // a number the caller gives wins over caller ID

    switch (this.state) {
      case 'issue':
        if (!this.slots.issue) { if (this._retry('issue') >= 2) this.slots.issue = text || 'Not stated'; else return { say: 'Sorry, could you tell me a little about the problem?' }; }
        break;
      case 'name':
        if (!this.slots.name) { if (this._retry('name') >= 2) this.slots.name = 'Not given'; else return { say: 'Sorry, I didn’t catch that. What’s your name?' }; }
        break;
      case 'address':
        // Never move on until there is a real street address (house number + street).
        // Callers give addresses in pieces ("1412" ... "Willow Bend Drive"): keep each piece and ask
        // only for the missing half.
        if (!this.slots.address && this.houseNumber && u.streetName) this.slots.address = `${this.houseNumber} ${u.streetName}`;
        if (!this.slots.address && this.streetName && u.houseNumber) this.slots.address = `${u.houseNumber} ${this.streetName}`;
        if (!this.slots.address && u.houseNumber) { this.houseNumber = u.houseNumber; if (this.streetName) this.slots.address = `${u.houseNumber} ${this.streetName}`; else return { say: `${u.houseNumber} — and what’s the street name?` }; }
        if (!this.slots.address && u.streetName) { this.streetName = u.streetName; return { say: `And what’s the house number on ${u.streetName}?` }; }
        if (!this.slots.address) {
          if (this._retry('address') >= 3) return this._callback('no-address');
          // Re-ask for the missing half if we already have one.
          if (this.streetName) return { say: `Sorry — what’s the house number on ${this.streetName}?` };
          if (this.houseNumber) return { say: `Sorry — ${this.houseNumber} and what street?` };
          return { say: 'Sorry — what’s the street address, with the house number?' };
        }
        break;
      case 'phone':
        if (u.phone) this.slots.phone = u.phone;
        else if (u.yes && this.callerDigits) this.slots.phone = this.callerDigits;
        else if (u.no) return { say: 'What’s the best number to reach you?' };
        else if (this._retry('phone') >= 2) this.slots.phone = this.callerDigits || 'unknown';
        else return { say: this._ask('phone') };
        break;
      case 'when':
        // The town often arrives as its own fragment right after the street ("Willow Bend Drive." /
        // "In Spring."): add it to the address instead of treating it as a failed time answer.
        const frag = text.trim().replace(/[.!,]$/, '');
        const town = !this.slots.when && this.slots.address && !u.when && (
          (/^in\s+[a-z]+(\s+[a-z]+)?$/i.test(frag) && !/\bin\s/i.test(this.slots.address)) ||  // "...Drive." + "In Spring."
          (/\sin$/i.test(this.slots.address) && /^[A-Z][a-z]+(\s+[A-Z][a-z]+)?$/.test(frag)));  // "...Drive in" + "Spring."
        if (town) {
          this.slots.address = `${this.slots.address} ${frag.replace(/^In\s/, 'in ')}`.replace(/\sin\s+in\s/i, ' in ');
          return { say: this._ask('when') };
        }
        if (!this.slots.when) {
          if (this._retry('when') >= 2) this.slots.when = { asap: true, start: this.now(), end: null, label: 'as soon as possible' };
          else return { say: 'Sorry — what day and time works best? For example, tomorrow morning.' };
        }
        break;
      case 'confirm':
        if (u.yes && !u.no) {
          const details = { ...this.slots, phone: this.slots.phone, slot: this.proposed, emergency: this.emergency };
          this.booking = await this.scheduler.book(details);
          return this._end('booked', `You’re all set for ${sayDateTime(this.proposed.start, this.tenant.timezone)}. We’ll see you then. Thanks for calling ${this.shop}. Goodbye.`);
        }
        if (u.phone && !u.no && u.phone !== this.slots.phone) { this.slots.phone = u.phone; this.phoneSource = 'said'; const p = await this._propose(); return { ...p, say: 'Got it, I’ll use that number. ' + p.say }; }
        // Repeating a time that the offered slot already satisfies ("tomorrow morning") is agreement
        // that was talked over, not a new request: confirm instead of re-offering the same slot.
        if (u.when && !u.no && this.proposed && this.proposed.start >= u.when.start && (!u.when.end || this.proposed.start < u.when.end) && this._retry('restate') < 2) {
          return { say: `Great — that’s ${sayDateTime(this.proposed.start, this.tenant.timezone)}. Shall I book it?` };
        }
        if (u.no || u.when) {
          if (this._retry('confirm') >= 3) return this._callback('no-agreeable-slot');
          if (u.when) { this.slots.when = u.when; this.excludeBefore = null; return this._propose(); }
          // Plain "no": don't offer that slot again; ask for a better time.
          this.excludeBefore = this.proposed.end; this.slots.when = null; this.state = 'when';
          return { say: 'No problem. What day and time would work better?' };
        }
        return { say: `Sorry — does ${sayDateTime(this.proposed.start, this.tenant.timezone)} work for you?` };
      default: break;
    }

    const next = this._next();
    if (next) return { say: this._ask(next) };
    return this._propose();
  }

  /** Conversation state, so a turn can be undone when the caller turns out not to have finished. */
  snapshot() {
    const keys = ['slots', 'state', 'tries', 'proposed', 'excludeBefore', 'emergency', 'outcome', 'phoneSource', 'houseNumber', 'streetName'];
    return structuredClone(Object.fromEntries(keys.map(k => [k, this[k]])));
  }
  restore(s) { Object.assign(this, structuredClone(s)); }

  summary() {
    return { outcome: this.outcome, slots: this.slots, emergency: this.emergency, booking: this.booking, proposed: this.proposed };
  }
}

module.exports = { BookingAgent, spellPhone };
