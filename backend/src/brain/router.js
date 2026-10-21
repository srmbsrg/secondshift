'use strict';
// Model router: one brain interface (.json / .chatJson / .warm, same contract as llm.js) over an
// ordered chain of providers. Local / free models go first; paid models are a fallback behind a
// monthly budget cap; when nothing answers, callers fall back to rules (phone) or canned answers
// (site chat). Swapping models is a config change (env), not a code change.
//
//   SECONDSHIFT_LLM_CHAIN        e.g. "local,abacus"   (default: local if LOCAL_LLM_BASE_URL is set, then the paid key we have)
//   SECONDSHIFT_LLM_CHAIN_CALL   optional per-task override for the live phone call
//   SECONDSHIFT_LLM_CHAIN_CHAT   optional per-task override for the website chat helper
//   LOCAL_LLM_BASE_URL           OpenAI-compatible server we run (Ollama / llama.cpp), e.g. http://10.0.0.5:11434/v1
//   LOCAL_LLM_MODEL              default llama3.1:8b       LOCAL_LLM_TIMEOUT_MS  default 8000
//   SECONDSHIFT_AI_BUDGET_USD    monthly cap on PAID model spend (default 5). 0 = paid models off.
//   SECONDSHIFT_LLM_PROVIDER     legacy single-provider switch, still honoured ("none" = rules only)
//
// Alerts (Telegram to Scott, rate-limited): a paid provider says it is out of credit / quota
// (HTTP 402, or 429 "insufficient_quota" / "no remaining credits"), a provider fails 3 times in a
// row, and paid spend crosses 80% and 100% of the monthly cap.

const fs = require('fs'), path = require('path');
const { createLlm } = require('./llm');

// List prices, USD per 1M tokens [input, output], checked Oct 2026 on the vendors' pricing pages.
// Unknown paid models are metered at a deliberately high price so the cap errs on the safe side.
const PRICES = {
  'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5': [1, 5], 'claude-haiku-4-5-20251001': [1, 5],
  'gpt-6-luna': [0.10, 0.50], 'gpt-6.1-sol': [2, 10],
};
const UNKNOWN_PRICE = [5, 15];

function priceOf(model, overrides = {}) { return overrides[model] || PRICES[model] || UNKNOWN_PRICE; }
function costUsd(model, usage, overrides) {
  const [pin, pout] = priceOf(model, overrides);
  return ((usage.input || 0) * pin + (usage.output || 0) * pout) / 1e6;
}
const monthOf = d => new Date(d).toISOString().slice(0, 7);

/** Monthly paid-spend meter, persisted to a small JSON file (survives restarts on a volume). */
function createBudget({ file = null, capUsd = 5, now = () => Date.now() } = {}) {
  let st = { month: monthOf(now()), spentUsd: 0, calls: 0, alerted: {} };
  try { if (file && fs.existsSync(file)) st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* corrupt -> start fresh */ }
  const roll = () => { const m = monthOf(now()); if (st.month !== m) st = { month: m, spentUsd: 0, calls: 0, alerted: {} }; };
  const save = () => { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(st)); } catch { /* metering must never break a call */ } };
  return {
    capUsd,
    allow() { roll(); return capUsd > 0 && st.spentUsd < capUsd; },
    add(usd) { roll(); st.spentUsd += usd; st.calls += 1; save(); return st.spentUsd; },
    /** true the first time a threshold is crossed this month (so the alert fires once). */
    crossed(pct) { roll(); const k = 'p' + pct; if (st.alerted[k] || st.spentUsd < capUsd * pct / 100) return false; st.alerted[k] = true; save(); return true; },
    state() { roll(); return { month: st.month, spentUsd: +st.spentUsd.toFixed(6), capUsd, paidCalls: st.calls, capped: !(capUsd > 0 && st.spentUsd < capUsd) }; },
  };
}

/** Telegram alerts with a per-kind cooldown so an outage pages Scott once, not once per caller. */
function createAlerts({ telegram = null, cooldownMs = 6 * 3600e3, now = () => Date.now(), log = () => {} } = {}) {
  const last = new Map(); const sent = [];
  return {
    sent,
    notify(kind, text) {
      const t = now(); if (last.has(kind) && t - last.get(kind) < cooldownMs) return false;
      last.set(kind, t); sent.push({ kind, text, at: t }); log(`[ai-alert] ${kind}: ${text}`);
      if (telegram) telegram.send(text).catch(e => log(`[ai-alert] telegram failed: ${e.message}`));
      return true;
    },
  };
}

const outOfCredit = m => m && (m.status === 402 || /insufficient_quota|no remaining credits|out of credits?|credit balance|billing/i.test(m.error || ''));

/**
 * @param {{task:string, providers:object[], budget:object, alerts:object, priceOverrides?:object, label?:string}} o
 *   providers: llm.js clients in order (null entries are skipped).
 */
