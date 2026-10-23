'use strict';
// The decision packet: the evidence file an AI agent hands its human about SecondShift.
// Rule: every line is either (a) verifiable at a linked public URL, (b) enforced by this code, or
// (c) taken from a real call record. Nothing invented: no customer counts, no testimonials, no stats.
const crypto = require('node:crypto');
const { renderPdf } = require('./pdf');

const SITE = 'https://www.carborundum.ai';
const LINKS = {
  product: `${SITE}/secondshift`,
  llms_txt: `${SITE}/llms.txt`,
  agents: `${SITE}/agents`,
  contact: `${SITE}/contact`,
  checkout_live: 'https://buy.stripe.com/7sY14nbM5dXPafi3z5aMU0r',
};

const BIG_CRM = /quick\s*books|qbo|salesforce/i;
const SIMPLE_CRM = /google\s*sheets?|sheet|csv|excel|email|webhook|zapier|airtable/i;

/** Accepts ["after_hours_calls","booking","crm_sync"] or { after_hours_calls:true, crm_sync:{system:"QuickBooks"} }. */
function normalizeNeeds(input) {
  const out = { after_hours_calls: false, booking: false, crm_sync: null, other: [] };
  const add = (k, v) => {
    const key = String(k).toLowerCase().replace(/[\s-]+/g, '_');
    if (/after_?hours|calls?|answer/.test(key)) out.after_hours_calls = true;
    else if (/book|schedul|appoint/.test(key)) out.booking = true;
    else if (/crm|sync|quickbooks|salesforce/.test(key)) out.crm_sync = { system: String((v && v.system) || (typeof v === 'string' ? v : '') || (BIG_CRM.test(key) ? key : '')).slice(0, 60) || null };
    else if (key) out.other.push(String(k).slice(0, 80));
  };
  if (Array.isArray(input)) input.slice(0, 20).forEach((k) => { if (k && typeof k === 'object') Object.entries(k).slice(0, 5).forEach(([kk, v]) => { if (v) add(kk, v); }); else add(k, true); });
  else if (input && typeof input === 'object') Object.entries(input).slice(0, 20).forEach(([k, v]) => { if (v) add(k, v); });
  if (!out.after_hours_calls && !out.booking && !out.crm_sync) { out.after_hours_calls = true; out.booking = true; }
  return out;
}

function quote(needs) {
  const lines = [{ item: 'SecondShift (answers calls 24/7, books the job, sends you every booking)', one_time: 0, monthly: 59.99,
    terms: 'First month free, then $59.99/month. No contract. Billed monthly by Stripe.', status: 'live', source: LINKS.product }];
  lines.push({ item: 'Agent access (this API) for the plan', one_time: 0, monthly: 0, terms: 'Included in every plan.', status: 'live for the demo shop', source: LINKS.agents });
  if (needs.crm_sync) {
    const sys = needs.crm_sync.system || '';
    const tier = BIG_CRM.test(sys) ? 'big' : SIMPLE_CRM.test(sys) ? 'simple' : 'unknown';
    const base = { status: 'build to order - not built yet. Scope and timeline are confirmed in writing before any charge.', source: LINKS.contact };
    if (tier === 'big') lines.push({ item: `CRM sync: ${sys} (QuickBooks/Salesforce-class custom build)`, one_time: 199, monthly: 10, terms: '$199 one-time + $10/month.', ...base });
    else if (tier === 'simple') lines.push({ item: `CRM sync: ${sys} (simple custom build)`, one_time: 49, monthly: 10, terms: '$49 one-time + $10/month.', ...base });
    else lines.push({ item: `CRM sync${sys ? ': ' + sys : ''} (custom build, tier set at scoping)`, one_time: null, monthly: 10,
      terms: 'Simple build $49 + $10/month, or QuickBooks/Salesforce-class build $199 + $10/month. Tier confirmed at scoping.', ...base });
  }
  const known = lines.filter((l) => l.one_time !== null);
  return {
    currency: 'USD', lines,
    due_today: 0,
    monthly_after_free_month: +lines.reduce((a, l) => a + (l.monthly || 0), 0).toFixed(2),
    one_time_build_fees: known.reduce((a, l) => a + (l.one_time || 0), 0),
    one_time_tier_to_confirm: lines.length > known.length,
    note: 'Prices as published by Carborundum on the date of this packet. Custom-build fees are charged only after scope is agreed.',
  };
}

