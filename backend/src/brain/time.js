'use strict';
// Timezone-correct local<->UTC helpers (Intl only, no deps) + a small parser for how callers say
// when they want someone out ("tomorrow morning", "Tuesday at 2", "as soon as possible").

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function localParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, dow: WEEKDAYS.indexOf(p.weekday.toLowerCase()) };
}
function offsetMinutes(date, tz) {
  const p = localParts(date, tz);
  return (Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}
/** Wall-clock time in `tz` -> Date (handles DST). */
function zoned(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off = offsetMinutes(new Date(guess), tz);
  let t = guess - off * 60000;
  const off2 = offsetMinutes(new Date(t), tz);
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}
/** Local calendar day `n` days after `date` in tz -> {y,mo,d,dow}. */
function addLocalDays(date, n, tz) {
  const p = localParts(date, tz);
  const u = new Date(Date.UTC(p.y, p.mo, p.d + n, 12));
  return { y: u.getUTCFullYear(), mo: u.getUTCMonth(), d: u.getUTCDate(), dow: u.getUTCDay() };
}

const PERIODS = { morning: [8, 12], afternoon: [12, 17], evening: [17, 20], night: [17, 20] };
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, noon: 12 };

/**
 * Parse a caller's time preference. Returns null if nothing usable was said, else
 * { asap, start: Date, end: Date|null, label } — start is the earliest acceptable time.
 */
function parseWhen(text, now, tz) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[.,!?]/g, ' ') + ' ';
  if (/\b(asap|as soon as|soonest|first available|earliest|right away|whenever|any ?time|today if)\b/.test(t) && !/\b(tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t)) {
    return { asap: true, start: now, end: null, label: 'as soon as possible' };
  }
  let dayOffset = null;
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) dayOffset = 0;
  if (/\b(tomorrow|tmrw)\b/.test(t)) dayOffset = 1;
  if (/\bday after tomorrow\b/.test(t)) dayOffset = 2;
  if (dayOffset === null) {
    const wd = WEEKDAYS.findIndex(w => new RegExp(`\\b${w}\\b`).test(t));
    if (wd >= 0) { const today = localParts(now, tz).dow; dayOffset = (wd - today + 7) % 7; if (/\bnext\b/.test(t) && dayOffset === 0) dayOffset = 7; }
  }
  let period = Object.keys(PERIODS).find(k => new RegExp(`\\b${k}\\b`).test(t)) || null;
  if (/\bfirst thing\b/.test(t)) period = 'morning';
  let hour = null, minute = 0;
  const m = t.match(/\b(?:at|around|about|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m|p\.?m|o'?clock)?\b/);
  if (m && (m[3] || /\b(at|around|about|by)\s+\d/.test(t))) {
    hour = +m[1]; minute = m[2] ? +m[2] : 0;
    if (/^p/.test(m[3] || '') && hour < 12) hour += 12;
    if (!m[3] && hour >= 1 && hour <= 6) hour += 12; // "at 2" in a service call means 2 PM
  } else {
    const w = t.match(/\b(?:at|around|about)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon)\b/);
    if (w) { hour = WORD_NUM[w[1]]; if (hour >= 1 && hour <= 6) hour += 12; if (/\b(am|morning)\b/.test(t) && hour > 12) hour -= 12; }
  }
  if (dayOffset === null && period === null && hour === null) return null;
  if (dayOffset === null) dayOffset = 0;
  const day = addLocalDays(now, dayOffset, tz);
  let startH = 7, startM = 0, endH = null;
  if (hour !== null) { startH = hour; startM = minute; endH = hour + 2; }
  else if (period) { [startH, endH] = PERIODS[period]; }
  const start = zoned(day.y, day.mo, day.d, startH, startM, tz);
  const end = endH !== null ? zoned(day.y, day.mo, day.d, endH, 0, tz) : zoned(day.y, day.mo, day.d, 23, 59, tz);
  return { asap: false, start, end, label: period || (hour !== null ? 'specific time' : 'that day') };
}

/** "Tuesday, October 13 at 8 AM" in the shop's timezone (for speech and email). */
function sayDateTime(date, tz) {
  const d = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(date);
  const p = localParts(date, tz);
  const h12 = ((p.h + 11) % 12) + 1, ampm = p.h < 12 ? 'AM' : 'PM';
  return `${d} at ${h12}${p.mi ? ':' + String(p.mi).padStart(2, '0') : ''} ${ampm}`;
}
/** Relative word for speech: "today" / "tomorrow" / weekday. */
function relativeDay(date, now, tz) {
  const a = localParts(now, tz), b = localParts(date, tz);
  const diff = Math.round((Date.UTC(b.y, b.mo, b.d) - Date.UTC(a.y, a.mo, a.d)) / 86400000);
  return diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : null;
}

module.exports = { localParts, offsetMinutes, zoned, addLocalDays, parseWhen, sayDateTime, relativeDay, WEEKDAYS };
