import type { TrustDesk } from './trust.ts';

/** The six product questions. Short enough to read at a desk. The market brief is the `why`. */
export const QUESTIONS: {
  id: 'watch' | 'pack' | 'canon' | 'lesson' | 'run' | 'write';
  kicker: string;
  ask: string;
  why: string;
}[] = [
  {
    id: 'watch',
    kicker: 'Watch',
    ask: 'How do you trust a read that is not always the same?',
    why: 'Grade it against the quote and the order. A failed read goes to a person. The model never grades itself.',
  },
  {
    id: 'pack',
    kicker: 'Pack',
    ask: 'How does it get this supplier’s papers and keep the others out?',
    why: 'A pack is this supplier’s quote, order, bill, mail and lessons. A cited line from another file is a leak, and a hold.',
  },
  {
    id: 'canon',
    kicker: 'Canon',
    ask: 'What is true when the bill, the order, the mail and the bank disagree?',
    why: 'Each fact has one owner. Mail never owns the last-4. Disagreement is a hold, not an average.',
  },
  {
    id: 'lesson',
    kicker: 'Lesson',
    ask: 'How does it get better without guessing the next extra?',
    why: 'Dana’s note, Luis’s count, or a written change is cited next time. None of them auto-pay.',
  },
  {
    id: 'run',
    kicker: 'Run',
    ask: 'What happens when a job crashes mid-bill?',
    why: 'A stale lease is picked up again. An old yes dies if the bill changed. Replay comes back as already done.',
  },
  {
    id: 'write',
    kicker: 'Write',
    ask: 'How does money leave once, with a receipt?',
    why: 'The same request cannot pay twice. Journals balance. Clerk proposes. Dana still says yes.',
  },
];

export interface HonestSnap {
  billCount: number;
  watchPass: number;
  watchScored: number;
  fieldsOk: number;
  fieldsScored: number;
  packsClean: number;
  conflicts: number;
  lessons: number;
  autoPaid: number;
  writesOnce: number;
  guessed: number;
  shared?: boolean;
}

export interface HonestRow {
  id: typeof QUESTIONS[number]['id'];
  kicker: string;
  ask: string;
  why: string;
  answer: string;
  num: string;
  ok: boolean;
  href: string;
}

export function snapFromDesk(d: TrustDesk): HonestSnap {
  return {
    billCount: d.bills.length,
    watchPass: d.watchPass,
    watchScored: d.watchScored,
    fieldsOk: d.fieldsOk,
    fieldsScored: d.fieldsScored,
    packsClean: d.packsClean,
    conflicts: d.conflicts,
    lessons: d.lessons,
    autoPaid: d.autoPaid,
    writesOnce: d.writesOnce,
    guessed: d.guessed,
  };
}

export function honestRows(s: HonestSnap): HonestRow[] {
  const n = s.billCount || 1;
  const watchOk = s.watchScored > 0 && s.watchPass === s.watchScored && s.guessed === 0;
  const answers: Record<HonestRow['id'], { answer: string; num: string; ok: boolean }> = {
    watch: {
      num: s.watchScored ? `${s.watchPass}/${s.watchScored}` : '-',
      ok: watchOk,
      answer: s.watchScored
        ? `${s.watchPass} of ${s.watchScored} bills match the quote and the order.${s.fieldsScored ? ` ${s.fieldsOk} of ${s.fieldsScored} labelled fields matched.` : ''}${watchOk ? '' : ' One extra is still held, which means the check is working.'}`
        : 'No labelled quote and order on these bills yet. Extras are still held.',
    },
    pack: {
      num: `${s.packsClean}/${n}`,
      ok: s.packsClean === n,
      answer: s.packsClean === n
        ? 'Every bill only saw its own supplier’s files. Other suppliers stayed out.'
        : 'A cited line came from the wrong supplier. That pack is held.',
    },
    canon: {
      num: String(s.conflicts),
      ok: true,
      answer: s.conflicts
        ? `${s.conflicts} facts disagree. Each is a hold, not a blended number. Mail never owns the bank last-4.`
        : 'Quote, order, bill, site and bank agree. Code still does not pay.',
    },
    lesson: {
      num: String(s.lessons),
      ok: s.autoPaid === 0,
      answer: s.autoPaid
        ? 'A lesson paid a later extra. That should never happen.'
        : s.lessons
          ? `${s.lessons} notes from a person. Cited next time. None of them auto-pay.`
          : 'No person has taught these bills yet. Clerk will not guess.',
    },
    run: {
      num: s.shared === false ? 'Laptop' : 'Shared',
      ok: s.shared !== false,
      answer: s.shared === false
        ? 'These books live on this machine. They will not follow you to a public domain.'
        : 'Jobs can be picked up again. An old yes dies if the bill changed. These books are shared.',
    },
    write: {
      num: `${s.writesOnce}/${n}`,
      ok: s.writesOnce === n,
      answer: s.writesOnce === n
        ? 'Retries cannot pay twice. Clerk proposes. Dana still says yes.'
        : 'A write ran more than once or a journal did not balance.',
    },
  };
  return QUESTIONS.map(q => ({
    ...q,
    ...answers[q.id],
    href: `/proof#${q.id}`,
  }));
}

export function honestSpeech(rows: HonestRow[]): string {
  return rows.map(r => `${r.ask} ${r.answer}`).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1400);
}
