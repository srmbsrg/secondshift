'use strict';
// Early-access leads from the SecondShift page (and the Carborundum contact form).
// A lead is accepted only once it is STORED (append-only JSONL on the data volume); then the owner
// is told immediately on Telegram, and by email when Gmail is connected (local outbox otherwise).
// If storing fails the caller gets an error, never a fake success.
const fs = require('fs'), path = require('path');

const TRADES = ['hvac', 'plumbing', 'electrical', 'roofing', 'other'];
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function validate(body) {
  const lead = {
    name: clip(body.name, 120), company: clip(body.company || body.shop, 160), email: clip(body.email, 200).toLowerCase(),
    phone: clip(body.phone, 40), trade: clip(body.trade, 40).toLowerCase(), notes: clip(body.notes || body.message || body.teamSize, 1000),
    source: clip(body.source || 'secondshift', 40),
  };
  if (body.website || body.company_url) return { spam: true };          // honeypot fields humans never see
  const errors = [];
  if (!lead.name) errors.push('name');
  if (!lead.email && !lead.phone) errors.push('email or phone');
  if (lead.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) errors.push('valid email');
  if (lead.phone && lead.phone.replace(/\D/g, '').length < 10) errors.push('valid phone');
  if (lead.trade && !TRADES.includes(lead.trade)) lead.trade = 'other';
  return errors.length ? { errors } : { lead };
}

function createLeads({ dataDir, telegram, mailer, ownerEmail }) {
  const file = path.join(dataDir, 'leads', 'leads.jsonl');
  return {
    file,
    async submit(body, meta = {}) {
      const v = validate(body || {});
      if (v.spam) return { ok: true, spam: true };   // look successful to bots, store nothing
      if (v.errors) return { ok: false, status: 400, error: `Please add: ${v.errors.join(', ')}.` };
      const lead = { id: `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), ...v.lead, ip: meta.ip || null, ua: clip(meta.ua, 200) };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(lead) + '\n');   // throws -> caller returns 500
      const text = [`🟢 New SecondShift early-access lead (${lead.source})`, `${lead.name}${lead.company ? ' — ' + lead.company : ''}`,
        lead.trade ? `Trade: ${lead.trade}` : null, lead.phone ? `Phone: ${lead.phone}` : null, lead.email ? `Email: ${lead.email}` : null,
        lead.notes ? `Notes: ${lead.notes}` : null, `Time: ${lead.at}`, `Lead id: ${lead.id}`].filter(Boolean).join('\n');
      const notified = {};
      if (telegram) { try { await telegram.send(text); notified.telegram = true; } catch (e) { notified.telegram = 'failed: ' + e.message; } }
      if (mailer && ownerEmail) { try { await mailer.send({ to: ownerEmail, subject: `SecondShift lead: ${lead.name}${lead.company ? ' — ' + lead.company : ''}`, text }); notified.email = mailer.kind; } catch (e) { notified.email = 'failed: ' + e.message; } }
      fs.appendFileSync(path.join(path.dirname(file), 'notify.log'), JSON.stringify({ id: lead.id, at: new Date().toISOString(), ...notified }) + '\n');
      return { ok: true, id: lead.id, notified };
    },
  };
}

module.exports = { createLeads, validate };
