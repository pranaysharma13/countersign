import assert from 'node:assert/strict';
import test from 'node:test';
import { roleFromLogin, supabaseIssuer, supabaseJwks } from './authRole.ts';

test('known staff mail sits at the right desk', () => {
  assert.equal(roleFromLogin({ email: 'dana@marlowfinch.example' }), 'owner');
  assert.equal(roleFromLogin({ email: 'jordan@marlowfinch.example' }), 'purchasing');
  assert.equal(roleFromLogin({ email: 'luis@marlowfinch.example' }), 'receiver');
  assert.equal(roleFromLogin({ email: 'sam@marlowfinch.example' }), 'bookkeeper');
});

test('user_metadata.role wins over the email', () => {
  assert.equal(roleFromLogin({ email: 'dana@marlowfinch.example', role: 'bookkeeper' }), 'bookkeeper');
});

test('unknown mail still gets a desk, not a crash', () => {
  assert.equal(roleFromLogin({ email: 'ap@other.example' }), 'owner');
});

test('Spacetime OIDC issuer is the Auth JWKS host', () => {
  const url = 'https://abcd.supabase.co';
  assert.equal(supabaseIssuer(url), 'https://abcd.supabase.co/auth/v1');
  assert.equal(supabaseJwks(url), 'https://abcd.supabase.co/auth/v1/.well-known/jwks.json');
});
