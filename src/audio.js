// Procedural soundtrack (Web Audio only, no files). Nothing is created until the user turns sound on.
// Contract used by app/ui:
//   const audio = createAudio()
//   audio.setEnabled(bool)   user toggle; first enable creates the AudioContext (must run inside a user gesture)
//   audio.enabled            current toggle state
//   audio.update(s)          every frame: s = { t, idx, u, playing, speed, hidden }  (idx = stage 0..9, u = stage progress 0..1)
// Extra exports: createAudioEngine(ctx, dest, opts) builds the whole graph on ANY BaseAudioContext (used for offline level tests;
//   synchronous unless opts.async, in which case it returns at once and engine.step(ms) finishes the build in slices),
//   AUDIO_EVENTS (sorted film-time list of every one-shot) and STAGE_CHORDS.
// Design: master bus (high-pass -> compressor -> limiter -> soft clip -> gate) + generated convolution reverb; evolving pad
// (two cross-faded banks of detuned saws, formant "choir" branch, sub drone); per-stage layer levels computed from (t, idx, u)
// and ramped with setTargetAtTime; deterministic one-shots that fire only when playing forward across their film time.
// All one-shot times come from timeline.js (EVENTS / STAGE_STARTS), so audio follows the director's retiming automatically.
// First enable is non-blocking: the context + bus + pad start at once; reverb IR, noise buffers (all generated in ~0.3 ms
// generator chunks) and the noise layers are built one by one in ~8 ms slices, the layers needed by the current stage first,
// each one fading in as it comes online. No slice ever blocks the main thread for a frame.
import { EVENTS, STAGE_STARTS, DURATION } from './timeline.js';

const clamp = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;
const sm = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const mtof = m => 440 * 2 ** ((m - 69) / 12);
const lcg = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

const T0 = Array.isArray(STAGE_STARTS) && STAGE_STARTS.length >= 10 ? STAGE_STARTS : [0, 20, 35, 55, 75, 92, 120, 136, 156, 171];
const T_END = Number.isFinite(DURATION) ? DURATION : 184;
const stageAt = t => { let i = 9; while (i > 0 && t < T0[i]) i--; return i; };
const ev = (k, d) => EVENTS && Number.isFinite(EVENTS[k]) ? EVENTS[k] : d;

// Film-time anchors, straight from the director's timeline.
const EV = {
  ignition: ev('ignition', 0), srbSep: ev('srbSep', 11.7), omsBurn: ev('omsBurn', 28.7), dockContact: ev('dockContact', 74.4), touchdown: ev('touchdown', 90.47),
  liftoff: ev('liftoff', 120.3), ascentDock: ev('ascentDock', 135.5), smSep: ev('smSep', 156.2), chuteDeploy: ev('chuteDeploy', 171.15), splash: ev('splash', 176.46), chuteRelease: ev('chuteRelease', 176.98)
};

// Six-note voicings (MIDI) per stage: launch D add9, orbit Gmaj9, transfer Em9, dock Asus, landing Fmaj9#11, surface Cmaj9,
// ascent Am9, return Bm9, entry Dm9 (dark), splash D major (resolution).
export const STAGE_CHORDS = [
  [38, 45, 50, 54, 57, 64], [43, 50, 55, 59, 62, 69], [40, 47, 55, 62, 66, 71], [45, 52, 57, 59, 64, 71], [41, 48, 57, 64, 67, 71],
  [48, 55, 59, 62, 64, 67], [45, 52, 57, 60, 64, 71], [47, 54, 59, 62, 66, 69], [38, 45, 53, 57, 64, 72], [38, 45, 54, 57, 62, 74]
];
const PAD_CUT = [1500, 1000, 950, 850, 700, 640, 800, 900, 520, 1250];

// ---------- one-shot schedule (film time) ----------
export const AUDIO_EVENTS = (() => {
  const E = [], add = (t, id, a = 0) => E.push({ t, id, a }), R = lcg(2718), S = T0;
  add(EV.ignition + .3, 'ignite'); add(EV.srbSep, 'srb'); add(EV.omsBurn, 'burn'); add(EV.dockContact, 'latch'); add(S[4] + .3, 'burn'); add(EV.touchdown, 'touch');
  add(EV.liftoff, 'burn'); add(EV.ascentDock, 'dock2'); add(EV.smSep, 'smsep');
  add(EV.chuteDeploy, 'chute', 0); add(EV.chuteDeploy + 1.15, 'chute', 1); add(EV.splash, 'splash'); add(EV.chuteRelease + .1, 'cutaway');
  for (const [s, o] of [[1, .6], [2, .7], [3, .5], [4, 1.2], [5, .5], [6, 1.4], [7, .6], [9, 1.4]]) add(S[s] + o, 'quindar');
  for (const [s, o] of [[2, 9.8], [5, 11.1], [7, 11.3]]) add(S[s] + o, 'quindar', 1);
  for (const [s, o] of [[5, 5.6], [5, 16.2], [5, 23.9]]) add(S[s] + o, 'roger');
  // RCS tick bursts: orbit trim, docking approach (ends just before contact), landing, ascent.
  const puffs = (a, b, g0, g1, v0, v1) => { for (let t = a; t < b; t += g0 + R() * (g1 - g0)) add(t, 'puff', v0 + R() * (v1 - v0)); };
  puffs(S[1] + 2, S[2] - 3, 2.2, 5, .35, .6); puffs(S[3] + 1.2, EV.dockContact - .6, .4, 1.25, .5, 1); puffs(S[4] + 2.5, EV.touchdown - 2.5, 1.4, 3.2, .4, .7); puffs(EV.liftoff + 3.7, EV.ascentDock - 2.5, 1.6, 3.4, .35, .6);
  for (let t = 6.5; t < T_END - 2; t += 5.6 + R() * 4.2) add(t, 'bell', R());
  return E.sort((x, y) => x.t - y.t);
})();

const CLIP = (() => { const c = new Float32Array(2049); for (let i = 0; i < c.length; i++) { const x = i / 1024 - 1, a = Math.abs(x); c[i] = Math.sign(x) * (a < .6 ? a : .6 + .255 * Math.tanh((a - .6) / .255)); } return c; })();