const FACTS = [
  { claim: 'SecondShift answers a shop\'s phone calls 24/7 (nights, weekends, holidays), talks with the caller, captures name, address, problem and callback number, reads the details back, and books the time.', evidence: 'test_drive transcript in this packet (a real call to the demo line)', source: LINKS.product },
  { claim: 'Price: first month free, then $59.99/month, no contract, checkout by Stripe.', source: LINKS.product, also: LINKS.llms_txt },
  { claim: 'Every call opens by naming the shop and saying it is recorded and answered by an automated assistant.', evidence: 'enforced in code: a shop config that lacks this disclosure is refused at startup; see the first line of the transcript', source: LINKS.product },
  { claim: 'Calls are kept as a written transcript; no audio is kept.', evidence: 'test_drive.audio_stored = false', source: LINKS.product },
  { claim: 'Emergency keywords (gas smell, burst pipe, no heat ...) can ring the owner\'s on-call phone instead of booking for later.', evidence: 'per-shop rule; the demo shop has no on-call number set, so it books the earliest slot and flags URGENT', source: LINKS.product },
  { claim: 'Bookings are kept on SecondShift\'s schedule and sent to the owner. Syncing into the owner\'s own Google or Outlook calendar is not available yet (listed as next).', source: LINKS.product },
];

const SECURITY = [
  'Phone webhooks are checked against the carrier (Twilio) signature; unsigned requests are rejected.',
  'Agent tokens: issued once, stored only as a SHA-256 hash, scoped, expire in 24 hours, revocable (DELETE /agent/token), rate-limited, and every use is written to an audit log (route, token id, outcome - never the token).',
  'Tokens from this endpoint reach the DEMO shop only. Test-drive data comes only from calls placed by our scripted QA caller, never from real callers.',
  'Payments run on Stripe; Carborundum never sees card numbers. The checkout linked from this API is Stripe TEST mode: no real charge.',
  'The public health check shows liveness only; configuration detail requires an operator token.',
  'No customer references or usage statistics are included in this packet.',
];

const ESCALATION = { name: 'Scott Murphy', role: 'Founder, Carborundum AI (human closer)', email: 'scott@carborundum.ai', web: LINKS.contact, location: 'Spring, TX',
  note: 'The demo line (346) 220-4138 is the AI, not a person. For a human, email Scott.' };

function buildPacket({ id, needsInput, testDrive, receipt, principal, base, now = new Date(), version = 1 }) {
  const needs = normalizeNeeds(needsInput);
  const fit = [];
  if (needs.after_hours_calls) fit.push({ need: 'after-hours calls', answer: 'Covered by SecondShift today.', status: 'live' });
  if (needs.booking) fit.push({ need: 'booking', answer: 'Covered: books the time with the caller and sends the owner every booking. Own-calendar sync not available yet.', status: 'live (calendar sync: not yet)' });
  if (needs.crm_sync) fit.push({ need: 'CRM sync' + (needs.crm_sync.system ? ` (${needs.crm_sync.system})` : ''), answer: 'Not built yet. Offered as a custom build to fit; priced below. We confirm scope and timeline in writing before charging.', status: 'build to order' });
  for (const o of needs.other) fit.push({ need: o, answer: 'Not a SecondShift feature today. Ask the human closer whether a custom build fits.', status: 'ask' });
  const packet = {
    packet: 'SecondShift decision packet', schema_version: '1.0', id, version, generated_at: now.toISOString(),
    vendor: { name: 'Carborundum AI', product: 'SecondShift', site: SITE },
    shop: { tenant: 'demo', label: 'SecondShift demo shop (public demo line (346) 220-4138)' },
    needs_received: needs, fit,
    test_drive: testDrive || { status: 'no QA test call on record yet', how: `POST ${base}/agent/test-drive to place one (about 1-2 minutes), then GET ${base}/agent/test-drive` },
    verified_facts: FACTS, security_and_data_handling: SECURITY,
    quote: quote(needs),
    escalation: ESCALATION,
    links: { ...LINKS, packet_json: `${base}/agent/decision-packet/${id}.json`, packet_pdf: `${base}/agent/decision-packet/${id}.pdf`, test_drive: `${base}/agent/test-drive`, test_checkout: `${base}/agent/checkout` },
    record: {
      requested_by: principal ? { token_id: principal.tokenId, tenant: principal.tenant } : null,
      test_drive_call_ref: testDrive && testDrive.call_ref || null,
      receipt: receipt || { status: 'no purchase recorded', how: `POST ${base}/agent/checkout (Stripe TEST mode)` },
    },
  };
  packet.record.sha256 = crypto.createHash('sha256').update(JSON.stringify({ ...packet, record: { ...packet.record, sha256: undefined } })).digest('hex');
  return packet;
}

