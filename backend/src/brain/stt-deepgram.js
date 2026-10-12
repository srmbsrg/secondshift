'use strict';
// Streaming speech-to-text over Deepgram's live WebSocket API, fed raw 8 kHz mu-law from the
// phone line. Emits:
//   'speech-started'        caller began talking (used for barge-in)
//   'utterance' (text)      a finished caller turn (speech_final or UtteranceEnd)
//   'error' (err), 'close'
// Uses Node's built-in WebSocket client (Node >= 22); auth via the "token" subprotocol.
const { EventEmitter } = require('events');

function openDeepgramStream({ apiKey, model = 'nova-2-phonecall', endpointingMs = 400, utteranceEndMs = 1000, language = 'en-US', url: overrideUrl }) {
  const ev = new EventEmitter();
  const q = new URLSearchParams({
    model, language, encoding: 'mulaw', sample_rate: '8000', channels: '1',
    interim_results: 'true', smart_format: 'true', punctuate: 'true',
    endpointing: String(endpointingMs), utterance_end_ms: String(utteranceEndMs), vad_events: 'true',
  });
  const url = overrideUrl || `wss://api.deepgram.com/v1/listen?${q}`;
  const ws = new WebSocket(url, ['token', apiKey]);
  ws.binaryType = 'arraybuffer';
  let open = false, pending = [], finals = [], keepAlive = null, closed = false;

  const flush = () => {
    const text = finals.join(' ').replace(/\s+/g, ' ').trim();
    finals = [];
    if (text) ev.emit('utterance', text);
  };
  ws.addEventListener('open', () => {
    open = true;
    for (const b of pending) ws.send(b);
    pending = [];
    keepAlive = setInterval(() => { try { ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {} }, 5000);
  });
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')); } catch { return; }
    if (m.type === 'SpeechStarted') ev.emit('speech-started');
    else if (m.type === 'Results') {
      const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
      const text = alt && alt.transcript ? alt.transcript.trim() : '';
      if (m.is_final && text) finals.push(text);
      if (m.speech_final) flush();
    } else if (m.type === 'UtteranceEnd') flush();
  });
  ws.addEventListener('error', err => ev.emit('error', err && err.message ? err : new Error('deepgram websocket error')));
  ws.addEventListener('close', e => { clearInterval(keepAlive); closed = true; flush(); ev.emit('close', e.code); });

  ev.send = buf => {
    if (closed) return;
    if (open) { try { ws.send(buf); } catch {} } else pending.push(buf);
  };
  ev.close = () => {
    if (closed) return;
    try { if (open) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
    setTimeout(() => { try { ws.close(); } catch {} }, 1500);
  };
  return ev;
}

module.exports = { openDeepgramStream };
