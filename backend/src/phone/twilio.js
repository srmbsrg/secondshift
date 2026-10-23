'use strict';
// Twilio Media Streams adapter. parse/audio/mark/clear are the Tiny Paws v1.0 adapter
// (service/lib/providers.js, commit f1437b2), unchanged in behaviour. SecondShift adds the inbound
// TwiML: <Connect><Stream> for the AI conversation, then a <Redirect> that Twilio follows when the
// stream ends — that "after" step is how we transfer an emergency or hang up WITHOUT needing the
// Twilio REST API (no Account SID / Auth Token required for the MVP call path).
const crypto = require('crypto');

const CHUNK = 160; // 20 ms of 8 kHz mu-law
const chunks = (buf, n = CHUNK) => { const out = []; for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, i + n)); return out; };
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parse(m) {
  switch (m.event) {
    case 'start': return { type: 'start', callId: m.start.callSid, streamId: m.start.streamSid || m.streamSid, params: m.start.customParameters || {} };
    case 'media': return (m.media.track && m.media.track !== 'inbound') ? null : { type: 'audio', mulaw: Buffer.from(m.media.payload, 'base64') };
    case 'dtmf': return { type: 'dtmf', digit: String(m.dtmf.digit) };
    case 'mark': return { type: 'played', name: m.mark.name };
    case 'stop': return { type: 'stop' };
    default: return null;
  }
}
const audio = (sid, buf) => chunks(buf).map(c => ({ event: 'media', streamSid: sid, media: { payload: c.toString('base64') } }));
const mark = (sid, name) => [{ event: 'mark', streamSid: sid, mark: { name } }];
const clear = sid => [{ event: 'clear', streamSid: sid }];

/** Inbound answer: stream the call to us, then come back to `afterUrl` when the stream closes. */
function answerTwiml({ wsUrl, afterUrl, tenant, from, callSid }) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEsc(wsUrl)}">` +
    `<Parameter name="tenant" value="${xmlEsc(tenant)}"/><Parameter name="from" value="${xmlEsc(from || '')}"/>` +
    `<Parameter name="callSid" value="${xmlEsc(callSid || '')}"/></Stream></Connect>` +
    `<Redirect method="POST">${xmlEsc(afterUrl)}</Redirect></Response>`;
}
const dialTwiml = number => `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${xmlEsc(number)}</Dial></Response>`;
const hangupTwiml = () => `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
const sayHangupTwiml = text => `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEsc(text)}</Say><Hangup/></Response>`;

/**
 * X-Twilio-Signature check (HMAC-SHA1 of full URL + sorted POST params).
 * Fails CLOSED: with no auth token configured every request is rejected, unless the caller passes
 * { allowUnsigned: true } (local dev only, via SECONDSHIFT_ALLOW_UNSIGNED_TWILIO=1; never in production).
 */
function validSignature(authToken, signature, url, params, opts = {}) {
  if (!authToken) return !!opts.allowUnsigned;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature || ''))); } catch { return false; }
}

module.exports = { name: 'twilio', parse, audio, mark, clear, answerTwiml, dialTwiml, hangupTwiml, sayHangupTwiml, validSignature };
