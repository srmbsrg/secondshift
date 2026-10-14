'use strict';
// Runtime config: shop ("tenant") files + secrets. Secrets are read from files at runtime and
// never committed (default dir: C:\Users\scott\secrets, override with SECONDSHIFT_SECRETS_DIR).
const fs = require('fs'), path = require('path');

const AI_WORDS = /\b(automated|a\.?i\.?|artificial|virtual) (assistant|agent|system)|\bautomated\b/i;

/** Compliance lint (same idea as Tiny Paws): a shop won't load unless the opening line identifies the
 *  business, discloses the automated assistant, and — if anything is stored — says the call is recorded. */
function lintTenant(t) {
  const errors = [];
  for (const k of ['id', 'shopName', 'timezone', 'disclosure', 'hours']) if (!t[k]) errors.push(`missing ${k}`);
  const opening = String(t.disclosure || '').replace(/\{shop\}/g, t.shopName || '');
  if (t.shopName && !opening.toLowerCase().includes(t.shopName.toLowerCase())) errors.push('disclosure must name the shop');
  if (!AI_WORDS.test(opening)) errors.push('disclosure must say the call is answered by an automated / AI assistant');
  const rec = t.recording || {};
  if ((rec.storeAudio || rec.storeTranscript !== false) && !/\brecord/i.test(opening)) errors.push('disclosure must say the call is recorded when audio or transcripts are stored');
  try { new Intl.DateTimeFormat('en-US', { timeZone: t.timezone }); } catch { errors.push('invalid timezone'); }
  const em = t.emergency || {};
  if (em.transferNumber && !/^\+\d{8,15}$/.test(em.transferNumber)) errors.push('emergency.transferNumber must be E.164, e.g. +18325550123');
  return errors;
}

function loadTenants(dir) {
  const tenants = {}, problems = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const errs = lintTenant(t);
    if (errs.length) problems[t.id || f] = errs; else tenants[t.id] = t;
  }
  return { tenants, problems };
}

function readSecret(dir, file) {
  const p = path.join(dir, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
}

function loadSecrets(env = process.env) {
  const dir = env.SECONDSHIFT_SECRETS_DIR || 'C:\\Users\\scott\\secrets';
  return {
    dir,
    deepgramKey: env.DEEPGRAM_API_KEY || readSecret(dir, 'Deepgram_api.txt'),
    resendKey: env.RESEND_API_KEY || readSecret(dir, 'Resend_API.txt'),
    telegramToken: env.TELEGRAM_BOT_TOKEN || readSecret(dir, 'Telegram_bot_token.txt'),
    telegramChatId: env.TELEGRAM_CHAT_ID || '6735511617',
    llmKey: env.SECONDSHIFT_LLM_KEY || readSecret(dir, 'secondshift_llm_key.txt'),
    abacusKey: env.ABACUS_API_KEY || readSecret(dir, 'SecondShift_Abacus_API.txt'),
    anthropicKey: env.ANTHROPIC_API_KEY || readSecret(dir, 'anthropic_api_key.txt'),
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || readSecret(dir, 'twilio_account_sid.txt'),
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || readSecret(dir, 'twilio_auth_token.txt'),
    googleTokenFile: env.SECONDSHIFT_GOOGLE_TOKEN || path.join(dir, 'secondshift_google_oauth.json'),
  };
}

module.exports = { lintTenant, loadTenants, loadSecrets, AI_WORDS };
