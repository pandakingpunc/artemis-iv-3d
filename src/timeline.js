// Film-time anchors (seconds) shared by the choreography (app.js), audio, spacecraft and effects so every beat lines up.
// Owner: director. Other modules import these instead of hard-coding times. Pure data/math: no THREE, no DOM.
export const DURATION = 184;
export const STAGE_STARTS = [0, 20, 35, 55, 75, 92, 120, 136, 156, 171];

export const EVENTS = {
  ignition: 0,            // SLS engines/SRBs light (stage 0)
  srbSep: 11.7,           // booster separation motors fire (stage 0, u = .585); thrust tail-off starts 1 s earlier
  omsBurn: 28.7,          // Orion burn in Earth orbit (stage 1, u = .58)
  dockContact: 73.3,      // Orion docking ring touches the lander hatch (stage 3); latch flash + settle, docked hold until the cut at 75
  touchdown: 90.47,       // lander footpads touch the regolith (stage 4); legs compress, engine throttles down for ~.45 s
  liftoff: 120.3,         // ascent engine lights (stage 6)
  ascentDock: 135.2,      // lander meets Orion above the surface (stage 6); .5 s hold before the cut at 136
  smSep: 156.2,           // service module separation before entry (stage 8)
  chuteDeploy: 171.15,    // pilot/drogue mortar fires (stage 9); mains inflate over the next ~1.7 s
  splash: 176.46,         // capsule hits the water (stage 9, u = .42)
  chuteRelease: 176.98    // mains cut away after splashdown (stage 9, u = .46)
};

// ---------------------------------------------------------------- surface-science choreography (stage 4 tail + stage 5)
// World coordinates of the lander ladder (lander yaw .15 about Y; ladder on lander-local +Z). x,z of the standing spot at the
// base of the ladder, and of the top of the ladder (y is the platform height).
export const LANDER_YAW = .15;
export const LADDER = { baseX: .9, baseZ: 6.0, baseY: 0, topX: .5, topZ: 5.0, topY: 5.35, platX: .28, platZ: 3.2, platY: 5.45 };
// Moments when the surface props appear (they are unpacked/planted by the astronauts, not present from the cut).
export const PROPS = { flag: 99.2, duster: 104.8, spss: 107.8 };
export const FLAG_POS = [15, 16], SPSS_POS = [21, -9], DUSTER_POS = [-17, -12];

// Ground rows [t, x, z, face?]: at film time t the astronaut is at (x, z). Equal consecutive positions = standing (facing `face`).
const ROUTES = [
  [ // astronaut 1: ladder -> flag (plants it) -> SPSS (deploys it) -> back to the ladder
    [94.6, .9, 6.0], [98.9, 13.4, 14.4], [98.9, 13.4, 14.4, .785], [101.2, 13.4, 14.4, .785], [101.2, 13.4, 14.4], [107.5, 19.6, -7.4], [107.5, 19.6, -7.4, 2.42], [109.8, 19.6, -7.4, 2.42], [109.8, 19.6, -7.4], [116.4, .9, 6.0]
  ],
  [ // astronaut 2: ladder -> DUSTER site (unfolds it) -> follows it a little -> back to the ladder
    [96.0, 1.5, 6.2], [96.0, 1.5, 6.2, 2.9], [98.2, 1.5, 6.2, 2.9], [98.2, 1.5, 6.2], [104.6, -15.4, -9.6], [104.6, -15.4, -9.6, -2.4], [107.0, -15.4, -9.6, -2.4], [107.0, -15.4, -9.6], [109.5, -19.6, -6.6], [109.5, -19.6, -6.6, -2.2], [110.4, -19.6, -6.6, -2.2], [110.4, -19.6, -6.6], [117.3, 1.5, 6.2]
  ]
];
// Ladder legs: [t0, t1, direction (+1 down, -1 up), x offset]. Top of the ladder is where the platform meets it.
const LADDERS = [
  [[91.7, 94.6, 1, -.25], [116.4, 119.4, -1, -.25]],
  [[93.2, 96.0, 1, .25], [117.9, 120.0, -1, .25]]
];
const APPEAR = [91.0, 92.2], VANISH = [120.0, 120.0];

