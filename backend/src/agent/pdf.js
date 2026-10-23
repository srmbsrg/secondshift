'use strict';
// Minimal one-page PDF writer (zero dependencies). Text only: Helvetica / Helvetica-Bold, ASCII-safe.
// Input: blocks [{ text, size?, bold?, gap?, color?, indent?, rule? }]. Long lines wrap; anything past the
// page bottom is cut and a footer says so (the packet must stay one page - the JSON is the complete record).
const W = 612, H = 792, M = 44;

const NARROW = "il.,:;'!|ijtf()[] ", WIDE = 'mwMW@%';
const charW = (c, size, bold) => size * (NARROW.includes(c) ? 0.28 : WIDE.includes(c) ? 0.83 : /[A-Z0-9$#&]/.test(c) ? 0.64 : 0.52) * (bold ? 1.05 : 1);
const textW = (s, size, bold) => [...s].reduce((a, c) => a + charW(c, size, bold), 0);

function ascii(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/…/g, '...').replace(/ /g, ' ').replace(/[•·]/g, '-').replace(/✓/g, '+')
    .replace(/[^\x20-\x7E\n]/g, '');
}
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(text, size, bold, maxW) {
  const out = [];
  for (const para of ascii(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (textW(next, size, bold) <= maxW || !line) line = next; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function renderPdf(blocks, { title = 'Document' } = {}) {
  const ops = []; let y = H - M; let cut = false;
  for (const b of blocks) {
    const size = b.size || 9, bold = !!b.bold, lead = size * 1.25;
    y -= b.gap || 0;
    for (const ln of wrap(b.text, size, bold, W - 2 * M - (b.indent || 0))) {
      if (y - lead < M) { cut = true; break; }
      y -= lead;
      const [r, g, bl] = b.color || [0.1, 0.1, 0.1];
      ops.push(`${r} ${g} ${bl} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf ${M + (b.indent || 0)} ${y.toFixed(1)} Td (${esc(ln)}) Tj ET`);
    }
    if (cut) break;
    if (b.rule) { y -= 4; ops.push(`0.75 0.75 0.75 RG 0.6 w ${M} ${y.toFixed(1)} m ${W - M} ${y.toFixed(1)} l S`); y -= 2; }
  }
  if (cut) ops.push(`0.5 0.1 0.1 rg BT /F1 7 Tf ${M} ${M - 14} Td (${esc('Page full - the JSON packet is the complete record.')}) Tj ET`);
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title (${esc(ascii(title))}) /Producer (SecondShift decision packet) >>`,
  ];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { buffer: Buffer.from(pdf, 'latin1'), cut };
}

module.exports = { renderPdf, ascii, wrap };
