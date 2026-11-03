import assert from 'node:assert/strict';
import test from 'node:test';
import { siteUrl } from './siteUrl.ts';

test('siteUrl falls back to localhost when no host env is set', () => {
  const prev = {
    APP_URL: process.env.APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  };
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  assert.equal(siteUrl(), 'http://localhost:3001');
  process.env.APP_URL = 'https://clerk.example/';
  assert.equal(siteUrl(), 'https://clerk.example');
  Object.assign(process.env, prev);
});
