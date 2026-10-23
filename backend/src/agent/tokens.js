'use strict';
// Demo-shop agent tokens. Any AI agent may request one: it can ONLY touch the demo shop (the public demo line's
// QA test calls, the decision packet, Stripe TEST-mode checkout). It never reaches a real shop's data.
// - Only a SHA-256 hash is stored; the token is shown once.
// - Scoped, expires (24h default), revocable by the holder (DELETE /agent/token) or the operator (revokeAll).
// - Every use is audited (agent/audit.jsonl: route, token id, outcome - never the token or customer data).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEMO_TENANT = 'demo';
const DEMO_SCOPES = ['packet:create', 'testdrive:read', 'testdrive:run', 'checkout:create'];
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function createTokenStore({ file, ttlHours = 24, now = () => Date.now() } = {}) {
  let db = { tokens: [] };
  if (file) { try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ } }
  const save = () => { if (!file) return; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); };
  const find = (token) => {
    if (!token) return null; const h = Buffer.from(sha(token));
    return db.tokens.find((t) => t.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(t.hash), h)) || null;
  };
  return {
    issue({ label = '' } = {}) {
      const token = 'ssd_' + crypto.randomBytes(24).toString('base64url');
      const t = now();
      const rec = { id: 'tok_' + crypto.randomBytes(6).toString('hex'), hash: sha(token), tenant: DEMO_TENANT, scopes: DEMO_SCOPES.slice(),
        label: String(label).slice(0, 80), createdAt: new Date(t).toISOString(), expiresAt: new Date(t + ttlHours * 36e5).toISOString(), revokedAt: null };
      db.tokens = db.tokens.filter((x) => Date.parse(x.expiresAt) > t - 7 * 864e5); // keep a week of history
      db.tokens.push(rec); save();
      return { token, id: rec.id, tenant: rec.tenant, scopes: rec.scopes, expiresAt: rec.expiresAt };
    },
    verify(token, scope) {
      const t = find(token);
      if (!t) return { ok: false, status: 401, error: 'missing or unknown token - POST /agent/token first' };
      if (t.revokedAt) return { ok: false, status: 401, error: 'token revoked' };
      if (Date.parse(t.expiresAt) <= now()) return { ok: false, status: 401, error: 'token expired' };
      if (t.tenant !== DEMO_TENANT) return { ok: false, status: 403, error: 'demo tenant only' };
      if (scope && !t.scopes.includes(scope)) return { ok: false, status: 403, error: `token lacks scope ${scope}` };
      return { ok: true, principal: { tokenId: t.id, tenant: t.tenant, scopes: t.scopes } };
    },
    revoke(token) { const t = find(token); if (!t || t.revokedAt) return false; t.revokedAt = new Date(now()).toISOString(); save(); return true; },
    revokeAll() { let n = 0; for (const t of db.tokens) if (!t.revokedAt) { t.revokedAt = new Date(now()).toISOString(); n++; } save(); return n; },
    count() { return db.tokens.filter((t) => !t.revokedAt && Date.parse(t.expiresAt) > now()).length; },
  };
}

// Fixed-window counters keyed by any string (IP, token id, 'global').
function createLimiter({ now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    peek(key, max, windowMs) {
      const t = now(); const arr = (hits.get(key) || []).filter((x) => x > t - windowMs);
      return arr.length >= max ? { ok: false, retryAfterSec: Math.ceil((arr[0] + windowMs - t) / 1000) } : { ok: true };
    },
    take(key, max, windowMs) {
      const t = now(); const arr = (hits.get(key) || []).filter((x) => x > t - windowMs);
      if (arr.length >= max) { hits.set(key, arr); return { ok: false, retryAfterSec: Math.ceil((arr[0] + windowMs - t) / 1000) }; }
      arr.push(t); hits.set(key, arr); return { ok: true };
    },
  };
}

function createAudit(file) {
  return {
    log(entry) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
      catch (e) { console.error('agent audit write failed', e.message); }
    },
  };
}

module.exports = { createTokenStore, createLimiter, createAudit, DEMO_TENANT, DEMO_SCOPES, sha };
