'use strict';
// Vendored from Tiny Paws v1.0 (GFS-Docs/ventures/si-phone-etiquette/service/lib, commit f1437b2).
// G.711 mu-law codec + tiny WAV reader + silence trim. No dependencies.

const BIAS = 0x84, CLIP = 32635;

function linearToMulaw(sample) {            // sample: int16
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

const MULAW_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff, sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let s = ((mantissa << 3) + BIAS) << exponent; s -= BIAS;
  MULAW_TABLE[i] = sign ? -s : s;
}
function mulawToLinear(b) { return MULAW_TABLE[b]; }

/** mu-law bytes -> Float32 samples (-1..1) */
function decodeMulaw(buf) {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_TABLE[buf[i]] / 32768;
  return out;
}
/** Float32 samples -> mu-law Buffer */
function encodeMulaw(f32) {
  const out = Buffer.alloc(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = linearToMulaw(Math.round(v * 32767));
  }
  return out;
}

/** Reads a PCM16 WAV. Returns {sr, samples: Float32Array (mono, first channel)}. */
function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, sr = 0, ch = 1, bits = 16, data = null;
  while (o + 8 <= buffer.length) {
    const id = buffer.toString('ascii', o, o + 4), sz = buffer.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = buffer.readUInt16LE(o + 10); sr = buffer.readUInt32LE(o + 12); bits = buffer.readUInt16LE(o + 22); }
    if (id === 'data') data = buffer.subarray(o + 8, o + 8 + sz);
    o += 8 + sz + (sz & 1);
  }
  if (!data || bits !== 16) throw new Error('need 16-bit PCM WAV');
  const n = Math.floor(data.length / 2 / ch), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * ch) / 32768;
  return { sr, samples: x };
}

/** Naive but adequate resampler (linear interpolation, with 2-tap averaging when downsampling). */
function resample(x, from, to) {
  if (from === to) return x;
  const ratio = from / to, n = Math.floor(x.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, j = Math.floor(p), f = p - j;
    const a = x[j] || 0, b = x[j + 1] !== undefined ? x[j + 1] : a;
    let v = a + (b - a) * f;
    if (ratio > 1.5) { let s = 0, c = 0; for (let k = Math.max(0, Math.round(p - ratio / 2)); k < Math.min(x.length, Math.round(p + ratio / 2)); k++) { s += x[k]; c++; } if (c) v = s / c; }
    out[i] = v;
  }
  return out;
}

/** Trim leading/trailing silence so the first word starts on the first sample (matters for time-to-first-word). */
function trimSilence(x, sr, thrDb = -42, padMs = 10) {
  const f = Math.round(sr / 100), n = Math.floor(x.length / f), db = i => { let e = 0; for (let k = i * f; k < (i + 1) * f; k++) e += x[k] * x[k]; return 10 * Math.log10(e / f + 1e-12); };
  let a = 0, b = n - 1;
  while (a < n && db(a) <= thrDb) a++;
  while (b > a && db(b) <= thrDb) b--;
  if (a >= n) return x;
  const pad = Math.round(padMs * sr / 1000);
  return x.subarray(Math.max(0, a * f - pad), Math.min(x.length, (b + 1) * f + pad));
}

module.exports = { linearToMulaw, mulawToLinear, decodeMulaw, encodeMulaw, readWav, resample, trimSilence };
