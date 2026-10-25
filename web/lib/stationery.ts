import type { Row, Tables } from './client';
import { day, isHiddenInstruction, money } from './format';

export const BUYER = {
  name: 'Marlow & Finch Builders',
  line: 'General contractor · Fremont, CA',
  mail: 'ap@marlowfinch.example',
};

export interface PaperLine {
  no: string;
  desc: string;
  qty: string;
  unit: string;
  price: string;
  amount: string;
  mark?: boolean;
}

export interface PaperField { k: string; v: string }

export interface PaperSignature { label: string; name: string; date: string }

export interface PaperModel {
  kind: string;
  title: string;
  number: string;
  firm: string;
  firmSub: string[];
  partyLabel: string;
  partyName: string;
  partySub: string[];
  fields: PaperField[];
  lines: PaperLine[];
  totals: { k: string; v: string; strong?: boolean }[];
  notes: string[];
  signatures: PaperSignature[];
}

const TITLE: Record<string, string> = {
  invoice: 'Invoice', po: 'Purchase Order', quote: 'Quotation', terms: 'Terms',
};

function texts(docId: string, t: Tables): string[] {
  return t.source_fragment
    .filter(f => f.document_id === docId && !isHiddenInstruction(String(f.text || '')))
    .sort((a, b) => (a.page - b.page) || (a.line_start - b.line_start))
    .map(f => String(f.text || '').trim())
    .filter(Boolean);
}

function afterColon(lines: string[], prefix: RegExp): string {
  const hit = lines.find(l => prefix.test(l));
  return hit ? hit.replace(prefix, '').trim() : '';
}

function prettyDate(raw: string): string {
  const iso = raw.match(/\d{4}-\d{2}-\d{2}/);
  return iso ? day(iso[0]) : raw;
}

function datesIn(raw: string): string {
  return raw.replace(/\d{4}-\d{2}-\d{2}/g, d => day(d));
}

function tableRow(text: string): PaperLine | null {
  const m = text.match(/^(\d+)\s+(.+?)\s{2,}([\d,.]+)\s+(\S+)\s+\$?([\d,.]+)\s+\$?([\d,.]+)\s*$/);
  if (!m) return null;
  return { no: m[1], desc: m[2].trim(), qty: m[3].replace(/\.0+$/, ''), unit: m[4], price: `$${m[5]}`, amount: `$${m[6]}` };
}

function letterhead(line: string | undefined): string[] {
  if (!line || /^(INVOICE|PURCHASE|QUOT)/i.test(line)) return [];
  return line.split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
}

function attention(lines: string[], buyer: string): string {
  const raw = afterColon(lines, /^(Bill to|Customer):\s*/i);
  if (!raw) return '';
  const rest = raw.replace(buyer, '').replace(/^[,\s]+/, '').replace(/^attn\.?\s*/i, '').trim();
  return rest ? `Attn: ${rest.replace(/\s*\(([^)]+)\)/, ', $1')}` : '';
}

function projectLine(lines: string[], fallback?: string): string {
  const raw = afterColon(lines, /^Project:\s*/i) || fallback || '';
  return raw ? `Project · ${raw}` : '';
}

function signatures(lines: string[]): PaperSignature[] {
  const out: PaperSignature[] = [];
  for (const l of lines) {
    const m = l.match(/^(Accepted for|Issued for|Issued by|Acknowledged by)\s*([^:]*):\s*(.+?)(?:\s{2,}Date:\s*(\S+))?$/i);
    if (!m) continue;
    const verb = m[1].replace(/\s+(for|by)$/i, '');
    const org = m[2].trim();
    const parts = m[3].split(',').map(s => s.trim());
    const company = org || (parts.length > 2 ? parts.pop()! : '');
    out.push({
      label: company ? `${verb} for ${company}` : verb,
      name: parts.join(', '),
      date: m[4] ? day(m[4]) : '',
    });
  }
  return out;
}

