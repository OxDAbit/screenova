// Everything that reads differently per operating system, in one place.
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

const LABELS = {
  darwin: { reveal: 'Mostrar en Finder', trash: 'la Papelera de macOS' },
  win32: { reveal: 'Mostrar en el Explorador', trash: 'la Papelera de reciclaje' },
  linux: { reveal: 'Mostrar en la carpeta', trash: 'la Papelera' },
};

// Privacy pages the "open settings" buttons lead to. Windows and Linux need no
// permission to capture the screen, so only macOS has a page for it.
const SETTINGS_URLS = {
  darwin: {
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  },
  win32: {
    camera: 'ms-settings:privacy-webcam',
    microphone: 'ms-settings:privacy-microphone',
  },
  linux: {},
};

module.exports = {
  isMac,
  isWindows,
  isLinux,
  labels: LABELS[process.platform] ?? LABELS.linux,
  settingsUrl: (kind) => (SETTINGS_URLS[process.platform] ?? {})[kind] ?? null,
};
