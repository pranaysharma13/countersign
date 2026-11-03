import assert from 'node:assert/strict';
import test from 'node:test';
import { clerkLine, companyAnswer, deskCaseFrom, resolutionOf, type DeskCase } from './deskCall.ts';

const c: DeskCase = {
  invoiceId: 'inv_rd',
  invoiceNumber: 'RD-612',
  supplier: 'Ridgeway Drywall',
  contactName: 'Jun Park',
  contactPhone: '(510) 555-0183',
  holdCode: 'PRICE_VARIANCE',
  extraCents: 25500,
};

test('desk case rejects a bank hold', () => {
  assert.equal(deskCaseFrom({ ...c, holdCode: 'PAYEE_CHANGE_PENDING' }), null);
});

test('dial names the number on file and labels the call simulated', () => {
  const s = clerkLine(c, 'dial');
  assert.match(s, /510, 555, 0183/);
  assert.match(s, /simulated/);
  assert.match(s, /Cartesia/);
});

test('rapport is a conversation, not a demand letter', () => {
  const s = clerkLine(c, 'rapport');
  assert.match(s, /Jun/);
  assert.match(s, /Oakview/);
  assert.match(s, /like the work/);
  assert.match(s, /\$255\.00/);
  assert.doesNotMatch(s, /Please send a revised invoice without/);
});

test('company hears a hello and picks up warm', () => {
  const r = companyAnswer({ ...c, heard: clerkLine(c, 'dial'), turn: 0 });
  assert.equal(r.intent, 'pickup');
  assert.match(r.say, /didn't expect a call/i);
  assert.equal(r.done, false);
});

test('company hears rapport and pitches', () => {
  const r = companyAnswer({ ...c, heard: clerkLine(c, 'rapport'), turn: 1 });
  assert.equal(r.intent, 'pitch');
  assert.match(r.say, /old quote|fuel|truck/i);
  assert.doesNotMatch(r.say.toLowerCase(), /i will clear the hold/);
});

test('company hears the refuse and tries one more close', () => {
  const r = companyAnswer({ ...c, heard: clerkLine(c, 'refuse'), turn: 2 });
  assert.equal(r.intent, 'close_try');
  assert.match(r.say, /delivery|half|meet you/i);
});

test('company hears the hold line and agrees to a credit', () => {
  const r = companyAnswer({ ...c, heard: clerkLine(c, 'hold_line'), turn: 3 });
  assert.equal(r.intent, 'agree');
  assert.match(r.say, /credit memo/);
  assert.match(r.say, /\$255\.00/);
  assert.equal(r.resolution?.holdStays, true);
  assert.equal(r.resolution?.pays, false);
});

test('resolution never pays and never clears the hold', () => {
  const r = resolutionOf(c);
  assert.equal(r.pays, false);
  assert.equal(r.holdStays, true);
  assert.match(r.summary, /hold stays/);
  assert.match(r.summary, /never pays/);
});

test('ceiling pitch talks about extra tons, not unit price', () => {
  const v: DeskCase = { ...c, holdCode: 'PO_CEILING', extraCents: 63000, supplier: 'Valley Sand & Gravel', contactName: 'Cal Rivera' };
  const r = companyAnswer({ ...v, heard: clerkLine(v, 'rapport'), turn: 1 });
  assert.equal(r.intent, 'pitch');
  assert.match(r.say, /tons|truck|dump/i);
});
