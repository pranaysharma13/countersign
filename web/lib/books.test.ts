import assert from 'node:assert/strict';
import test from 'node:test';
import { booksLine } from './books.ts';

test('local books say they will not follow a public domain', () => {
  const s = booksLine({ source: 'local', shared: false, core: false, hosted: false });
  assert.match(s, /this machine/);
  assert.doesNotMatch(s, /DATA_SOURCE|Spacetime|Vercel/);
});

test('live books without the file service stay honest', () => {
  const s = booksLine({ source: 'live', shared: true, core: false, hosted: true });
  assert.match(s, /Shared books/);
  assert.match(s, /PDF preview/);
});
