import assert from 'node:assert/strict';
import test from 'node:test';
import { approveFromTranscript, billSpeech, blockedSpeech, callScript, parseSiteReceipt, paymentReadback, queueSpeech, spokenBriefing, transferSpeech, verdictFromTranscript } from './voice.ts';
import { fingerprint } from './voiceLog.ts';

test('empty reply is unclear', () => {
  assert.equal(verdictFromTranscript('', '7703'), 'unclear');
});

test('yes plus last four accepts', () => {
  assert.equal(verdictFromTranscript('Yes, we requested 7703', '7703'), 'accept');
});

test('plain no rejects', () => {
  assert.equal(verdictFromTranscript('No, we did not request this', '7703'), 'reject');
  assert.equal(verdictFromTranscript('Nope. Fraud.', '7703'), 'reject');
});

test('yes without last four stays unclear', () => {
  assert.equal(verdictFromTranscript('Yes I think so', '7703'), 'unclear');
});

test('strong confirm without digits still accepts', () => {
  assert.equal(verdictFromTranscript('Yes, that is right, we requested the change', '7703'), 'accept');
});

test('call script never uses a number from the request as the callee', () => {
  const s = callScript({
    contactName: 'Mina Cole',
    contactPhone: '4155550144',
    supplier: 'Northline Rebar',
    invoiceNumber: 'NL-441',
    oldLast4: '4188',
    newLast4: '7703',
    newBank: 'Harbor Wire Bank',
  });
  assert.match(s.clerkOpen, /415, 555, 0144/);
  assert.match(s.clerkAsk, /7 7 0 3/);
  assert.doesNotMatch(s.clerkOpen, /7703/);
});

test('briefing is trimmed and joined', () => {
  assert.equal(spokenBriefing(['  A.  ', '', 'B.']), 'A. B.');
});

test('briefing speaks cubic yards and last-four marks', () => {
  assert.match(spokenBriefing(['40 yd³ to ····4188']), /cubic yards/);
  assert.match(spokenBriefing(['40 yd³ to ····4188']), /ending 4188/);
});

test('queue speech names the first bill and who acts', () => {
  const s = queueSpeech([
    { supplier: 'Valley Sand & Gravel', number: 'VS-310', who: 'Buyer', action: 'Ask the supplier for a corrected invoice.', amount: '$3,990.00' },
    { supplier: 'Ridge Hardware', number: 'RH-55', who: 'Buyer', action: 'Ask about the extra charge.', amount: '$412.00' },
  ]);
  assert.match(s, /2 bills are waiting/);
  assert.match(s, /Valley Sand/);
  assert.match(s, /\$3,990/);
  assert.match(s, /Buyer/);
  assert.match(s, /VS 310/);
});

test('empty queue has a plain line', () => {
  assert.equal(queueSpeech([]), 'Nothing is waiting on you.');
});

test('blocked speech lists why it cannot pay', () => {
  const s = blockedSpeech({
    supplier: 'Northline Rebar',
    invoiceNumber: 'NL-441',
    amount: '$8,200.00',
    reasons: ['New bank account', 'Only Dana can pay.'],
  });
  assert.match(s, /cannot pay \$8,200/);
  assert.match(s, /New bank account/);
  assert.match(s, /NL 441/);
});

test('transfer speech reads money and last four', () => {
  const s = transferSpeech({
    supplier: 'Cedar & Bolt', invoiceNumber: 'CB-8802',
    amount: '$4,180.00', bank: 'Fremont Trade Bank', last4: '5531',
  });
  assert.match(s, /\$4,180/);
  assert.match(s, /5 5 3 1/);
});

test('payment readback names the last four', () => {
  const s = paymentReadback({
    supplier: 'Cedar & Bolt', invoiceNumber: 'CB-8802',
    amount: '$4,180.00', bank: 'Fremont Trade Bank', last4: '5531',
  });
  assert.match(s, /4,180/);
  assert.match(s, /5 5 3 1/);
});

test('spoken approve needs the last four', () => {
  assert.equal(approveFromTranscript('approve 5531', '5531'), 'approve');
  assert.equal(approveFromTranscript('approve', '5531'), 'unclear');
  assert.equal(approveFromTranscript('reject this', '5531'), 'reject');
});

test('bill speech names the count and who acts', () => {
  const s = billSpeech({
    supplier: 'Valley Sand & Gravel',
    invoiceNumber: 'VS-310',
    story: 'They billed more than the purchase order allows.',
    who: 'Buyer',
    action: 'Ask the supplier for a corrected invoice.',
    math: 'Order allows 80 ton. This bill is 95 ton. Cannot pay $630.00.',
  });
  assert.match(s, /80 ton/);
  assert.match(s, /\$630/);
  assert.match(s, /Buyer/);
  assert.match(s, /VS 310/);
});

test('site receipt takes the first number as the count', () => {
  assert.deepEqual(parseSiteReceipt('Counted 40 crates against the packing list'), {
    qty: '40', reason: 'Counted 40 crates against the packing list',
  });
  assert.equal(parseSiteReceipt('ninety five tons, tickets match').qty, '');
});

test('fingerprint changes when the words change', () => {
  assert.notEqual(fingerprint('yes 7703'), fingerprint('yes 7704'));
  assert.equal(fingerprint('same'), fingerprint('same'));
});
