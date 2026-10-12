'use strict';
// Google OAuth access tokens from a stored refresh token (no passwords, no SDK).
// The token file is created ONCE by `node tools/google-auth.js` — Scott signs in and approves on
// Google's own consent page; this code never sees a password.
// File shape: { client_id, client_secret, refresh_token, scopes: [...] }
const fs = require('fs');

function createGoogleAuth(tokenFile) {
  if (!tokenFile || !fs.existsSync(tokenFile)) return null;
  const cfg = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (!cfg.refresh_token || !cfg.client_id || !cfg.client_secret) return null;
  let cached = null;
  return {
    scopes: cfg.scopes || [],
    async token() {
      if (cached && cached.exp > Date.now() + 60000) return cached.value;
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token, grant_type: 'refresh_token' }),
      });
      const j = await res.json();
      if (!res.ok || !j.access_token) throw new Error(`google token refresh failed: ${res.status} ${j.error || ''}`);
      cached = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
      return cached.value;
    },
  };
}

module.exports = { createGoogleAuth };
