const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const path = require('node:path');
const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences,
  globalShortcut, Tray, Menu, nativeImage, dialog, shell, screen,
} = require('electron');
const { APP_NAME, SHORTCUT_TOGGLE, SHORTCUT_PAUSE, NAVY, TOPBAR, CREAM } = require('./brand');
const platform = require('./platform');
const store = require('./store');
const media = require('./media');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const ASSETS = path.join(ROOT, 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');

const BUBBLE_SIZES = { s: 160, m: 240, l: 360 };
const ID_PATTERN = /^rec-[a-z0-9-]+$/;

app.setName(APP_NAME);

// The smoke test uses a throwaway profile, so it neither collides with a running
// Screenova (single-instance lock) nor leaves anything in the real one.
if (process.env.SCREENOVA_SMOKE) {
  app.setPath('userData', path.join(app.getPath('temp'), `screenova-smoke-profile-${process.pid}`));
}

if (!app.requestSingleInstanceLock()) app.quit();

const win = { library: null, bubble: null, controls: null, countdown: null, recorder: null };

// One recording session at a time. `token` changes whenever a session is
// cancelled or restarted, so stale async steps can tell they are obsolete.
const rec = {
  state: 'idle', // idle | countdown | recording | paused | saving
  token: null,
  config: null,
  display: null,
  id: null,
  ext: 'mp4', // final container, set when the recorder reports its codec
  tempPath: null,
  writer: null,
  createdAt: 0,
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  durationMs: 0,
  countdownTimer: null,
  countdownDone: null,
  pendingReady: null,
  onDiscarded: null,
};

let selectedSourceId = null;
let screenRequested = false;
const sourceDisplays = new Map();
let tray = null;

// ---------------------------------------------------------------- windows

// Overlays and the hidden recorder must keep running while unfocused or
// hidden; the library can be throttled like any background window.
function createWindow(page, { backgroundThrottling = false, ...options } = {}, query) {
  const w = new BrowserWindow({
    show: false,
    title: APP_NAME,
    ...options,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling,
    },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (event) => event.preventDefault());
  w.loadFile(path.join(RENDERER, page), query ? { query } : undefined);
  return w;
}

function alive(key) {
  return win[key] && !win[key].isDestroyed() ? win[key] : null;
}

function closeWindow(key) {
  const w = alive(key);
  if (w) w.destroy();
  win[key] = null;
}

function closeOverlays() {
  closeWindow('bubble');
  closeWindow('controls');
  closeWindow('countdown');
}

function whenLoaded(w) {
  return w.webContents.isLoading()
    ? new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    : Promise.resolve();
}

function showLibrary() {
  const existing = alive('library');
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }
  // The library draws its own top bar. macOS keeps its traffic lights inside it;
  // Windows and Linux get their minimise/maximise/close buttons overlaid on the
  // right of the same bar.
  const titleBar = platform.isMac
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 } }
    : {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: TOPBAR, symbolColor: CREAM, height: 68 },
      icon: path.join(ASSETS, 'icon-square.png'),
    };
  const w = createWindow('library.html', {
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    ...titleBar,
    backgroundColor: NAVY,
    backgroundThrottling: true,
  });
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => {
    if (win.library === w) win.library = null;
  });
  win.library = w;
  return w;
}

