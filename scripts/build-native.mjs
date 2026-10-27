// Compiles native/screen-access.swift into native/bin/screen-access (macOS only).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCREEN_ACCESS = path.join(ROOT, 'native', 'bin', 'screen-access');

export function buildNative() {
  if (process.platform !== 'darwin') return null;
  fs.mkdirSync(path.dirname(SCREEN_ACCESS), { recursive: true });
  execFileSync('xcrun', [
    'swiftc', '-O',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`,
    path.join(ROOT, 'native', 'screen-access.swift'),
    '-o', SCREEN_ACCESS,
  ], { stdio: 'inherit' });
  return SCREEN_ACCESS;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Compilado: ${path.relative(ROOT, buildNative())}`);
}
