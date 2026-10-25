// Which Gmail settings are present, and in which file, without ever printing a value.
//   cd web && npm run check:gmail
// The web app reads web/.env.local; the root .env is for Python. Gmail needs an OAuth client (ID ending in
// .apps.googleusercontent.com, plus its secret). A Google API key (starts with AIza) won't work.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [['web/.env.local', resolve(web, '.env.local')], ['.env (root)', resolve(web, '..', '.env')]];
const NAMES = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URI'];
const REDIRECT = 'http://localhost:3001/api/gmail/callback';

function parse(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function shape(name, v) {
  if (!v) return 'present but empty';
  if (v.startsWith('AIza')) return 'WRONG: this is a Google API key (AIza...), not an OAuth client';
  if (name === 'GMAIL_CLIENT_ID') return v.endsWith('.apps.googleusercontent.com') ? 'ok (OAuth client ID)' : 'WRONG: should end in .apps.googleusercontent.com';
  if (name === 'GMAIL_CLIENT_SECRET') return v.startsWith('GOCSPX-') ? 'ok (OAuth client secret)' : 'present (not the usual GOCSPX- prefix; fine if it came from the OAuth client)';
  return v === REDIRECT ? 'ok' : `different from ${REDIRECT}; it must match the OAuth client exactly`;
}

let webOk = true;
for (const [label, path] of FILES) {
  if (!existsSync(path)) {
    console.log(`${label}: file not found`);
    if (label.startsWith('web')) webOk = false;
    continue;
  }
  const env = parse(path);
  console.log(`${label}:`);
  for (const n of NAMES) {
    const has = Object.hasOwn(env, n);
    console.log(`  ${n.padEnd(20)} ${has ? shape(n, env[n]) : 'missing'}`);
    if (label.startsWith('web') && !has && n !== 'GMAIL_REDIRECT_URI') webOk = false;
    if (label.startsWith('web') && has && /WRONG|empty/.test(shape(n, env[n]))) webOk = false;
  }
}
console.log(webOk
  ? '\nweb/.env.local has what Gmail needs. Restart the web app after any change.'
  : '\nGmail is not set up in web/.env.local yet (the web app does not read the root .env). See the Gmail steps in web/README.md or on /inbox.');
process.exit(webOk ? 0 : 1);
