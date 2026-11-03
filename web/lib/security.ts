/** Facts a security questionnaire asks. None of this is a SOC report. */
export const SECURITY: { id: string; title: string; body: string }[] = [
  {
    id: 'soc',
    title: 'Attestations',
    body: 'No SOC 1 or SOC 2 report yet. This page is the list we will take into that audit. Do not treat it as one.',
  },
  {
    id: 'ai',
    title: 'What the model sees',
    body: 'Document and email text is data. Clerk does not follow instructions in a bill. Customer bills do not train a model. Extraction uses a strict schema. The model does not grade itself, pay, or clear a hold.',
  },
  {
    id: 'transit',
    title: 'In transit',
    body: 'The hosted app is HTTPS. Tokens for the live database stay on the server. They do not go to the browser.',
  },
  {
    id: 'rest',
    title: 'At rest',
    body: 'Live books sit in the database we publish to. Local books sit in this process and die with it. We store bank last-4, not full account numbers. Card data is not collected.',
  },
  {
    id: 'hands',
    title: 'Who else sees a bill',
    body: 'Anthropic reads extracts when live AI is on (fixture mode keeps bills local). Cartesia speaks and transcribes when those keys are set. The demo bank is Capital One Nessie, labeled simulated. Hosting may be Vercel. The live database is SpacetimeDB.',
  },
  {
    id: 'leave',
    title: 'How you leave',
    body: 'You own the bills, the files, and the audit log. Download the company pack any time. Per-bill CSV is on each invoice. We do not keep a second general ledger.',
  },
  {
    id: 'hours',
    title: 'When this host is down',
    body: 'The ERP remains the books. If this app is down at a payment run, nobody here can pay, and that is the safe failure. There is no uptime credit on this demo.',
  },
];

export function aiTrainsOnBills(): boolean {
  return false;
}