// ---------- engine ----------
export function createAudioEngine(ctx, dest = ctx.destination, opts = {}) {
  const R = lcg(4242), sr = ctx.sampleRate, fade = opts.async ? .7 : 0;
  const G = (v = 0) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const bq = (type, f, q = .707) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
  const osc = (type, f, detune = 0) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune; o.start(); return o; };
  const panner = p => { const n = ctx.createStereoPanner(); n.pan.value = p; return n; };
  const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };
  const mod = (lfo, depth, param) => { lfo.connect(G(depth)).connect(param); };

  // master bus
  const bus = G(1), comp = ctx.createDynamicsCompressor(), lim = ctx.createDynamicsCompressor(), shaper = ctx.createWaveShaper(), master = G(0);
  comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 2.5; comp.attack.value = .02; comp.release.value = .4;
  lim.threshold.value = -6; lim.knee.value = 3; lim.ratio.value = 20; lim.attack.value = .003; lim.release.value = .15;
  shaper.curve = CLIP; shaper.oversample = 'none';
  chain(bus, bq('highpass', 24, .6), comp, lim, shaper, master).connect(dest);
  // Reverb: the impulse response is cut into REV_SEGS consecutive time segments, each convolved by its own ConvolverNode behind a
  // DelayNode (convolution is linear, so the sum is exact). Assigning ConvolverNode.buffer blocks the main thread in proportion to the
  // IR length (~20 ms for 3.8 s), so this turns one 20 ms stall into ~5 ms steps. Silent until the IR arrives.
  const REV_SEGS = 5, revIn = G(1), revLP = bq('lowpass', 6500, .5), revHP = bq('highpass', 170, .5), conv = [];
  chain(revIn, revLP); chain(revHP, G(.85)).connect(bus);
  const IR_N = Math.round(sr * (opts.irSec || 3.8)), IR_PER = Math.ceil(IR_N / REV_SEGS / 128) * 128;
  for (let k = 0; k < REV_SEGS; k++) { const c = ctx.createConvolver(); c.normalize = false; conv.push(c); let n = revLP; if (k) { n = ctx.createDelay(4); n.delayTime.value = k * IR_PER / sr; revLP.connect(n); } chain(n, c, revHP); }
  const layers = {}, last = {}, zeroAt = {};
  // A silent layer is disconnected from the bus: Web Audio only renders nodes that reach the destination, so idle chains cost nothing.
  const layer = (name, send = 0) => { const o = G(0); o.connect(bus); if (send) { o._send = G(send); o._send.connect(revIn); o.connect(o._send); } o._on = true; layers[name] = o; last[name] = -1; zeroAt[name] = -1; return o; };
  const attach = o => { if (o._on) return; o.connect(bus); if (o._send) o.connect(o._send); o._on = true; };
  const detach = o => { if (!o._on) return; o.disconnect(); o._on = false; };
  const NAMES = ['pad', 'choir', 'sub', 'cabin', 'rumble', 'roar', 'crackle', 'descent', 'dust', 'plasma', 'buffet', 'wind', 'waves', 'breath'];
  const SEND = { pad: .55, choir: .7, sub: 0, cabin: .06, rumble: .1, roar: .16, crackle: .22, descent: .1, dust: .1, plasma: .14, buffet: 0, wind: .22, waves: .3, breath: .22 };
  for (const n of NAMES) layer(n, SEND[n]);
  const TRIM = Object.assign({ "pad": 0.5, "choir": 1.75, "sub": 0.0214, "cabin": 0.0288, "rumble": 0.163, "roar": 0.301, "crackle": 0.593, "descent": 0.08, "dust": 0.17, "plasma": 0.382, "buffet": 0.1166, "wind": 0.2376, "waves": 0.126, "breath": 0.225 }, opts.trim);
  const TAU = { pad: 1, choir: 1.2, sub: 1.2, cabin: .8, rumble: .2, roar: .22, crackle: .25, descent: .18, dust: .25, plasma: .3, buffet: .3, wind: .7, waves: .8, breath: .6 };
  // filters whose frequency the per-frame control sweeps (created up front, wired into their layer by the build step)
  const roarBP = bq('bandpass', 700, .5), roarLP = bq('lowpass', 600, .6), plBP = bq('bandpass', 900, .5), descLP = bq('lowpass', 240, .7);
  layers.descent._lp = descLP;
  // a freshly built chain enters its layer through a gain that fades in, so late-arriving layers never click
  const into = (name, tc = fade) => { const f = G(tc ? 0 : 1); f.connect(layers[name]); if (tc) { const n = ctx.currentTime; f.gain.setValueAtTime(0, n); f.gain.linearRampToValueAtTime(1, n + tc); } return f; };

  // ---------- buffers (generators: yield every ~0.3 ms of work so the pump can hand the thread back) ----------
  const B = {}, CH = 32768, rnd = lcg(919);
  const norm = (a, rms) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; const k = rms / Math.sqrt(s / a.length + 1e-12); for (let i = 0; i < a.length; i++) a[i] *= k; return a; };
  const make = data => { const b = ctx.createBuffer(1, data.length, sr); b.getChannelData(0).set(data); return b; };
  const L = Math.round(sr * 6), M = Math.round(sr * .4);
  const loopable = raw => { const o = new Float32Array(L); for (let i = 0; i < L; i++) o[i] = i < M ? raw[i] * Math.sqrt(i / M) + raw[L + i] * Math.sqrt(1 - i / M) : raw[i]; return o; };
  const MK = {
    * white() { const w = new Float32Array(Math.round(sr * 3)); for (let i0 = 0; i0 < w.length; i0 += CH * 4) { for (let i = i0, e = Math.min(w.length, i0 + CH * 4); i < e; i++) w[i] = rnd() * 2 - 1; yield; } B.white = make(norm(w, .3)); },
    * pink() {
      const raw = new Float32Array(L + M); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i0 = 0; i0 < raw.length; i0 += CH) {
        for (let i = i0, e = Math.min(raw.length, i0 + CH); i < e; i++) {
          const w = rnd() * 2 - 1;
          b0 = .99886 * b0 + w * .0555179; b1 = .99332 * b1 + w * .0750759; b2 = .969 * b2 + w * .153852; b3 = .8665 * b3 + w * .3104856; b4 = .55 * b4 + w * .5329522; b5 = -.7616 * b5 - w * .016898;
          raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * .5362; b6 = w * .115926;
        }
        yield;
      }
      B.pink = make(norm(loopable(raw), .3));
    },
    * brown() {
      const raw = new Float32Array(L + M); let y = 0;
      for (let i0 = 0; i0 < raw.length; i0 += CH * 2) { for (let i = i0, e = Math.min(raw.length, i0 + CH * 2); i < e; i++) { y = .9985 * y + (rnd() * 2 - 1) * .05; raw[i] = y; } yield; }
      B.brown = make(norm(loopable(raw), .3));
    },
    // Impulsive grains (SRB crackle / plasma sparks): Poisson-timed, clumped, power-law amplitudes, cyclic so the loop is seamless.
    * crackle(name, sec, rate, tauMin, tauMax, seed) {
      const n = Math.round(sr * sec), b = ctx.createBuffer(2, n, sr);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c), r = lcg(seed + c * 977); let pos = 0, cnt = 0;
        while (pos < n) {
          pos += -Math.log(1 - r()) / rate * sr;
          const clump = r() < .3 ? 2 + (r() * 3 | 0) : 1;
          for (let k = 0; k < clump; k++) {
            const at = (pos + k * r() * .005 * sr) | 0, a = Math.pow(r(), 2.6) * .95 + .02, tau = (tauMin + (tauMax - tauMin) * r()) * sr, len = Math.min(tau * 7, sr * .05) | 0;
            for (let i = 0; i < len; i++) d[(at + i) % n] += a * (r() * 2 - 1) * Math.exp(-i / tau);
          }
          if ((++cnt & 31) === 0) yield;
        }
        let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i])); for (let i = 0; i < n; i++) d[i] /= pk * 1.1;
        yield;
      }
      B[name] = b;
    },
    * crackleA() { yield* MK.crackle('crackleA', 5, 85, .0007, .004, 11); },
    * crackleB() { yield* MK.crackle('crackleB', 7, 11, .004, .014, 313); },
    // Procedural convolution reverb impulse: decaying noise that darkens over time, with a tiny pre-delay.
    * ir() {
      const n = IR_N, b = ctx.createBuffer(2, n, sr), pre = Math.round(sr * .016);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c), r = lcg(7001 + c * 131); let lp = 0, lp2 = 0;
        for (let i0 = pre; i0 < n; i0 += CH) {
          for (let i = i0, e = Math.min(n, i0 + CH); i < e; i++) {
            const tt = (i - pre) / sr, k = .9 - .8 * Math.min(1, tt / 2.4), x = (r() * 2 - 1);
            lp += (x - lp) * k; lp2 += (lp - lp2) * (k * .8 + .15);
            d[i] = lp2 * Math.exp(-tt * 1.9) * (1 - Math.exp(-tt / .014)) * Math.min(1, (n - i) / (sr * .25));
          }
          yield;
        }
      }
      // same gain a ConvolverNode applies with normalize = true (RMS-normalised, -58 dB calibration), baked in because segments must share one scale
      let p = 0; for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) p += d[i] * d[i]; }
      p = Math.sqrt(p / (2 * n)); const scale = Math.pow(10, -58 * .05) / Math.max(p, .000125) * 44100 / sr, per = IR_PER;
      yield;
      for (let k = 0; k < REV_SEGS; k++) {
        const a = k * per, len = Math.min(per, n - a), sg = ctx.createBuffer(2, len, sr);
        for (let c = 0; c < 2; c++) { const d = b.getChannelData(c), o = sg.getChannelData(c); for (let i = 0; i < len; i++) o[i] = d[a + i] * scale; }
        conv[k].buffer = sg; yield;
      }
      B.ir = 1;
    }
  };
  function* need(...names) { for (const n of names) if (!B[n]) yield* MK[n](); }
  const loopSrc = (b, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.playbackRate.value = rate; s.start(0, R() * b.duration); return s; };
  // two decorrelated copies of a noise buffer panned left/right (cheap stereo width)
  const wide = (b, rate = 1, w = .6) => { const o = G(.75); chain(loopSrc(b, rate), panner(-w), o); chain(loopSrc(b, rate * 1.01), panner(w), o); return o; };

  // ---------- layer builders (each runs in its own build step; none touches the bus until its buffers exist) ----------
  const banks = [];
  let padReady = false, subs = [];
  const slow = osc('sine', .067);
  function* buildPad() {
    // ambient score: two cross-faded pad banks + formant choir + sub drone (no buffers needed: this is what plays first)
    const FP = into('pad'), FC = into('choir'), FS = into('sub');
    const padLfo = [osc('sine', .041), osc('sine', .067), osc('sine', .093)], cutLfo = osc('sine', .053), formLfo = osc('sine', .037), formLfo2 = osc('sine', .029);
    const VPAN = [-.6, .45, -.25, .65, -.45, .25], VG = [.55, .7, .85, .85, .75, .6];
    function* makeBank(out) {
      const inp = G(0), lp = bq('lowpass', 1000, .45), voices = [];
      for (let v = 0; v < 6; v++) {
        const vg = G(VG[v] * .16), lg = G(.62), oa = osc('sawtooth', 220, -6 - R() * 5), ob = osc('sawtooth', 220, 6 + R() * 5);
        oa.connect(vg); ob.connect(vg); chain(vg, lg, panner(VPAN[v])).connect(inp);
        padLfo[v % 3].connect(G(.3)).connect(lg.gain); voices.push([oa, ob]); yield;
      }
      chain(inp, lp, FP); mod(cutLfo, 260, lp.frequency);
      const f1 = bq('bandpass', 780, 6), f2 = bq('bandpass', 1180, 7), f3 = bq('bandpass', 2800, 8);
      chain(inp, f1, G(1.1), FC); chain(inp, f2, G(.7), FC); chain(inp, f3, G(.35), FC);
      mod(formLfo, 170, f1.frequency); mod(formLfo2, 320, f2.frequency);
      const outs = [lp, f1, f2, f3], b = { inp, lp, voices, on: true, offAt: -1 };
      // an inactive bank is disconnected (its 12 oscillators then cost nothing)
      b.attach = () => { b.offAt = -1; if (!b.on) { for (const n of outs) inp.connect(n); b.on = true; } };
      b.detach = () => { if (b.on) { inp.disconnect(); b.on = false; } };
      out.push(b);
    }
    yield* makeBank(banks); yield* makeBank(banks);
    const sub1 = osc('sine', 40), sub2 = osc('sine', 40, 7), sub3 = osc('triangle', 80);
    chain(sub1, G(.5), FS); chain(sub2, G(.4), FS); chain(sub3, bq('lowpass', 190, .5), G(.14), FS);
    subs = [sub1, sub2, sub3]; padReady = true;
  }
  const GROUPS = {
    * cabin() {  // spacecraft cabin: fans/pumps, a quiet 120 Hz hum
      yield* need('pink'); const F = into('cabin'), am = G(.8); slow.connect(G(.12)).connect(am.gain);
      chain(osc('sine', 117), G(.55), am, F); chain(osc('sine', 234.5, 4), G(.16), am); chain(osc('sine', 351, -3), G(.06), am);
      chain(loopSrc(B.pink, .8), bq('lowpass', 420, .5), G(.4), am); chain(loopSrc(B.pink), bq('bandpass', 1900, .35), G(.05), am);
    },
    * wind() {
      yield* need('pink'); const F = into('wind'), bp = bq('bandpass', 520, .7), gust = G(.7); mod(slow, 230, bp.frequency); slow.connect(G(.28)).connect(gust.gain);
      chain(wide(B.pink, 1, .7), bp, G(.9), gust, F);
    },
    * waves() {
      yield* need('brown', 'pink'); const F = into('waves'), wave1 = osc('sine', .118), wave2 = osc('sine', .121, 0), lp = bq('lowpass', 620, .5), surge = G(.5), foam = G(.3);
      wave1.connect(G(.48)).connect(surge.gain); wave2.connect(G(.3)).connect(foam.gain); mod(wave1, 160, lp.frequency);
      chain(wide(B.brown, 1, .5), lp, G(2.2), surge, F); chain(wide(B.pink, .9, .8), bq('bandpass', 1500, .5), G(1.1), foam, F);
    },
    * breath() {  // suit breathing: two astronauts at ~0.25 Hz / 0.2 Hz, pink noise through a sweeping band, plus regulator hiss
      yield* need('pink', 'white'); const F = into('breath');
      [[osc('sine', .25), 880, -.4], [osc('sine', .205), 700, .4]].forEach(([l, f, p]) => {
        const bp = bq('bandpass', f, 1.3), am = G(.45); l.connect(G(.45)).connect(am.gain); mod(l, 260, bp.frequency);
        chain(loopSrc(B.pink), bp, G(.9), am, panner(p), F); chain(loopSrc(B.white), bq('bandpass', 5800, .7), G(.04), am);
      });
    },
    * rumble() {  // launch: brown rumble
      yield* need('brown'); const F = into('rumble'), thrum = osc('sine', 13), lp1 = bq('lowpass', 115, .8), th = G(.82), lp2 = bq('lowpass', 300, .6);
      chain(loopSrc(B.brown), lp1, G(1.8), th, F); thrum.connect(G(.18)).connect(th.gain);
      chain(loopSrc(B.brown, .8), lp2, G(1.7), F);
    },
    * roar() {  // broadband roar
      yield* need('pink', 'brown', 'white'); const F = into('roar');
      chain(wide(B.pink), roarBP, G(1.1), F); chain(wide(B.brown, 1.2, .4), roarLP, G(1.2), F); chain(loopSrc(B.white), bq('highpass', 2600, .5), G(.12), F);
    },
    * crackle() {  // SRB crackle
      yield* need('crackleA'); yield* need('crackleB'); const F = into('crackle');
      chain(loopSrc(B.crackleA), bq('highpass', 500, .5), bq('bandpass', 2400, .55), G(1.8), F);
      chain(loopSrc(B.crackleA, .91), bq('bandpass', 4300, .5), G(1.1), F);
      chain(loopSrc(B.crackleB), bq('lowpass', 1400, .7), G(1.6), F);
    },
    * descent() {  // engine heard through the structure (OMS, descent, ascent)
      yield* need('brown', 'pink'); const F = into('descent'), tremolo = osc('sine', .17), tr = G(.9); tremolo.connect(G(.1)).connect(tr.gain);
      chain(loopSrc(B.brown, .9), descLP, G(2.2), tr, F); chain(loopSrc(B.pink, .8), bq('bandpass', 480, .9), G(.9), tr); chain(loopSrc(B.pink, 1.1), bq('bandpass', 950, .7), G(.7), tr);
    },
    * dust() { yield* need('white'); chain(loopSrc(B.white), bq('bandpass', 3300, .6), G(.5), into('dust')); },
    * plasma() {  // entry: plasma roar, hiss, sparks
      yield* need('pink', 'white', 'crackleA'); const F = into('plasma');
      chain(wide(B.pink), plBP, G(1.5), F); chain(wide(B.white, 1, .8), bq('highpass', 3500, .5), bq('lowpass', 9500, .5), G(.28), F);
      chain(loopSrc(B.crackleA, 1.1), bq('highpass', 1600, .5), G(.9), F);
    },
    * buffet() {  // entry: low buffeting
      yield* need('brown'); const F = into('buffet'), buf7 = osc('sine', 7.3), buf11 = osc('sine', 11.4), am = G(.55); buf7.connect(G(.22)).connect(am.gain); buf11.connect(G(.14)).connect(am.gain);
      chain(loopSrc(B.brown), bq('lowpass', 95, 1), G(3.2), am, F); chain(loopSrc(B.brown, 1.4), bq('lowpass', 380, .6), G(.6), am);
    }
  };
  // stages in which each noise layer is audible: those are built first
  const WHERE = { cabin: [1, 2, 3, 4, 6, 7, 8], wind: [0, 8, 9], waves: [0, 9], breath: [5, 6], rumble: [0, 1], roar: [0], crackle: [0], descent: [1, 4, 6], dust: [4, 6], plasma: [8, 9], buffet: [8] };

  function* build() {
    yield; yield* buildPad(); yield;
    if (!opts.noRev) yield* need('ir');
    yield* need('white');
    const st = opts.stage | 0, order = Object.keys(GROUPS).sort((a, b) => (WHERE[a].includes(st) ? 0 : 1) - (WHERE[b].includes(st) ? 0 : 1));
    for (const g of order) { yield* GROUPS[g](); yield; }
  }
  const it = build(); let ready = false, maxSlice = 0, worst = 0;
  // Run build steps for up to `ms` milliseconds; returns true once everything is built.
  const step = (ms = 8) => {
    if (ready) return true;
    const t0 = performance.now();
    do { const a = performance.now(), d = it.next().done; worst = Math.max(worst, performance.now() - a); if (d) { ready = true; break; } } while (performance.now() - t0 + worst < ms);
    maxSlice = Math.max(maxSlice, performance.now() - t0); return ready;
  };

  // ----- one-shot synthesis (short-lived nodes) -----
  let live = 0;
  const radioHead = G(1); { const hp = bq('highpass', 480, .6), lp = bq('lowpass', 3400, .6), pk = bq('peaking', 1500, 1); pk.gain.value = 5; chain(radioHead, hp, lp, pk); pk.connect(bus); pk.connect(G(.1)).connect(revIn); }
  let vs = 1;
  const env = (n, now, peak, att, tau, hold = 0) => { peak *= vs; n.gain.setValueAtTime(0, now); n.gain.linearRampToValueAtTime(peak, now + att); if (hold) { n.gain.setValueAtTime(peak, now + att + hold); n.gain.linearRampToValueAtTime(0, now + att + hold + .008); } else n.gain.setTargetAtTime(0, now + att, tau); };
  function out(node, o) {
    let n = node; if (o.pan) n = chain(n, panner(o.pan));
    n.connect(o.dest || bus); if (o.send) n.connect(G(o.send)).connect(revIn);
  }
  function burst(now, o) {
    const buf = B[o.buf || 'white']; if (!buf) return;   // noise buffer not built yet (first second after enabling)
    live++; const s = ctx.createBufferSource(), f = bq(o.type || 'bandpass', o.f0 || 1000, o.q || .7), e = G(0), dur = o.dur, tau = o.tau || dur / 4;
    s.buffer = buf; s.loop = true;
    if (o.f1) { f.frequency.setValueAtTime(o.f0, now); f.frequency.exponentialRampToValueAtTime(o.f1, now + dur); }
    env(e, now, o.gain, o.att || .004, tau, o.hold || 0); chain(s, f, e); out(e, o);
    const end = now + (o.att || .004) + (o.hold || 0) + tau * 7 + .05; s.start(now, R() * 2); s.stop(end);
    s.onended = () => { live--; s.disconnect(); f.disconnect(); e.disconnect(); };
  }
  function tone(now, o) {
    live++; const s = ctx.createOscillator(), e = G(0), tau = o.tau || .15; s.type = o.type || 'sine'; s.frequency.setValueAtTime(o.f0, now);
    if (o.f1) s.frequency.exponentialRampToValueAtTime(o.f1, now + (o.sweep || tau * 3));
    env(e, now, o.gain, o.att || .004, tau, o.hold || 0); chain(s, e); out(e, o);
    s.start(now); s.stop(now + (o.att || .004) + (o.hold || 0) + tau * 7 + .05);
    s.onended = () => { live--; s.disconnect(); e.disconnect(); };
  }
  // Docking-ring capture: low thump through the hull, a decaying metallic rattle while the vehicles settle, the hard-latch
  // clunk, a short ratchet of the ring hooks and a faint pressure hiss. Everything is anchored to `now` = the contact time.
  const RATTLE = [[.07, 2310, 410], [.13, 3160, 590], [.2, 2740, 380], [.29, 3820, 650], [.4, 2480, 440], [.53, 3470, 560], [.69, 2950, 400]];
  function dock(now, v, full) {
    tone(now, { f0: 84, f1: 42, sweep: .14, gain: .62 * v, tau: .09, att: .002, send: .15 });
    burst(now, { buf: 'brown', type: 'lowpass', f0: 210, dur: .55, tau: .17, att: .003, gain: .55 * v, send: .2 });
    burst(now, { type: 'bandpass', f0: 1900, q: 1.1, dur: .05, tau: .012, att: .001, gain: .22 * v });
    for (let k = 0; k < RATTLE.length; k++) {
      const [g, f, f2] = RATTLE[k], a = Math.exp(-k * .38) * v;
      burst(now + g, { type: 'bandpass', f0: f, q: 2.4, dur: .04, tau: .01, att: .001, gain: .09 * a, pan: (k % 3 - 1) * .25, send: .1 });
      tone(now + g, { type: 'triangle', f0: f2, gain: .02 * a, tau: .05, att: .001, pan: (k % 3 - 1) * .25, send: .2 });
    }
    if (!full) return;
    SH.clunk(now + .86, .42 * v);
    for (let k = 0; k < 8; k++) burst(now + 1.2 + k * .075, { type: 'bandpass', f0: 3000 + (k % 3) * 420, q: 2, dur: .03, tau: .008, att: .001, gain: .085 * v, pan: (k % 2 - .5) * .5 });
    burst(now + 1.3, { buf: 'pink', type: 'bandpass', f0: 4800, q: .7, dur: 1.4, tau: .4, att: .15, gain: .05 * v, send: .25 });
  }
  const SH = {
    ignite(now) {
      tone(now, { f0: 62, f1: 31, sweep: .9, gain: .6, tau: .5, att: .04, send: .2 });
      burst(now, { buf: 'brown', type: 'lowpass', f0: 170, dur: 2.8, tau: .95, att: .25, gain: .8, send: .15 });
      burst(now, { type: 'highpass', f0: 1800, dur: .5, tau: .1, att: .003, gain: .22, send: .3 });
    },
    srb(now) {
      tone(now, { f0: 88, f1: 36, sweep: .5, gain: .85, tau: .22, att: .003, send: .25 });
      burst(now, { buf: 'brown', type: 'lowpass', f0: 160, dur: 1, tau: .35, att: .004, gain: 1, send: .3 });
      burst(now, { type: 'highpass', f0: 1500, dur: .12, tau: .03, att: .001, gain: .5 });
      burst(now + .02, { buf: 'crackleA', type: 'bandpass', f0: 3000, q: .6, dur: .5, tau: .12, att: .002, gain: .6, pan: .3, send: .35 });
      burst(now + .05, { buf: 'pink', type: 'bandpass', f0: 2500, f1: 380, q: .8, dur: 1.5, tau: .5, att: .08, gain: .32, pan: -.2, send: .6 });
    },
    clunk(now, v) {
      tone(now, { f0: 190, f1: 105, sweep: .1, gain: .55 * v, tau: .06, att: .002, send: .15 });
      tone(now, { type: 'triangle', f0: 523, gain: .2 * v, tau: .1, att: .001, send: .35 });
      tone(now, { type: 'triangle', f0: 811, gain: .13 * v, tau: .075, att: .001, send: .35 });
      tone(now, { type: 'sine', f0: 1347, gain: .06 * v, tau: .05, att: .001, send: .4 });
      burst(now, { type: 'bandpass', f0: 2800, q: 1.2, dur: .06, tau: .015, att: .001, gain: .3 * v });
    },
    latch(now) { dock(now, 1, true); },
    dock2(now) { dock(now, .8, true); },   // lander meets Orion above the surface (ascent)
    // service-module separation: pyro bolt crack, a thump through the structure, spring push-off whoosh and a few debris ticks
    smsep(now) {
      burst(now, { type: 'highpass', f0: 1300, dur: .09, tau: .022, att: .001, gain: .55, send: .25 });
      tone(now, { f0: 150, f1: 62, sweep: .12, gain: .55, tau: .07, att: .002, send: .2 });
      burst(now, { buf: 'brown', type: 'lowpass', f0: 230, dur: .6, tau: .2, att: .003, gain: .6, send: .25 });
      burst(now + .06, { buf: 'pink', type: 'bandpass', f0: 1900, f1: 520, q: .7, dur: 1.2, tau: .38, att: .09, gain: .16, pan: -.2, send: .4 });
      for (let k = 0; k < 6; k++) burst(now + .12 + k * .09 + (k * k % 3) * .02, { type: 'bandpass', f0: 2200 + k * 410, q: 2.2, dur: .04, tau: .01, att: .001, gain: .1 * Math.exp(-k * .28), pan: (k % 2 ? .35 : -.35), send: .2 });
    },
    puff(now, a) {
      const p = (R() - .5) * 1.4, d = .09 + a * .12;
      burst(now, { type: 'bandpass', f0: 2800, q: .9, dur: d, tau: d / 3, att: .006, gain: .09 + .16 * a, pan: p, send: .22 });
      tone(now, { f0: 120, f1: 80, gain: .12 * a, tau: .035, att: .004, pan: p * .6 });
    },
    burn(now) { burst(now, { buf: 'brown', type: 'lowpass', f0: 260, dur: 1.4, tau: .4, att: .12, gain: .5, send: .1 }); tone(now + .05, { f0: 70, f1: 45, sweep: .6, gain: .25, tau: .3, att: .06 }); },
    touch(now) {
      tone(now, { f0: 72, f1: 28, sweep: .6, gain: .9, tau: .22, att: .003, send: .2 });
      burst(now, { buf: 'brown', type: 'lowpass', f0: 230, dur: 1, tau: .3, att: .004, gain: .8, send: .2 });
      burst(now + .03, { type: 'bandpass', f0: 3000, q: .5, dur: 1.5, tau: .5, att: .05, gain: .14, send: .3 });
      tone(now + .12, { type: 'triangle', f0: 181, gain: .06, tau: .25, att: .004, send: .4 }); tone(now + .17, { type: 'triangle', f0: 233, gain: .045, tau: .22, att: .004, send: .4 });
    },
    chute(now, a) {
      const v = a ? .6 : 1;
      tone(now, { f0: 95, f1: 46, sweep: .3, gain: .55 * v, tau: .13, att: .004, send: .2 });
      burst(now, { buf: 'brown', type: 'lowpass', f0: 280, dur: .7, tau: .2, att: .012, gain: .55 * v, send: .2 });
      burst(now + .02, { buf: 'crackleA', type: 'bandpass', f0: 800, f1: 450, q: .7, dur: 1, tau: .3, att: .02, gain: .45 * v, pan: a ? .3 : -.3, send: .35 });
      burst(now + .05, { buf: 'pink', type: 'bandpass', f0: 1200, f1: 400, q: .6, dur: 1.2, tau: .4, att: .1, gain: .18 * v, send: .4 });
    },
    splash(now) {
      tone(now, { f0: 58, f1: 27, sweep: .8, gain: .9, tau: .3, att: .004, send: .15 });
      burst(now, { type: 'lowpass', f0: 5200, f1: 280, q: .5, dur: 1.7, tau: .55, att: .008, gain: .8, send: .3 });
      burst(now, { buf: 'brown', type: 'lowpass', f0: 600, dur: 2.2, tau: .7, att: .03, gain: .75, send: .25 });
      burst(now + .1, { buf: 'pink', type: 'bandpass', f0: 1500, f1: 600, q: .5, dur: 2.6, tau: .8, att: .2, gain: .25, pan: .2, send: .4 });
      for (let k = 0; k < 8; k++) { const f = 320 + R() * 320; tone(now + .35 + k * .15 + R() * .1, { f0: f, f1: f * 2.3, sweep: .09, gain: .035 + R() * .05, tau: .03, att: .004, pan: (R() - .5) * 1.2, send: .3 }); }
    },
    cutaway(now) {
      burst(now, { type: 'highpass', f0: 3000, dur: .1, tau: .025, att: .001, gain: .32, send: .2 }); tone(now, { f0: 150, f1: 90, sweep: .1, gain: .3, tau: .06, att: .002 });
      burst(now + .05, { buf: 'pink', type: 'bandpass', f0: 1600, f1: 420, q: .8, dur: 1.4, tau: .4, att: .1, gain: .13, send: .4 });
    },
    quindar(now, a) {
      const v = a ? .6 : 1, p = a ? .3 : 0;
      tone(now, { f0: 2525, gain: .035 * v, att: .004, hold: .25, dest: radioHead, pan: p });
      burst(now + .27, { buf: 'crackleA', type: 'highpass', f0: 900, dur: .85, tau: .25, att: .01, gain: .09 * v, dest: radioHead, pan: p });
      burst(now + .27, { type: 'bandpass', f0: 2000, q: .5, dur: .85, tau: .25, att: .01, gain: .02 * v, dest: radioHead, pan: p });
      tone(now + 1.15, { f0: 2475, gain: .035 * v, att: .004, hold: .25, dest: radioHead, pan: p });
    },
    roger(now) {
      for (let k = 0; k < 2; k++) tone(now + k * .13, { f0: 1180, gain: .035, att: .003, hold: .055, dest: radioHead, pan: .25 });
      burst(now + .3, { buf: 'crackleA', type: 'highpass', f0: 900, dur: .5, tau: .14, att: .01, gain: .06, dest: radioHead, pan: .25 });
    },
    bell(now, a, idx) {
      const vol = [0, .036, .04, .036, 0, .024, .032, .036, 0, .032][idx]; if (!vol) return;
      const ch = STAGE_CHORDS[idx], note = ch[(a * 6) | 0] + 12 + 12 * (((a * 97) | 0) % 2), f = mtof(Math.min(note, 98)), p = ((a * 31) % 1 - .5) * 1.2;
      tone(now, { f0: f, gain: vol, att: .01, tau: 2.2, pan: p, send: .9 });
      tone(now, { f0: f * 2.76, gain: vol * .22, att: .006, tau: 1.2, pan: p, send: .9 });
      tone(now, { f0: f * 5.4, gain: vol * .07, att: .004, tau: .6, pan: p, send: .9 });
      tone(now, { f0: f * .5, gain: vol * .4, att: .02, tau: 3, pan: p, send: .6 });
    }
  };
  const SHOT_VOL = { ignite: .6, touch: .4, splash: .5, srb: .85, puff: .45 };
  const MAJOR = { ignite: 1, srb: 1, latch: 1, dock2: 1, smsep: 1, touch: 1, chute: 1, splash: 1, cutaway: 1, burn: 1 };

  // ----- per-frame control -----
  const LV = {}; for (const n of NAMES) LV[n] = 0;
  const TD = EV.touchdown, SEP = EV.srbSep;
  function levels(t, idx, u) {
    for (const n of NAMES) LV[n] = 0;
    const heat = idx === 8 ? Math.sin(u * Math.PI) : 0;
    switch (idx) {
      case 0: {
        const ign = sm(0, 2.5, t - EV.ignition), alt = 1 - .9 * sm(.45, 1, u), after = sm(SEP - .08, SEP + .35, t), amb = 1 - sm(.3, 4.5, t);
        LV.rumble = ign * alt; LV.roar = ign * alt * (1 - .4 * after); LV.crackle = sm(.15, 1.9, t - EV.ignition) * alt * (1 - .9 * after);
        LV.waves = .5 * amb; LV.wind = .3 * amb; LV.pad = .1 + .5 * sm(.15, 1, u); LV.choir = .35 * sm(.2, 1, u); LV.sub = .3 + .2 * u; break;
      }
      case 1: LV.pad = .78; LV.choir = .45; LV.sub = .55; LV.cabin = .4; LV.descent = .3 * sm(EV.omsBurn, EV.omsBurn + 1.5, t); LV.rumble = .25 * (1 - sm(0, .1, u)); break;
      case 2: LV.pad = .8; LV.choir = .5; LV.sub = .6; LV.cabin = .32; break;
      case 3: LV.pad = .55 + .2 * u; LV.choir = .38; LV.sub = .45; LV.cabin = .36 + .1 * sm(EV.dockContact - 1.5, EV.dockContact + 1, t); break;
      case 4: {
        const tt = t - TD, eng = sm(0, .1, u) * (1 - sm(TD - .09, TD + .26, t)), land = sm(TD, T0[5], t);
        LV.descent = .75 * eng; LV.dust = .34 * sm(TD - 6.1, TD - .7, t) * (1 - sm(TD, TD + .85, t)) + (tt > 0 ? .22 * Math.exp(-tt / 1.6) : 0);
        LV.pad = .5 + .2 * land; LV.choir = .3 + .2 * land; LV.sub = .3; LV.cabin = .12 * (1 - eng); break;
      }
      case 5: LV.pad = .55; LV.choir = .38; LV.sub = .3; LV.breath = .5 * sm(0, .06, u); break;
      case 6: {
        const LO = EV.liftoff, AD = EV.ascentDock, eng = sm(LO - .25, LO + .4, t) * (1 - sm(AD - 2.7, AD - .3, t));
        LV.descent = .7 * eng; LV.dust = .3 * (1 - sm(LO - .3, LO + 3.7, t)); LV.pad = .6; LV.choir = .4; LV.sub = .4; LV.cabin = .3 * sm(LO + 4.5, AD - 2.7, t); LV.breath = .15 * (1 - sm(0, .15, u)); break;
      }
      case 7: LV.pad = .8; LV.choir = .5; LV.sub = .55; LV.cabin = .35; break;
      case 8: LV.plasma = Math.pow(heat, 1.1) * .9; LV.buffet = Math.pow(heat, 1.4) * .85; LV.wind = .3 * sm(.6, 1, u); LV.pad = .22 + .35 * (1 - heat); LV.choir = .15 * (1 - heat); LV.sub = .3; LV.cabin = .22 * (1 - heat); break;
      default: {
        const SP = EV.splash, tt = t - SP, pre = 1 - sm(SP - .5, SP + .26, t);
        LV.wind = .45 * pre + .22 * (1 - pre); LV.waves = .35 + .25 * sm(SP - 1.6, SP + 1, t) + (tt > 0 ? .4 * Math.exp(-tt / 2.8) : 0); LV.plasma = .25 * (1 - sm(0, .06, u));
        LV.pad = .4 + .4 * sm(.4, 1, u); LV.choir = .5 * sm(.5, 1, u); LV.sub = .35; break;
      }
    }
    return heat;
  }

  let first = true, prevT = 0, lastLvl = -1, lastMaster = -1, lastChordT = -9, chordIdx = -1, bankA = 0;
  function setChord(bank, idx, now, snap) {
    const ch = STAGE_CHORDS[idx];
    for (let v = 0; v < 6; v++) for (const o of banks[bank].voices[v]) snap ? (o.frequency.value = mtof(ch[v])) : o.frequency.setTargetAtTime(mtof(ch[v]), now, .03);
  }
  function update(s, now = ctx.currentTime) {
    const t = s.t, idx = clamp(s.idx | 0, 0, 9), u = clamp(s.u), speed = s.speed || 1;
    const active = s.on !== false && !!s.playing && !s.hidden;
    const mt = active ? (speed > 2.05 ? .8 : 1) : 0;
    if (mt !== lastMaster) { master.gain.setTargetAtTime(mt, now, active ? .15 : s.hidden ? .04 : .1); lastMaster = mt; }
    if (first) prevT = t;
    const dtFilm = t - prevT;
    if (active && !opts.noShots && dtFilm > 0 && dtFilm <= .6 && speed <= 2.05) {
      for (let i = 0; i < AUDIO_EVENTS.length; i++) {
        const e = AUDIO_EVENTS[i]; if (e.t <= prevT) continue; if (e.t > t) break;
        if (!MAJOR[e.id] && live > 22 && !opts.noCap) continue;
        vs = SHOT_VOL[e.id] || 1; SH[e.id](now, e.a, stageAt(e.t)); vs = 1;
      }
    }
    prevT = t;
    // chord / pad colour (the pad is built first, a few ms after enabling; until then this waits)
    if (padReady && idx !== chordIdx && (chordIdx < 0 || now - lastChordT > 1.5)) {
      const snap = chordIdx < 0, [sub1, sub2, sub3] = subs;
      if (snap) { bankA = 0; setChord(0, idx, now, true); banks[0].inp.gain.value = .5; banks[1].inp.gain.value = 0; banks[1].detach(); }
      else { const nb = 1 - bankA; banks[nb].attach(); setChord(nb, idx, now, false); banks[bankA].offAt = now + 9; banks[nb].inp.gain.setTargetAtTime(.5, now, 1.3); banks[bankA].inp.gain.setTargetAtTime(0, now, .85); bankA = nb; }
      const cut = PAD_CUT[idx], tau = snap ? .03 : 1.2;
      for (const b of banks) b.lp.frequency.setTargetAtTime(cut, now, tau);
      const root = mtof(STAGE_CHORDS[idx][0] - 12); sub1.frequency.setTargetAtTime(root, now, snap ? .03 : 1.6); sub2.frequency.setTargetAtTime(root, now, snap ? .03 : 1.6); sub3.frequency.setTargetAtTime(root * 2, now, snap ? .03 : 1.6);
      chordIdx = idx; lastChordT = now;
    }
    if (first || now - lastLvl >= .04) {
      lastLvl = now; const heat = levels(t, idx, u);
      if (padReady) for (const b of banks) if (b.offAt >= 0 && now > b.offAt) b.detach();
      if (opts.force) for (const n of NAMES) LV[n] = opts.force[n] || 0;
      for (const n of NAMES) {
        if (LV[n] < .004) LV[n] = 0; const v = LV[n] * TRIM[n], o = layers[n];
        if (v > 0) { zeroAt[n] = -1; attach(o); } else if (zeroAt[n] < 0) zeroAt[n] = first ? now - 99 : now; else if (now - zeroAt[n] > TAU[n] * 9 + .2) detach(o);
        if (first || (v !== last[n] && (v === 0 || Math.abs(v - last[n]) > .002))) { o.gain.setTargetAtTime(v, now, first ? .03 : TAU[n]); last[n] = v; }
      }
      roarBP.frequency.setTargetAtTime(300 + 800 * LV.roar, now, .3); roarLP.frequency.setTargetAtTime(300 + 500 * LV.roar, now, .3);
      descLP.frequency.setTargetAtTime(190 + 170 * LV.descent, now, .3);
      plBP.frequency.setTargetAtTime(450 + 1900 * heat, now, .3);
    }
    first = false;
  }
  const hush = () => { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(0, ctx.currentTime, .03); lastMaster = 0; };
  if (!opts.async) while (!step(1e9));   // offline / test use: finish the whole build before returning
  return { update, hush, step, layers, master, bus, ctx, buffers: B, get ready() { return ready; }, get maxSlice() { return maxSlice; }, get live() { return live; }, shots: SH };
}

