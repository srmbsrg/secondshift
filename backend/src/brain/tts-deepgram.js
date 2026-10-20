'use strict';
// Text-to-speech via Deepgram Aura, returned directly as raw 8 kHz mu-law (no container) — exactly
// what a Twilio media stream plays, so there is no transcoding step on the hot path.
// Small in-memory cache so fixed lines (the disclosure greeting) are instant after the first call.

function createTts({ apiKey, model = 'aura-asteria-en', cacheSize = 64, endpoint = 'https://api.deepgram.com/v1/speak' }) {
  const cache = new Map();
  async function speak(text) {
    const key = model + '|' + text;
    if (cache.has(key)) return cache.get(key);
    const q = new URLSearchParams({ model, encoding: 'mulaw', sample_rate: '8000', container: 'none' });
    // Retry transient Deepgram failures (429/5xx, network) briefly — a caller is waiting on the line.
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${endpoint}?${q}`, {
          method: 'POST',
          headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (res.ok || !(res.status === 429 || res.status >= 500) || attempt >= 2) break;
      } catch (e) { if (attempt >= 2) throw e; }
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
    }
    if (!res.ok) throw new Error(`deepgram tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (cache.size >= cacheSize) cache.delete(cache.keys().next().value);
    cache.set(key, buf);
    return buf;
  }
  return { speak, model };
}

module.exports = { createTts };
