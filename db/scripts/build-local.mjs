// Bundle the local demo backend (local/backend.ts) into dist/local.mjs for the web server.
// spacetimedb is bundled in, its host syscalls resolve to the same stub the vitest plugin uses,
// and the test datastore's wasm files are copied next to the bundle.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

const vite = spacetimedbModuleTestPlugin();
const STUB = '\0spacetimedb-module-test-sys';
const sysPlugin = {
  name: 'spacetime-sys',
  setup(b) {
    b.onResolve({ filter: /^spacetime:sys@/ }, args => ({ path: vite.resolveId(args.path) ?? args.path, namespace: 'stsys' }));
    b.onLoad({ filter: /.*/, namespace: 'stsys' }, () => ({ contents: vite.load(STUB), loader: 'js' }));
  },
};

await build({
  entryPoints: ['local/backend.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/local.mjs',
  plugins: [sysPlugin],
  external: ['./portable-datastore-wasm/*'],
  // spacetimedb's server polyfill replaces globalThis.console with the module-host stub; restore the
  // real one after the bundle loads so the host app (Next.js) keeps its logs.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url); const __realConsole = globalThis.console; const __hadWindow = 'window' in globalThis; const __hadGlobal = 'global' in globalThis;" },
  // It also aliases globalThis.window (Next.js would then think server rendering runs in a browser).
  footer: { js: 'globalThis.console = __realConsole; if (!__hadWindow) delete globalThis.window; if (!__hadGlobal) delete globalThis.global;' },
  logLevel: 'warning',
});

const pkgDir = join(process.cwd(), 'node_modules', 'spacetimedb');
mkdirSync('dist', { recursive: true });
cpSync(join(pkgDir, 'dist/server/test-utils/portable-datastore-wasm'), 'dist/portable-datastore-wasm', { recursive: true });
console.log('built dist/local.mjs');
