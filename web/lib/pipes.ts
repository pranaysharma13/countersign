import type { Tables } from './client';
import { isSandbox } from './format.ts';

export interface Pipe {
  id: string;
  name: string;
  owns: string;
  never: string;
  n: number;
  ok: boolean;
  note: string;
}

function rows(t: Tables, name: string) {
  return t[name] ?? [];
}

/** Named systems of record. A later ERP is another pipe with an owns/never list, not a dump into the prompt. */
export function deskPipes(t: Tables): Pipe[] {
  const invoices = rows(t, 'invoice').filter(i => !isSandbox(i));
  const files = rows(t, 'document').filter(d => invoices.some(i => {
    const revs = rows(t, 'invoice_revision').filter(r => r.invoice_id === i.id);
    const pur = rows(t, 'purchase').find(p => p.id === i.purchase_id);
    return revs.some(r => r.document_id === d.id) || pur?.quote_document_id === d.id || pur?.po_document_id === d.id;
  }));
  const mail = rows(t, 'email_message');
  const site = rows(t, 'receipt_attestation').filter(a => invoices.some(i => i.id === a.invoice_id));
  const bank = rows(t, 'payee_profile').filter(p => p.status === 'verified' || p.status === 'pending');
  const pendingMailBank = bank.filter(p => p.status === 'pending');
  const pays = rows(t, 'payment');
  const flags = rows(t, 'hold').filter(h => h.code === 'SUPPLIER_RISK' && h.status === 'open');

  return [
    {
      id: 'files',
      name: 'Files',
      owns: 'What they quoted, ordered, and billed',
      never: 'Pay, approve, or clear a hold',
      n: files.length || rows(t, 'document').length,
      ok: true,
      note: 'PDFs and letters are data. Hidden instructions stay printed text.',
    },
    {
      id: 'mail',
      name: 'Mail',
      owns: 'That someone asked for a change',
      never: 'The bank last-4, a price, or a yes',
      n: mail.length,
      ok: pendingMailBank.length === 0 || rows(t, 'hold').some(h => h.code === 'PAYEE_CHANGE_PENDING'),
      note: pendingMailBank.length
        ? `${pendingMailBank.length} new account${pendingMailBank.length === 1 ? '' : 's'} from mail. The number on the quote still owns where to pay.`
        : mail.length
          ? `${mail.length} letter${mail.length === 1 ? '' : 's'} on file. None of them own the bank number.`
          : 'No mail ingested yet.',
    },
    {
      id: 'site',
      name: 'Site',
      owns: 'What arrived, this drop only',
      never: 'The unit price or the next load',
      n: site.length,
      ok: true,
      note: site.length
        ? `${site.length} count${site.length === 1 ? '' : 's'} on file. The next drop is confirmed again.`
        : 'Nobody on site has confirmed a drop.',
    },
    {
      id: 'bank',
      name: 'Account on file',
      owns: 'Where to pay, after Dana says yes',
      never: 'A number from the email that asked for the change',
      n: bank.filter(p => p.status === 'verified').length,
      ok: pendingMailBank.every(p => rows(t, 'hold').some(h => h.code === 'PAYEE_CHANGE_PENDING' && h.status === 'open')),
      note: 'Call the contact already on the quote. Clerk never dials a number from the asking email.',
    },
    {
      id: 'nessie',
      name: 'Job bank',
      owns: 'A simulated transfer, labeled',
      never: 'A live bank, a payee change, or a silent underpay',
      n: pays.length,
      ok: true,
      note: pays.length
        ? `${pays.length} transfer${pays.length === 1 ? '' : 's'}. Demo money, labeled simulated.`
        : 'Nothing has left. Clerk proposes. Dana still pays.',
    },
    {
      id: 'crs',
      name: 'Supplier flag',
      owns: 'A public-records flag on a test identity',
      never: 'The billed amount',
      n: flags.length,
      ok: true,
      note: flags.length
        ? `${flags.length} flag${flags.length === 1 ? '' : 's'} held. Payment waits for a person.`
        : 'No supplier flags open.',
    },
  ];
}

export function pipeLine(p: Pipe): string {
  return `${p.name} owns ${p.owns.toLowerCase()}. Never ${p.never.toLowerCase()}.`;
}
