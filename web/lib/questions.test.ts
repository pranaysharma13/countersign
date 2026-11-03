import assert from 'node:assert/strict';
import test from 'node:test';
import { QUESTIONS, honestRows, type HonestSnap } from './questions.ts';

const snap: HonestSnap = {
  billCount: 10,
  watchPass: 8,
  watchScored: 9,
  fieldsOk: 54,
  fieldsScored: 54,
  packsClean: 10,
  conflicts: 16,
  lessons: 10,
  autoPaid: 0,
  writesOnce: 10,
  guessed: 0,
  shared: true,
};

test('six questions, six live answers a person can read', () => {
  const rows = honestRows(snap);
  assert.equal(rows.length, 6);
  assert.equal(QUESTIONS.length, 6);
  assert.match(rows[0].ask, /trust a read/);
  assert.match(rows[0].answer, /8 of 9/);
  assert.match(rows[0].answer, /54 of 54/);
  assert.match(rows[1].answer, /own supplier/);
  assert.match(rows[2].answer, /last-4/);
  assert.match(rows[3].answer, /auto-pay/);
  assert.match(rows[5].answer, /Dana still says yes/);
  assert.equal(rows[3].ok, true);
  assert.equal(rows[0].ok, false);
});

test('a lesson that auto-pays is a fail a person can see', () => {
  const rows = honestRows({ ...snap, autoPaid: 1 });
  const lesson = rows.find(r => r.id === 'lesson')!;
  assert.equal(lesson.ok, false);
  assert.match(lesson.answer, /should never happen/);
});
