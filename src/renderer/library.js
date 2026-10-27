const $ = (id) => document.getElementById(id);

const MODE_LABELS = { 'screen-cam': 'Pantalla + cámara', screen: 'Solo pantalla', cam: 'Solo cámara' };
const MIN_CLIP = 0.5;

let info = null;
let recordings = [];
let current = null; // recording open in the player
let trim = { start: 0, end: 0 };
let duration = 0;
let sources = [];
let sourceKind = 'screen';
let previews = { camera: null, mic: null, audio: null, raf: 0 };
let savingToast = false;

// ------------------------------------------------------------ helpers

const prefs = loadPrefs();

function loadPrefs() {
  const defaults = { mode: 'screen-cam', bubbleSize: 'm', sourceId: '', cameraId: '', micId: 'default' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('rec-prefs') || '{}') };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem('rec-prefs', JSON.stringify(prefs));
  } catch {
    // Preferences are a convenience; recording works without them.
  }
}

function prettyShortcut(accel) {
  const map = { Alt: '⌥', Shift: '⇧', CommandOrControl: '⌘', Command: '⌘', Control: '⌃' };
  return accel.split('+').map((k) => map[k] ?? k).join('');
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function precise(sec) {
  const safe = Math.max(0, sec);
  const m = String(Math.floor(safe / 60)).padStart(2, '0');
  const s = (safe % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function shortDate(ts) {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(ts);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

let toastTimer = 0;
function toast(message, { error = false, sticky = false } = {}) {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.textContent = message;
  t.classList.toggle('error', error);
  t.hidden = false;
  if (!sticky) toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
}

function hideToast() {
  $('toast').hidden = true;
}

// ------------------------------------------------------------ library view

async function refresh() {
  recordings = await api.invoke('library:list');
  renderGrid();
  if (current) {
    const fresh = recordings.find((r) => r.id === current.id);
    if (fresh) current = fresh;
    else showLibraryView();
  }
}

function renderGrid() {
  const grid = $('grid');
  grid.replaceChildren();
  const n = recordings.length;
  const folder = info.folder.replace(/^\/Users\/[^/]+/, '~');
  $('lib-count').textContent = `${String(n).padStart(2, '0')} ${n === 1 ? 'vídeo' : 'vídeos'} · ${folder}`;
  $('empty').hidden = n > 0;
  grid.hidden = n === 0;

  for (const r of recordings) {
    const length = (r.trimEnd ?? r.durationMs / 1000) - (r.trimStart || 0);
    const thumb = el('div', { className: 'thumb' }, [
      r.thumbUrl
        ? el('img', { className: 'frame', src: r.thumbUrl, alt: '' })
        : el('img', { className: 'mark', src: '../../assets/mark.svg', alt: '' }),
      el('span', { className: 'play', innerHTML: '<svg viewBox="0 0 24 24"><path d="M7 4l14 8-14 8z"/></svg>' }),
      el('span', { className: 'dur mono', textContent: clock(length * 1000) }),
    ]);
    const meta = el('div', { className: 'mono' }, [
      `${shortDate(r.createdAt)} · ${MODE_LABELS[r.mode] ?? ''}`,
      r.trimStart || r.trimEnd !== null ? el('span', { className: 'badge', textContent: ' · recortado' }) : null,
    ]);
    const open = el('button', { className: 'card-open', type: 'button' }, [
      thumb,
      el('div', { className: 'card-body' }, [el('div', { className: 'card-title', textContent: r.title }), meta]),
    ]);
    open.addEventListener('click', () => openPlayer(r.id));
    const more = el('button', {
      className: 'card-more',
      type: 'button',
      title: 'Más opciones',
      innerHTML: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    });
    more.setAttribute('aria-label', `Más opciones para ${r.title}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', () => cardMenu(r.id, more));
    const card = el('article', { className: 'card' }, [open, more]);
    card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      cardMenu(r.id, more);
    });
    grid.append(card);
  }
}

async function cardMenu(id, button) {
  button.classList.add('open');
  const action = await api.invoke('library:card-menu', id);
  button.classList.remove('open');
  if (action === 'open') openPlayer(id);
  else if (action === 'rename') {
    openPlayer(id);
    $('title').focus();
    $('title').select();
  } else if (action === 'export') exportRecording(id);
  else if (action === 'reveal') api.invoke('library:reveal', id);
  else if (action === 'remove') removeRecording(id);
}

async function removeRecording(id) {
  const removed = await api.invoke('library:remove', id);
  if (!removed) return;
  if (current?.id === id) showLibraryView();
  await refresh();
  toast('Grabación movida a la papelera');
}

let exportingId = null;

async function exportRecording(id) {
  if (exportingId) {
    toast('Ya hay una exportación en curso.');
    return;
  }
  if (current?.id === id && trimDirty()) await saveTrim();
  exportingId = id;
  $('export').disabled = true;
  $('export-fill').style.width = '0%';
  const result = await api.invoke('library:export', id);
  exportingId = null;
  $('export').disabled = false;
  $('export-progress').hidden = true;
  if (result.ok) toast('MP4 exportado');
  else if (result.canceled) hideToast();
  else toast(`No se pudo exportar: ${result.error}`, { error: true });
}

function showLibraryView() {
  const video = $('video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  current = null;
  $('view-player').hidden = true;
  $('view-library').hidden = false;
}

// ------------------------------------------------------------ player

function openPlayer(id) {
  const entry = recordings.find((r) => r.id === id);
  if (!entry) return;
  current = entry;
  $('view-library').hidden = true;
  $('view-player').hidden = false;
  $('title').value = entry.title;
  $('player-meta').textContent = `${shortDate(entry.createdAt)} · ${clock(entry.durationMs)} · ${MODE_LABELS[entry.mode] ?? ''}`;
  $('export-progress').hidden = true;

  duration = entry.durationMs / 1000;
  trim = { start: entry.trimStart || 0, end: entry.trimEnd ?? duration };
  const video = $('video');
  video.src = entry.videoUrl;
  video.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      duration = video.duration;
      trim.end = Math.min(entry.trimEnd ?? duration, duration);
      trim.start = Math.min(trim.start, Math.max(0, trim.end - MIN_CLIP));
    }
    video.currentTime = trim.start;
    renderTrim();
  }, { once: true });
  renderTrim();
}

function savedTrim() {
  return { start: current.trimStart || 0, end: current.trimEnd ?? duration };
}

function trimDirty() {
  const saved = savedTrim();
  return Math.abs(saved.start - trim.start) > 0.05 || Math.abs(saved.end - trim.end) > 0.05;
}

function renderTrim() {
  if (!duration) return;
  const pct = (t) => `${(t / duration) * 100}%`;
  $('tl-sel').style.left = pct(trim.start);
  $('tl-sel').style.width = `${((trim.end - trim.start) / duration) * 100}%`;
  $('h-start').style.left = pct(trim.start);
  $('h-end').style.left = pct(trim.end);
  $('t-start').textContent = precise(trim.start);
  $('t-end').textContent = precise(trim.end);
  $('trim-length').textContent = `Duración ${precise(trim.end - trim.start)}`;
  for (const [id, value] of [['h-start', trim.start], ['h-end', trim.end]]) {
    $(id).setAttribute('aria-valuemin', '0');
    $(id).setAttribute('aria-valuemax', duration.toFixed(1));
    $(id).setAttribute('aria-valuenow', value.toFixed(1));
    $(id).setAttribute('aria-valuetext', precise(value));
  }
  $('trim-save').disabled = !trimDirty();
  renderPlayhead();
}

function renderPlayhead() {
  if (!duration) return;
  $('tl-playhead').style.left = `${(clamp($('video').currentTime, 0, duration) / duration) * 100}%`;
}

function setTrim(edge, t) {
  if (edge === 'start') trim.start = clamp(t, 0, trim.end - MIN_CLIP);
  else trim.end = clamp(t, trim.start + MIN_CLIP, duration);
  renderTrim();
}

function timeAt(clientX) {
  const rect = $('timeline').getBoundingClientRect();
  return clamp((clientX - rect.left) / rect.width, 0, 1) * duration;
}

function bindHandle(edge) {
  const handle = $(edge === 'start' ? 'h-start' : 'h-end');
  handle.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    $('video').pause();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    setTrim(edge, timeAt(event.clientX));
    $('video').currentTime = edge === 'start' ? trim.start : trim.end;
  });
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 1 : 0.1;
    const value = edge === 'start' ? trim.start : trim.end;
    if (event.key === 'ArrowLeft') setTrim(edge, value - step);
    else if (event.key === 'ArrowRight') setTrim(edge, value + step);
    else return;
    event.preventDefault();
    $('video').currentTime = edge === 'start' ? trim.start : trim.end;
  });
}

async function saveTrim() {
  if (!current) return;
  const end = trim.end >= duration - 0.05 ? null : Number(trim.end.toFixed(3));
  current = await api.invoke('library:update', current.id, { trimStart: Number(trim.start.toFixed(3)), trimEnd: end });
  recordings = recordings.map((r) => (r.id === current.id ? current : r));
  renderGrid();
  renderTrim();
}

function setupPlayer() {
  const video = $('video');

  // Playback stays inside the trimmed range.
  video.addEventListener('play', () => {
    if (video.currentTime < trim.start - 0.05 || video.currentTime >= trim.end - 0.05) video.currentTime = trim.start;
  });
  video.addEventListener('timeupdate', () => {
    if (!video.paused && video.currentTime >= trim.end) {
      video.pause();
      video.currentTime = trim.end;
    }
    renderPlayhead();
  });
  video.addEventListener('seeked', renderPlayhead);
  video.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else video.requestFullscreen().catch((err) => console.error(err));
  });

  $('timeline').addEventListener('pointerdown', (event) => {
    if (!duration) return;
    video.currentTime = clamp(timeAt(event.clientX), trim.start, trim.end);
  });
  bindHandle('start');
  bindHandle('end');

  $('mark-in').addEventListener('click', () => setTrim('start', video.currentTime));
  $('mark-out').addEventListener('click', () => setTrim('end', video.currentTime));
  $('trim-reset').addEventListener('click', () => {
    trim = { start: 0, end: duration };
    renderTrim();
  });
  $('trim-save').addEventListener('click', async () => {
    await saveTrim();
    toast('Recorte guardado');
  });

  $('back').addEventListener('click', showLibraryView);

  const title = $('title');
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') title.blur();
    if (event.key === 'Escape') {
      title.value = current.title;
      title.blur();
    }
  });
  title.addEventListener('change', async () => {
    if (!current) return;
    current = await api.invoke('library:update', current.id, { title: title.value });
    title.value = current.title;
    recordings = recordings.map((r) => (r.id === current.id ? current : r));
    renderGrid();
  });

  $('reveal').addEventListener('click', () => current && api.invoke('library:reveal', current.id));

  $('remove').addEventListener('click', () => current && removeRecording(current.id));
  $('export').addEventListener('click', () => current && exportRecording(current.id));

  // Exports started from a library card report progress in the toast instead.
  api.on('export:progress', ({ id, progress }) => {
    const pct = Math.round(progress * 100);
    if (current?.id === id) {
      $('export-progress').hidden = false;
      $('export-fill').style.width = `${pct}%`;
    } else if (pct < 100) {
      toast(`Exportando MP4… ${pct} %`, { sticky: true });
    }
  });
}

// ------------------------------------------------------------ new recording

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value ?? 'screen-cam';
}

function applyMode() {
  const mode = selectedMode();
  prefs.mode = mode;
  savePrefs();
  $('source-field').hidden = mode === 'cam';
  $('camera-field').hidden = mode === 'screen';
  $('bubble-size').hidden = mode !== 'screen-cam';
  startCameraPreview();
}

function renderSources() {
  const box = $('sources');
  box.replaceChildren();
  for (const tab of document.querySelectorAll('.tabs [data-kind]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.kind === sourceKind));
  }
  const visible = sources.filter((s) => s.kind === sourceKind);
  if (!visible.length) {
    box.append(el('div', {
      className: 'note',
      textContent: sourceKind === 'screen'
        ? 'No hay pantallas disponibles. Revisa el permiso de grabación de pantalla.'
        : 'No hay ventanas disponibles.',
    }));
    return;
  }
  if (!sources.some((s) => s.id === prefs.sourceId)) prefs.sourceId = visible[0].id;
  for (const s of visible) {
    const tile = el('button', { className: 'source', type: 'button', title: s.name }, [
      s.thumb ? el('img', { src: s.thumb, alt: '' }) : el('div', { className: 'noimg' }),
      el('span', { textContent: s.name }),
    ]);
    tile.setAttribute('aria-pressed', String(s.id === prefs.sourceId));
    tile.addEventListener('click', () => {
      prefs.sourceId = s.id;
      savePrefs();
      renderSources();
    });
    box.append(tile);
  }
}

async function loadSources() {
  $('sources').replaceChildren(el('div', { className: 'note', textContent: 'Buscando pantallas y ventanas…' }));
  try {
    sources = await api.invoke('sources:list');
  } catch (err) {
    sources = [];
    console.error(err);
  }
  const known = sources.find((s) => s.id === prefs.sourceId);
  if (known) sourceKind = known.kind;
  renderSources();
}

// Device labels are only exposed after a first getUserMedia call, so this is
// skipped once permission has been granted (it would also briefly grab the camera).
async function unlockDeviceLabels() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.length && devices.every((d) => d.label)) return;
  for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }]) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((t) => t.stop());
      return;
    } catch {
      // Try a narrower request; a Mac may have no camera.
    }
  }
}

function fillSelect(select, devices, selected, { none } = {}) {
  select.replaceChildren();
  if (none) select.append(el('option', { value: '', textContent: none }));
  devices.forEach((d, i) => {
    select.append(el('option', { value: d.deviceId, textContent: d.label || `Dispositivo ${i + 1}` }));
  });
  const values = [...select.options].map((o) => o.value);
  select.value = values.includes(selected) ? selected : values[none ? 1 : 0] ?? '';
}

async function loadDevices() {
  await unlockDeviceLabels();
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  fillSelect($('camera'), cams, prefs.cameraId);
  if (!cams.length) $('camera').append(el('option', { value: '', textContent: 'No se encontró ninguna cámara' }));
  fillSelect($('mic'), mics, prefs.micId, { none: 'Sin micrófono' });
  if (prefs.micId === '') $('mic').value = '';
  prefs.cameraId = $('camera').value;
  prefs.micId = $('mic').value;
  startCameraPreview();
  startMicMeter();
}

function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each call supersedes the previous one; the request counter lets a slow, stale call
// drop its stream instead of overwriting the newer preview.
let cameraRequest = 0;
let micRequest = 0;

async function startCameraPreview() {
  const request = ++cameraRequest;
  const video = $('cam-preview');
  stopStream(previews.camera);
  previews.camera = null;
  video.srcObject = null;
  if (!$('new-dialog').open || selectedMode() === 'screen' || !$('camera').value) return;

  // A camera that was just released can refuse to reopen for a moment
  // (NotReadableError), so retry a few times before giving up.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: $('camera').value }, width: { ideal: 640 }, height: { ideal: 480 } },
      });
      if (request !== cameraRequest) {
        stopStream(stream);
        return;
      }
      previews.camera = stream;
      video.srcObject = stream;
      await video.play().catch(() => {});
      return;
    } catch (err) {
      if (request !== cameraRequest || err.name === 'NotAllowedError') return;
      console.warn('Camera preview attempt failed:', err.name);
      await wait(300 * (attempt + 1));
    }
  }
}

async function startMicMeter() {
  const request = ++micRequest;
  stopMicMeter();
  if (!$('new-dialog').open || !$('mic').value) return;
  try {
    const id = $('mic').value;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: id === 'default' ? true : { deviceId: { exact: id } } });
    if (request !== micRequest) {
      stopStream(stream);
      return;
    }
    previews.mic = stream;
    previews.audio = new AudioContext();
    const analyser = previews.audio.createAnalyser();
    analyser.fftSize = 512;
    previews.audio.createMediaStreamSource(previews.mic).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
      $('meter-fill').style.width = `${Math.min(100, rms * 400)}%`;
      previews.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    console.error(err);
  }
}

function stopMicMeter() {
  cancelAnimationFrame(previews.raf);
  stopStream(previews.mic);
  previews.audio?.close();
  previews = { ...previews, mic: null, audio: null, raf: 0 };
  $('meter-fill').style.width = '0%';
}

function stopPreviews() {
  cameraRequest += 1;
  micRequest += 1;
  stopStream(previews.camera);
  previews.camera = null;
  $('cam-preview').srcObject = null;
  stopMicMeter();
}

function showFormError(message, code) {
  const box = $('form-error');
  box.replaceChildren(message);
  if (code) {
    const button = el('button', { className: 'btn', type: 'button', textContent: 'Abrir Ajustes' });
    button.addEventListener('click', () => api.invoke('permissions:open-settings', code));
    box.append(button);
  }
  box.hidden = false;
}

async function openNewRecording() {
  const dialog = $('new-dialog');
  if (dialog.open) return;
  showLibraryView();
  $('form-error').hidden = true;
  const mode = document.querySelector(`input[name="mode"][value="${prefs.mode}"]`);
  if (mode) mode.checked = true;
  const size = document.querySelector(`input[name="bubble"][value="${prefs.bubbleSize}"]`);
  if (size) size.checked = true;
  dialog.showModal();
  applyMode();
  loadSources();
  await loadDevices();
}

function setupNewRecording() {
  const dialog = $('new-dialog');
  $('new-rec').addEventListener('click', openNewRecording);
  $('empty-new').addEventListener('click', openNewRecording);
  $('new-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stopPreviews);

  for (const input of document.querySelectorAll('input[name="mode"]')) input.addEventListener('change', applyMode);
  for (const input of document.querySelectorAll('input[name="bubble"]')) {
    input.addEventListener('change', () => {
      prefs.bubbleSize = input.value;
      savePrefs();
    });
  }
  for (const tab of document.querySelectorAll('.tabs [data-kind]')) {
    tab.addEventListener('click', () => {
      sourceKind = tab.dataset.kind;
      renderSources();
    });
  }
  $('refresh').addEventListener('click', loadSources);
  $('camera').addEventListener('change', () => {
    prefs.cameraId = $('camera').value;
    savePrefs();
    startCameraPreview();
  });
  $('mic').addEventListener('change', () => {
    prefs.micId = $('mic').value;
    savePrefs();
    startMicMeter();
  });

  $('new-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('form-error').hidden = true;
    const mode = selectedMode();
    if (mode !== 'cam' && !sources.some((s) => s.id === prefs.sourceId)) {
      showFormError('Elige qué pantalla o ventana grabar.');
      return;
    }
    if (mode !== 'screen' && !$('camera').value) {
      showFormError('No hay ninguna cámara disponible. Elige «Solo pantalla».');
      return;
    }
    const start = $('start');
    start.disabled = true;
    stopPreviews(); // free the camera and mic for the recorder
    const result = await api.invoke('rec:start', {
      mode,
      sourceId: prefs.sourceId,
      cameraId: $('camera').value,
      micId: $('mic').value,
      bubbleSize: prefs.bubbleSize,
    });
    start.disabled = false;
    if (result.ok) {
      dialog.close();
    } else {
      showFormError(result.error, result.code);
      startCameraPreview();
      startMicMeter();
    }
  });
}

// ------------------------------------------------------------ permissions banner

async function checkPermissions() {
  const status = await api.invoke('permissions:check');
  const banner = $('banner');
  if (status.screen === 'denied' || status.screen === 'restricted') {
    // A switch that already looks on usually belongs to an older build of the
    // app, which macOS no longer matches, so the hint covers that case too.
    $('banner-text').textContent = `${info.name} no tiene permiso para grabar la pantalla. Actívalo en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y vuelve a abrir la app. Si ya aparece activado, quítalo de la lista con «−» y vuelve a añadirlo.`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// ------------------------------------------------------------ boot

async function init() {
  info = await api.invoke('app:info');
  const toggle = prettyShortcut(info.shortcut);
  $('empty-shortcut').textContent = toggle;
  $('sc-toggle').textContent = toggle;
  $('sc-pause').textContent = prettyShortcut(info.pauseShortcut);
  $('new-rec').title = `Nueva grabación (${toggle})`;

  $('open-folder').addEventListener('click', () => api.invoke('library:reveal-folder'));
  $('banner-action').addEventListener('click', () => api.invoke('permissions:open-settings', 'screen'));

  setupPlayer();
  setupNewRecording();

  api.on('library:changed', refresh);
  api.on('library:open', async (id) => {
    await refresh();
    openPlayer(id);
  });
  api.on('library:new-recording', openNewRecording);
  api.on('library:error', (message) => toast(message, { error: true }));
  api.on('rec:state', ({ state }) => {
    if (state === 'saving') {
      savingToast = true;
      toast('Guardando grabación…', { sticky: true });
    } else if (savingToast && state === 'idle') {
      savingToast = false;
      hideToast();
    }
  });

  window.addEventListener('focus', checkPermissions);
  await Promise.all([refresh(), checkPermissions()]);
}

init();
