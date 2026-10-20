'use strict';
// Wrap raw 8 kHz mu-law in a WAV container (format 7 = mu-law). Only used when a shop turns
// recording.storeAudio on.
function encodeWavMulaw(mulaw, sampleRate = 8000) {
  const h = Buffer.alloc(58);
  h.write('RIFF', 0); h.writeUInt32LE(50 + mulaw.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(18, 16); h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.writeUInt16LE(0, 36);
  h.write('fact', 38); h.writeUInt32LE(4, 42); h.writeUInt32LE(mulaw.length, 46);
  h.write('data', 50); h.writeUInt32LE(mulaw.length, 54);
  return Buffer.concat([h, mulaw]);
}
module.exports = { encodeWavMulaw };
