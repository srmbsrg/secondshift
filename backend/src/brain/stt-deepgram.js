'use strict';
// Streaming speech-to-text over Deepgram's live WebSocket API, fed raw 8 kHz mu-law from the
// phone line. Emits:
//   'speech-started'        Deepgram VAD heard sound (informational; noise triggers it too)
//   'speech-words' (text)   interim words while the caller is talking (used for barge-in)
//   'utterance' (text)      a finished caller turn
//   'error' (err), 'close'
// Uses Node's built-in WebSocket client (Node >= 22); auth via the "token" subprotocol.
//
// Turn-taking: Deepgram's speech_final fires after a short pause (endpointing), which on a real call
// is often mid-thought ("My name is Scott, we have a backed-up toilet ... [pause] ... need someone
// to come out"). So a speech_final only starts a HOLD: if the caller keeps talking before it
// expires, the words join the same turn. The hold is longer when the turn looks unfinished
// (ends in a bare number, "and", "um", a comma), e.g. someone reading out an address.
const { EventEmitter } = require('events');

const UNFINISHED = /(\b\d+|\b(and|um+|uh+|so|but|or|the|at|on|in|to|for|near|it's|its|is|my|our)|[,-])\s*$/i;

function openDeepgramStream({ apiKey, model = 'nova-2-phonecall', endpointingMs = 400, utteranceEndMs = 1000,
  holdMs = 1000, unfinishedHoldMs = 1600, language = 'en-US', url: overrideUrl }) {
  const ev = new EventEmitter();
  const q = new URLSearchParams({
    model, language, encoding: 'mulaw', sample_rate: '8000', channels: '1',
    interim_results: 'true', smart_format: 'true', punctuate: 'true',
    endpointing: String(endpointingMs), utterance_end_ms: String(utteranceEndMs), vad_events: 'true',
  });
  const url = overrideUrl || `wss://api.deepgram.com/v1/listen?${q}`;
  const ws = new WebSocket(url, ['token', apiKey]);
  ws.binaryType = 'arraybuffer';
  let open = false, pending = [], finals = [], keepAlive = null, closed = false, hold = null;
  let interim = '';      // latest not-yet-final words (only used to notice a stall)
  let lastWords = '';    // last words reported as 'speech-words' (only NEW words count as talking)
  let stale = null;      // asks Deepgram to finalize an interim it is sitting on
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/ +/g, ' ').trim();
  // Only FINAL text is ever used. When Deepgram stalls on an interim (sim: ~9 s with no final), we
  // send its Finalize control message, which returns the pending words as a final right away.
  const finalize = () => { try { if (open && !closed) ws.send(JSON.stringify({ type: 'Finalize' })); } catch {} };

  const flush = () => {
    if (process.env.SECONDSHIFT_STT_DEBUG) console.log(`[stt ${Date.now() % 100000}] FLUSH`);
    clearTimeout(hold); hold = null;
    const text = finals.join(' ').replace(/\s+/g, ' ').trim();
    finals = [];
    if (text) ev.emit('utterance', text);
  };
  const startHold = () => {
    clearTimeout(hold);
    const sofar = finals.join(' ').trim();
    hold = setTimeout(flush, UNFINISHED.test(sofar) ? unfinishedHoldMs : holdMs);
  };
  ws.addEventListener('open', () => {
    open = true;
    for (const b of pending) ws.send(b);
    pending = [];
    keepAlive = setInterval(() => { try { ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {} }, 5000);
  });
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')); } catch { return; }
    if (process.env.SECONDSHIFT_STT_DEBUG) console.log(`[stt ${Date.now() % 100000}] ${m.type}${m.type === 'Results' ? ` final=${m.is_final} sf=${m.speech_final} fin=${!!m.from_finalize} "${(m.channel.alternatives[0] || {}).transcript || ''}"` : ''}`);
    if (m.type === 'SpeechStarted') ev.emit('speech-started');
    else if (m.type === 'Results') {
      const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
      const text = alt && alt.transcript ? alt.transcript.trim() : '';
      // Deepgram re-sends the same interim while it decides; only NEW words mean the caller is still talking.
      if (text && norm(text) !== norm(lastWords)) { lastWords = text; clearTimeout(hold); hold = null; ev.emit('speech-words', text); }
      clearTimeout(stale);
      if (m.is_final) { if (text) finals.push(text); interim = ''; }
      // Safety net for Deepgram sitting on an interim (sim: 9-17 s): 3 s unchanged is never live speech
      // (interims update about every second while someone talks); 1.5 s was too short and cut a caller off.
      else if (text) { interim = text; stale = setTimeout(() => { if (interim === text) finalize(); }, 3000); }
      if ((m.speech_final || m.from_finalize) && finals.length) startHold();
    } else if (m.type === 'UtteranceEnd') {
      if (interim) finalize(); // words still pending: get them as a final, then the hold starts
      else if (finals.length && !hold) startHold();
    }
  });
  ws.addEventListener('error', err => ev.emit('error', err && err.message ? err : new Error('deepgram websocket error')));
  ws.addEventListener('close', e => { clearInterval(keepAlive); clearTimeout(stale); closed = true; flush(); ev.emit('close', e.code); });

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

module.exports = { openDeepgramStream, UNFINISHED };
