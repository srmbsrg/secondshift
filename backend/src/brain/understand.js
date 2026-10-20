'use strict';
// Turns one caller utterance into booking facts. Two layers:
//   1. Deterministic rules (always on): yes/no, phone digits, emergency keywords, time phrases,
//      and the field the agent just asked for (name / address / issue).
//   2. Optional LLM extraction (any OpenAI-compatible model) that can fill fields the caller
//      volunteered out of order and flag emergencies the keyword list misses.
// Rules win for the field being asked; the LLM only adds. The call works with the LLM off.
const { parseWhen } = require('./time');

const YES = /\b(yes|yeah|yep|yup|sure|correct|that works|works for me|that'?ll work|sounds good|sounds great|okay|ok|perfect|right|absolutely|please do|book it|go ahead|do it|that's fine|that is fine)\b/i;
const NO = /\b(no|nope|nah|not really|not right|not quite|wrong|incorrect|doesn'?t work|does not work|can'?t|cannot|different|another|other number)\b/i;
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
  const s = tidyAddress(String(text).replace(/^((yeah|yes|um+|uh+|so|okay|ok)[,.]?\s+)+/i, '').replace(/^(it'?s|it is|that'?s|the address is|address is|we'?re at|i'?m at|at)\s+/i, ''));
  // A street address needs a house number followed by a street name ("1412 Willow Bend"), or a
  // numbered rural road ("County Road 12"). A sentence with no number ("need someone to come out
  // and take a look") is NOT an address (live call 2 booked that as the location).
  if (!isStreetAddress(s)) return null;
  // Start at the house number: drop lead-in words speech-to-text leaves in ("for 1420 Willow...").
  const m = s.match(/\b\d+[a-z]?[.,]?\s+(?:[nsew]\.?\s+)?[a-z]{2,}/i);
  return m ? s.slice(m.index) : s;
}
const STREET = /\b(street|st|drive|dr|road|rd|lane|ln|avenue|ave|court|ct|circle|cir|boulevard|blvd|way|place|pl|trail|trl|parkway|pkwy|highway|hwy|loop|terrace|bend|run|ridge)\b/i;
// Deepgram's smart formatting reads a spoken house number as money ("fourteen twelve" -> "$14.12",
// "$1,412"). While we are asking for an address, turn those back into plain numbers.
// ...or writes it out in words ("fourteen twelve", "three thirty four", "one oh five"). People say
// house numbers in 1–2 digit chunks, so each chunk becomes its digits and the chunks are joined.
const ONES = { zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function wordsToDigits(s) {
  // Longest words first, each ending at a word boundary, so "fourteen" is not read as "four" + "teen".
  return String(s).replace(/\b(?:(?:thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|zero|three|seven|eight|four|five|nine|one|two|six|ten|oh)\b[\s-]*)+/gi, run => {
    const w = run.toLowerCase().split(/[\s-]+/).filter(Boolean); let out = '';
    for (let i = 0; i < w.length; i++) {
      if (w[i] === 'hundred') { out += '00'; continue; }
      if (w[i] === 'thousand') { out += '000'; continue; }
      if (w[i] in TEENS) out += TEENS[w[i]];
      else if (w[i] in TENS) { if (w[i + 1] in ONES && ONES[w[i + 1]] > 0) out += TENS[w[i]] + ONES[w[++i]]; else out += TENS[w[i]]; }
      else if (w[i] in ONES) out += ONES[w[i]];
    }
    // "hundred" after a chunk ("twelve hundred") multiplies rather than appends a chunk
    return (out || run.trim()) + (/\s$/.test(run) ? ' ' : '');
  });
}
const unMoney = s => String(s).replace(/\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?\b/g, (_, a, b) => a.replace(/,/g, '') + (b || ''));
// Speech-to-text turns a pause after the house number into a full stop ("1412. Willow Bend").
const tidyAddress = s => String(s).replace(/(\d)[.,]\s+(?=[a-z])/gi, '$1 ').replace(/[.!?]+$/, '').trim();
const isStreetAddress = s => /\b\d+[a-z]?[.,]?\s+(?:[nsew]\.?\s+)?[a-z]{2,}/i.test(s) || /\b(county road|cr|farm road|fm|highway|hwy|route|rr|state road)\s*\d+/i.test(s);
// Just a house number so far ("1412"): hold it and ask for the street.
const bareNumber = s => { const m = String(s).trim().match(/^(?:(?:yeah|yes|um+|uh+|so|okay|ok|it'?s|it is|the number is|number)[,.]?\s+)*(\d{1,6}[a-z]?)[.,]?$/i); return m ? m[1] : null; };

function rules(text, expecting, ctx) {
  const out = {};
  const t = String(text || '');
  // A clear yes only: an echo of our own question ("That work?") or any question-shaped reply that
  // does not start with a yes word is ambiguous, not agreement (live call 3).
  const questionShaped = /\?\s*$/.test(t) && !/^\W*(yes|yeah|yep|yup|sure|ok|okay|absolutely)\b/i.test(t);
  if (YES.test(t) && !/\b(no|not)\b/i.test(t) && !questionShaped) out.yes = true;
  if (NO.test(t) && !out.yes) out.no = true;
  if (questionShaped && !out.no) out.unclear = true;
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
  if (expecting === 'address') {
    const a = cleanAddress(t);
    if (a) out.address = a;
    else {
      const n = bareNumber(t); if (n) out.houseNumber = n;
      // Street with no number yet ("Willow Bend Drive in Spring"): keep it and ask for the number.
      else if (STREET.test(t) && !/\d/.test(t)) out.streetName = tidyAddress(t.replace(/^((yeah|yes|um+|uh+|so|okay|ok|it'?s|it is|on)[,.]?\s+)+/i, ''));
    }
  }
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
"emergency": true ONLY for danger or active damage: gas smell, fire/smoke/sparks, flooding/burst pipe, no heat in freezing weather, carbon monoxide, sewage flooding into the home. A clogged or backed-up toilet, sink or drain, a leaky faucet, or a broken AC on a mild day is NOT an emergency.
Never invent values. Never copy these instructions into values.`;

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'and', 'my', 'is', 'a', 'an', 'it', 'its', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'our', 'we', 'i', 'out', 'here', 'need', 'needs']);

/**
 * @param {string} text   caller utterance (final transcript)
 * @param {string} expecting which field the agent just asked for
 * @param {object} ctx {now, tz, emergencyKeywords, llm, slots, budgetMs}
 *
 * The rules answer at once. The model gets `budgetMs` (default: wait for it); if it is slower, the
 * reply goes out on the rules alone and `out.late` resolves with the model's grounded extras so the
 * agent can fill them in the background. The caller never waits on the model for a scripted line.
 */
async function understand(text, expecting, ctx) {
  if (expecting === 'address') text = wordsToDigits(unMoney(text));
  const r = rules(text, expecting, ctx);
  if (!ctx.llm) return r;
  // A short, clear yes/no to a confirm question needs no model round trip (saves ~0.6 s per turn).
  if ((r.yes || r.no) && !r.when && !r.emergency && String(text).trim().split(/\s+/).length <= 5) return r;
  // Same for a short answer the rules already fully understood ("Tomorrow morning.", "Jordan Avery.").
  const short = String(text).trim().split(/\s+/).length <= 4;
  if (short && !r.emergency && ((expecting === 'when' && r.when) || (expecting === 'confirm' && r.when) || (expecting === 'name' && r.name))) return r;
  const known = Object.entries(ctx.slots || {}).filter(([k, v]) => v && ['issue', 'name', 'address', 'phone'].includes(k)).map(([k, v]) => `${k}=${v}`).join('; ');
  const pending = ctx.llm.json(SYSTEM, `Already known: ${known || 'nothing yet'}.\nThe assistant just asked for: ${expecting}.\nCaller's latest words: "${text}"`)
    .then(j => (j && typeof j === 'object' ? grounded(j, text, ctx) : null)).catch(() => null);
  const budget = ctx.budgetMs;
  const j = budget === undefined ? await pending
    : await Promise.race([pending, new Promise(res => setTimeout(() => res(undefined), budget))]);
  if (j === undefined) return { ...r, late: pending };   // model still thinking: answer now, merge later
  if (!j) return r;                                      // model off / error: rules carry the call
  const out = { ...r };
  // The model's version is preferred when grounded: rules take the whole sentence as the "issue"
  // or "address", the model trims it to the part that matters.
  for (const k of ['name', 'address', 'issue']) if (j[k]) out[k] = j[k];
  if (!out.phone && j.phone) out.phone = j.phone;
  if (!out.when && j.when) out.when = j.when;
  if (j.emergency && !out.emergency) { out.emergency = true; out.emergencyReason = 'model'; }
  // Yes/no is never taken from the model: booking needs a clear affirmative in the caller's words
  // (live call: the model read "That work?" as yes).
  return out;
}

// Grounding guard: model-proposed text must come from what the caller actually said, so a model
// can tidy and reorder but never invent. Name/address: verbatim substring. Issue/time: at least 2/3
// of the phrase's content words are the caller's own (speech-to-text writes "back... up" where the
// model writes "backed up").
function grounded(j, text, ctx) {
  const said = norm(text);
  const verbatim = v => { const n = norm(v); return n.length >= 2 && said.includes(n); };
  const words = new Set(said.split(' '));
  const summarised = v => { const w = norm(v).split(' ').filter(x => x.length > 2 && !STOP.has(x)); return w.length > 0 && w.filter(x => words.has(x)).length * 3 >= w.length * 2; };
  const str = k => (typeof j[k] === 'string' && j[k].trim() ? j[k].trim() : null);
  const g = {};
  if (str('name') && verbatim(str('name'))) g.name = str('name');
  if (str('address') && verbatim(str('address')) && isStreetAddress(str('address'))) g.address = tidyAddress(str('address'));
  if (str('issue') && summarised(str('issue'))) g.issue = str('issue').charAt(0).toUpperCase() + str('issue').slice(1);
  if (j.phone) { const d = digitsOf(String(j.phone)); if (d) g.phone = d; }
  // A time must come from the caller's words too: the model once read "need someone to come out" as
  // "as soon as possible" and the agent offered a slot nobody asked for.
  if (str('when') && summarised(str('when'))) { const w = parseWhen(str('when'), ctx.now, ctx.tz); if (w) g.when = w; }
  if (j.emergency === true) g.emergency = true;
  return g;
}

module.exports = { understand, rules, cleanName, cleanAddress, digitsOf, isStreetAddress };
