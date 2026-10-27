// Hidden window that owns the capture streams and the MediaRecorder.
// Chunks are streamed to the main process every second, so a long recording
// never has to fit in memory.
let recorder = null;
let tracks = [];
let discard = false;
let sendQueue = Promise.resolve();

// H.264 goes through the Mac's hardware encoder; VP8/VP9 are software-only
// and cost several CPU cores at Retina sizes, so they are only a fallback.
const MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

// Retina screens are captured at up to this size; the full 3072px width would
// quadruple the encoding work for little visible gain in a screen recording.
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1200;

function stopTracks() {
  for (const track of tracks) track.stop();
  tracks = [];
}

function describe(err) {
  if (err?.name === 'NotAllowedError') return 'Permiso denegado. Revisa los permisos de pantalla, cámara y micrófono en Ajustes del Sistema.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No se encontró el dispositivo seleccionado.';
  if (err?.name === 'NotReadableError') return 'El dispositivo está en uso por otra aplicación.';
  return err?.message || String(err);
}

async function openVideo(config) {
  if (config.mode === 'cam') {
    const constraints = {
      video: {
        deviceId: config.cameraId ? { exact: config.cameraId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
    };
    // The bubble may still be releasing the camera; retry briefly.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await navigator.mediaDevices.getUserMedia(constraints)).getVideoTracks();
      } catch (err) {
        if (attempt >= 3 || err.name === 'NotAllowedError') throw err;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
  // The main process answers this with the screen or window picked in the library.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { max: MAX_WIDTH },
      height: { max: MAX_HEIGHT },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });
  const [track] = stream.getVideoTracks();
  // Some sources ignore the initial constraints; apply them again so the
  // capture is scaled down before it reaches the encoder.
  const { width = 0, height = 0 } = track.getSettings();
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    await track.applyConstraints({ width: { max: MAX_WIDTH }, height: { max: MAX_HEIGHT }, frameRate: { max: 30 } }).catch(() => {});
  }
  return [track];
}

async function openAudio(config) {
  if (!config.micId) return [];
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: config.micId === 'default' ? undefined : { exact: config.micId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  return stream.getAudioTracks();
}

api.on('recorder:prepare', async (config) => {
  try {
    const video = await openVideo(config);
    tracks.push(...video);
    tracks.push(...(await openAudio(config)));

    // Ending the share from the macOS menu bar counts as pressing stop.
    video[0].addEventListener('ended', () => api.send('rec:stop'));

    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 128_000,
    });
    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return;
      // Chained so chunks reach the main process in order.
      sendQueue = sendQueue.then(async () => {
        if (!discard) api.send('rec:chunk', new Uint8Array(await event.data.arrayBuffer()));
      });
    });
    recorder.addEventListener('stop', () => {
      stopTracks();
      sendQueue.then(() => api.send(discard ? 'rec:discarded' : 'rec:finished'));
    });
    recorder.addEventListener('error', (event) => api.send('rec:failed', describe(event.error)));
    const { width, height } = video[0].getSettings();
    api.send('rec:ready', { mimeType: recorder.mimeType || mimeType, width, height });
  } catch (err) {
    stopTracks();
    api.send('rec:failed', describe(err));
  }
});

api.on('recorder:begin', () => recorder?.start(1000));
api.on('recorder:pause', () => recorder?.state === 'recording' && recorder.pause());
api.on('recorder:resume', () => recorder?.state === 'paused' && recorder.resume());
api.on('recorder:stop', () => {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else api.send('rec:finished');
});
api.on('recorder:discard', () => {
  discard = true;
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  } else {
    stopTracks();
    api.send('rec:discarded');
  }
});
