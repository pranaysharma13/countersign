import type { OfficeSnap } from './office';
import { BOOKS_DATE, CLOSE_MONTH } from './office';
import { ROLE_LABEL, money } from './format';

export async function downloadBoardPack(snap: OfficeSnap): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const left = 54;
  const right = pageW - 54;
  let y = 56;

  const line = (gap = 18) => { y += gap; };
  const ensure = (need: number) => {
    if (y + need > 720) { doc.addPage(); y = 56; }
  };

  doc.setFillColor(20, 20, 20);
  doc.rect(0, 0, pageW, 36, 'F');
  doc.setTextColor(244, 241, 234);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('CONFIDENTIAL · Marlow & Finch · fictional books', left, 22);
  doc.text(`Books ${BOOKS_DATE}`, right, 22, { align: 'right' });

  y = 64;
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(18);
  doc.text('Oakview Lane Fourplex', left, y);
  line(16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90, 90, 90);
  doc.text(`Board pack · ${CLOSE_MONTH} · same numbers as the bills`, left, y);
  line(28);

  const facts: [string, string][] = [
    ['In the job account', money(snap.cashOnHand)],
    ['Suppliers asked', money(snap.askedCents)],
    ['Not agreed yet', money(snap.heldCents)],
    ['Ready to pay', money(snap.readyCents)],
    ['Still to collect', money(snap.remainingContractCents)],
    ['People who have to act', String(snap.humanCount)],
  ];
  facts.forEach(([k, v], i) => {
    const x = left + (i % 2) * 250;
    if (i % 2 === 0) ensure(28);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    doc.text(k, x, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20, 20, 20);
    doc.text(v, x + 200, y, { align: 'right' });
    if (i % 2 === 1) line(22);
  });
  if (facts.length % 2) line(22);

  doc.setFillColor(20, 20, 20);
  doc.rect(left, y, right - left, 1, 'F');
  line(22);
  doc.setFontSize(12);
  doc.text('Needs a person', left, y);
  line(16);
  snap.escalations.slice(0, 8).forEach(e => {
    ensure(28);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(20, 20, 20);
    doc.text(`${e.supplier} ${e.number}`, left, y);
    doc.text(money(e.cents), right, y, { align: 'right' });
    line(12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    doc.text(`${e.waitingDays}d · ${ROLE_LABEL[e.role] ?? e.role} · ${e.hold}`, left, y);
    line(16);
  });

  ensure(40);
  doc.setFillColor(20, 20, 20);
  doc.rect(left, y, right - left, 1, 'F');
  line(22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(20, 20, 20);
  doc.text('Controls', left, y);
  line(16);
  snap.controls.forEach(c => {
    ensure(28);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(`${c.ok ? 'OK' : 'OPEN'}  ${c.label}`, left, y);
    line(12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    const wrap = doc.splitTextToSize(c.note, right - left) as string[];
    doc.text(wrap, left, y);
    line(wrap.length * 12 + 8);
    doc.setTextColor(20, 20, 20);
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text(`Page ${i} of ${pages} · Clerk does not replace the bank or the books.`, left, 770);
  }
  doc.save(`Clerk_Oakview_board_${BOOKS_DATE}.pdf`);
}