const TAU = Math.PI * 2, STEP = 2.5;
const angLerp = (a, b, k) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return a + d * k; };
const sstep = k => { k = k < 0 ? 0 : k > 1 ? 1 : k; return k * k * (3 - 2 * k); };

const segs = ROUTES.map(rows => {
  const out = []; let ph = 0, h = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1], dx = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dz), walk = len > .05;
    const N = walk ? Math.max(1, Math.round(len / STEP)) : 0, ph0 = ph, h0 = h;
    if (walk) h = Math.atan2(dx, dz); else if (a[3] != null) h = a[3];
    ph += N * Math.PI;
    out.push({ t0: a[0], t1: b[0], x0: a[1], z0: a[2], x1: b[1], z1: b[2], walk, ph0, N, h0, h });
  }
  return out;
});

// Pose of astronaut i (0|1) at film time t. out = { mode, x, z, h, phase, ladderK, scale }:
//  mode 0 hidden · 1 on the platform/ladder (ladderK 0 = top .. 1 = bottom; x,z,y are world, y above the lander's ground reference) · 2 on the ground.
//  phase is the lope phase (radians; each foot lands at multiples of PI), h the heading (rotation.y).
export function astronautAt(i, t, out) {
  out.mode = 0; out.scale = 1; out.y = LADDER.platY; out.ladderK = 0; out.phase = 0; out.h = 0; out.x = LADDER.platX; out.z = LADDER.platZ;
  if (t < APPEAR[i] || t >= VANISH[i]) return out;
  out.scale = sstep((t - APPEAR[i]) / .55);
  const L = LADDERS[i];
  for (let k = 0; k < 2; k++) {
    const [t0, t1, dir, ox] = L[k];
    if (t >= t0 && t < t1) {
      const s = (t - t0) / (t1 - t0), kk = dir > 0 ? s : 1 - s;
      out.mode = 1; out.ladderK = kk; out.h = Math.PI + LANDER_YAW; out.phase = kk * 6.4 * Math.PI;
      out.y = LADDER.topY + (LADDER.baseY - LADDER.topY) * kk; out.x = LADDER.topX + (LADDER.baseX - LADDER.topX) * kk + ox * Math.cos(LANDER_YAW); out.z = LADDER.topZ + (LADDER.baseZ - LADDER.topZ) * kk + .3;
      return out;
    }
  }
  if (t < L[0][0]) { out.mode = 1; out.ladderK = 0; out.y = LADDER.platY; out.h = Math.PI + LANDER_YAW; out.x = LADDER.platX; out.z = LADDER.platZ; return out; }   // waiting on the platform
  if (t >= L[1][1]) { out.mode = 1; out.ladderK = 0; out.y = LADDER.topY; out.h = Math.PI + LANDER_YAW; out.x = LADDER.topX; out.z = LADDER.topZ + .3; return out; }
  const S = segs[i];
    out.mode = 2;
  let s = S[0];
  if (t < S[0].t0) { out.x = S[0].x0; out.z = S[0].z0; out.h = Math.PI + LANDER_YAW; out.phase = 0; out.scale = 1; return out; }
  for (let k = 0; k < S.length; k++) if (t >= S[k].t0) s = S[k];
  const p = s.t1 > s.t0 ? Math.min(1, (t - s.t0) / (s.t1 - s.t0)) : 1;
  out.x = s.x0 + (s.x1 - s.x0) * p; out.z = s.z0 + (s.z1 - s.z0) * p;
  out.h = angLerp(s.h0, s.h, sstep((t - s.t0) / .6));
  out.phase = s.ph0 + (s.walk ? p * s.N * Math.PI : 0);
  return out;
}
