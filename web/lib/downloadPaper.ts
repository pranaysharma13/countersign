import type { PaperModel } from './stationery';

export function paperFilename(p: PaperModel): string {
  const safe = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe(p.firm)}_${safe(p.title)}_${safe(p.number)}.pdf`;
}

export async function downloadPaper(p: PaperModel): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const left = 54;
  const right = pageW - 54;
  let y = 56;

  doc.setFillColor(20, 20, 20);
  doc.rect(right - 168, y - 6, 168, 52, 'F');
  doc.setTextColor(200, 195, 182);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(p.title.toUpperCase(), right - 12, y + 10, { align: 'right' });
  doc.setTextColor(244, 241, 234);
  doc.setFontSize(16);
  doc.text(p.number, right - 12, y + 32, { align: 'right' });

  doc.setTextColor(26, 26, 24);
  doc.setFontSize(16);
  doc.text(p.firm, left, y + 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(107, 103, 94);
  const headLines = p.firmSub.flatMap(s => doc.splitTextToSize(s, right - 168 - left - 20) as string[]);
  headLines.forEach((s, i) => doc.text(s, left, y + 28 + i * 12));

  y += Math.max(68, 40 + headLines.length * 12);
  doc.setFillColor(20, 20, 20);
  doc.rect(left, y, right - left, 2, 'F');
  y += 28;

  doc.setTextColor(107, 103, 94);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text(p.partyLabel.toUpperCase(), left, y);
  doc.setTextColor(26, 26, 24);
  doc.setFontSize(12);
  doc.text(p.partyName, left, y + 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(107, 103, 94);
  const partyLines = p.partySub.flatMap(s => doc.splitTextToSize(s, right - 200 - left - 16) as string[]);
  partyLines.forEach((s, i) => doc.text(s, left, y + 30 + i * 12));

  let metaY = y;
  p.fields.forEach(f => {
    doc.setTextColor(107, 103, 94);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(f.k, right - 200, metaY);
    doc.setTextColor(26, 26, 24);
    doc.setFont('helvetica', 'bold');
    const val = doc.splitTextToSize(f.v, 116) as string[];
    doc.text(val, right, metaY, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    metaY += 4 + val.length * 12;
  });

  y = Math.max(y + 30 + partyLines.length * 12, metaY) + 22;

  if (p.lines.length) {
    const cols = [
      { k: '#', w: 28, align: 'left' as const, pad: 0 },
      { k: 'Description', w: 212, align: 'left' as const, pad: 0 },
      { k: 'Qty', w: 56, align: 'right' as const, pad: 0 },
      { k: 'Unit', w: 56, align: 'left' as const, pad: 12 },
      { k: 'Unit price', w: 80, align: 'right' as const, pad: 0 },
      { k: 'Amount', w: 72, align: 'right' as const, pad: 0 },
    ];
    const cell = (s: string | string[], x: number, c: (typeof cols)[number]) =>
      doc.text(s, c.align === 'right' ? x + c.w : x + c.pad, y, { align: c.align });
    const header = () => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(107, 103, 94);
      let hx = left;
      cols.forEach(c => { cell(c.k.toUpperCase(), hx, c); hx += c.w; });
      y += 6;
      doc.setFillColor(20, 20, 20);
      doc.rect(left, y, right - left, 1.2, 'F');
      y += 16;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(26, 26, 24);
    };
    header();
    p.lines.forEach(row => {
      const vals = [row.no, row.desc, row.qty, row.unit, row.price, row.amount];
      const wrapped = cols.map((c, i) => doc.splitTextToSize(vals[i], c.w - c.pad - 6) as string[]);
      const h = Math.max(...wrapped.map(w => w.length)) * 12 + 6;
      if (y + h > pageH - 72) { doc.addPage(); y = 56; header(); }
      let x = left;
      cols.forEach((c, i) => { cell(wrapped[i], x, c); x += c.w; });
      y += h;
    });
  }

  if (p.totals.length) {
    y += 10;
    if (y + p.totals.length * 18 > pageH - 72) { doc.addPage(); y = 56; }
    p.totals.forEach(r => {
      doc.setFont('helvetica', r.strong ? 'bold' : 'normal');
      doc.setFontSize(r.strong ? 12 : 10);
      doc.setTextColor(r.strong ? 20 : 107, r.strong ? 20 : 103, r.strong ? 20 : 94);
      doc.text(r.k, right - 200, y);
      doc.text(r.v, right, y, { align: 'right' });
      if (r.strong) {
        doc.setFillColor(20, 20, 20);
        doc.rect(right - 200, y - 14, 200, 1.2, 'F');
      }
      y += 18;
    });
  }

  if (p.notes.length) {
    y += 16;
    doc.setFillColor(230, 225, 214);
    doc.rect(left, y, right - left, 0.6, 'F');
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(107, 103, 94);
    p.notes.forEach(n => {
      const wrap = doc.splitTextToSize(n, right - left);
      if (y + wrap.length * 12 > pageH - 48) { doc.addPage(); y = 56; }
      doc.text(wrap, left, y);
      y += wrap.length * 12 + 4;
    });
  }

  if (p.signatures.length) {
    y += 34;
    if (y + 40 > pageH - 48) { doc.addPage(); y = 80; }
    const gap = 28;
    const w = (right - left - gap * (p.signatures.length - 1)) / p.signatures.length;
    p.signatures.forEach((s, i) => {
      const x = left + i * (w + gap);
      doc.setFillColor(26, 26, 24);
      doc.rect(x, y, w, 0.8, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(26, 26, 24);
      doc.text(doc.splitTextToSize(s.name, w) as string[], x, y + 16);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(107, 103, 94);
      doc.text(doc.splitTextToSize(s.date ? `${s.label} · ${s.date}` : s.label, w) as string[], x, y + 30);
    });
  }

  doc.save(paperFilename(p));
}
