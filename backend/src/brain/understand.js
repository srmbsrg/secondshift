'use strict';
// Turns one caller utterance into booking facts. Two layers:
//   1. Deterministic rules (always on): yes/no, phone digits, emergency keywords, time phrases,
//      and the field the agent just asked for (name / address / issue).
//   2. Optional LLM extraction (any OpenAI-compatible model) that can fill fields the caller
//      volunteered out of order and flag emergencies the keyword list misses.
// Rules win for the field being asked; the LLM only adds. The call works with the LLM off.
const { parseWhen } = require('./time');

const YES = /\b(yes|yeah|yep|yup|sure|correct|that works|works for me|sounds good|okay|ok|perfect|right|absolutely|please do|that's fine|that is fine)\b/i;
const NO = /\b(no|nope|nah|not really|doesn'?t work|does not work|can'?t|cannot|different|another|other number)\b/i;
const BYE = /\b(bye|goodbye|never ?mind|hang up|that'?s all)\b/i;

function digitsOf(text) {
  const d = String(text).replace(/[^\d]/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}
function cleanName(text) {
  let s = String(text).replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(uh|um|yeah|yes|sure|ok|okay)\s+/i, '').replace(/^(my name is|my name's|the name is|name's|this is|it's|it is|i'm|i am|call me)\s+/i, '');
  const words = s.split(' ').filter(w => /^[a-z'-]+$/i.test(w)).slice(0, 3);
  if (!words.length) return null;
  return words.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
function cleanAddress(text) {
  const s = String(text).replace(/^(it'?s|it is|that'?s|the address is|address is|we'?re at|i'?m at|at)\s+/i, '').replace(/[.!?]+$/, '').trim();
  return /\d/.test(s) || s.split(' ').length >= 3 ? s : null;
}

function rules(text, expecting, ctx) {
  const out = {};
  const t = String(text || '');
  if (YES.test(t) && !/\bno\b/i.test(t)) out.yes = true;
  if (NO.test(t) && !out.yes) out.no = true;
  if (BYE.test(t)) out.bye = true;
  const ph = digitsOf(t); if (ph) out.phone = ph;
  const kw = (ctx.emergencyKeywords || []).find(k => t.toLowerCase().includes(k.toLowerCase()));
  if (kw) { out.emergency = true; out.emergencyReason = kw; }
  const when = parseWhen(t, ctx.now, ctx.tz); if (when) out.when = when;
  if (expecting === 'issue') {
    let issue = t.trim();
    for (let i = 0; i < 3; i++) issue = issue.replace(/^(hi|hello|hey|yeah|yes|um+|uh+|so|well|good (morning|afternoon|evening))[\s,.!]+/i, '').trim();
    if (issue.split(/\s+/).length >= 2) out.issue = issue.charAt(0).toUpperCase() + issue.slice(1);
  }
  if (expecting === 'name') { const n = cleanName(t); if (n) out.name = n; }
  if (expecting === 'address') { const a = cleanAddress(t); if (a) out.address = a; }
  return out;
}

const SYSTEM = `You extract booking details from what a caller just said to a home-service company's phone assistant (HVAC, plumbing, electrical, roofing).
Return ONLY a JSON object with any of these keys you can fill from THIS utterance (omit unknown keys):
"issue" (what is wrong, short), "name" (caller's name), "address" (service address), "phone" (digits only),
"when" (their preferred day/time, in their words), "yes" (true if they agreed), "no" (true if they declined),
"emergency" (true ONLY for danger or active damage: gas smell, fire/smoke/sparks, flooding/burst pipe, no heat in freezing weather, carbon monoxide, sewage backup).`;

/**
 * @param {string} text   caller utterance (final transcript)
 * @param {string} expecting which field the agent just asked for
 * @param {object} ctx {now, tz, emergencyKeywords, llm, slots}
 */
async function understand(text, expecting, ctx) {
  const r = rules(text, expecting, ctx);
  if (!ctx.llm) return r;
  const j = await ctx.llm.json(SYSTEM, `The assistant just asked for: ${expecting}.\nCaller said: "${text}"`);
  if (!j || typeof j !== 'object') return r;
  const out = { ...r };
  // Grounding guard: only accept a model-proposed name/address/issue if it actually appears in what
  // the caller said. Small models echo schema words ("caller's name") — this blocks invented values.
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const said = norm(text);
  const grounded = v => { const n = norm(v); return n.length >= 2 && said.includes(n); };
  for (const k of ['issue', 'name', 'address']) if (!out[k] && typeof j[k] === 'string' && j[k].trim() && k !== expecting && grounded(j[k])) out[k] = j[k].trim();
  if (!out.phone && j.phone) { const d = digitsOf(String(j.phone)); if (d) out.phone = d; }
  if (!out.when && typeof j.when === 'string') { const w = parseWhen(j.when, ctx.now, ctx.tz); if (w) out.when = w; }
  if (j.emergency === true && !out.emergency) { out.emergency = true; out.emergencyReason = 'model'; }
  if (!out.yes && !out.no) { if (j.yes === true) out.yes = true; else if (j.no === true) out.no = true; }
  return out;
}

module.exports = { understand, rules, cleanName, cleanAddress, digitsOf };
