'use strict';
// Owner notifications. "gmail": Gmail API send with the same Google OAuth token as the calendar
// (scope gmail.send) — no SMTP password needed. "file": writes .eml-style text files to an outbox
// directory (development/tests).
const fs = require('fs'), path = require('path');

const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function rfc822({ from, to, subject, text }) {
  const subj = /[^\x20-\x7e]/.test(subject) ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=` : subject;
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subj}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', text].join('\r\n');
}

function gmailMailer({ auth, from }) {
  return {
    kind: 'gmail',
    async send(msg) {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { authorization: `Bearer ${await auth.token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: b64url(rfc822({ from, ...msg })) }),
      });
      if (!res.ok) throw new Error(`gmail send ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).id;
    },
  };
}

function fileMailer({ dir, from = 'secondshift@localhost' }) {
  return {
    kind: 'file',
    async send(msg) {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.eml`);
      fs.writeFileSync(f, rfc822({ from, ...msg }));
      return f;
    },
  };
}

module.exports = { gmailMailer, fileMailer, rfc822 };
