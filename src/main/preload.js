const { contextBridge, ipcRenderer } = require('electron');

// Every window shares this preload; the allowlists are the whole IPC surface.
const INVOKE = new Set([
  'app:info', 'sources:list', 'permissions:check', 'permissions:open-settings',
  'rec:start', 'library:list', 'library:update', 'library:remove', 'library:reveal', 'library:reveal-folder', 'library:export', 'library:card-menu',
]);
const SEND = new Set([
  'rec:pause', 'rec:resume', 'rec:stop', 'rec:restart', 'rec:cancel',
  'rec:chunk', 'rec:finished', 'rec:discarded', 'rec:failed', 'rec:ready',
  'bubble:size',
]);
const RECEIVE = new Set([
  'rec:state', 'countdown:tick', 'recorder:prepare', 'recorder:begin', 'recorder:pause',
  'recorder:resume', 'recorder:stop', 'recorder:discard',
  'library:changed', 'library:open', 'library:new-recording', 'library:error', 'export:progress',
]);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error(`Canal no permitido: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    if (!SEND.has(channel)) throw new Error(`Canal no permitido: ${channel}`);
    ipcRenderer.send(channel, ...args);
  },
  on(channel, callback) {
    if (!RECEIVE.has(channel)) throw new Error(`Canal no permitido: ${channel}`);
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
