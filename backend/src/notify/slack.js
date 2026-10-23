'use strict';
// Team alert to Slack #agents for every REAL inbound call (anything not from an excluded test
// number, e.g. Scott's own phones). Posts through a Slack incoming webhook (free, no app scopes).
// Off unless SLACK_AGENTS_WEBHOOK_URL is set. Never throws into a call.
const DEFAULT_EXCLUDE = '+19034747930'; // Scott's test phone

const digits10 = n => String(n || '').replace(/\D/g, '').slice(-10);

function parseExclude(list) {
  return new Set(String(list == null ? DEFAULT_EXCLUDE : list).split(/[,\s]+/).map(digits10).filter(d => d.length === 10));
}

/** True when this call should be posted: a real caller ID that is not on the exclude list. */
function isRealCaller(from, exclude) {
  const d = digits10(from);
  if (d.length !== 10) return false; // blocked / anonymous / sim ids: not a real number
  return !exclude.has(d);
}

function createSlack({ webhookUrl, exclude, timeoutMs = 8000, fetchImpl = globalThis.fetch }) {
  if (!webhookUrl) return null;
  const ex = parseExclude(exclude);
  return {
    kind: 'slack',
    shouldPost: from => isRealCaller(from, ex),
    async send(text) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(webhookUrl, {
          method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`slack ${res.status}`);
        return true;
      } finally { clearTimeout(t); }
    },
  };
}
module.exports = { createSlack, isRealCaller, parseExclude, digits10 };
