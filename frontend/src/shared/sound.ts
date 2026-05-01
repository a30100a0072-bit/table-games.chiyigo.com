// Cheap Web Audio cues — zero asset bundle weight, just oscillator beeps.
// Mute state persists in localStorage so it survives reloads.

let ctx: AudioContext | null = null;
const STORAGE_KEY = "chiyigo.muted";

/** iOS Safari (and some Chrome variants) leave a fresh AudioContext in
 *  the "suspended" state until the SAME tick as a user gesture. If the
 *  first sfx call happens later on a state push (opponent's move), it
 *  silently fails. Call this from a click handler at app entry to
 *  flip the context to "running" before any incoming events need it.   */
export function unlockAudio(): void {
  if (isMuted()) return;
  const c = getCtx(); if (!c) return;
  if (c.state !== "suspended") return;
  try {
    c.resume().catch(() => {});
    // A zero-gain blip — required on some WebKit builds where resume()
    // alone isn't enough; the context needs a real source to start.
    const osc = c.createOscillator();
    const g   = c.createGain();
    g.gain.value = 0;
    osc.connect(g); g.connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.01);
  } catch { /* best effort; gameplay still works without sound */ }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Cls = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
             ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Cls) return null;
    try { ctx = new Cls(); } catch { return null; }
  }
  return ctx;
}

export function isMuted(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "1";
}
export function setMuted(m: boolean): void {
  if (typeof localStorage === "undefined") return;
  if (m) localStorage.setItem(STORAGE_KEY, "1");
  else   localStorage.removeItem(STORAGE_KEY);
}

interface Note { freq: number; ms: number; gain?: number; type?: OscillatorType; }

function play(notes: Note[]): void {
  if (isMuted()) return;
  const c = getCtx(); if (!c) return;
  // resume needed on iOS Safari after a user gesture
  if (c.state === "suspended") c.resume().catch(() => {});
  let t = c.currentTime;
  for (const n of notes) {
    const osc = c.createOscillator();
    const g   = c.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.freq;
    g.gain.setValueAtTime((n.gain ?? 0.18), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + n.ms / 1000);
    osc.connect(g); g.connect(c.destination);
    osc.start(t);
    osc.stop(t + n.ms / 1000);
    t += n.ms / 1000;
  }
}

// Public cues — keep names verb-based and short. Add new ones at the end.
export const sfx = {
  cardSelect:  () => play([{ freq: 880,  ms: 60,  gain: 0.10 }]),
  cardPlay:    () => play([{ freq: 1760, ms: 50,  gain: 0.14, type: "triangle" }]),
  pass:        () => play([{ freq: 440,  ms: 100, gain: 0.10, type: "triangle" }]),
  myTurn:      () => play([{ freq: 660,  ms: 90,  gain: 0.16 },
                           { freq: 990,  ms: 90,  gain: 0.16 }]),
  win:         () => play([{ freq: 523,  ms: 100, gain: 0.20 },
                           { freq: 659,  ms: 100, gain: 0.20 },
                           { freq: 784,  ms: 100, gain: 0.20 },
                           { freq: 1047, ms: 200, gain: 0.22 }]),
  lose:        () => play([{ freq: 440,  ms: 150, gain: 0.16, type: "sawtooth" },
                           { freq: 330,  ms: 250, gain: 0.16, type: "sawtooth" }]),
  notify:      () => play([{ freq: 1320, ms: 60,  gain: 0.12 }]),
};
