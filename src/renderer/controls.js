const bar = document.getElementById('bar');
const time = document.getElementById('time');
const pause = document.getElementById('pause');
const pauseIcon = document.getElementById('pause-icon');
const STATES = ['countdown', 'recording', 'paused', 'saving'];

let current = { state: 'countdown', elapsed: 0 };
let receivedAt = performance.now();

function format(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

// The clock only changes once a second, so a light timer that writes only on
// change avoids repainting this always-on-top window every frame.
function render() {
  const live = current.state === 'recording';
  const ms = live ? current.elapsed + performance.now() - receivedAt : current.elapsed;
  const text = current.state === 'countdown' ? 'Lista…' : format(ms);
  if (time.textContent !== text) time.textContent = text;
}

api.on('rec:state', (next) => {
  current = next;
  receivedAt = performance.now();
  for (const s of STATES) bar.classList.toggle(s, s === next.state);
  const paused = next.state === 'paused';
  pause.disabled = !['recording', 'paused'].includes(next.state);
  pause.title = paused ? 'Reanudar (⌥⇧P)' : 'Pausar (⌥⇧P)';
  pause.setAttribute('aria-label', paused ? 'Reanudar' : 'Pausar');
  pauseIcon.innerHTML = paused ? '<path d="M7 5l12 7-12 7z" />' : '<path d="M9 5v14M15 5v14" />';
  render();
});

pause.addEventListener('click', () => api.send(current.state === 'paused' ? 'rec:resume' : 'rec:pause'));
document.getElementById('restart').addEventListener('click', () => api.send('rec:restart'));
document.getElementById('cancel').addEventListener('click', () => api.send('rec:cancel'));
document.getElementById('stop').addEventListener('click', () => api.send('rec:stop'));

setInterval(render, 250);
render();
