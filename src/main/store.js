const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, shell } = require('electron');
const { APP_NAME } = require('./brand');

// Recordings live in ~/Movies/<APP_NAME>/ as <id>.<mp4|webm> + <id>.jpg + <id>.json.
// H.264 recordings are stored as MP4; WebM is the software-codec fallback.
function dir() {
  return path.join(app.getPath('videos'), APP_NAME);
}

function files(id, ext = 'mp4') {
  const base = path.join(dir(), id);
  return { video: `${base}.${ext}`, thumb: `${base}.jpg`, meta: `${base}.json` };
}

async function ensureDir() {
  await fs.mkdir(dir(), { recursive: true });
}

function newId() {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function defaultTitle(date = new Date()) {
  const when = new Intl.DateTimeFormat('es-ES', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
  return `Grabación ${when}`;
}

async function exists(p) {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

async function toEntry(meta) {
  const f = files(meta.id, meta.ext);
  const [videoMtime, thumbMtime] = await Promise.all([exists(f.video), exists(f.thumb)]);
  if (!videoMtime) return null;
  return {
    ...meta,
    videoPath: f.video,
    videoUrl: `${pathToFileURL(f.video).href}?v=${Math.round(videoMtime)}`,
    thumbUrl: thumbMtime ? `${pathToFileURL(f.thumb).href}?v=${Math.round(thumbMtime)}` : null,
  };
}

async function list() {
  await ensureDir();
  const names = (await fs.readdir(dir())).filter((n) => n.endsWith('.json'));
  const entries = await Promise.all(names.map(async (name) => {
    try {
      return await toEntry(JSON.parse(await fs.readFile(path.join(dir(), name), 'utf8')));
    } catch {
      return null;
    }
  }));
  return entries.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

async function get(id) {
  return toEntry(JSON.parse(await fs.readFile(files(id).meta, 'utf8')));
}

async function save(meta) {
  await ensureDir();
  await fs.writeFile(files(meta.id).meta, JSON.stringify(meta, null, 2));
  return get(meta.id);
}

const EDITABLE = ['title', 'trimStart', 'trimEnd'];

async function update(id, patch) {
  const meta = JSON.parse(await fs.readFile(files(id).meta, 'utf8'));
  for (const key of EDITABLE) {
    if (key in patch) meta[key] = patch[key];
  }
  if (typeof meta.title !== 'string' || !meta.title.trim()) meta.title = defaultTitle(new Date(meta.createdAt));
  meta.title = meta.title.trim().slice(0, 200);
  return save(meta);
}

// Moves the files to the macOS Trash, so a deletion can be undone from Finder.
async function remove(id) {
  const paths = new Set([...Object.values(files(id, 'mp4')), files(id, 'webm').video]);
  for (const p of paths) {
    if (await exists(p)) await shell.trashItem(p);
  }
}

module.exports = { dir, files, ensureDir, newId, defaultTitle, list, get, save, update, remove };
