// Headless self-check for CI: `SCREENOVA_SMOKE=<results.json> Screenova` runs the
// platform-specific pieces on a real machine (ffmpeg and its encoders,
// MediaRecorder codecs, screen capture sources, the library UI and the tray
// icon), writes a JSON report and exits with 0 only if every check passed.
// It records nothing: the video comes from ffmpeg and a canvas.
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, desktopCapturer, nativeImage } = require('electron');
const platform = require('./platform');

const TIMEOUT_MS = 150_000;

async function size(file) {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

function loaded(w) {
  return new Promise((resolve) => w.webContents.once('did-finish-load', resolve));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkFfmpeg(media) {
  const version = await new Promise((resolve, reject) => {
    execFile(media.ffmpegPath, ['-hide_banner', '-version'], (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  return version.split('\n')[0];
}

async function checkPipeline(media, dir) {
  const part = path.join(dir, 'clip.part');
  const video = path.join(dir, 'clip.mp4');
  const thumb = path.join(dir, 'clip.jpg');
  await media.makeTestClip(part, 3);
  await media.finalize(part, video, thumb);
  const copied = await media.exportMp4(video, path.join(dir, 'full.mp4'), { durationSec: 3 }, () => {});
  const trimmed = await media.exportMp4(video, path.join(dir, 'trim.mp4'), { start: 0.5, end: 2.5, durationSec: 3 }, () => {});
  const sizes = {
    video: await size(video),
    thumb: await size(thumb),
    full: await size(path.join(dir, 'full.mp4')),
    trim: await size(path.join(dir, 'trim.mp4')),
  };
  if (Object.values(sizes).some((s) => s === 0)) throw new Error(`empty output ${JSON.stringify(sizes)}`);
  return { exportCopy: copied, exportTrimEncoder: trimmed, sizes };
}

// Runs inside recorder.html, so it tests the exact codec list the recorder uses.
const RECORDER_PROBE = `(async () => {
  const supported = MIME_TYPES.filter((t) => MediaRecorder.isTypeSupported(t));
  const mimeType = supported[0];
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const g = canvas.getContext('2d');
  let t = 0;
  const draw = setInterval(() => {
    t += 1;
    g.fillStyle = 'hsl(' + (t * 7) % 360 + ', 50%, 40%)';
    g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#fff';
    g.font = '64px sans-serif';
    g.fillText('Screenova ' + t, 80, 120 + (t * 9) % 500);
  }, 33);
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType, videoBitsPerSecond: 4000000 });
  let bytes = 0;
  recorder.ondataavailable = (e) => { bytes += e.data.size; };
  recorder.start(500);
  await new Promise((r) => setTimeout(r, 2500));
  recorder.stop();
  await new Promise((r) => { recorder.onstop = r; });
  clearInterval(draw);
  return { supported, mimeType: recorder.mimeType || mimeType, bytes };
})()`;

async function checkRecorder(createWindow) {
  const w = createWindow('recorder.html', { width: 320, height: 240 });
  await loaded(w);
  try {
    const result = await w.webContents.executeJavaScript(RECORDER_PROBE);
    if (!result.bytes) throw new Error(`MediaRecorder produced no data with ${result.mimeType}`);
    result.hardwareFriendly = /avc1|h264/.test(result.mimeType);
    return result;
  } finally {
    w.destroy();
  }
}

async function checkSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  if (!sources.length) throw new Error('no screens offered for capture');
  return { screens: sources.length };
}

async function checkLibrary(createWindow) {
  const errors = [];
  const w = createWindow('library.html', { width: 1200, height: 800 });
  // Electron 35+ passes one details object; older versions passed positional args.
  w.webContents.on('console-message', (details, legacyLevel, legacyMessage) => {
    const level = details?.level ?? legacyLevel;
    if (level === 'error' || level === 3) errors.push(details?.message ?? legacyMessage);
  });
  await loaded(w);
  await wait(1500);
  try {
    const ui = await w.webContents.executeJavaScript(`({
      platform: document.documentElement.dataset.platform,
      reveal: document.getElementById('reveal').textContent,
      shortcut: document.getElementById('empty-shortcut').textContent,
      bannerHidden: document.getElementById('banner').hidden,
    })`);
    if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`);
    if (ui.platform !== process.platform) throw new Error(`platform class is ${ui.platform}`);
    if (ui.reveal !== platform.labels.reveal) throw new Error(`reveal label is "${ui.reveal}"`);
    return ui;
  } finally {
    w.destroy();
  }
}

function checkTrayIcon(assets) {
  const file = path.join(assets, platform.isMac ? 'trayTemplate.png' : 'tray.png');
  if (!existsSync(file)) throw new Error(`missing ${path.basename(file)}`);
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`${path.basename(file)} did not load`);
  return image.getSize();
}

module.exports = async function runSmoke(outPath, { createWindow, media }) {
  const watchdog = setTimeout(() => app.exit(2), TIMEOUT_MS);
  const dir = path.join(app.getPath('temp'), `screenova-smoke-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });

  const report = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    checks: [],
  };
  const check = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      report.checks.push({ name, ok: true, ms: Date.now() - started, detail });
    } catch (err) {
      report.checks.push({ name, ok: false, ms: Date.now() - started, error: String(err?.message ?? err).slice(0, 2000) });
    }
  };

  await check('ffmpeg', () => checkFfmpeg(media));
  await check('media-pipeline', () => checkPipeline(media, dir));
  await check('media-recorder', () => checkRecorder(createWindow));
  await check('screen-sources', () => checkSources());
  await check('library-ui', () => checkLibrary(createWindow));
  await check('tray-icon', () => checkTrayIcon(path.join(__dirname, '..', '..', 'assets')));

  report.ok = report.checks.every((c) => c.ok);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  await fs.rm(dir, { recursive: true, force: true });
  clearTimeout(watchdog);
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
};
