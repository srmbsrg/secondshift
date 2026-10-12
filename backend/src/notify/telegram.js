'use strict';
// Instant alerts to the owner's Telegram (Bot API sendMessage). Never throws into a call: a failed
// alert is logged by the caller and the call carries on.
function createTelegram({ token, chatId, timeoutMs = 8000 }) {
  if (!token || !chatId) return null;
  return {
    kind: 'telegram',
    async send(text) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(`telegram ${res.status}: ${j.description || 'send failed'}`);
        return j.result && j.result.message_id;
      } finally { clearTimeout(t); }
    },
  };
}
module.exports = { createTelegram };
