'use strict';
// Calendar backends behind one interface:
//   busy(from, to) -> [{start,end}]      create(event) -> {id, link}
// "google": Google Calendar API (freeBusy + events.insert) using an OAuth refresh token.
// "file":   a local JSON calendar for development/tests (no account needed).
const fs = require('fs'), path = require('path');

function googleCalendar({ auth, calendarId = 'primary', timeZone }) {
  const base = 'https://www.googleapis.com/calendar/v3';
  const call = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${await auth.token()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`google calendar ${res.status}: ${(j.error && j.error.message) || ''}`);
    return j;
  };
  return {
    kind: 'google',
    async busy(from, to) {
      const j = await call(`${base}/freeBusy`, { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone, items: [{ id: calendarId }] });
      const cal = j.calendars && j.calendars[calendarId];
      return ((cal && cal.busy) || []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
    },
    async create(ev) {
      const j = await call(`${base}/calendars/${encodeURIComponent(calendarId)}/events`, {
        summary: ev.summary, location: ev.location, description: ev.description,
        start: { dateTime: ev.start.toISOString(), timeZone }, end: { dateTime: ev.end.toISOString(), timeZone },
      });
      return { id: j.id, link: j.htmlLink };
    },
  };
}

function fileCalendar({ file }) {
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  return {
    kind: 'file',
    async busy(from, to) {
      return load().map(e => ({ start: new Date(e.start), end: new Date(e.end) })).filter(b => b.start < to && b.end > from);
    },
    async create(ev) {
      const all = load();
      const id = 'local-' + Date.now().toString(36);
      all.push({ id, summary: ev.summary, location: ev.location, description: ev.description, start: ev.start.toISOString(), end: ev.end.toISOString() });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
      return { id, link: null };
    },
  };
}

module.exports = { googleCalendar, fileCalendar };
