import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const dbRoot = resolve(process.cwd(), '../db');
const from = resolve(dbRoot, 'dist');
const to = resolve(process.cwd(), '.local-backend');

if (!existsSync(resolve(dbRoot, 'package.json'))) {
  console.log('skip local backend: ../db is not in this upload');
  process.exit(0);
}

const built = spawnSync('npm', ['run', 'build:local'], { cwd: dbRoot, stdio: 'inherit' });
if (built.status) process.exit(built.status);

if (!existsSync(from)) {
  throw new Error(`db/dist is missing. Run npm --prefix ../db run build:local first.`);
}
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log('staged .local-backend from db/dist');
