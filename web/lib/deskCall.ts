export const DESK_HOLDS = ['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'PO_CEILING'] as const;
export type DeskHoldCode = (typeof DESK_HOLDS)[number];

export function isDeskHold(code: string): code is DeskHoldCode {
  return (DESK_HOLDS as readonly string[]).includes(code);
}

export type CompanyIntent = 'pickup' | 'pitch' | 'close_try' | 'agree' | 'bye';

export type DeskCase = {
  invoiceId: string;
  invoiceNumber: string;
  supplier: string;
  contactName: string;
  contactPhone: string;
  holdCode: DeskHoldCode;
  extraCents: number;
};

export type DeskResolution = {
  outcome: 'credit_promised';
  summary: string;
  holdStays: true;
  pays: false;
};

export type CompanyReply = {
  say: string;
  intent: CompanyIntent;
  heard: string;
  done: boolean;
  resolution: DeskResolution | null;
};

export type ClerkBeat = 'dial' | 'rapport' | 'refuse' | 'hold_line' | 'thanks';

function firstName(name: string): string {
  if (/accounts receivable|receivable|^ar\b/i.test(name)) return 'there';
  const n = name.trim().split(/\s+/)[0] || 'there';
  if (/accounts|sales|dispatch|inside/i.test(n)) return 'there';
  return n;
}

function spokenPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}, ${d.slice(3, 6)}, ${d.slice(6)}`;
  return raw || 'the number on the quote';
}

function spokenRef(s: string): string {
  return s.replace(/-/g, ' ');
}

function extraOf(c: DeskCase): string {
  const n = Math.max(0, Math.round(c.extraCents));
  const d = Math.floor(n / 100);
  const c2 = n % 100;
  return `$${d.toLocaleString('en-US')}.${String(c2).padStart(2, '0')}`;
}

function holdLabel(code: DeskHoldCode): string {
  if (code === 'PRICE_VARIANCE') return 'Price is higher than agreed';
  if (code === 'PROPOSED_CHARGE') return 'Extra charge not agreed';
  return 'Billed more than ordered';
}

function mismatch(c: DeskCase): string {
  if (c.holdCode === 'PO_CEILING') {
    return `Invoice ${spokenRef(c.invoiceNumber)} billed more than the purchase order allows. The extra is ${extraOf(c)}.`;
  }
  if (c.holdCode === 'PROPOSED_CHARGE') {
    return `Invoice ${spokenRef(c.invoiceNumber)} has an extra charge that was never agreed. That extra is ${extraOf(c)}.`;
  }
  return `Invoice ${spokenRef(c.invoiceNumber)} is above the quoted unit price. The extra is ${extraOf(c)}.`;
}

export function clerkLine(c: DeskCase, beat: ClerkBeat): string {
  const who = firstName(c.contactName);
  if (beat === 'dial') {
    return `Calling ${c.contactName} at ${spokenPhone(c.contactPhone)}, the number already on the quote. This call is simulated. The voice is live Cartesia.`;
  }
  if (beat === 'rapport') {
    return `${who === 'there' ? 'Hi, this is Clerk' : `${who}, it's Clerk`} at Marlow and Finch. Hope the Oakview crew is treating you alright. I'm not calling to beat you up. We like the work. ${mismatch(c)} I wanted to talk it through before anyone starts chasing paper.`;
  }
  if (beat === 'refuse') {
    return `I hear the pitch, and I get why you'd float it. I still cannot take a deal from a phone call. Clerk never pays the extra from this line. What would actually close this is a credit for ${extraOf(c)} and a revised invoice at what was already agreed. Can you do that for me?`;
  }
  if (beat === 'hold_line') {
    return `That's a generous offer, and I will not pretend it isn't. It still is not a written correction on this bill. The hold stays on the paper until we have that credit or a revised invoice. I will not approve the extra from here.`;
  }
  return `Thank you, ${who}. We'll watch for that paper. Until it lands, the hold stays, and nobody here can pay. Take care of the crew.`;
}

function pitch(c: DeskCase): string {
  const who = firstName(c.contactName);
  if (c.holdCode === 'PO_CEILING') {
    return `${who === 'there' ? 'Hey' : who}, glad you called, honestly. Look, those extra tons were already on the truck. Site waved us in. If I haul it back I eat a dump fee, and you still need material next week. Keep this invoice as billed and I'll throw the next Oakview drop at the old rate. That's the better deal for both of us.`;
  }
  if (c.holdCode === 'PROPOSED_CHARGE') {
    return `Appreciate you picking up the phone instead of just emailing. Everybody is putting a fuel line on right now. That's how the yards are surviving. Leave this invoice alone and I'll waive the surcharge on the next two loads. You'd come out ahead.`;
  }
  return `Hey, thanks for calling me direct. Gypsum and freight moved on us mid-job. That extra ${extraOf(c)} is us eating half of it. Keep this bill as-is and I'll keep next month's Oakview loads at the old quote. That's a real save, not a paperwork fight.`;
}

