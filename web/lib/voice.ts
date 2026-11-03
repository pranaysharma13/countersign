export type CallVerdict = 'accept' | 'reject' | 'unclear';

export function verdictFromTranscript(text: string, last4: string): CallVerdict {
  const t = text.toLowerCase();
  if (!t.trim()) return 'unclear';
  const digits = t.replace(/\D/g, '');
  const saidLast4 = !!last4 && (t.includes(last4) || digits.includes(last4));
  const no = /\b(no|nope|not us|don't|do not|never|wrong|fraud|didn't request|did not request|reject)\b/.test(t);
  const yes = /\b(yes|yeah|yep|correct|confirm(?:ed)?|that's right|that is right|please change|go ahead)\b/.test(t)
    || /\b(we did|i did)\b(?! not)/.test(t);
  if (no && !yes) return 'reject';
  if (yes && saidLast4) return 'accept';
  if (yes && /\b(confirm|confirmed|we requested|please change|that's right|that is right)\b/.test(t)) return 'accept';
  return 'unclear';
}

export function callScript(input: {
  contactName: string;
  contactPhone: string;
  supplier: string;
  invoiceNumber: string;
  oldLast4: string;
  newLast4: string;
  newBank: string;
}): { clerkOpen: string; contactPickup: string; clerkAsk: string } {
  return {
    clerkOpen: `Calling ${input.contactName} at ${spokenPhone(input.contactPhone)}, the number already on the quote. This call is simulated. The voice is live Cartesia.`,
    contactPickup: `${input.supplier}, accounts receivable. This is ${input.contactName}.`,
    clerkAsk: `This is Clerk, for Marlow and Finch. Invoice ${spokenRef(input.invoiceNumber)}. Someone emailed us to pay ${input.newBank}, account ending ${spokenDigits(input.newLast4)}. The account on file ends ${spokenDigits(input.oldLast4)}. Did you request this change? Please say yes or no. If yes, repeat the last four of the new account.`,
  };
}

export function spokenBriefing(lines: string[]): string {
  const body = lines
    .filter(Boolean)
    .join(' ')
    .replace(/yd³/g, 'cubic yards')
    .replace(/····/g, 'ending ')
    .replace(/—/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, 1400);
}

/** Sonic 3.6 reads money and counts without extra markup. Keep this as spoken English. */
export function billSpeech(input: {
  supplier: string;
  invoiceNumber: string;
  story: string;
  who: string;
  action: string;
  math?: string;
}): string {
  return spokenBriefing([
    `${input.supplier}, invoice ${spokenRef(input.invoiceNumber)}.`,
    input.story,
    input.math ?? '',
    `${input.who} needs to ${input.action.replace(/\.$/, '')}.`,
  ]);
}

export function letterSpeech(subject: string, body: string): string {
  return spokenBriefing([`Letter. ${subject}.`, body]);
}

export function queueSpeech(
  items: { supplier: string; number: string; who: string; action: string; amount: string }[],
  empty = 'Nothing is waiting on you.',
): string {
  if (!items.length) return empty;
  const head = items.length === 1 ? 'One bill is waiting.' : `${items.length} bills are waiting.`;
  const first = items[0];
  const rest = items.slice(1, 3).map(e => `${e.supplier}, ${e.amount}, ${e.who}.`);
  const more = items.length > 3 ? `And ${items.length - 3} more.` : '';
  return spokenBriefing([
    head,
    `First: ${first.supplier}, invoice ${spokenRef(first.number)}, ${first.amount}. ${first.who} needs to ${first.action.replace(/\.$/, '')}.`,
    ...rest,
    more,
  ]);
}

export function transferSpeech(input: {
  supplier: string;
  invoiceNumber: string;
  amount: string;
  bank: string;
  last4: string;
}): string {
  return spokenBriefing([
    `${input.supplier}, invoice ${spokenRef(input.invoiceNumber)}.`,
    `${input.amount}, to ${input.bank}, account ending ${spokenDigits(input.last4)}.`,
  ]);
}

export function blockedSpeech(input: {
  supplier: string;
  invoiceNumber: string;
  amount?: string;
  reasons: string[];
}): string {
  return spokenBriefing([
    `${input.supplier}, invoice ${spokenRef(input.invoiceNumber)} cannot pay${input.amount ? ` ${input.amount}` : ''}.`,
    input.reasons.length ? `Still blocking: ${input.reasons.join('. ')}.` : 'Something still has to be fixed.',
  ]);
}

/** Ink is good at spoken numbers. First number is the count; the rest is how they know. */
export function parseSiteReceipt(text: string): { qty: string; reason: string } {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/(\d+(?:[.,]\d+)?)/);
  return {
    qty: m ? m[1].replace(',', '.') : '',
    reason: t,
  };
}

export type PayVerdict = 'approve' | 'reject' | 'unclear';

export function paymentReadback(input: {
  supplier: string;
  invoiceNumber: string;
  amount: string;
  bank: string;
  last4: string;
}): string {
  return spokenBriefing([
    `This is Clerk. You are about to approve a payment.`,
    `${input.supplier}, invoice ${spokenRef(input.invoiceNumber)}.`,
    `${input.amount}, to ${input.bank}, account ending ${spokenDigits(input.last4)}.`,
    `Say approve and the last four if this is correct. Say reject if it is not.`,
  ]);
}

export function approveFromTranscript(text: string, last4: string): PayVerdict {
  const t = text.toLowerCase();
  if (!t.trim()) return 'unclear';
  const digits = t.replace(/\D/g, '');
  const saidLast4 = !!last4 && (t.includes(last4) || digits.includes(last4));
  const no = /\b(no|reject|stop|don't|do not|cancel|never)\b/.test(t);
  const yes = /\b(approve|approved|yes|confirm|confirmed|go ahead|pay it)\b/.test(t);
  if (no && !yes) return 'reject';
  if (yes && saidLast4) return 'approve';
  return 'unclear';
}

function spokenPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}, ${d.slice(3, 6)}, ${d.slice(6)}`;
  return raw;
}

function spokenDigits(s: string): string {
  return s.split('').join(' ');
}

function spokenRef(s: string): string {
  return s.replace(/-/g, ' ');
}
