import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = (p) => path.join(root, 'extension', p);

// --- Расширение ---
await build({
  entryPoints: {
    background: ext('src/background.ts'),
    content: ext('src/content.ts'),
    popup: ext('src/popup/popup.ts'),
  },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir: ext('dist'),
  logLevel: 'info',
});

mkdirSync(ext('dist'), { recursive: true });
cpSync(ext('manifest.json'), ext('dist/manifest.json'));
cpSync(ext('src/popup/popup.html'), ext('dist/popup.html'));
cpSync(ext('src/popup/popup.css'), ext('dist/popup.css'));
cpSync(ext('icons'), ext('dist/icons'), { recursive: true });
cpSync(ext('fonts'), ext('dist/fonts'), { recursive: true });

// --- CoApp ---
await build({
  entryPoints: [path.join(root, 'coapp/src/host.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(root, 'coapp/dist/host.cjs'),
  logLevel: 'info',
});

console.log('Build done.');
