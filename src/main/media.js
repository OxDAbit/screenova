const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');

// In a packaged app the binary sits in app.asar.unpacked rather than app.asar.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

function parseTime(line) {
  const m = /time=(\d+):(\d+):([\d.]+)/.exec(line);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function run(args, { totalSec, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args]);
    let tail = '';
    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      const t = parseTime(text);
      if (t !== null && totalSec && onProgress) onProgress(Math.min(1, t / totalSec));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg terminó con código ${code}\n${tail}`));
    });
  });
}

// MediaRecorder output is fragmented (MP4) or has no duration or seek index
// (WebM); a stream copy writes a regular, seekable file without re-encoding.
async function finalize(tempPath, videoPath, thumbPath) {
  const mp4 = videoPath.endsWith('.mp4') ? ['-movflags', '+faststart'] : [];
  try {
    await run(['-i', tempPath, '-c', 'copy', ...mp4, videoPath]);
    await fs.rm(tempPath, { force: true });
  } catch (err) {
    console.error('Remux failed, keeping the raw recording:', err.message);
    await fs.rename(tempPath, videoPath);
  }
  await thumbnail(videoPath, thumbPath);
}

async function thumbnail(videoPath, thumbPath) {
  const frame = ['-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', thumbPath];
  try {
    await run(['-ss', '0.5', '-i', videoPath, ...frame]);
    await fs.access(thumbPath);
  } catch {
    // Recordings shorter than half a second, or audio-only edge cases.
    await run(['-i', videoPath, ...frame]).catch(() => {});
  }
}

// The platform's hardware H.264 encoder first (fast, light on the CPU): VideoToolbox
// on macOS, Media Foundation on Windows. x264 is the software fallback everywhere.
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
const HARDWARE = {
  darwin: ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-allow_sw', '1'],
  win32: ['-c:v', 'h264_mf', '-b:v', '8M', '-rate_control', 'cbr'],
};
const ENCODERS = [HARDWARE[process.platform], X264].filter(Boolean);

// Resolves to the video encoder that was used ('copy' when nothing was re-encoded).
async function exportMp4(videoPath, destPath, { start = 0, end = null, durationSec }, onProgress) {
  const length = (end ?? durationSec) - start;
  const output = ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', destPath];

  // An untrimmed H.264 recording only needs its container copied.
  if (start <= 0 && end === null && videoPath.endsWith('.mp4')) {
    await run(['-i', videoPath, '-c:v', 'copy', ...output], { totalSec: length, onProgress });
    return 'copy';
  }

  const input = [];
  if (start > 0) input.push('-ss', start.toFixed(3));
  input.push('-i', videoPath);
  if (end !== null) input.push('-t', length.toFixed(3));
  const video = ['-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];

  let lastError = null;
  for (const encoder of ENCODERS) {
    try {
      await run([...input, ...encoder, ...video, ...output], { totalSec: length, onProgress });
      return encoder[1];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Builds a short synthetic H.264 + AAC clip, fragmented like MediaRecorder's
// output; the smoke test uses it so it needs no camera or screen.
async function makeTestClip(destPath, seconds = 3) {
  await run([
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', destPath,
  ]);
}

module.exports = { finalize, exportMp4, makeTestClip, ffmpegPath };
