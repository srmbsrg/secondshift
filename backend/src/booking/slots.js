'use strict';
// Pick the first open appointment slot that respects business hours, lead time, existing
// calendar events (busy blocks), and the caller's preference.
const { localParts, zoned, addLocalDays, WEEKDAYS } = require('../brain/time');

/**
 * @param {object} o
 *   now, tz, hours ({monday:[8,17],...; missing = closed}), slotMinutes, leadMinutes,
 *   busy: [{start:Date,end:Date}], pref: {start,end}|null, searchDays (default 14), stepMinutes (30)
 * @returns {{start:Date,end:Date,matchedPreference:boolean}|null}
 */
function findSlot(o) {
  const { now, tz, hours, slotMinutes = 120, leadMinutes = 60, busy = [], pref = null, searchDays = 14, stepMinutes = 30 } = o;
  const earliest = new Date(Math.max(now.getTime() + leadMinutes * 60000, pref && pref.start ? pref.start.getTime() : 0));
  const overlaps = (s, e) => busy.some(b => s < b.end && e > b.start);
  let fallback = null;
  for (let i = 0; i < searchDays; i++) {
    const day = addLocalDays(now, i, tz);
    const win = hours[WEEKDAYS[day.dow]];
    if (!win) continue;
    const open = zoned(day.y, day.mo, day.d, win[0], 0, tz), close = zoned(day.y, day.mo, day.d, win[1], 0, tz);
    let s = new Date(Math.max(open.getTime(), earliest.getTime()));
    // round up to the step
    const lp = localParts(s, tz), rem = lp.mi % stepMinutes;
    if (rem) s = new Date(s.getTime() + (stepMinutes - rem) * 60000 - lp.s * 1000);
    for (; s.getTime() + slotMinutes * 60000 <= close.getTime(); s = new Date(s.getTime() + stepMinutes * 60000)) {
      const e = new Date(s.getTime() + slotMinutes * 60000);
      if (overlaps(s, e)) continue;
      const inPref = !pref || !pref.end || s < pref.end;
      if (inPref) return { start: s, end: e, matchedPreference: true };
      if (!fallback) fallback = { start: s, end: e, matchedPreference: false };
      break;
    }
    if (fallback) return fallback;
  }
  return fallback;
}

module.exports = { findSlot };
