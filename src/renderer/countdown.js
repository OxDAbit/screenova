const num = document.getElementById('num');
const sweep = document.getElementById('sweep');
let audio = null;

// A short synthesized tick, so no sound assets are needed. The recorder only
// starts after the last tick, so the tone never ends up in the video.
function beep(frequency) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.2);
  } catch {
    // Audio is optional; the countdown works without it.
  }
}

function restart(el, cls) {
  el.classList.remove(cls);
  void el.getBoundingClientRect();
  el.classList.add(cls);
}

api.on('countdown:tick', (n) => {
  num.textContent = String(n);
  restart(num, 'pop');
  restart(sweep, 'run');
  beep(n === 1 ? 880 : 660);
});
