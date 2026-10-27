// Renders the app and menu-bar icons from assets/mark.svg (the Screenova mark).
// Run with `npm run icons` (it runs under Electron, which does the SVG rasterizing).
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = path.join(__dirname, '..', 'assets');
const NAVY = '#1c3f6e';

const mark = fs.readFileSync(path.join(ASSETS, 'mark.svg'), 'utf8');
const markBody = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

// macOS icon grid: an 824px rounded square centred in a 1024px canvas.
const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="${NAVY}"/>
  <g transform="translate(512 512) scale(8) translate(-50 -50)">${markBody}</g>
</svg>`;

// Template image: macOS only uses the alpha channel and tints it for light/dark
// menu bars, so this is the mark as a single-colour silhouette with bolder strokes.
const TRAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g transform="translate(50 50)" fill="none" stroke="#000">
    <circle r="36" stroke-width="6" opacity="0.4"/>
    <path d="M 0,-36 A 36,36 0 0,1 25.5,-25.5" stroke-width="11" stroke-linecap="round"/>
    <path d="M 25.5,25.5 A 36,36 0 0,1 0,36" stroke-width="11" stroke-linecap="round"/>
    <circle r="20" fill="#000" stroke="none"/>
  </g>
</svg>`;

// Windows and Linux icons fill their canvas (no macOS-style margin) and keep the
// navy plate, so the mark reads on light and dark taskbars and system trays alike.
const SQUARE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="200" fill="${NAVY}"/>
  <g transform="translate(512 512) scale(10.5) translate(-50 -50)">${markBody}</g>
</svg>`;

// One offscreen window is reused for every icon size.
let win = null;

async function render(svg, size) {
  win ??= new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.setContentSize(size, size);
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">
  </body></html>`;
  // Offscreen windows hand over frames through `paint`; keep the latest one.
  let image = null;
  const onPaint = (_event, _dirty, frame) => {
    image = frame;
  };
  win.webContents.setFrameRate(10);
  win.webContents.on('paint', onPaint);
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  win.webContents.off('paint', onPaint);
  if (!image) throw new Error(`No frame rendered for a ${size}px icon`);
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

async function main() {
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), await render(APP_ICON, 1024));
  fs.writeFileSync(path.join(ASSETS, 'trayTemplate.png'), await render(TRAY_ICON, 18));
  fs.writeFileSync(path.join(ASSETS, 'trayTemplate@2x.png'), await render(TRAY_ICON, 36));
  // electron-builder turns icon-square.png into the Windows .ico and Linux icons.
  fs.writeFileSync(path.join(ASSETS, 'icon-square.png'), await render(SQUARE_ICON, 512));
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), await render(SQUARE_ICON, 16));
  fs.writeFileSync(path.join(ASSETS, 'tray@2x.png'), await render(SQUARE_ICON, 32));

  // .icns for packaging, built with macOS's own iconutil.
  if (process.platform === 'darwin') {
    const set = path.join(ASSETS, 'icon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const base of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${base}x${base}.png`), await render(APP_ICON, base));
      fs.writeFileSync(path.join(set, `icon_${base}x${base}@2x.png`), await render(APP_ICON, base * 2));
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(ASSETS, 'icon.icns')]);
    fs.rmSync(set, { recursive: true, force: true });
  }
  console.log('Iconos generados en assets/');
}

// Software rendering is plenty for a few icons and works without a GPU.
app.disableHardwareAcceleration();
app.dock?.hide();
app.whenReady().then(main).then(() => app.quit(), (err) => {
  console.error(err);
  app.exit(1);
});
