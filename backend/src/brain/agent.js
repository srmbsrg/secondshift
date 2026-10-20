'use strict';
// The booking conversation. Pure logic: no audio, no network — talks to the outside world only
// through the injected `scheduler` (find + book a slot). That keeps it unit-testable and lets the
// same agent run behind any phone layer.
const { understand, cleanAddress, cleanName } = require('./understand');
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
    this.houseNumber = null; this.readbackDone = false;
    // How long a turn may wait for the model before replying on the rules alone (the model's extras
    // are merged when they arrive). Scripted next-questions never wait on the model.
    this.modelBudgetMs = o.modelBudgetMs !== undefined ? o.modelBudgetMs : 450;
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
      case 'readback': return this._readbackLine();
      default: return '';
    }
  }
  // One read-back before the time is offered, so a misheard name or street gets caught (live call 3:
  // "Murphy" -> "Mercy", street name misspelled).
  _readbackLine() {
    const n = this.slots.name && this.slots.name !== 'Not given' ? this.slots.name : null;
    return n ? `I’ve got ${n} at ${this.slots.address} — is that right?` : `I’ve got the address as ${this.slots.address} — is that right?`;
  }
  _next() {
    for (const f of ['issue', 'name', 'address']) if (!this.slots[f]) return f;
    if (!this.readbackDone) return 'readback';
    for (const f of ['phone', 'when']) if (!this.slots[f]) return f; // phone only when there is no caller ID
    return null;
  }
  /** Model extras that arrived after we had already replied: fill only what is still missing. */
  _applyLate(g) {
    if (!g || this.state === 'done') return;
    if (g.issue && this.slots.issue && this.rawIssue && this.slots.issue === this.rawIssue) this.slots.issue = g.issue; // tidier wording
    for (const k of ['name', 'address']) if (g[k] && !this.slots[k]) this.slots[k] = g[k];
    if (g.when && !this.slots.when && this.state !== 'confirm') this.slots.when = g.when;
    if (g.emergency && !this.emergency) this.emergency = { reason: 'model', text: this.slots.issue || '' }; // flag urgent
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
      budgetMs: this.modelBudgetMs,
    });
    if (u.late) u.late.then(g => this._applyLate(g));
    if (this.state === 'issue' && u.issue && !this.slots.issue) this.rawIssue = u.issue;

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
      case 'readback': {
        if (this._townFragment(text, u)) return { say: `Thanks — ${this._readbackLine()}` };
        if (u.yes && !u.no) { this.readbackDone = true; break; }
        // A correction: take a new street address and/or a new name from what they said.
        const fixed = await this._correction(text);
        if (fixed) {
          if (this._retry('readback') >= 3) { this.readbackDone = true; break; } // stop looping; keep what we have
          return { say: `Thanks — ${this._readbackLine()}` };
        }
        if (u.no) return { say: 'Sorry about that — what should I fix, the name or the address?' };
        if (this._retry('readback-unclear') >= 2) { this.readbackDone = true; break; }
        return { say: `Sorry — ${this._readbackLine()}` };
      }
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
        if (!this.slots.when && this._townFragment(text, u)) return { say: this._ask('when') };
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
        // Not a clear yes (e.g. "That work?" — an echo of our own question): ask once, plainly.
        if (this._retry('unclear-yes') >= 2) return this._callback('unclear-confirmation');
        return { say: 'Sorry — shall I book it?' };
      default: break;
    }

    const next = this._next();
    if (next) return { say: this._ask(next) };
    return this._propose();
  }

  /**
   * The town often arrives as its own fragment right after the street ("Willow Bend Drive." /
   * "In Spring.", or "...Drive in" / "Spring."): add it to the address. Returns true if it did.
   */
  _townFragment(text, u) {
    const frag = String(text).trim().replace(/[.!,]$/, '');
    const town = this.slots.address && !u.when && !u.yes && !u.no && (
      (/^in\s+[a-z]+(\s+[a-z]+)?$/i.test(frag) && !/\bin\s/i.test(this.slots.address)) ||
      (/\sin$/i.test(this.slots.address) && /^[A-Z][a-z]+(\s+[A-Z][a-z]+)?$/.test(frag)));
    if (town) this.slots.address = `${this.slots.address} ${frag.replace(/^In\s/, 'in ')}`.replace(/\sin\s+in\s/i, ' in ');
    return !!town;
  }

  /**
   * A read-back correction: "No, it's 334 Gamewood Drive" / "Murphy, M-U-R-P-H-Y" / "the name is Scott
   * Murphy". Returns true if the name or address changed.
   */
  async _correction(text) {
    let t = String(text).replace(/[’‘]/g, "'").trim();
    for (let prev = null; prev !== t;) { prev = t; t = t.replace(/^\W*(no|nope|not quite|not right|that's not right|that is not right|actually|sorry|it's|it is|it should be|should be)\b[,.!]?\s*/i, '').trim(); } // "No, it's ..."
    t = t.replace(/\b((?:[A-Za-z][\s.-]+){2,}[A-Za-z])\b/g, m => { const l = m.replace(/[\s.-]+/g, ''); return l.length >= 3 ? l[0].toUpperCase() + l.slice(1).toLowerCase() : m; }); // spelled letters
    let changed = false;
    const a = await understand(t, 'address', { now: this.now(), tz: this.tenant.timezone, emergencyKeywords: [] });
    const fixedAddress = !!(a.address && a.address !== this.slots.address);
    if (fixedAddress) { this.slots.address = a.address; changed = true; t = t.replace(/\b\d[\s\S]*$/, '').trim(); }
    const cued = /^(and\s+)?(the\s+)?(name\s+is|name's|my name is|this is|spelled)\s+/i.test(t);
    const nameText = t.replace(/^(and\s+)?(the\s+)?(name\s+is|name's|my name is|this is|it's|spelled)\s+/i, '').replace(/[,.].*$/, '').trim();
    // Words left over around an address fix ("No, it's for 1420 ...") are not a name unless the caller
    // said so ("...and the name is Murphy") or it's a capitalised word that isn't a function word.
    if (fixedAddress && !cued && !/^[A-Z][a-z']{2,}(\s+[A-Z][a-z']+)?$/.test(nameText)) return changed;
    if (/^(for|at|on|in|to|is|and|the|a|an|um|uh)$/i.test(nameText)) return changed;
    const n = nameText && /^[A-Za-z][A-Za-z' -]{1,40}$/.test(nameText) ? cleanName(nameText) : null;
    if (n && n !== this.slots.name && !/^(no|yes|yeah|the|name|address|street|it'?s|its|that|right|correct|okay|ok|sorry)$/i.test(n)) {
      // A single word is usually the surname they're fixing ("Murphy"): keep the first name we had.
      const parts = (this.slots.name || '').split(' ');
      this.slots.name = n.includes(' ') || parts.length < 2 ? n : `${parts[0]} ${n}`;
      changed = true;
    }
    return changed;
  }

  /** Conversation state, so a turn can be undone when the caller turns out not to have finished. */
  snapshot() {
    const keys = ['slots', 'state', 'tries', 'proposed', 'excludeBefore', 'emergency', 'outcome', 'phoneSource', 'houseNumber', 'streetName', 'readbackDone', 'rawIssue'];
    return structuredClone(Object.fromEntries(keys.map(k => [k, this[k]])));
  }
  restore(s) { Object.assign(this, structuredClone(s)); }

  summary() {
    return { outcome: this.outcome, slots: this.slots, emergency: this.emergency, booking: this.booking, proposed: this.proposed };
  }
}

module.exports = { BookingAgent, spellPhone };