function createRouter({ task = 'default', providers = [], budget, alerts, priceOverrides = {}, product = 'SecondShift' }) {
  const chain = providers.filter(Boolean);
  if (!chain.length) return null;
  const fails = new Map(); let lastError = null, lastServedBy = null;
  const label = p => `${p.provider}:${p.model}`;

  async function run(method, args, metaIndex) {
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i];
      if (p.paid && !budget.allow()) { lastError = { provider: label(p), error: 'monthly AI budget cap reached', at: new Date().toISOString() }; continue; }
      const meta = {};
      const a = args.slice();
      if (method === 'json') a[metaIndex] = meta; else a[metaIndex] = { ...(a[metaIndex] || {}), meta };
      const out = await p[method](...a);
      if (p.paid && meta.usage) {
        budget.add(costUsd(p.model, meta.usage, priceOverrides));
        const s = budget.state();
        if (budget.crossed(100)) alerts.notify('budget100', `🛑 ${product} AI: paid model spend hit the monthly cap ($${s.spentUsd.toFixed(2)} of $${s.capUsd}). Paid models are now OFF until next month; phone runs on rules, site chat on canned answers. Raise SECONDSHIFT_AI_BUDGET_USD to resume.`);
        else if (budget.crossed(80)) alerts.notify('budget80', `⚠️ ${product} AI: paid model spend is at 80% of the monthly cap ($${s.spentUsd.toFixed(2)} of $${s.capUsd}).`);
      }
      if (out) { fails.set(label(p), 0); lastServedBy = label(p); return out; }
      lastError = { provider: label(p), status: meta.status || null, error: meta.error || 'empty/unparseable reply', at: new Date().toISOString() };
      const n = (fails.get(label(p)) || 0) + 1; fails.set(label(p), n);
      const next = chain.slice(i + 1).map(label).join(' -> ') || (task === 'chat' ? 'canned answers' : 'rules only');
      if (p.paid && outOfCredit(meta)) {
        alerts.notify(`credit:${label(p)}`, `🔋 ${product} AI (${task}): ${label(p)} reports it is OUT OF CREDIT (HTTP ${meta.status}). Falling back to ${next}. Top-up is a money decision - yours.`);
      } else if (n === 3) {
        alerts.notify(`down:${label(p)}`, `⚠️ ${product} AI (${task}): ${label(p)} failed 3 times in a row (${meta.status || meta.error || 'no reply'}). Falling back to ${next}.`);
      }
    }
    return null;
  }

  return {
    task, provider: chain.map(p => p.provider).join('>'), model: chain.map(p => p.model).join('>'),
    chain: chain.map(label),
    warm() { const p = chain.find(x => !x.paid || budget.allow()); return p && p.warm ? p.warm() : Promise.resolve(null); },
    json(system, user) { return run('json', [system, user, undefined], 2); },
    chatJson(system, messages, opts = {}) { return run('chatJson', [system, messages, opts], 2); },
    status() { return { task, chain: chain.map(l => `${label(l)}${l.paid ? ' (paid)' : ' (free)'}`), lastServedBy, lastError }; },
  };
}

const PAID_KEYS = { abacus: 'abacusKey', anthropic: 'anthropicKey', openai: 'llmKey' };

/** One provider client from a chain entry name. */
function providerFromName(name, env, secrets) {
  const n = name.trim().toLowerCase();
  if (!n || n === 'none') return null;
  if (n === 'local' || n === 'ollama') {
    const baseUrl = env.LOCAL_LLM_BASE_URL || (n === 'ollama' ? env.SECONDSHIFT_LLM_BASE_URL : null);
    if (!baseUrl) return null; // no local server configured here -> skip it
    return createLlm({ provider: 'local', baseUrl, model: env.LOCAL_LLM_MODEL || (n === 'ollama' && env.SECONDSHIFT_LLM_MODEL) || undefined, apiKey: env.LOCAL_LLM_KEY || '', timeoutMs: +env.LOCAL_LLM_TIMEOUT_MS || 8000 });
  }
  const legacy = (env.SECONDSHIFT_LLM_PROVIDER || '').toLowerCase() === n;
  return createLlm({ provider: n, apiKey: secrets[PAID_KEYS[n]] || (n === 'openai' ? secrets.llmKey : ''),
    baseUrl: legacy ? env.SECONDSHIFT_LLM_BASE_URL : undefined, model: legacy ? env.SECONDSHIFT_LLM_MODEL : undefined,
    timeoutMs: +env.SECONDSHIFT_LLM_TIMEOUT_MS || undefined, reasoningEffort: env.SECONDSHIFT_LLM_REASONING });
}

/** Default chain: local first (when a local server is configured), then whichever paid key we hold. */
function chainFromEnv(env, secrets, task) {
  const explicit = env[`SECONDSHIFT_LLM_CHAIN_${task.toUpperCase()}`] || env.SECONDSHIFT_LLM_CHAIN;
  if (explicit) return explicit.split(',');
  const legacy = (env.SECONDSHIFT_LLM_PROVIDER || '').toLowerCase();
  if (legacy === 'none') return [];
  if (legacy) return [legacy];
  const paid = secrets.anthropicKey ? 'anthropic' : secrets.abacusKey ? 'abacus' : secrets.llmKey ? 'openai' : null;
  return ['local', paid].filter(Boolean);
}

/** Build the per-task routers sharing one budget and one alert channel. */
function createRoutersFromEnv(env, secrets, { telegram = null, dataDir = null, now, log = (...a) => console.error(...a) } = {}) {
  const cap = env.SECONDSHIFT_AI_BUDGET_USD !== undefined && env.SECONDSHIFT_AI_BUDGET_USD !== '' ? +env.SECONDSHIFT_AI_BUDGET_USD : 5;
  const budget = createBudget({ file: dataDir ? path.join(dataDir, 'ai-budget.json') : null, capUsd: Number.isFinite(cap) ? cap : 5, now });
  const alerts = createAlerts({ telegram: env.SECONDSHIFT_AI_ALERTS === 'off' ? null : telegram, now, log: m => log(m) });
  let priceOverrides = {}; try { if (env.SECONDSHIFT_AI_PRICES) priceOverrides = JSON.parse(env.SECONDSHIFT_AI_PRICES); } catch { /* ignore */ }
  const make = task => createRouter({ task, providers: chainFromEnv(env, secrets, task).map(n => providerFromName(n, env, secrets)), budget, alerts, priceOverrides });
  return { call: make('call'), chat: make('chat'), budget, alerts };
}

module.exports = { createRouter, createBudget, createAlerts, createRoutersFromEnv, chainFromEnv, costUsd, outOfCredit, PRICES };
