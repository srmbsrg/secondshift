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
  // A name volunteered before we asked ("my name is Scott Murphy"). Needs the transcript's capitals,
  // so "this is urgent" is not a name.
  if (expecting !== 'name') { const m = t.match(/\b(?:[Mm]y name is|[Mm]y name's|[Nn]ame is|[Tt]his is)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)/); if (m) out.name = m[1]; }
  if (expecting === 'address') { const a = cleanAddress(t); if (a) out.address = a; }
  return out;
}

const SYSTEM = `You are the listening half of a phone assistant that books service calls for a home-service company (HVAC, plumbing, electrical, roofing).
Callers are often rambly or say everything in one breath, like a voicemail. Pull out EVERY detail present in the caller's latest words.
Return ONLY a JSON object, omitting keys you cannot fill from the caller's latest words:
"issue": what is wrong, a short phrase (max 12 words) using the caller's own words,
"name": the caller's name exactly as said,
"address": the service street address exactly as said,
"phone": callback number, digits only,
"when": their preferred day/time in their words (e.g. "tomorrow morning", "as soon as possible"),
"yes": true if they agreed to / confirmed what the assistant just asked,
"no": true if they declined / said it was wrong,
"emergency": true ONLY for danger or active damage: gas smell, fire/smoke/sparks, flooding/burst pipe, no heat in freezing weather, carbon monoxide, sewage backup.
Never invent values. Never copy these instructions into values.`;

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'and', 'my', 'is', 'a', 'an', 'it', 'its', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'our', 'we', 'i', 'out', 'here', 'need', 'needs']);

/**
 * @param {string} text   caller utterance (final transcript)
 * @param {string} expecting which field the agent just asked for
 * @param {object} ctx {now, tz, emergencyKeywords, llm, slots}
 */
async function understand(text, expecting, ctx) {
  const r = rules(text, expecting, ctx);
  if (!ctx.llm) return r;
  const known = Object.entries(ctx.slots || {}).filter(([k, v]) => v && ['issue', 'name', 'address', 'phone'].includes(k)).map(([k, v]) => `${k}=${v}`).join('; ');
  const j = await ctx.llm.json(SYSTEM, `Already known: ${known || 'nothing yet'}.\nThe assistant just asked for: ${expecting}.\nCaller's latest words: "${text}"`);
  if (!j || typeof j !== 'object') return r; // model off / slow / error: rules carry the call
  const out = { ...r };
  // Grounding guard: model-proposed text must come from what the caller actually said, so a model
  // can tidy and reorder but never invent. Name/address: verbatim substring. Issue: a short phrase
  // whose content words all appear in the utterance.
  const said = norm(text);
  const verbatim = v => { const n = norm(v); return n.length >= 2 && said.includes(n); };
  const words = new Set(said.split(' '));
  const summarised = v => { const w = norm(v).split(' ').filter(x => x.length > 2 && !STOP.has(x)); return w.length > 0 && w.every(x => words.has(x)); };
  const str = k => (typeof j[k] === 'string' && j[k].trim() ? j[k].trim() : null);
  // The model's version is preferred when grounded: rules take the whole sentence as the "issue"
  // or "address", the model trims it to the part that matters.
  if (str('name') && verbatim(str('name'))) out.name = str('name');
  if (str('address') && verbatim(str('address')) && /\d/.test(str('address'))) out.address = str('address');
  if (str('issue') && summarised(str('issue'))) out.issue = str('issue').charAt(0).toUpperCase() + str('issue').slice(1);
  if (!out.phone && j.phone) { const d = digitsOf(String(j.phone)); if (d) out.phone = d; }
  if (!out.when && typeof j.when === 'string') { const w = parseWhen(j.when, ctx.now, ctx.tz); if (w) out.when = w; }
  if (j.emergency === true && !out.emergency) { out.emergency = true; out.emergencyReason = 'model'; }
  if (!out.yes && !out.no) { if (j.yes === true) out.yes = true; else if (j.no === true) out.no = true; }
  return out;
}

module.exports = { understand, rules, cleanName, cleanAddress, digitsOf };
