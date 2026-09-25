/**
 * Victory fanfares, synthesized — one per XP grade.
 *
 * Synthesized on purpose, with a three-oscillator budget per voice: a
 * downloaded game clip drags in a licensing question and a network fetch for a
 * two-second sting. It matters here in particular, because the brief for this
 * feature literally began "a bit like Final Fantasy" — that fanfare is Square
 * Enix / Nobuo Uematsu and is not ours to play. **Every melody below is
 * original.** Evoke the genre; transcribe nothing.
 *
 * The pacing rule that shapes all five: a 0.3R scalp getting a four-second
 * orchestral moment is funny once and irritating forever. Intensity AND length
 * scale with the grade, so the loud one stays rare enough to keep meaning
 * something. The disciplined LOSS deliberately gets a real fanfare — warm,
 * resolved, in a major key — because the whole system falls over if taking the
 * right loss sounds like a failure.
 */

import type { XpGrade } from './xp';

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  // `new Ctor()` can throw outright — a locked-down or stubbed environment, or
  // a browser refusing another context after too many were created. It used to
  // sit outside the caller's try/catch, so that throw escaped into the trade
  // close. A missing chime must never be able to break booking a fill.
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  // Autoplay policy parks the context until a gesture. Resume is best-effort
  // and must never reject into the caller — a muted chime is not an error.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

/** One voice: an oscillator through its own gain envelope. */
function note(
  c: AudioContext, start: number, freq: number, duration: number,
  gain: number, type: OscillatorType = 'triangle', detune = 0,
): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** A note plus a fifth-above shimmer — the "brass section" of three oscillators. */
function chord(c: AudioContext, start: number, freq: number, duration: number, gain: number): void {
  note(c, start, freq, duration, gain, 'triangle');
  note(c, start, freq * 1.5, duration, gain * 0.35, 'triangle', 4);
  note(c, start, freq / 2, duration, gain * 0.45, 'sine');
}

// Equal temperament from A4. Written as names so the melodies stay readable.
const HZ: Record<string, number> = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00, C6: 1046.50,
};

/**
 * FLAWLESS — the full thing, and the only one that gets to be long (~1.8s).
 * An original rising major figure that lands on the octave: the triumph is the
 * ARRIVAL, not the volume.
 */
function flawless(c: AudioContext, t: number): void {
  const g = 0.16;
  note(c, t + 0.00, HZ.G4, 0.10, g, 'square');
  note(c, t + 0.09, HZ.C5, 0.10, g, 'square');
  note(c, t + 0.18, HZ.E5, 0.10, g, 'square');
  chord(c, t + 0.30, HZ.G5, 0.34, g);
  chord(c, t + 0.62, HZ.E5, 0.18, g * 0.8);
  chord(c, t + 0.78, HZ.G5, 0.18, g * 0.8);
  chord(c, t + 0.96, HZ.C6, 0.85, g * 1.05);   // the arrival
  note(c, t + 0.96, HZ.C4, 0.90, g * 0.5, 'sine');
}

/** SOLID — the same shape, shorter, no final octave leap (~0.9s). */
function solid(c: AudioContext, t: number): void {
  const g = 0.145;
  note(c, t + 0.00, HZ.C5, 0.10, g, 'square');
  note(c, t + 0.10, HZ.E5, 0.10, g, 'square');
  chord(c, t + 0.22, HZ.G5, 0.50, g);
}

/**
 * DISCIPLINED LOSS — warm, resolved, unmistakably NOT a failure sound. A plain
 * rising major third to the fifth: it settles rather than deflates. Getting
 * this one wrong breaks the whole system, so it is deliberately closer to
 * `solid` than to anything sad, just softer and slower.
 */
function disciplined(c: AudioContext, t: number): void {
  const g = 0.125;
  note(c, t + 0.00, HZ.C4, 0.55, g * 0.55, 'sine');
  chord(c, t + 0.00, HZ.E4, 0.24, g);
  chord(c, t + 0.22, HZ.G4, 0.24, g);
  chord(c, t + 0.44, HZ.C5, 0.62, g * 0.95);   // resolves home, unhurried
}

/** LOOSE — it worked, it was not the plan. Two notes, no resolution (~0.4s). */
function loose(c: AudioContext, t: number): void {
  const g = 0.11;
  note(c, t + 0.00, HZ.D5, 0.12, g, 'triangle');
  note(c, t + 0.12, HZ.F5, 0.30, g * 0.9, 'triangle');
}

/**
 * UNSTRUCTURED — a single dry blip. No fanfare, no melody, no reward. The
 * silence where a fanfare would be is the whole message.
 */
function unstructured(c: AudioContext, t: number): void {
  note(c, t + 0.00, HZ.A4, 0.09, 0.075, 'sine');
}

const VOICES: Record<XpGrade, (c: AudioContext, t: number) => void> = {
  flawless, solid, disciplined, loose, unstructured,
};

/** Roughly how long each grade sounds for, so a caller can pace the animation. */
export const XP_SOUND_MS: Record<XpGrade, number> = {
  flawless: 1850, solid: 750, disciplined: 1080, loose: 430, unstructured: 110,
};

/**
 * Best-effort — a dropped chime must never break a trade close. Callers gate
 * this on a user setting; it is never played unasked.
 */
export function playXpFanfare(grade: XpGrade): void {
  const c = audioContext();
  if (!c) return;
  try {
    (VOICES[grade] ?? unstructured)(c, c.currentTime + 0.02);
  } catch {
    // ignore
  }
}
