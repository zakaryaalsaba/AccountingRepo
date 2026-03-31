function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(columns, rows) {
  const head = columns.map((c) => csvEscape(c.label || c.key)).join(',');
  const body = rows
    .map((r) => columns.map((c) => csvEscape(r[c.key])).join(','))
    .join('\n');
  return `${head}\n${body}\n`;
}

// Minimal one-page PDF builder (text-only). Good enough for report exports without external deps.
export function toSimplePdf(title, columns, rows) {
  const lines = [];
  lines.push(String(title || 'Report'));
  lines.push('');
  lines.push(columns.map((c) => String(c.label || c.key)).join(' | '));
  lines.push('-'.repeat(100));
  for (const r of rows) {
    lines.push(columns.map((c) => String(r[c.key] ?? '')).join(' | '));
  }
  const text = lines.join('\n');
  const esc = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const objects = [];
  objects.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj');
  objects.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj');
  objects.push('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj');
  const stream = `BT /F1 10 Tf 40 760 Td 12 TL (${esc.split('\n').join(') Tj T* (')}) Tj ET`;
  objects.push(`4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`);
  objects.push('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj}\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

