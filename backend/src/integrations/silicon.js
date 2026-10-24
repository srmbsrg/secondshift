'use strict';
// SecondShift -> Silicon (the shop's scheduler). Only used when the tenant turns on
// integrations.silicon.post_to_silicon; otherwise SecondShift runs standalone exactly as before.
//
//   availability(from, to) -> [{start,end}]   times when Silicon has no tech free
//   postJob(payload)       -> {created, job}  idempotent on payload.externalRef (retries are safe)
//   postFollowUp(payload)  -> {created, followUp}  callback / hang-up item (not a job); same idempotency
//
// A post that still fails after retries is written to an outbox file and retried in the
// background, so a Silicon outage never loses a booking. Contract: manifold docs/SCHEDULER-HUB-CONTRACT.md
const fs = require('fs'), path = require('path');

function createSiliconClient({ url, token, fetchImpl = fetch, timeoutMs = 4000, retries = 3, backoffMs = 400, outboxFile, log = () => {} }) {
  if (!url || !token) throw new Error('silicon integration needs url and token');
  const base = url.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function call(method, p, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) { const e = new Error(`silicon ${res.status}: ${j.error || 'error'}`); e.status = res.status; e.disabled = !!j.disabled; throw e; }
      return j;
    } finally { clearTimeout(t); }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 4xx (except 408/429) won't get better by retrying.
  const retryable = e => !e.status || e.status >= 500 || e.status === 408 || e.status === 429;

  async function postWithRetry(p, payload) {
    if (!payload || !payload.externalRef) throw new Error('externalRef required');
    let last;
    for (let i = 0; i < retries; i++) {
      try { return await call('POST', p, payload); }
      catch (e) { last = e; if (!retryable(e)) break; if (i < retries - 1) await sleep(backoffMs * (i + 1)); }
    }
    throw last;
  }
  const postJob = payload => postWithRetry('/api/integrations/secondshift/jobs', payload);
  const postFollowUp = payload => postWithRetry('/api/integrations/secondshift/followups', payload);
  // Carborundum's own sales CRM: a real caller on the DEMO line is a sales lead (Silicon dedupes by phone).
  const postSalesLead = payload => postWithRetry('/api/integrations/sales/leads', payload);

  function enqueue(payload, reason, kind = 'job') {
    if (!outboxFile) return;
    fs.mkdirSync(path.dirname(outboxFile), { recursive: true });
    fs.appendFileSync(outboxFile, JSON.stringify({ at: new Date().toISOString(), reason, kind, payload }) + '\n');
  }

  /** Retry everything in the outbox once; keep what still fails. Returns {sent, kept}. */
  async function flushOutbox() {
    if (!outboxFile || !fs.existsSync(outboxFile)) return { sent: 0, kept: 0 };
    const lines = fs.readFileSync(outboxFile, 'utf8').split('\n').filter(Boolean);
    const keep = []; let sent = 0;
    for (const l of lines) {
      let item; try { item = JSON.parse(l); } catch { continue; }
      try { await (item.kind === 'followup' ? postFollowUp : item.kind === 'saleslead' ? postSalesLead : postJob)(item.payload); sent++; } catch (e) { if (retryable(e)) keep.push(l); else log('silicon outbox drop', e.message); }
    }
    fs.writeFileSync(outboxFile, keep.length ? keep.join('\n') + '\n' : '');
    return { sent, kept: keep.length };
  }

  async function availability(from, to) {
    const j = await call('GET', `/api/integrations/secondshift/availability?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
    return (j.busy || []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  return { url: base, postJob, postFollowUp, postSalesLead, availability, enqueue, flushOutbox };
}

/**
 * Sales-lead post for a real call on the demo line (event "call" on Silicon's sales CRM). Null when the
 * caller ID is not a real 10-digit number. The caller's phone is the key; names said on a demo call are
 * often role-play, so they only go in the note.
 */
function salesLeadPayload({ callSid, from, outcome, slots = {}, emergency }) {
  const d = String(from || '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return null;
  return {
    event: 'call', externalRef: `secondshift:${callSid}:saleslead`,
    lead: { phone: from, source: 'secondshift-demo-line' },
    text: `Called the SecondShift demo line (346) 220-4138. ${callSummaryText({ slots, outcome, emergency, from })}`,
  };
}

/** Plain-English call summary for the job card in Silicon / Carbon. */
function callSummaryText({ slots = {}, outcome, emergency, from }) {
  return [
    outcome === 'booked' ? 'Booked by SecondShift on the phone.' : `Call outcome: ${outcome || 'unknown'}.`,
    `Caller: ${slots.name || 'not given'}${slots.phone || from ? ` · ${slots.phone || from}` : ''}`,
    slots.address ? `Address: ${slots.address}` : null,
    `Problem: ${slots.issue || 'not stated'}`,
    emergency ? `EMERGENCY flagged: ${emergency.reason}` : null,
  ].filter(Boolean).join('\n');
}

/**
 * Calendar backend (same interface as booking/calendar.js) that makes Silicon the schedule.
 * Falls back to `fallback` (the file/Google calendar) whenever Silicon is unreachable or has the
 * integration switched off, so a call is never dropped.
 */
function siliconCalendar({ client, fallback, tenant, log = () => {} }) {
  return {
    kind: 'silicon',
    fallbackKind: fallback.kind,
    async busy(from, to) {
      try { return await client.availability(from, to); }
      catch (e) { log('silicon availability failed, using ' + fallback.kind, e.message); return fallback.busy(from, to); }
    },
    async create(ev) {
      const d = ev.data || {};
      const payload = {
        externalRef: `secondshift:${ev.callSid || 'nocall-' + Date.now().toString(36)}`,
        tenant: tenant && tenant.id,
        customer: { name: d.name || null, phone: d.phone || null, address: d.address || null },
        issue: d.issue || null,
        emergency: d.emergency ? { reason: d.emergency.reason } : null,
        scheduledFor: ev.start.toISOString(),
        durationMinutes: Math.round((ev.end - ev.start) / 60000),
        call: { sid: ev.callSid || null, from: ev.callerNumber || null, outcome: 'booked', summary: ev.description },
      };
      try {
        const r = await client.postJob(payload);
        return { id: r.job.id, jobNumber: r.job.jobNumber, link: `${client.url}/ghost-control/operations/schedule`, calendarKind: 'silicon' };
      } catch (e) {
        log('silicon post failed, booking locally', e.message);
        if (!e.disabled) client.enqueue(payload, e.message); // turned off in Silicon = standalone, don't queue
        const local = await fallback.create(ev);
        return { ...local, calendarKind: fallback.kind, siliconQueued: !e.disabled };
      }
    },
  };
}

/**
 * Follow-up payload for a call that did not book: the caller asked for a callback, or hung up.
 * Returns null for booked calls and emergency transfers (those are not follow-ups).
 */
function followUpPayload({ callSid, tenantId, from, outcome, slots = {}, emergency, transcript }) {
  if (outcome === 'booked' || outcome === 'transfer') return null;
  const kind = outcome === 'callback' ? 'callback' : 'hangup';
  return {
    externalRef: `secondshift:${callSid}:followup`,
    tenant: tenantId,
    kind,
    customer: { name: slots.name || null, phone: slots.phone || from || null },
    reason: slots.issue || null,
    call: {
      sid: callSid, from: from || null, outcome,
      summary: callSummaryText({ slots, outcome, emergency, from }),
      transcript: transcript ? transcript.map(l => ({ who: l.who, text: l.text })) : undefined,
    },
  };
}

module.exports = { createSiliconClient, siliconCalendar, callSummaryText, followUpPayload, salesLeadPayload };
