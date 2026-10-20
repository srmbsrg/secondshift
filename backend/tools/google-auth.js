'use strict';
// ONE-TIME Google consent for the pilot calendar + owner email. Run by Scott, interactively:
//
//   node tools/google-auth.js "C:\path\to\client_secret_XXXX.json"
//
// It prints a Google consent URL. Scott opens it, signs in to scottroymurphy.carb@gmail.com ON
// GOOGLE'S OWN PAGE, and approves. Google redirects back to this script on 127.0.0.1, which saves
// a refresh token to  <secrets>\secondshift_google_oauth.json. This script never sees a password.
//
// The client_secret JSON comes from Google Cloud Console (OAuth client, type "Desktop app").
const fs = require('fs'), http = require('http'), path = require('path');
const { loadSecrets } = require('../src/config');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/gmail.send'];

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('Usage: node tools/google-auth.js <client_secret.json from Google Cloud Console>'); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(file, 'utf8')); const c = j.installed || j.web;
  if (!c || !c.client_id || !c.client_secret) throw new Error('client_secret JSON missing client_id/client_secret');
  const out = loadSecrets().googleTokenFile;

  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', login_hint: 'scottroymurphy.carb@gmail.com',
  });
  console.log('\nOpen this URL, sign in as scottroymurphy.carb@gmail.com, and approve:\n\n' + url + '\n');

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); return res.end(); }
      const err = u.searchParams.get('error'), code = u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(err ? `Google returned: ${err}. You can close this tab.` : 'SecondShift is connected. You can close this tab.');
      err ? reject(new Error(err)) : resolve(code);
    });
  });
  server.close();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const tok = await res.json();
  if (!tok.refresh_token) throw new Error('No refresh token returned: ' + JSON.stringify(tok).slice(0, 200));
  fs.writeFileSync(out, JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: tok.refresh_token, scopes: SCOPES }, null, 2));
  console.log('Saved Google token to ' + out + ' (keep it out of git).');
}
main().catch(e => { console.error(e.message); process.exit(1); });
