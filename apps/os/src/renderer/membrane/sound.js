// Sound director — per-blob ambient drone. Off by default; user toggles
// the hum via the panel button.
//
// Voice: a fundamental sine + perfect 5th (3:2 ratio) routed through a soft
// lowpass with a slow LFO sweep on cutoff — gives the tone organic motion
// without anything you'd notice as melody. Master gain rests at -36dB so
// it's atmosphere, not music.
//
// Per-blob tonics: D2 / G2 / A2 / F#2. The 5th rides 3:2 above. Navigating
// between blobs ramps both oscillators over 1.2s for a slow chord change.

export const TONIC_HZ = {
  self:   73.42, // D2
  cohort: 97.99, // G2
  events: 110.0, // A2
  asks:   92.50, // F#2
};

const ACTIVE_DB = -36;
const FADE_IN_SEC = 4.0;
const FADE_OUT_SEC = 2.4;
const PITCH_RAMP_SEC = 1.2;
const FIFTH_RATIO = 3 / 2;

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function createSoundDirector() {
  let ctx = null;
  let oscFundamental = null;
  let oscFifth = null;
  let oscMix = null;
  let masterGain = null;
  let lowpass = null;
  let lfoOsc = null;
  let lfoGain = null;
  let enabled = false;
  let currentTonic = TONIC_HZ.self;
  let initialized = false;

  function ensureContext() {
    if (ctx) return ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  function buildGraph() {
    if (!ctx || initialized) return;

    masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(ctx.destination);

    lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 380;
    lowpass.Q.value = 0.6;
    lowpass.connect(masterGain);

    // Slow LFO on the lowpass cutoff. 0.07Hz ≈ 14s period. Sweep ±80Hz
    // around the 380Hz center, so the tone breathes.
    lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = 0.07;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = 80;
    lfoOsc.connect(lfoGain).connect(lowpass.frequency);
    lfoOsc.start();

    // Two oscillators: fundamental + perfect 5th. The 5th is mixed in
    // softer than the fundamental so the tone reads tonic, not chord.
    oscMix = ctx.createGain();
    oscMix.gain.value = 1.0;
    oscMix.connect(lowpass);

    oscFundamental = ctx.createOscillator();
    oscFundamental.type = 'sine';
    oscFundamental.frequency.value = currentTonic;
    const fundGain = ctx.createGain();
    fundGain.gain.value = 0.8;
    oscFundamental.connect(fundGain).connect(oscMix);
    oscFundamental.start();

    oscFifth = ctx.createOscillator();
    oscFifth.type = 'sine';
    oscFifth.frequency.value = currentTonic * FIFTH_RATIO;
    const fifthGain = ctx.createGain();
    fifthGain.gain.value = 0.32;
    oscFifth.connect(fifthGain).connect(oscMix);
    oscFifth.start();

    initialized = true;
  }

  function rampOscillators(targetHz) {
    if (!ctx || !oscFundamental || !oscFifth) return;
    const t = ctx.currentTime;
    oscFundamental.frequency.cancelScheduledValues(t);
    oscFundamental.frequency.setValueAtTime(oscFundamental.frequency.value, t);
    oscFundamental.frequency.exponentialRampToValueAtTime(targetHz, t + PITCH_RAMP_SEC);
    oscFifth.frequency.cancelScheduledValues(t);
    oscFifth.frequency.setValueAtTime(oscFifth.frequency.value, t);
    oscFifth.frequency.exponentialRampToValueAtTime(targetHz * FIFTH_RATIO, t + PITCH_RAMP_SEC);
  }

  return {
    init() {
      // No-op — scaffolding lives in setEnabled() now that M4 is active.
    },
    setTonic(hzOrId) {
      const hz = typeof hzOrId === 'string' ? TONIC_HZ[hzOrId] : hzOrId;
      if (typeof hz !== 'number') return;
      currentTonic = hz;
      if (initialized) rampOscillators(hz);
    },
    setEnabled(on) {
      enabled = !!on;
      if (enabled) {
        ensureContext();
        buildGraph();
        if (ctx?.state === 'suspended') ctx.resume();
        if (!masterGain || !ctx) return;
        const t = ctx.currentTime;
        masterGain.gain.cancelScheduledValues(t);
        masterGain.gain.setValueAtTime(masterGain.gain.value, t);
        masterGain.gain.linearRampToValueAtTime(dbToGain(ACTIVE_DB), t + FADE_IN_SEC);
      } else if (masterGain && ctx) {
        const t = ctx.currentTime;
        masterGain.gain.cancelScheduledValues(t);
        masterGain.gain.setValueAtTime(masterGain.gain.value, t);
        masterGain.gain.linearRampToValueAtTime(0, t + FADE_OUT_SEC);
      }
    },
    isEnabled() {
      return enabled;
    },
    tick(_t) {
      // Reserved hook — modulation already runs in the audio graph (LFO).
    },
    destroy() {
      try {
        if (oscFundamental) oscFundamental.stop();
        if (oscFifth) oscFifth.stop();
        if (lfoOsc) lfoOsc.stop();
        if (ctx) ctx.close();
      } catch (e) {}
      ctx = null;
      oscFundamental = null;
      oscFifth = null;
      lfoOsc = null;
      lfoGain = null;
      oscMix = null;
      masterGain = null;
      lowpass = null;
      initialized = false;
    },
  };
}
