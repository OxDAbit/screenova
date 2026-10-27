// Builds "Screenova.app", signs it ad hoc and installs it in ~/Applications, so
// macOS treats it as its own app (camera, microphone and screen-recording
// permissions belong to it instead of the terminal that launched it).
//
// The build happens in a temp folder: ~/Documents may be synced by iCloud,
// which keeps adding Finder metadata that codesign rejects.
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNative } from './build-native.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = pkg.productName;
const BUNDLE_ID = 'com.oxdabit.screenova';
const BUILD = path.join(os.tmpdir(), 'screenova-build');
const INSTALL_DIR = path.join(os.homedir(), 'Applications');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

fs.rmSync(BUILD, { recursive: true, force: true });
const screenAccess = buildNative();

const [outDir] = await packager({
  dir: ROOT,
  out: BUILD,
  overwrite: true,
  platform: 'darwin',
  arch: process.arch,
  name: NAME,
  executableName: NAME,
  appBundleId: BUNDLE_ID,
  appCategoryType: 'public.app-category.video',
  appVersion: pkg.version,
  appCopyright: `© ${new Date().getFullYear()} 0xDA bit`,
  icon: path.join(ROOT, 'assets', 'icon.icns'),
  darwinDarkModeSupport: true,
  prune: true,
  // ffmpeg is an executable, so it has to live outside the asar archive.
  asar: { unpack: '**/node_modules/ffmpeg-static/**' },
  ignore: [/^\/out($|\/)/, /^\/scripts($|\/)/, /^\/native($|\/)/, /^\/README\.md$/, /^\/\.gitignore$/],
  // Lands in Contents/Resources, outside the asar archive, so it can run.
  extraResource: [screenAccess],
  extendInfo: {
    NSCameraUsageDescription: `${NAME} usa la cámara cuando la incluyes en una grabación.`,
    NSMicrophoneUsageDescription: `${NAME} usa el micrófono para grabar tu voz.`,
    LSMinimumSystemVersion: '12.0',
  },
});

const built = path.join(outDir, `${NAME}.app`);

// The app holds camera, microphone and screen-recording grants. These fuses stop
// other local programs from running the bundled Electron as plain Node.js
// (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect) and inheriting those grants,
// and make it load its code only from the packaged asar archive.
await flipFuses(path.join(built, 'Contents', 'MacOS', NAME), {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
});

// Editing Info.plist and the fuses invalidates Electron's signature; re-sign ad hoc.
run('xattr', ['-cr', built]);
run('codesign', ['--force', '--deep', '--sign', '-', built]);
// An ad hoc signature's designated requirement defaults to the binary's cdhash,
// which changes on every build, so macOS would forget the camera, microphone
// and screen-recording grants each time. Pin it to the bundle identifier
// instead. Only the outer bundle is re-signed: the helpers keep their own.
run('codesign', [
  '--force', '--sign', '-',
  `-r=designated => identifier "${BUNDLE_ID}"`,
  built,
]);
run('codesign', ['--verify', '--deep', '--strict', built]);

fs.mkdirSync(INSTALL_DIR, { recursive: true });
const installed = path.join(INSTALL_DIR, `${NAME}.app`);
fs.rmSync(installed, { recursive: true, force: true });
// ditto keeps the bundle's symlinks and signature intact.
run('ditto', ['--norsrc', '--noextattr', built, installed]);
fs.rmSync(BUILD, { recursive: true, force: true });

console.log(`Instalada en ${installed}`);