export function buildPaper(doc: Row, t: Tables, ctx?: { inv?: Row; rev?: Row; pur?: Row; highlight?: string }): PaperModel {
  const kind = String(doc.kind || 'other');
  const lines = texts(doc.id, t);
  const sup = t.supplier.find(s => s.id === ctx?.inv?.supplier_id || s.id === ctx?.pur?.supplier_id);
  const proj = t.project?.find(p => p.id === ctx?.pur?.project_id);
  const title = TITLE[kind] ?? 'Document';
  const parsed = lines.map(tableRow).filter(Boolean) as PaperLine[];
  const attn = attention(lines, BUYER.name);
  const signed = signatures(lines);
  const supplierHead = (() => {
    const head = letterhead(lines[1]);
    const phone = sup?.phone_on_file;
    return phone && !head.some(h => h.includes(phone)) ? [...head, phone] : head;
  })();

  if (kind === 'invoice' && ctx?.inv && ctx.rev) {
    const items = t.invoice_line.filter(l => l.revision_id === ctx.rev!.id);
    return {
      kind, title,
      number: ctx.inv.invoice_number,
      firm: sup?.name || lines[0] || 'Supplier',
      firmSub: supplierHead.length ? supplierHead : [
        sup?.email_domain ? `ar@${sup.email_domain}` : '',
        sup?.phone_on_file || '',
      ].filter(Boolean),
      partyLabel: 'Bill to',
      partyName: BUYER.name,
      partySub: [attn, BUYER.line, projectLine(lines, proj?.name)].filter(Boolean),
      fields: [
        { k: 'Invoice date', v: day(ctx.inv.invoice_date) },
        { k: 'Due', v: day(ctx.inv.due_date) },
        { k: 'Purchase order', v: ctx.pur?.po_number || (afterColon(lines, /^Your PO:\s*/i).split(/\s{2,}/)[0] ?? '') },
        { k: 'Quote', v: (afterColon(lines, /^Your PO:\s*/i).match(/Quote:\s*(\S+)/) || [])[1] ?? '' },
        { k: 'Currency', v: ctx.inv.currency || 'USD' },
      ].filter(f => f.v),
      lines: items.length ? items.map((l, i) => ({
        no: String(i + 1),
        desc: l.description,
        qty: (l.quantity_milli / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 }),
        unit: l.unit === 'cy' ? 'yd³' : l.unit,
        price: money(l.unit_price_cents),
        amount: money(l.amount_cents),
        mark: ctx.highlight ? String(l.source_fragment_ids_json || '').includes(ctx.highlight) : false,
      })) : parsed,
      totals: [
        { k: 'Gross', v: money(ctx.rev.gross_cents) },
        { k: 'Balance due', v: money(ctx.rev.balance_requested_cents), strong: true },
      ],
      notes: [
        datesIn(afterColon(lines, /^Delivered:\s*/i)) ? `Delivered ${datesIn(afterColon(lines, /^Delivered:\s*/i))}` : '',
        afterColon(lines, /^Remit to:\s*/i) ? `Remit to ${afterColon(lines, /^Remit to:\s*/i)}` : '',
        afterColon(lines, /^Payment terms:\s*/i) || (ctx.inv.due_date ? `Payment due ${day(ctx.inv.due_date)}` : ''),
        afterColon(lines, /^Questions:\s*/i) ? `Questions: ${afterColon(lines, /^Questions:\s*/i)}` : '',
      ].filter(Boolean),
      signatures: signed,
    };
  }

  const heading = lines.find(l => /^(INVOICE|PURCHASE ORDER|QUOTATION|QUOTE)\b/i.test(l)) || '';
  const number = heading.replace(/^(INVOICE|PURCHASE ORDER|QUOTATION|QUOTE)\s*/i, '').trim()
    || (kind === 'po' ? ctx?.pur?.po_number : '')
    || String(doc.filename || '').replace(/\.[^.]+$/, '');
  const firm = kind === 'po' ? (lines[0] || BUYER.name) : (sup?.name || lines[0] || 'Supplier');
  const firmSub = kind === 'po'
    ? (letterhead(lines[1]).length ? letterhead(lines[1]) : [BUYER.line, BUYER.mail])
    : supplierHead;

  let quoteLines: PaperLine[] = [];
  if (kind === 'quote' && !parsed.length) {
    const product = afterColon(lines, /^Product:\s*/i);
    const qty = afterColon(lines, /^Maximum quantity:\s*/i).match(/^([\d,.]+)\s+(\w+)/);
    const price = afterColon(lines, /^Unit price:\s*/i).match(/^(\$[\d,.]+)/);
    const ext = afterColon(lines, /^Extended maximum:\s*/i).match(/=\s*(\$[\d,.]+)/);
    if (product) {
      quoteLines = [{
        no: '1',
        desc: product,
        qty: qty?.[1] ?? '',
        unit: qty?.[2] ?? '',
        price: price?.[1] ?? '',
        amount: ext?.[1] ?? '',
      }];
    }
  }

  const poCap = afterColon(lines, /^PO total, not to exceed:\s*/i);
  const totals: PaperModel['totals'] = [];
  const gross = afterColon(lines, /^Gross amount:\s*/i);
  const due = afterColon(lines, /^Balance due:\s*/i);
  const extTotal = (afterColon(lines, /^Extended maximum:\s*/i).match(/=\s*(\$[\d,.]+)/) || [])[1];
  if (gross) totals.push({ k: 'Gross', v: gross });
  if (due) totals.push({ k: 'Balance due', v: due, strong: true });
  if (poCap) totals.push({ k: 'Not to exceed', v: poCap, strong: true });
  if (extTotal && !totals.length) totals.push({ k: 'Quoted maximum', v: extTotal, strong: true });

  const supplierParty = afterColon(lines, /^Supplier:\s*/i);
  const validity = afterColon(lines, /^Price validity:\s*/i);
  const excluded = afterColon(lines, /^Not included:\s*/i);
  const poTerms = afterColon(lines, /^Terms:\s*/i);

  return {
    kind, title, number, firm, firmSub,
    partyLabel: kind === 'po' ? 'Supplier' : 'Customer',
    partyName: kind === 'po' ? (sup?.name || supplierParty.split(',')[0] || 'Supplier') : BUYER.name,
    partySub: kind === 'po'
      ? [supplierParty.split(',').slice(1).join(',').trim(), projectLine(lines, proj?.name)].filter(Boolean)
      : [attn, BUYER.line, projectLine(lines, proj?.name)].filter(Boolean),
    fields: [
      { k: kind === 'quote' ? 'Quote date' : 'Date', v: prettyDate(afterColon(lines, /^(Invoice date|PO date|Quote date):\s*/i)) },
      { k: 'Due', v: prettyDate(afterColon(lines, /^Due date:\s*/i)) },
      { k: 'Quote', v: kind === 'po' ? ((poTerms.match(/Quote\s+(\S+)/) || [])[1] ?? '') : '' },
      { k: 'Reference', v: kind === 'po' ? '' : afterColon(lines, /^Your PO:\s*/i) },
      { k: 'Prices valid', v: validity.replace(/^.*?from\s+(\d{4}-\d{2}-\d{2})\s+through\s+(\d{4}-\d{2}-\d{2}).*$/i, (_, a, b) => `${day(a)} – ${day(b)}`) },
    ].filter(f => f.v && !/\d{4}-\d{2}-\d{2}/.test(f.v)),
    lines: parsed.length ? parsed : quoteLines,
    totals,
    notes: [
      validity ? `Price ${datesIn(validity)}.` : '',
      excluded ? `Not included: ${excluded}.` : '',
      kind === 'po' && poTerms ? `Terms: ${poTerms}` : '',
      afterColon(lines, /^Remit to:\s*/i),
      afterColon(lines, /^Payment terms:\s*/i) ? `Payment terms: ${afterColon(lines, /^Payment terms:\s*/i)}` : '',
      lines.find(l => /incorporates the .* Terms and Conditions/i.test(l)) || '',
      lines.find(l => /acknowledges and accepts/i.test(l)) || '',
    ].filter(Boolean),
    signatures: signed,
  };
}