function closeTry(c: DeskCase): string {
  if (c.holdCode === 'PO_CEILING') {
    return `Okay, credit is painful on my end. What if I split the extra with you: you take half, I write off half, and I send a signed note that the extra quantity was used on site? That's as close as I can get without a new PO.`;
  }
  if (c.holdCode === 'PROPOSED_CHARGE') {
    return `Alright, hear me out. I'll knock the extra in half on this bill if you let the rest ride, and I'll put it in an email today. That's me meeting you in the middle.`;
  }
  return `What if I throw in delivery on the next drop, no charge, and you keep this invoice as written? That's cash back to the job, faster than waiting on a credit memo.`;
}

function agree(c: DeskCase): string {
  return `Alright. You win this one. I'll have receivables send a credit memo for ${extraOf(c)} and a revised ${spokenRef(c.invoiceNumber)} today. Sorry for the runaround. I had to try.`;
}

export function resolutionOf(c: DeskCase): DeskResolution {
  return {
    outcome: 'credit_promised',
    summary: `${c.contactName} will send a credit for ${extraOf(c)} and a revised invoice. The hold stays on the paper. Clerk never pays from this call.`,
    holdStays: true,
    pays: false,
  };
}

/** Mock company: answers from what it heard. Turn is only a fallback so the demo never stalls. */
export function companyAnswer(input: DeskCase & { heard: string; turn: number }): CompanyReply {
  const heard = String(input.heard || '').replace(/\s+/g, ' ').trim();
  const t = heard.toLowerCase();
  const turn = Number.isFinite(input.turn) ? input.turn : 0;

  const pickup = /\b(calling|simulated|cartesia|hello|hi, this is clerk|it's clerk|its clerk)\b/.test(t)
    && !/\b(credit|revised|hold stays|will not approve|generous)\b/.test(t);
  const rapport = /\b(oakview|like the work|talk it through|quoted|purchase order|never agreed|unit price)\b/.test(t);
  const refuse = /\b(cannot take|never pays|revised invoice|credit for|can you do that)\b/.test(t);
  const firm = /\b(generous|hold stays|will not approve|not a written correction)\b/.test(t);
  const thanks = /\b(thank you|watch for that paper|take care of the crew)\b/.test(t);

  let intent: CompanyIntent;
  if (thanks || turn >= 4) intent = 'bye';
  else if (firm || turn >= 3) intent = 'agree';
  else if (refuse || turn >= 2) intent = 'close_try';
  else if (rapport || turn >= 1) intent = 'pitch';
  else if (pickup || turn <= 0) intent = 'pickup';
  else intent = turn >= 3 ? 'agree' : 'pitch';

  if (intent === 'pickup') {
    return {
      say: `${input.supplier}, this is ${firstName(input.contactName) === 'there' ? 'accounts receivable' : firstName(input.contactName)}. Hey, didn't expect a call. What's going on?`,
      intent,
      heard,
      done: false,
      resolution: null,
    };
  }
  if (intent === 'pitch') {
    return { say: pitch(input), intent, heard, done: false, resolution: null };
  }
  if (intent === 'close_try') {
    return { say: closeTry(input), intent, heard, done: false, resolution: null };
  }
  if (intent === 'agree') {
    return { say: agree(input), intent, heard, done: false, resolution: resolutionOf(input) };
  }
  return {
    say: `We'll send it this afternoon. Thanks for calling instead of just short-paying us.`,
    intent: 'bye',
    heard,
    done: true,
    resolution: resolutionOf(input),
  };
}

export function deskCaseFrom(input: {
  invoiceId: string;
  invoiceNumber: string;
  supplier: string;
  contactName: string;
  contactPhone: string;
  holdCode: string;
  extraCents: number;
}): DeskCase | null {
  if (!isDeskHold(input.holdCode)) return null;
  return {
    invoiceId: String(input.invoiceId || '').slice(0, 80),
    invoiceNumber: String(input.invoiceNumber || '').slice(0, 40),
    supplier: String(input.supplier || 'Supplier').slice(0, 80),
    contactName: String(input.contactName || 'Accounts Receivable').slice(0, 80),
    contactPhone: String(input.contactPhone || '').slice(0, 32),
    holdCode: input.holdCode,
    extraCents: Math.max(0, Math.round(Number(input.extraCents) || 0)),
  };
}

export function deskTitle(code: DeskHoldCode): string {
  if (code === 'PRICE_VARIANCE') return 'Call about the price';
  if (code === 'PROPOSED_CHARGE') return 'Call about the extra charge';
  return 'Call about the extra quantity';
}
