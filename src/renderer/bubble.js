const params = new URLSearchParams(location.search);
const bubble = document.getElementById('bubble');
const video = document.getElementById('video');
const buttons = document.querySelectorAll('[data-size]');

function markSize(size) {
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.size === size));
}

for (const b of buttons) {
  b.addEventListener('click', () => {
    markSize(b.dataset.size);
    api.send('bubble:size', b.dataset.size);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The library's preview has just released the camera; it can take a moment
// before the device accepts a new session, so retry before showing an error.
async function start() {
  const cameraId = params.get('cameraId');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: cameraId ? { exact: cameraId } : undefined,
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
      });
      video.srcObject = stream;
      video.addEventListener('playing', () => bubble.classList.add('live'), { once: true });
      await video.play().catch(() => {});
      return;
    } catch (err) {
      if (err.name === 'NotAllowedError') break;
      console.warn('Camera attempt failed:', err.name);
      await wait(300 * (attempt + 1));
    }
  }
  bubble.classList.add('failed');
}

markSize(params.get('size') || 'm');
start();