async function sendToLibrary(channel, ...args) {
  const w = showLibrary();
  await whenLoaded(w);
  if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

function overlayOptions(extra) {
  return {
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    ...extra,
  };
}

function pinOnTop(w) {
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

// The camera bubble is deliberately NOT content-protected: it has to appear in
// the screen capture. The controls and countdown are hidden from the capture.
function openBubble(cameraId, display, sizeKey) {
  closeWindow('bubble');
  const size = BUBBLE_SIZES[sizeKey];
  const { workArea } = display;
  const w = createWindow('bubble.html', overlayOptions({
    width: size,
    height: size,
    x: workArea.x + 40,
    y: workArea.y + workArea.height - size - 40,
  }), { cameraId: cameraId || '', size: sizeKey });
  pinOnTop(w);
  w.once('ready-to-show', () => w.showInactive());
  win.bubble = w;
}

function openControls(display) {
  closeWindow('controls');
  const width = 380;
  const height = 72;
  const { workArea } = display;
  const w = createWindow('controls.html', overlayOptions({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + workArea.height - height - 28,
  }));
  w.setContentProtection(true);
  pinOnTop(w);
  w.once('ready-to-show', () => {
    w.showInactive();
    w.webContents.send('rec:state', publicState());
  });
  win.controls = w;
}

function openCountdown(display) {
  closeWindow('countdown');
  const size = 260;
  const { workArea } = display;
  const w = createWindow('countdown.html', overlayOptions({
    width: size,
    height: size,
    x: Math.round(workArea.x + (workArea.width - size) / 2),
    y: Math.round(workArea.y + (workArea.height - size) / 2),
    focusable: false,
  }));
  w.setContentProtection(true);
  w.setIgnoreMouseEvents(true);
  pinOnTop(w);
  win.countdown = w;
  return w;
}

// ---------------------------------------------------------------- state

function elapsedMs() {
  if (!rec.startedAt) return 0;
  const now = rec.state === 'paused' ? rec.pausedAt : Date.now();
  return Math.max(0, now - rec.startedAt - rec.pausedTotal);
}

function publicState() {
  return { state: rec.state, elapsed: elapsedMs(), mode: rec.config?.mode ?? null };
}

function broadcast() {
  const payload = publicState();
  for (const key of Object.keys(win)) {
    const w = alive(key);
    if (w) w.webContents.send('rec:state', payload);
  }
  updateTray();
}

function resetSession() {
  Object.assign(rec, {
    state: 'idle', token: null, config: null, display: null, id: null, ext: 'mp4', tempPath: null, writer: null,
    createdAt: 0, startedAt: 0, pausedAt: 0, pausedTotal: 0, durationMs: 0,
    countdownTimer: null, countdownDone: null, pendingReady: null, onDiscarded: null,
  });
}

// ---------------------------------------------------------------- session

function sanitizeConfig(raw = {}) {
  const mode = ['screen-cam', 'screen', 'cam'].includes(raw.mode) ? raw.mode : 'screen-cam';
  const str = (v) => (typeof v === 'string' ? v.slice(0, 512) : '');
  return {
    mode,
    sourceId: str(raw.sourceId),
    cameraId: str(raw.cameraId),
    micId: str(raw.micId),
    bubbleSize: BUBBLE_SIZES[raw.bubbleSize] ? raw.bubbleSize : 'm',
  };
}

function displayFor(config) {
  const id = sourceDisplays.get(config.sourceId);
  const match = config.mode !== 'cam' && id && screen.getAllDisplays().find((d) => String(d.id) === id);
  if (match) return match;
  const lib = alive('library');
  return lib ? screen.getDisplayMatching(lib.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function openWriter() {
  await store.ensureDir();
  rec.id = store.newId();
  // The container is only known once the recorder picks a codec; ffmpeg probes it later.
  rec.tempPath = path.join(store.dir(), `${rec.id}.part`);
  rec.writer = fs.createWriteStream(rec.tempPath);
}

function closeWriter() {
  const writer = rec.writer;
  rec.writer = null;
  if (!writer) return Promise.resolve();
  return new Promise((resolve) => writer.end(resolve));
}

function prepareRecorder(config) {
  closeWindow('recorder');
  const w = createWindow('recorder.html', { width: 320, height: 240 });
  win.recorder = w;
  const ready = new Promise((resolve, reject) => {
    rec.pendingReady = { resolve, reject };
  });
  whenLoaded(w).then(() => {
    if (!w.isDestroyed()) w.webContents.send('recorder:prepare', config);
  });
  return ready;
}

function runCountdown(display) {
  const w = openCountdown(display);
  return new Promise((resolve) => {
    rec.countdownDone = resolve;
    let n = 3;
    const tick = () => {
      if (w.isDestroyed()) return resolve();
      if (n === 0) {
        closeWindow('countdown');
        return resolve();
      }
      w.webContents.send('countdown:tick', n);
      n -= 1;
      rec.countdownTimer = setTimeout(tick, 1000);
    };
    whenLoaded(w).then(() => {
      if (w.isDestroyed()) return resolve();
      w.showInactive();
      tick();
    });
  });
}

function stopCountdown() {
  clearTimeout(rec.countdownTimer);
  rec.countdownTimer = null;
  rec.countdownDone?.();
  rec.countdownDone = null;
  closeWindow('countdown');
}

async function startSession(config) {
  const token = {};
  rec.token = token;
  rec.config = config;
  rec.startedAt = 0;
  rec.pausedTotal = 0;
  rec.state = 'countdown';
  broadcast();

  try {
    await openWriter();
    await Promise.all([prepareRecorder(config), runCountdown(rec.display)]);
  } catch (err) {
    if (rec.token === token) await abortSession(err.message);
    return;
  }
  if (rec.token !== token || rec.state !== 'countdown') return;

  rec.createdAt = Date.now();
  rec.startedAt = Date.now();
  rec.state = 'recording';
  alive('recorder')?.webContents.send('recorder:begin');
  broadcast();
}

function discardRecorder() {
  const w = alive('recorder');
  if (!w) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    rec.onDiscarded = () => {
      clearTimeout(timer);
      resolve();
    };
    w.webContents.send('recorder:discard');
  });
}

async function dropRecording() {
  rec.token = null;
  rec.pendingReady = null;
  stopCountdown();
  await discardRecorder();
  closeWindow('recorder');
  const tempPath = rec.tempPath;
  await closeWriter();
  if (tempPath) await fsp.rm(tempPath, { force: true });
}

async function abortSession(message) {
  await dropRecording();
  closeOverlays();
  resetSession();
  broadcast();
  await sendToLibrary('library:error', message);
}

async function cancelSession() {
  if (!['countdown', 'recording', 'paused'].includes(rec.state)) return;
  await dropRecording();
  closeOverlays();
  resetSession();
  broadcast();
  showLibrary();
}

async function restartSession() {
  if (!['countdown', 'recording', 'paused'].includes(rec.state)) return;
  const { config, display } = rec;
  await dropRecording();
  resetSession();
  rec.display = display;
  startSession(config);
}

function stopSession() {
  if (rec.state === 'countdown') return cancelSession();
  if (rec.state !== 'recording' && rec.state !== 'paused') return;
  rec.durationMs = elapsedMs();
  rec.state = 'saving';
  closeWindow('controls');
  broadcast();
  alive('recorder')?.webContents.send('recorder:stop');
}

async function finishSession() {
  const { id, tempPath, durationMs, createdAt, config, ext } = rec;
  await closeWriter();
  closeWindow('recorder');
  closeOverlays();
  await sendToLibrary('rec:state', publicState());

  try {
    const f = store.files(id, ext);
    await media.finalize(tempPath, f.video, f.thumb);
    await store.save({
      id,
      ext,
      title: store.defaultTitle(new Date(createdAt)),
      createdAt,
      durationMs,
      mode: config.mode,
      trimStart: 0,
      trimEnd: null,
    });
    resetSession();
    broadcast();
    await sendToLibrary('library:changed');
    await sendToLibrary('library:open', id);
  } catch (err) {
    resetSession();
    broadcast();
    await sendToLibrary('library:error', `No se pudo guardar la grabación: ${err.message}`);
  }
}

function togglePause() {
  const recorder = alive('recorder');
  if (!recorder) return;
  if (rec.state === 'recording') {
    rec.state = 'paused';
    rec.pausedAt = Date.now();
    recorder.webContents.send('recorder:pause');
  } else if (rec.state === 'paused') {
    rec.pausedTotal += Date.now() - rec.pausedAt;
    rec.state = 'recording';
    recorder.webContents.send('recorder:resume');
  } else {
    return;
  }
  broadcast();
}

function openNewRecording() {
  sendToLibrary('library:new-recording');
}

function onShortcutToggle() {
  if (rec.state === 'idle') openNewRecording();
  else if (rec.state === 'countdown') cancelSession();
  else stopSession();
}

// ---------------------------------------------------------------- permissions

// Electron's capture APIs fail silently on recent macOS instead of showing the
// screen-recording prompt, so a tiny native helper asks for it. Being a child of
// the app, its request is attributed to Screenova and adds it to the privacy list.
const SCREEN_ACCESS = app.isPackaged
  ? path.join(process.resourcesPath, 'screen-access')
  : path.join(ROOT, 'native', 'bin', 'screen-access');

function requestScreenAccess() {
  if (process.platform !== 'darwin' || !fs.existsSync(SCREEN_ACCESS)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(SCREEN_ACCESS, ['request'], { timeout: 120000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

function permissionStatus() {
  if (process.platform !== 'darwin') return { screen: 'granted', camera: 'granted', microphone: 'granted' };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
  };
}

async function requestPermissions(config) {
  if (process.platform !== 'darwin') return { ok: true };
  if (config.mode !== 'screen' && !(await systemPreferences.askForMediaAccess('camera'))) {
    return { ok: false, code: 'camera', error: `${APP_NAME} necesita acceso a la cámara.` };
  }
  if (config.micId && !(await systemPreferences.askForMediaAccess('microphone'))) {
    return { ok: false, code: 'microphone', error: `${APP_NAME} necesita acceso al micrófono.` };
  }
  if (config.mode !== 'cam' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
    return {
      ok: false,
      code: 'screen',
      error: 'Falta el permiso de grabación de pantalla. Actívalo en Ajustes del Sistema y vuelve a abrir la app.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- IPC

function fromRecorder(event) {
  return event.sender === alive('recorder')?.webContents;
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    labels: platform.labels,
    home: app.getPath('home'),
    shortcut: SHORTCUT_TOGGLE,
    pauseShortcut: SHORTCUT_PAUSE,
    folder: store.dir(),
    state: publicState(),
  }));

  ipcMain.handle('sources:list', async () => {
    // Ask once per launch; macOS only shows its prompt the first time anyway.
    if (!screenRequested && permissionStatus().screen !== 'granted') {
      screenRequested = true;
      await requestScreenAccess();
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: false,
    });
    sourceDisplays.clear();
    return sources
      .filter((s) => !s.name.startsWith(APP_NAME))
      .map((s) => {
        sourceDisplays.set(s.id, s.display_id);
        return {
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        };
      });
  });

  ipcMain.handle('permissions:check', () => permissionStatus());
  ipcMain.handle('permissions:open-settings', async (_e, kind) => {
    // Makes sure Screenova is in the list before sending the user there.
    if (kind === 'screen') await requestScreenAccess();
    const url = platform.settingsUrl(kind);
    if (url) shell.openExternal(url);
  });

  ipcMain.handle('rec:start', async (_e, raw) => {
    if (rec.state !== 'idle') return { ok: false, error: 'Ya hay una grabación en curso.' };
    const config = sanitizeConfig(raw);
    if (config.mode !== 'cam' && !config.sourceId) return { ok: false, error: 'Elige qué pantalla o ventana grabar.' };
    const permission = await requestPermissions(config);
    if (!permission.ok) return permission;

    selectedSourceId = config.sourceId;
    rec.display = displayFor(config);
    alive('library')?.hide();
    if (config.mode !== 'screen') {
      openBubble(config.cameraId, rec.display, config.mode === 'cam' ? 'l' : config.bubbleSize);
    }
    openControls(rec.display);
    startSession(config);
    return { ok: true };
  });

  ipcMain.on('rec:ready', (event, details = {}) => {
    if (!fromRecorder(event)) return;
    const mime = typeof details.mimeType === 'string' ? details.mimeType : '';
    rec.ext = /avc1|h264/.test(mime) ? 'mp4' : 'webm';
    console.log(`Recording ${details.width}x${details.height} as ${mime || 'default codec'}`);
    rec.pendingReady?.resolve();
    rec.pendingReady = null;
  });

  ipcMain.on('rec:failed', (event, message) => {
    if (!fromRecorder(event)) return;
    const text = typeof message === 'string' ? message : 'Error desconocido del grabador.';
    if (rec.pendingReady) {
      rec.pendingReady.reject(new Error(text));
      rec.pendingReady = null;
    } else {
      console.error('Recorder error:', text);
    }
  });

  ipcMain.on('rec:chunk', (event, data) => {
    if (!fromRecorder(event) || !rec.writer || !(data instanceof Uint8Array)) return;
    rec.writer.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });

  ipcMain.on('rec:finished', (event) => {
    if (fromRecorder(event) && rec.state === 'saving') finishSession();
  });

  ipcMain.on('rec:discarded', (event) => {
    if (!fromRecorder(event)) return;
    rec.onDiscarded?.();
    rec.onDiscarded = null;
  });

  ipcMain.on('rec:pause', () => rec.state === 'recording' && togglePause());
  ipcMain.on('rec:resume', () => rec.state === 'paused' && togglePause());
  ipcMain.on('rec:stop', () => stopSession());
  ipcMain.on('rec:restart', () => restartSession());
  ipcMain.on('rec:cancel', () => cancelSession());

  ipcMain.on('bubble:size', (event, key) => {
    const w = alive('bubble');
    const size = BUBBLE_SIZES[key];
    if (!w || event.sender !== w.webContents || !size) return;
    const b = w.getBounds();
    // Keep the bottom-left corner anchored, which is where the bubble starts.
    w.setBounds({ x: b.x, y: b.y + b.height - size, width: size, height: size });
  });

  ipcMain.handle('library:list', () => store.list());

  ipcMain.handle('library:update', (_e, id, patch = {}) => {
    if (!ID_PATTERN.test(id)) throw new Error('Grabación no válida.');
    const clean = {};
    if (typeof patch.title === 'string') clean.title = patch.title;
    if (Number.isFinite(patch.trimStart) && patch.trimStart >= 0) clean.trimStart = patch.trimStart;
    if (patch.trimEnd === null || (Number.isFinite(patch.trimEnd) && patch.trimEnd > 0)) clean.trimEnd = patch.trimEnd;
    return store.update(id, clean);
  });

  ipcMain.handle('library:remove', async (event, id) => {
    if (!ID_PATTERN.test(id)) throw new Error('Grabación no válida.');
    const entry = await store.get(id);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      buttons: ['Mover a la papelera', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      message: `¿Mover «${entry.title}» a la papelera?`,
      detail: `Podrás recuperarla desde ${platform.labels.trash}.`,
    });
    if (response !== 0) return false;
    await store.remove(id);
    return true;
  });

  ipcMain.handle('library:reveal', async (_e, id) => {
    if (!ID_PATTERN.test(id)) return;
    shell.showItemInFolder(store.files(id).video);
  });

  // Native menu for a library card; resolves to the chosen action, which the
  // library then runs through the same flows as the player's buttons.
  ipcMain.handle('library:card-menu', (event, id) => {
    if (!ID_PATTERN.test(id)) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    return new Promise((resolve) => {
      let choice = null;
      const pick = (action) => () => {
        choice = action;
        resolve(action);
      };
      const menu = Menu.buildFromTemplate([
        { label: 'Abrir', click: pick('open') },
        { label: 'Renombrar', click: pick('rename') },
        { type: 'separator' },
        { label: 'Exportar MP4…', click: pick('export') },
        { label: platform.labels.reveal, click: pick('reveal') },
        { type: 'separator' },
        { label: 'Mover a la papelera…', click: pick('remove') },
      ]);
      // `callback` runs when the menu closes, which can precede the click handler.
      menu.popup({ window, callback: () => setTimeout(() => choice ?? resolve(null), 50) });
    });
  });

  ipcMain.handle('library:reveal-folder', async () => {
    await store.ensureDir();
    shell.openPath(store.dir());
  });

  ipcMain.handle('library:export', async (event, id) => {
    if (!ID_PATTERN.test(id)) throw new Error('Grabación no válida.');
    const entry = await store.get(id);
    const safeName = entry.title.replace(/[\\/:*?"<>|]/g, '-');
    const parent = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(parent, {
      title: 'Exportar como MP4',
      defaultPath: path.join(app.getPath('desktop'), `${safeName}.mp4`),
      filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const send = (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('export:progress', { id, progress });
    };
    try {
      await media.exportMp4(entry.videoPath, filePath, {
        start: entry.trimStart || 0,
        end: entry.trimEnd ?? null,
        durationSec: entry.durationMs / 1000,
      }, send);
      send(1);
      shell.showItemInFolder(filePath);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err.message.split('\n')[0] };
    }
  });
}

// ---------------------------------------------------------------- tray

function updateTray() {
  if (!tray) return;
  const active = rec.state === 'recording' || rec.state === 'paused';
  const busy = rec.state !== 'idle';
  const template = [];
  if (!busy) {
    template.push({ label: 'Nueva grabación…', accelerator: SHORTCUT_TOGGLE, click: openNewRecording });
  } else {
    template.push(
      { label: 'Detener y guardar', accelerator: SHORTCUT_TOGGLE, enabled: active, click: stopSession },
      { label: rec.state === 'paused' ? 'Reanudar' : 'Pausar', accelerator: SHORTCUT_PAUSE, enabled: active, click: togglePause },
      { label: 'Cancelar grabación', enabled: rec.state !== 'saving', click: () => cancelSession() },
    );
  }
  template.push(
    { type: 'separator' },
    { label: 'Abrir biblioteca', click: showLibrary },
    { label: 'Abrir carpeta de grabaciones', click: async () => { await store.ensureDir(); shell.openPath(store.dir()); } },
    { type: 'separator' },
    { label: `Salir de ${APP_NAME}`, role: 'quit' },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
  // setTitle only shows text on macOS; elsewhere the tooltip carries the state.
  if (platform.isMac) tray.setTitle(active ? (rec.state === 'paused' ? ' Pausa' : ' REC') : '');
  else tray.setToolTip(active ? `${APP_NAME} · ${rec.state === 'paused' ? 'en pausa' : 'grabando'}` : APP_NAME);
}

function createTray() {
  // macOS tints a black template image for light and dark menu bars; Windows and
  // Linux show the icon as is, so they get the coloured mark.
  const iconPath = path.join(ASSETS, platform.isMac ? 'trayTemplate.png' : 'tray.png');
  if (!fs.existsSync(iconPath)) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (platform.isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  // A left click on a Windows/Linux tray icon is expected to open the app.
  if (!platform.isMac) tray.on('click', () => rec.state === 'idle' && showLibrary());
  updateTray();
}

// ---------------------------------------------------------------- lifecycle

app.on('second-instance', () => showLibrary());

// Groups the windows under one taskbar entry and names the app in Windows notifications.
if (platform.isWindows) app.setAppUserModelId('com.oxdabit.screenova');

app.whenReady().then(() => {
  const dockIcon = path.join(ASSETS, 'icon.png');
  if (platform.isMac && fs.existsSync(dockIcon)) app.dock?.setIcon(dockIcon);

  // 'fullscreen' is what the video player's full-screen button asks for.
  const allowed = new Set(['media', 'display-capture', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // getDisplayMedia() in the recorder window resolves to the source picked in the library.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const source = sources.find((s) => s.id === selectedSourceId) ?? sources.find((s) => s.id.startsWith('screen:'));
    callback(source ? { video: source } : {});
  });

  registerIpc();

  // CI runs the packaged app with SCREENOVA_SMOKE=<results.json> to check the
  // platform-specific pieces on a real Windows or Linux machine.
  if (process.env.SCREENOVA_SMOKE) {
    require('./smoke')(process.env.SCREENOVA_SMOKE, { createWindow, media });
    return;
  }

  createTray();
  globalShortcut.register(SHORTCUT_TOGGLE, onShortcutToggle);
  globalShortcut.register(SHORTCUT_PAUSE, togglePause);
  showLibrary();
});

app.on('activate', () => {
  if (rec.state === 'idle') showLibrary();
});

// Stays in the menu bar / system tray after the library window closes, like a
// recorder should; the tray menu has the way out. Without a tray (some Linux
// desktops) closing the last window quits.
app.on('window-all-closed', () => {
  if (!platform.isMac && !tray && !process.env.SCREENOVA_SMOKE) app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
