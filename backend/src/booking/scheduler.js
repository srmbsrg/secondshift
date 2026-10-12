'use strict';
// Glue between the agent and a calendar backend: find an open slot, then create the event.
const { findSlot } = require('./slots');
const { sayDateTime } = require('../brain/time');

function createScheduler({ tenant, calendar, now = () => new Date(), callerNumber }) {
  return {
    async findSlot(pref, excludeBefore) {
      const from = now(), to = new Date(from.getTime() + 15 * 86400000);
      const busy = await calendar.busy(from, to);
      let p = pref;
      if (excludeBefore) p = { ...(pref || {}), start: new Date(Math.max(excludeBefore.getTime(), pref && pref.start ? pref.start.getTime() : 0)), end: pref ? pref.end : null };
      return findSlot({ now: from, tz: tenant.timezone, hours: tenant.hours, slotMinutes: tenant.slotMinutes, leadMinutes: p && p.asap ? Math.min(tenant.leadMinutes || 60, 60) : tenant.leadMinutes, busy, pref: p && p.asap ? null : p });
    },
    async book(d) {
      const urgent = d.emergency ? 'URGENT — ' : '';
      const phone = d.phone && /^\d{10}$/.test(d.phone) ? `(${d.phone.slice(0, 3)}) ${d.phone.slice(3, 6)}-${d.phone.slice(6)}` : (d.phone || 'unknown');
      const ev = {
        summary: `${urgent}SecondShift booking: ${d.name || 'Caller'} — ${(d.issue || '').slice(0, 60)}`,
        location: d.address || '',
        description: [
          `Booked by SecondShift (automated assistant) for ${tenant.shopName}.`,
          `Customer: ${d.name || 'not given'}`, `Phone: ${phone}`, `Address: ${d.address || 'not given'}`,
          `Problem: ${d.issue || 'not stated'}`, d.emergency ? `EMERGENCY flagged: ${d.emergency.reason}` : '',
          `Caller ID: ${callerNumber || 'unknown'}`,
        ].filter(Boolean).join('\n'),
        start: d.slot.start, end: d.slot.end,
      };
      const r = await calendar.create(ev);
      return { ...r, when: sayDateTime(d.slot.start, tenant.timezone), calendar: calendar.kind, event: ev };
    },
  };
}

module.exports = { createScheduler };
