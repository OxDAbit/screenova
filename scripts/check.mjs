// Syntax-checks every JavaScript source with `node --check`; works the same on
// macOS, Windows and Linux (no shell globbing).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src/main', 'src/renderer', 'scripts'];

let failed = 0;
for (const dir of DIRS) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    if (!/\.(c|m)?js$/.test(name)) continue;
    const file = path.join(ROOT, dir, name);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failed += 1;
      console.error(`✗ ${path.relative(ROOT, file)}\n${err.stderr}`);
    }
  }
}
if (failed) process.exit(1);
console.log('Sintaxis correcta en todos los archivos.');