// ---------- public wrapper (real-time) ----------
export function createAudio() {
  let A = null, enabled = false, silentSince = -1, resuming = false;
  const S = { t: 0, idx: 0, u: 0, playing: false, speed: 1, hidden: false, on: false };
  function pump() {   // finish the engine build in ~8 ms slices with a breather between them
    if (!A || A.eng.step(8)) return;
    A.pumpTimer = setTimeout(pump, 2);
  }
  function init() {
    if (A) return;
    const Ctx = window.AudioContext || window.webkitAudioContext, ctx = new Ctx({ latencyHint: 'interactive' });
    A = { ctx, eng: createAudioEngine(ctx, ctx.destination, { async: true, stage: S.idx }), timer: 0, pumpTimer: 0 };
    A.pumpTimer = setTimeout(pump, 0);   // first slice runs after the click handler has returned
    // rAF stops in background tabs, so silence immediately here instead of waiting for update({ hidden: true }).
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      A.eng.hush(); clearTimeout(A.timer);
      A.timer = setTimeout(() => { if (document.hidden && A.ctx.state === 'running') A.ctx.suspend().catch(() => { }); }, 2500);
    });
  }
  return {
    get enabled() { return enabled; },
    get engine() { return A && A.eng; },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) return;
      try { init(); if (A.ctx.state !== 'running') A.ctx.resume().catch(() => { }); silentSince = -1; } catch { enabled = false; }
    },
    update({ t, idx, u, playing, speed, hidden }) {
      S.t = t; S.idx = idx; S.u = u; S.playing = playing; S.speed = speed; S.hidden = hidden; S.on = enabled;
      if (!A) return;
      const { ctx, eng } = A;
      const want = enabled && playing && !hidden, wall = performance.now() / 1000;
      if (want) {
        silentSince = -1;
        if (ctx.state !== 'running' && !resuming) { resuming = true; ctx.resume().catch(() => { }).finally(() => { resuming = false; }); }
      } else if (silentSince < 0) silentSince = wall;
      else if (wall - silentSince > 3 && ctx.state === 'running') ctx.suspend().catch(() => { });
      eng.update(S, ctx.currentTime);
    }
  };
}
