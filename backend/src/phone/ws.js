'use strict';
// Vendored from Tiny Paws v1.0 (GFS-Docs/ventures/si-phone-etiquette/service/lib, commit f1437b2).
// Minimal RFC 6455 WebSocket server (text frames, ping/pong, close, fragmentation).
// Enough for Twilio Media Streams; keeps the service dependency-free.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConnection extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.buf = Buffer.alloc(0); this.frag = null; this.closed = false;
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    socket.on('close', () => this._closed(1006));
    socket.on('error', e => { this.emit('error', e); this._closed(1006); });
  }
  _closed(code) { if (!this.closed) { this.closed = true; this.emit('close', code); } }
  _parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16 * 1024 * 1024) { this.close(1009); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = this.buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(need);
      if (op === 0x8) { this._send(0x8, payload.subarray(0, 2)); this.socket.end(); this._closed(payload.length >= 2 ? payload.readUInt16BE(0) : 1005); return; }
      if (op === 0x9) { this._send(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x0) { if (!this.frag) continue; this.frag.parts.push(payload); if (fin) { const all = Buffer.concat(this.frag.parts), o = this.frag.op; this.frag = null; this._deliver(o, all); } continue; }
      if (!fin) { this.frag = { op, parts: [payload] }; continue; }
      this._deliver(op, payload);
    }
  }
  _deliver(op, data) { this.emit('message', op === 0x1 ? data.toString('utf8') : data, op === 0x2); }
  _send(op, payload) {
    if (this.closed && op !== 0x8) return;
    // SecondShift change: never write to a socket that has already been ended/destroyed.
    if (this.socket.writableEnded || this.socket.destroyed) return;
    const len = payload.length; let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x80 | op;
    try { this.socket.write(Buffer.concat([h, payload])); } catch (e) { /* socket gone */ }
  }
  send(text) { this._send(0x1, Buffer.from(typeof text === 'string' ? text : JSON.stringify(text), 'utf8')); }
  close(code = 1000) { const b = Buffer.alloc(2); b.writeUInt16BE(code, 0); this._send(0x8, b); try { this.socket.end(); } catch (e) {} this._closed(code); }
}

/** Attach to an http.Server. onConnection(conn, req) is called for upgrades whose path matches. */
function attachWebSocket(server, path, onConnection) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    const ok = typeof path === 'function' ? path(url.pathname) : url.pathname === path;
    if (!ok || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    onConnection(new WsConnection(socket), req);
  });
}

module.exports = { attachWebSocket, WsConnection };