function packetPdf(p) {
  const B = [], h = (text) => B.push({ text, size: 10.5, bold: true, gap: 7, color: [0.05, 0.2, 0.4] }), t = (text, o = {}) => B.push({ text, size: 8.3, ...o });
  B.push({ text: 'SecondShift - decision packet', size: 17, bold: true });
  t(`Carborundum AI | ${p.shop.label} | packet ${p.id} v${p.version} | ${p.generated_at.replace('T', ' ').slice(0, 16)} UTC`, { color: [0.35, 0.35, 0.35], rule: true });
  h('Fit to the needs you sent');
  for (const f of p.fit) t(`- ${f.need}: ${f.answer} [${f.status}]`);
  h('Test drive: real call to the demo line');
  const td = p.test_drive;
  if (td && td.transcript) {
    t(`Call ${td.call_ref}, ${String(td.started_at).replace('T', ' ').slice(0, 16)} UTC. Caller: ${td.caller}. Outcome: ${td.outcome}${td.booking && td.booking.when ? ', booked ' + td.booking.when : ''}. Audio stored: ${td.audio_stored ? 'yes' : 'no'}.`);
    for (const l of td.transcript.slice(0, 16)) t(`${l.who}: ${l.text}`, { indent: 10, size: 7.6 });
    if (td.transcript.length > 16) t(`... ${td.transcript.length - 16} more lines in the JSON packet.`, { indent: 10, size: 7.6 });
  } else t(td.status + '. ' + td.how);
  h('Verified facts');
  for (const f of p.verified_facts) t(`- ${f.claim} (${f.source.replace('https://', '')})`);
  h('Security and data handling');
  for (const s of p.security_and_data_handling) t('- ' + s);
  h('Price quote (USD)');
  for (const l of p.quote.lines) t(`- ${l.item}: ${l.terms} [${l.status}]`);
  t(`Due today: $${p.quote.due_today}. Monthly after the free month: $${p.quote.monthly_after_free_month}. One-time build fees: $${p.quote.one_time_build_fees}${p.quote.one_time_tier_to_confirm ? ' + custom-build tier ($49 or $199) to confirm' : ''}.`, { bold: true });
  h('Talk to a human');
  t(`${p.escalation.name}, ${p.escalation.role}: ${p.escalation.email} | ${p.escalation.web.replace('https://', '')}. ${p.escalation.note}`);
  h('Record');
  const r = p.record.receipt;
  t(`Receipt: ${r.mode === 'test' ? `STRIPE TEST MODE (demo, no real charge) - session ${r.session_ref}, status ${r.status}, ${r.created_at || ''}` : r.status}.`);
  t(`Requested by agent token ${p.record.requested_by ? p.record.requested_by.token_id : '-'} (demo tenant). JSON: ${p.links.packet_json}`);
  t(`SHA-256 of JSON: ${p.record.sha256}`, { size: 7, color: [0.35, 0.35, 0.35] });
  return renderPdf(B, { title: `SecondShift decision packet ${p.id}` });
}

module.exports = { buildPacket, packetPdf, normalizeNeeds, quote, LINKS, FACTS, SECURITY, ESCALATION };
