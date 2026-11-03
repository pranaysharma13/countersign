export const TOUR_KEY = 'clerk-tour-v1';
export const TOUR_EVENT = 'clerk-tour';

export const TOUR: { id: string; title: string; body: string; href?: string }[] = [
  {
    id: 'you',
    title: 'You are Dana Marlow',
    body: 'Dana owns Marlow & Finch, a fictional builder on Oakview Lane. In this demo you sit as Dana. Clerk already checked the bills. Clerk cannot pay them. You can.',
  },
  {
    id: 'desks',
    title: 'Dana, Jordan, Luis, Sam',
    body: 'Dana pays. Jordan (Buyer) sends the correction letter. Luis (Site) confirms what arrived. Sam (Books) can read every bill and cannot pay. The same person must not order, receive, and pay.',
  },
  {
    id: 'clerk',
    title: 'What Clerk already did',
    body: 'Clerk read each supplier bill against the quote, the purchase order, and the mail. If the price, the count, or the bank account does not match, Clerk stops and names who has to act. Proof scores those answers from these books.',
  },
  {
    id: 'call',
    title: 'First job: a new bank account',
    body: 'Northline emailed a new last-4. That is not enough. You call Tomas Reed at the number already on their quote. Clerk does not dial a number from the email that asked for the change.',
    href: '/calls',
  },
  {
    id: 'bank',
    title: 'The job bank is pretend',
    body: 'Banks shows the Oakview job account. Pretend money, labeled simulated. Books and the bank should match. Held money does not leave.',
    href: '/banks',
  },
  {
    id: 'proof',
    title: 'Proof scores six questions from these books',
    body: 'A changing read, the wrong supplier file, two sources that disagree, a lesson that must not auto-pay, a crashed job, a write that must not run twice. Open Proof. The answers come from these invoices.',
    href: '/proof',
  },
  {
    id: 'next',
    title: 'Then the rest of the desk',
    body: 'Work is the bills that still need a person. Bills lists every invoice. Inbox is the mail. Sneak lets you try a fake bill. Switch I am if you want Buyer or Site. They cannot pay.',
    href: '/office',
  },
];

export function tourDone(): boolean {
  try { return localStorage.getItem(TOUR_KEY) === 'done'; }
  catch { return true; }
}

export function markTourDone() {
  try { localStorage.setItem(TOUR_KEY, 'done'); }
  catch { /* private mode */ }
}

export function requestTour() {
  window.dispatchEvent(new Event(TOUR_EVENT));
}
