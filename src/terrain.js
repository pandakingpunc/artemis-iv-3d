// South-polar lunar terrain: power-law crater field (real mesh geometry, C1 crater profiles), soft rounded highland massifs on the horizon (slopes <= ~30 deg,
// superposed craters, no layering), GPU-baked clipmaps (sun shadows, cavity AO, fine-crater normals, ejecta, regolith grain, highland crater tile), boulders and boot prints.
// heights(x, z) is the single source of truth: the mesh vertices, rocks, props and the astronauts all sample it, so everything
// stands exactly on the rendered ground.
//
// Cost design: the fragment shader never evaluates crater/noise fields per pixel. Everything detailed is baked ONCE on the GPU at init
// (render-target passes, one shader compile each) into textures: a 192 m / 2048² detail clipmap (fine-crater gradients + ejecta + cavity AO
// + sun shadows through the real mesh heights), 512² mid/far shadow maps, a tiling 5 m grain/pebble texture and a tiling 512² tile of
// degraded superposed craters (sampled at three scales) for the highlands. Per pixel that is ~8 texture fetches instead of ~100 hash evaluations. If the GPU bake is unavailable the ground still
// renders (flat placeholders). Landing-pad / prop / astronaut-route keep-outs come from timeline.js so no crater is ever under a footpad.
import * as THREE from 'three';
import { makeRng } from './util.js';
import { NOISE_GLSL } from './sky.js';
import * as TL from './timeline.js';
const { EVENTS, STAGE_STARTS } = TL;

const T0 = performance.now();
export const initStats = {};                  // init timing in ms (module = crater/massif build at import, bake = height grids + GPU passes, mesh, total)
const R_CURV = 8000;                          // ground drops r²/R_CURV below the tangent plane (soft lunar curvature)
const MESH_R = 2200;                          // terrain disc radius (the far edge fades to black)
export const SUN_DIR = new THREE.Vector3(-180, 32, 100).normalize();   // surface-world sun (looks.js sunOffset)
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mixf = (a, b, t) => a + (b - a) * t;

// ---------- props, astronaut routes and the keep-out circles derived from them ----------
// The director's timeline.js owns the surface choreography (astronautAt(i, t, out) is pure, so the footfalls can be replayed here).
const YAW = TL.LANDER_YAW ?? .15, LAD = TL.LADDER ?? { baseX: .9, baseZ: 6 };
const FLAG = TL.FLAG_POS ?? [15, 16], SPSS = TL.SPSS_POS ?? [21, -9], DUSTER = TL.DUSTER_POS ?? [-17, -12];
const PROPS = [[FLAG[0], FLAG[1], 4], [SPSS[0], SPSS[1], 5.5], [DUSTER[0] - 3, DUSTER[1], 5.5]];   // flag, SPSS, DUSTER (x, z, keep-out radius)
const T_WALK0 = STAGE_STARTS[5] - 2, T_WALK1 = STAGE_STARTS[6] + 1;
// Replay both astronauts: corridor polylines (boulder / crater keep-out), footfalls (live boot prints) and standing spots (shuffled prints).
const ASTRO = (() => {
  const out = { lines: [[], []], steps: [], stands: [] };
  if (!TL.astronautAt) return out;
  const P = {};
  for (let i = 0; i < 2; i++) {
    let prev = null, kPrev = 0, stand = null;
    for (let t = T_WALK0; t <= T_WALK1; t += .02) {
      TL.astronautAt(i, t, P);
      if (P.mode !== 2) { prev = null; stand = null; continue; }
      const k = Math.floor(P.phase / Math.PI + 1e-4), L = out.lines[i];
      if (!L.length || Math.hypot(P.x - L.at(-1)[0], P.z - L.at(-1)[1]) > 1.2) L.push([P.x, P.z]);
      if (prev) {
        if (k > kPrev) out.steps.push({ t, x: P.x, z: P.z, h: P.h, foot: k & 1 });
        const still = Math.hypot(P.x - prev.x, P.z - prev.z) < 1e-4;
        if (still) { if (!stand) { stand = { t0: t, x: P.x, z: P.z, h: P.h }; } stand.t1 = t; } else { if (stand && stand.t1 - stand.t0 > .9) out.stands.push(stand); stand = null; }
      } else out.stands.push({ t0: t, t1: t + .15, x: P.x, z: P.z, h: P.h, first: true });
      prev = { x: P.x, z: P.z }; kPrev = k;
    }
    if (stand && stand.t1 - stand.t0 > .9) out.stands.push(stand);
  }
  return out;
})();
const TRAILS = { a1: ASTRO.lines[0], a2: ASTRO.lines[1] };
const distToTrails = (x, z) => {
  let m = 1e9;
  for (const t of Object.values(TRAILS)) for (let i = 0; i < t.length - 1; i++) {
    const [ax, az] = t[i], [bx, bz] = t[i + 1], dx = bx - ax, dz = bz - az, u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    m = Math.min(m, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return m;
};
// No crater (mesh or baked) may overlap these circles: props, the DUSTER's roll-out, both astronaut routes.
const KEEP_N = 96, KEEP_E = 48, KEEP = [];
{
  for (const [x, z, r] of PROPS) KEEP.push([x, z, r]);
  KEEP.push([DUSTER[0] - 6, DUSTER[1], 4.5], [DUSTER[0], DUSTER[1], 4.5]);
  for (const L of Object.values(TRAILS)) for (let i = 0; i < L.length - 1 && KEEP.length < KEEP_N; i++) {
    const d = Math.hypot(L[i + 1][0] - L[i][0], L[i + 1][1] - L[i][1]), n = Math.max(1, Math.round(d / 2.6));
    for (let k = 0; k < n && KEEP.length < KEEP_N; k++) KEEP.push([mixf(L[i][0], L[i + 1][0], k / n), mixf(L[i][1], L[i + 1][1], k / n), 2.2]);
  }
  while (KEEP.length < KEEP_N) KEEP.push([1e5, 1e5, 0]);
  KEEP.length = KEEP_N;
}
// Keep-out amplitude map (±48 m, 1 byte/texel): 0 on props / walking corridors, 1 elsewhere; sampled once per baked crater.
function keepTex() {
  const N = 192, c = 2 * KEEP_E / N, d = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -KEEP_E + (i + .5) * c, z = -KEEP_E + (j + .5) * c; let a = 1;
    for (const k of KEEP) { const dd = Math.hypot(x - k[0], z - k[1]) - k[2] - 1; if (dd < 3) a *= sstep(0, 3, dd); }
    d[j * N + i] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RedFormat); t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
const keepClear = (x, z, r) => { for (const k of KEEP) if (Math.hypot(x - k[0], z - k[1]) < k[2] + r * 1.2) return false; return true; };
// Lander footpads (landed pose, yaw LANDER_YAW, pad ring radius 5.75, octagonal pads r~.9) and the ladder foot: contact AO + disturbed dust in the shader.
const PADS = [0, 1, 2, 3].map(i => { const a = i * Math.PI / 2 + Math.PI / 4 + YAW; return [5.75 * Math.cos(a), -5.75 * Math.sin(a), .9]; });
PADS.push([LAD.baseX, LAD.baseZ, .5]);

// ---------- deterministic value noise for the height field ----------
const ih = (x, y, s) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1274126177); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function vn(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = ih(ix, iy, s), b = ih(ix + 1, iy, s), c = ih(ix, iy + 1, s), d = ih(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, s, o) { let a = .5, t = 0, n = 0; for (let i = 0; i < o; i++) { t += a * vn(x, y, s + i * 7); n += a; x = x * 2.03 + 17.3; y = y * 2.03 + 9.1; a *= .5; } return t / n; }
// Smooth ridged noise: the crest is rounded (no knife-edge crease), so coarse mesh sampling cannot saw-tooth the skyline.
const ridge = (x, y, s, o) => { let a = .5, t = 0, n = 0; for (let i = 0; i < o; i++) { const q = 2 * vn(x, y, s + i * 5) - 1, r = Math.max(0, 1 - Math.sqrt(q * q + .035)) / .81; t += a * r * r; n += a; x = x * 2.1 + 11.7; y = y * 2.1 + 3.3; a *= .5; } return t / n; };

// ---------- crater population: N(>r) ∝ r^-b, many small fresh sharp craters, few big degraded ones ----------
const CELL = 64, OFF = 2560, GN = 80, grid = new Array(GN * GN), craters = [];
function addCrater(x, z, r, age, rnd) {
  const big = Math.min(1, Math.max(0, (r - 30) / 60)), wo = mixf(.3, .62, age), th = rnd() * 3.1416;
  const c = {
    x, z, r, age, fresh: (1 - age) * (1 - age), wo, wr: mixf(.07, .3, age), cx: big, e: r < 14 ? mixf(.7, 1, rnd()) : mixf(.86, 1, rnd()), ct: Math.cos(th), st: Math.sin(th),
    fl: mixf(0, .36, big) + (r > 2.5 ? rnd() * .14 : 0),
    depth: r * mixf(.3, .1, age) * mixf(1, .55, big), rim: r * mixf(.075, .03, age), lobe: r > 5 ? mixf(.4, .12, age) : 0, ph: x * .37 + z * .11,
    peak: r > 70 && (Math.abs(x * 7 + z) % 3 < 1.8) ? r * .045 : 0, reach: 2.6, sc: sstep(8, 22, Math.hypot(x, z))
  };
  c.reach2 = (c.reach * r) ** 2; craters.push(c);
  const rad = c.reach * r, i0 = Math.max(0, Math.floor((x - rad + OFF) / CELL)), i1 = Math.min(GN - 1, Math.floor((x + rad + OFF) / CELL));
  const j0 = Math.max(0, Math.floor((z - rad + OFF) / CELL)), j1 = Math.min(GN - 1, Math.floor((z + rad + OFF) / CELL));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (grid[j * GN + i] ||= []).push(c);
}
{
  const rnd = makeRng(60611);
  const layer = (n, rmin, rmax, ext, b, keep, ageFn, clus = .1, fade = 1e9) => {
    for (let i = 0; i < n; i++) {
      const r = rmin * Math.pow(1 - rnd() * (1 - Math.pow(rmin / rmax, b)), -1 / b), age = ageFn(rnd());
      for (let t = 0; t < 14; t++) {
        const a = rnd() * 6.2832, d = ext * Math.sqrt(rnd()), x = Math.cos(a) * d, z = Math.sin(a) * d;
        if (d - r * 1.7 < keep) continue;           // keep the landing zone, props and the astronaut walks clear
        if (!keepClear(x, z, r * 1.7)) continue;
        if (d > fade && rnd() < sstep(fade, ext, d) * .75) continue;      // thin out toward the edge so the clipmap radius never reads as a ring
        if (rnd() > Math.min(1, Math.max(clus, (fbm(x * .006 + 3, z * .006 + 7, 91, 3) - .27) * 3.2))) continue;   // clustered fields and smooth plains
        addCrater(x, z, r, age, rnd); break;
      }
    }
  };
  layer(1000, 1.35, 4, 200, 2.3, 9, u => .08 + .92 * Math.pow(u, .8), .35, 100);   // near field: real geometry, resolved by the .5 m mesh
  layer(1500, 2.6, 10, 400, 2, 16, u => Math.pow(u, .75));
  layer(150, 9, 40, 850, 1.9, 36, u => .1 + .9 * Math.pow(u, .9));
  layer(30, 38, 170, 1300, 1.5, 70, u => .55 + .45 * u);
}

// ---------- polar highlands: rounded, regolith-draped massifs ----------
// Lunar highland relief is soft: slopes stay below ~30 deg, ridges are rounded and cratered, there is no layering. Each massif is a compound of
// elliptical domes ((1-rho^2)^p profile, relief ratio H/a <= ~.26, so the steepest flank is ~22 deg), merged with a smooth max so saddles stay
// rounded; broad noise octaves whose amplitude scales with wavelength (<= ~7 deg each) add rolling relief. Domes near the sun's azimuth stay low
// (they must not shade the pad) and the sector around Earth stays open (Earth hangs over the horizon, never in front of a hill).
const SUN_AZ = Math.atan2(SUN_DIR.z, SUN_DIR.x), EARTH_AZ = Math.atan2(-360, -170);
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 6.2832; while (d < -Math.PI) d += 6.2832; return Math.abs(d); };
const azMask = th => { const e = angDiff(th, EARTH_AZ), s = angDiff(th, SUN_AZ); return (1 - .93 * Math.exp(-((e / .36) ** 2))) * (.36 + .64 * sstep(.45, 1.15, s)); };
const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * .25; };
const massifs = [];
{
  const mr = makeRng(7714);
  // th: azimuth, a: half-width along the horizon, br: depth ratio (radial half-width / a), front: distance of the near foot from the pad, k: relief ratio H / radial half-width
  const dome = (th, a, br, front, k) => {
    const b = a * br, D = front + b, rot = th + Math.PI / 2 + (mr() - .5) * .9, H = b * k * azMask(th);
    massifs.push({ x: Math.cos(th) * D, z: Math.sin(th) * D, H, ia: 1 / a, ib: 1 / b, c: Math.cos(rot), s: Math.sin(rot), p: 1.9 + .5 * mr(), R2: a > b ? a * a : b * b });
  };
  const ring = (n, f) => { for (let i = 0; i < n; i++) f(-Math.PI + (i + mr()) * (6.2832 / n)); };
  ring(24, th => dome(th, 240 + mr() * 280, .6 + .4 * mr(), 500 + mr() * 800, .14 + .1 * mr()));
  ring(12, th => dome(th, 600 + mr() * 400, .6 + .3 * mr(), 480 + mr() * 800, .2 + .07 * mr()));
  ring(12, th => dome(th, 1000 + mr() * 500, .55 + .25 * mr(), 1000 + mr() * 500, .23 + .07 * mr()));
  // principal massifs: broad, rounded, flank slope up to ~30 deg, one in most directions so the horizon has depth
  for (const az of [-165, -84, -32, 28, 84, 128]) dome(az * Math.PI / 180 + (mr() - .5) * .2, 900 + mr() * 260, .5 + .12 * mr(), 420 + mr() * 200, .31 + .05 * mr());
}

// ---------- superposed craters on the highlands: radii the mesh can resolve (smaller ones come from the baked highland tile in the shader) ----------
{
  const rnd = makeRng(33190), spacing = d => .5 + Math.max(0, d - 30) * .011;
  for (let i = 0, got = 0; got < 900 && i < 12000; i++) {
    const a = rnd() * 6.2832, d = 340 + 1780 * Math.sqrt(rnd()), x = Math.cos(a) * d, z = Math.sin(a) * d;
    const rmin = Math.max(16, 2.7 * spacing(d)), rmax = 260, r = rmin * Math.pow(1 - rnd() * (1 - Math.pow(rmin / rmax, 1.5)), -1 / 1.5);
    if (d - r * 1.5 < 300 || rnd() > Math.min(1, .35 + (fbm(x * .004 + 5, z * .004 + 2, 77, 3) - .3) * 3)) continue;
    addCrater(x, z, r, .8 + .2 * rnd(), rnd); got++;
  }
}

initStats.module = performance.now() - T0;
let lastBright = 0;       // crater-freshness side output of the last heights() call (used for vertex colouring)
// Terrain height at (x, z). The landing site around the origin (r<15) is flat at y≈0; gentle slopes at r 12–25 where the props stand.
export function heights(x, z) {
  const r2 = x * x + z * z, r = Math.sqrt(r2);
  let h = -r2 / R_CURV * sstep(6, 60, r), br = 0;
  const w = sstep(10, 52, r);
  if (w > 0) h += w * ((fbm(x * .011, z * .011, 3, 3) - .5) * 5.2 + (fbm(x * .0026, z * .0026, 7, 3) - .5) * 30 * sstep(60, 400, r));
  const list = grid[(((z + OFF) / CELL) | 0) * GN + (((x + OFF) / CELL) | 0)];
  if (list && r > 8) {
    for (let k = 0; k < list.length; k++) {
      const c = list[k], dx = x - c.x, dz = z - c.z, d2 = dx * dx + dz * dz;
      if (d2 > c.reach2) continue;
      const ur = dx * c.ct + dz * c.st, vr = (-dx * c.st + dz * c.ct) / c.e, d = Math.sqrt(ur * ur + vr * vr) / c.r;
      if (d > 2.6) continue;
      // C1 profile: smooth bowl (flat floor for big ones) + rim bump (gaussian inside, lorentzian ejecta outside) that meet with zero slope at d=1
      const t = d <= c.fl ? 0 : Math.min(1, (d - c.fl) / (1.12 - c.fl)), s = t * t * (3 - 2 * t);
      let v = d < 1.12 ? -c.depth * Math.pow(1 - s, 1.35) : 0, rim = c.rim;
      if (c.lobe && d < 2.2) rim *= 1 + c.lobe * Math.cos(3 * Math.atan2(vr, ur) + c.ph);
      if (d < 1) { const e = (d - 1) / c.wr; v += rim * Math.exp(-e * e); } else { const q = (d - 1) / c.wo; v += rim * Math.pow(1 + q * q, -1.5); }
      if (c.peak) v += c.peak * Math.exp(-(d / .13) * (d / .13));
      h += v * (1 - sstep(1.7, 2.6, d)) * c.sc;
      br += c.fresh * (d < 1 ? .35 + .65 * d * d : Math.exp(-(d - 1) * 1.1)) * c.sc;
    }
  }
  {
    const mk = r > 300 ? sstep(300, 640, r) * (1 - sstep(1700, 2200, r)) : 0;
    if (mk > 0) {
      const wx = (vn(x * .0022, z * .0022, 21) - .5) * 70, wz = (vn(x * .0022 + 7, z * .0022 + 3, 22) - .5) * 70;
      let mh = 0;
      for (let k = 0; k < massifs.length; k++) {
        const m = massifs[k], dx = x + wx - m.x, dz = z + wz - m.z;
        if (dx * dx + dz * dz > m.R2) continue;
        const u = (dx * m.c + dz * m.s) * m.ia, v = (-dx * m.s + dz * m.c) * m.ib, q = u * u + v * v;
        if (q < 1) mh = smax(mh, m.H * Math.pow(1 - q, m.p), 16);
      }
      const am = azMask(Math.atan2(z, x));
      h += mk * (mh + am * ((fbm(x * .0018, z * .0018, 31, 2) - .5) * 60 + (fbm(x * .0046, z * .0046, 33, 2) - .5) * 16 + (fbm(x * .0105, z * .0105, 35, 2) - .5) * 4.5 * (1 - sstep(900, 1500, r))));
    }
  }
  lastBright = br > 1 ? 1 : br;
  return h;
}

// ---------- GPU bake: height grids -> sun shadows / cavity AO / detail clipmap / tiling textures ----------
const GRID = { N: { E: 96, N: 384 }, M: { E: 320, N: 256 }, F: { E: 2000, N: 256 } };   // coarse height grids (half-float textures)
const DET_E = GRID.N.E, DET_N = 2048;                                                    // detail clipmap: 192 m, 9.4 cm / texel
const SM_N = 512;                                                                         // mid / far shadow maps
function heightTex(g) {
  const { E, N } = g, c = 2 * E / N, u = new Uint16Array(N * N), toH = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) u[j * N + i] = toH(heights(-E + (i + .5) * c, -E + (j + .5) * c));
  const t = new THREE.DataTexture(u, N, N, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
const BAKE_VS = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
// P1: detail height field = coarse mesh height (bilinear) + fine craters; gradients/ejecta only for the fine part.
const BAKE_DETAIL_FS = /* glsl */`
varying vec2 vUv; uniform sampler2D tN, tK; uniform float uE; uniform int uNT;
${NOISE_GLSL}
float keepAmp(vec2 c,float rad){ return smoothstep(6.+rad,10.+rad*1.2,length(c))*texture2D(tK,c/${(2 * KEEP_E).toFixed(1)}+.5).r; }
// one crater: acc += (dH/dx, dH/dz, H, freshness). Same C1 profile as the CPU mesh craters (bowl + gaussian/lorentzian rim).
void addC(vec2 p,vec2 c,float rad,float age,float e,float th,float fl,float lobe,float ph,inout vec4 acc){
  vec2 q=p-c; float ct=cos(th),st=sin(th);
  vec2 qr=vec2(ct*q.x+st*q.y,(-st*q.x+ct*q.y)/e);
  float l=length(qr),d=l/rad; if(d>2.6) return;
  float amp=keepAmp(c,rad); if(amp<=.001) return;
  float depth=rad*(.3-.2*age)*amp, rim=rad*(.075-.05*age)*amp, wr=mix(.07,.3,age), wo=mix(.3,.62,age);
  float t=clamp((d-fl)/(1.12-fl),0.,1.), s=t*t*(3.-2.*t), ds=6.*t*(1.-t)/(1.12-fl);
  float hb=-depth*pow(1.-s,1.35), dhb=depth*1.35*pow(max(1.-s,1e-3),.35)*ds;
  vec2 dir=qr/max(l,1e-5); float ang=atan(dir.y,dir.x);
  float rimH=rim*(1.+lobe*cos(3.*ang+ph));
  float hr,dhr;
  if(d<1.){ float x=(d-1.)/wr, g=exp(-x*x); hr=rimH*g; dhr=-2.*x/wr*rimH*g; }
  else { float x=(d-1.)/wo, q2=1.+x*x; hr=rimH*pow(q2,-1.5); dhr=-3.*x/wo*rimH*pow(q2,-2.5); }
  float win=1.-smoothstep(1.7,2.6,d);
  float dh=(dhb+dhr)*win/rad;
  vec2 ge=dh*dir; ge.y/=e;
  vec2 g=vec2(ct*ge.x-st*ge.y,st*ge.x+ct*ge.y);
  float fr=(1.-age)*(1.-age)*amp*(d<1.?.8*smoothstep(.35,1.,d):exp(-(d-1.)*1.7));
  float rays=pow(.5+.5*cos(9.*ang+ph*5.+3.*sin(ang*4.+ph)),3.)*exp(-(d-1.)*.9)*step(1.,d)*(1.-smoothstep(1.4,2.4,d));
  fr+=(1.-age)*(1.-age)*amp*.35*rays*(1.-smoothstep(.0,.3,age-.1));
  acc+=vec4(g,(hb+hr)*win,fr);
}
// All three crater layers and the secondary chains run through ONE loop with ONE addC call site (compile time).
void main(){
  vec2 P=(vUv-.5)*2.*uE; vec4 acc=vec4(0.);
  for(int q=0;q<uNT;q++){
    vec2 c=vec2(0.); float rad=0., age=0., e=1., th=0., fl=0., lobe=0., ph=0.; bool ok=false;
    if(q<54){
      int l=q/18, r=q-l*18, i=r%3-1, j=(r/3)%3-1, k=r/9;
      float cell=l==0?3.4:(l==1?1.8:1.), seed=float(l+1), rmin=l==0?.5:(l==1?.26:.15), rmax=l==0?1.4:(l==1?.75:.42), prob=l==0?.42:(l==1?.4:.3);
      vec2 id=floor(P/cell)+vec2(float(i),float(j));
      float s=seed+float(k)*13.7;
      vec4 h=vec4(hash12(id*1.13+s),hash12(id*.71+s+5.2),hash12(id*1.91+s+11.7),hash12(id*.53+s+23.1));
      c=(id+.12+.76*hash22(id+s*1.7))*cell;
      ok=h.x<=prob && hash12(id*7.7+s+2.)<=smoothstep(5.,26.,length(c));      // density grows gradually away from the landing pad
      rad=rmin+(rmax-rmin)*pow(h.y,2.4); age=clamp(pow(h.z,.8),0.,1.);
      e=mix(.68,1.,hash12(id*2.3+s)); th=hash12(id*3.1+s+1.3)*3.1416; fl=.4*smoothstep(.6,1.,h.w); lobe=rad>.9?.35*(1.-age):0.; ph=h.w*6.2;
    } else {
      int r=q-54, i=r%3-1, j=(r/3)%3-1, n=r/9;
      vec2 id=floor(P/15.)+vec2(float(i),float(j));
      vec3 h=vec3(hash12(id*1.7+41.),hash12(id*.9+43.),hash12(id*2.1+47.));
      vec2 c0=(id+.1+.8*hash22(id+3.3))*15.; float a=h.y*6.2832, fn=float(n);
      c=c0+vec2(cos(a),sin(a))*(fn*(.75+.5*h.z))+(hash22(id+fn)-.5)*.3;
      ok=h.x<=.2; rad=.2+.16*hash12(id+fn*1.7+4.); age=.25+.4*hash12(id+fn*.37); e=.8+.2*hash12(id+fn*2.9); th=a; ph=1.;
    }
    if(ok) addC(P,c,rad,age,e,th,fl,lobe,ph,acc);
  }
  gl_FragColor=vec4(texture2D(tN,vUv).r+acc.z,acc.x,acc.y,acc.w);
}`;
// P2a: detail clipmap RGBA8 = (gradX, gradZ, freshness, cavity AO)
const BAKE_DETAILG_FS = /* glsl */`
varying vec2 vUv; uniform sampler2D tH; uniform float uE;
void main(){
  vec4 hd=texture2D(tH,vUv); float h0=hd.x, s1=0., s2=0., k=1./(2.*uE);
  for(int a=0;a<8;a++){ float an=float(a)*.785398; vec2 o=vec2(cos(an),sin(an))*k; s1+=texture2D(tH,vUv+o*.25).x; s2+=texture2D(tH,vUv+o*.9).x; }
  float cav=1.1*max(0.,s1/8.-h0)/.25*.5+.9*max(0.,s2/8.-h0)/.9;
  gl_FragColor=vec4(.5+.5*clamp(hd.y,-1.,1.),.5+.5*clamp(hd.z,-1.,1.),clamp(hd.w,0.,1.),1.-min(.62,cav*.55));
}`;
// P2b: sun shadow (+ cavity AO for the coarse maps). Marches toward the sun; detail mode reads the clipmap for the first ~14 m and the coarse grids beyond.
const BAKE_SHADOW_FS = /* glsl */`
varying vec2 vUv; uniform sampler2D tH,tN,tM,tF; uniform float uE,uN,uDet,uD0,uRatio,uCavR1,uCavR2; uniform int uSteps; uniform vec3 uSun;
float Hc(vec2 p){
  float m=max(abs(p.x),abs(p.y)), h=-1e5;
  if(m<${(GRID.F.E - 1).toFixed(1)}) h=textureLod(tF,p/${(2 * GRID.F.E).toFixed(1)}+.5,0.).r;
  if(m<${(GRID.M.E - 1).toFixed(1)}) h=textureLod(tM,p/${(2 * GRID.M.E).toFixed(1)}+.5,0.).r;
  if(m<${(GRID.N.E - 1).toFixed(1)}) h=textureLod(tN,p/${(2 * GRID.N.E).toFixed(1)}+.5,0.).r;
  return h;
}
float Hs(vec2 p,float d){
  float m=max(abs(p.x),abs(p.y));
  float h;
  if(uDet>.5&&d<14.&&m<uE-1.) h=textureLod(tH,p/(2.*uE)+.5,0.).x; else h=Hc(p);
  return h;
}
void main(){
  vec2 P=(vUv-.5)*2.*uE; float c=2.*uE/uN;
  float h0=uDet>.5?texture2D(tH,vUv).x:Hc(P);
  float vis=1., d=uD0;
  for(int k=0;k<200;k++){
    if(k>=uSteps) break;
    float hs=Hs(P+uSun.xy*d,d); if(hs<-1e4) break;
    float o=(hs-h0-uSun.z*d)/(.022*d+.12*c);
    vis=min(vis,o>=1.?0.:(o<=-1.?1.:.5-.5*o));
    if(vis<.004) break;
    d*=(d<14.&&uDet>.5)?uRatio*1.04:uRatio;
  }
  float cav=0.;
  if(uDet<.5){
    for(int r=0;r<2;r++){ float R=r==0?uCavR1:uCavR2, w=r==0?1.7:1.1, s=0.;
      for(int a=0;a<8;a++){ float an=float(a)*.785398; float hh=Hc(P+vec2(cos(an),sin(an))*R); s+=hh<-1e4?h0:hh; }
      cav+=w*max(0.,s/8.-h0)/R; }
  }
  gl_FragColor=vec4(vis,1.-min(.7,cav),0.,1.);
}`;
// Tiling regolith micro texture (period = 1 uv): pebbles / clods / grain. RG = height gradient, B = albedo variation, A = pebble AO.
const NOISE_PERIODIC = /* glsl */`
float pn(vec2 p,float per){ vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f); vec2 a=mod(i,per),b=mod(i+1.,per);
  return mix(mix(hash12(a),hash12(vec2(b.x,a.y)),u.x),mix(hash12(vec2(a.x,b.y)),hash12(b),u.x),u.y); }`;
const BAKE_MICRO_FS = /* glsl */`
varying vec2 vUv; uniform int uN9; ${NOISE_GLSL} ${NOISE_PERIODIC}
const float TILE=5.12;
// returns (height in metres, albedo variation)
vec2 field(vec2 p){
  float h=0., alb=0.;
  float N=32.; vec2 ip=floor(p*N);
  for(int q=0;q<uN9;q++){
    int i=q%3-1, j=q/3-1;
    vec2 id=mod(ip+vec2(float(i),float(j)),N);
    float a=hash12(id+3.1), b=hash12(id*1.7+9.4); if(a>.42) continue;
    vec2 c=(ip+vec2(float(i),float(j))+.15+.7*hash22(id+5.7))/N;
    float rad=(.012+.034*b*b*b)*(.5+.5*a*2.);       // 1.2 .. 4.6 cm
    vec2 dq=(p-c); dq-=floor(dq+.5); float d=length(dq*TILE)/rad;
    float m=1.-smoothstep(.72,1.,d);
    h+=m*rad*.4*sqrt(max(1.-d*d*.8,0.)); alb+=m*(hash12(id+8.8)-.5)*.9;
  }
  vec2 g1=vec2(pn(p*96.,96.),pn(p*96.+31.,96.)), g2=vec2(pn(p*210.+7.,210.),0.);
  h+=(g1.x-.5)*.006+(g2.x-.5)*.0022+(pn(p*24.+5.,24.)-.5)*.011;
  alb+=(g1.y-.5)*.35+(pn(p*40.+11.,40.)-.5)*.3;
  return vec2(h,alb);
}
void main(){
  vec2 p=vUv; float e=1./512.;
  vec2 fv[3];
  for(int s=0;s<3;s++) fv[s]=field(p+(s==1?vec2(e,0.):(s==2?vec2(0.,e):vec2(0.))));
  vec2 f0=fv[0], fx=fv[1], fy=fv[2];
  vec2 g=vec2(fx.x-f0.x,fy.x-f0.x)/(e*TILE);
  gl_FragColor=vec4(.5+.5*clamp(g/1.2,-1.,1.),clamp(.5+f0.y*.5,0.,1.),1.-.5*clamp((fx.x+fy.x)*.5-f0.x,0.,.03)/.03);
}`;
// Tiling highland tile (period = 1 uv): a periodic power-law field of degraded, superposed craters of all sizes (5 octaves, 4..64 cells per tile),
// same C1 bowl + rim profile as the mesh craters. RG = slope (d/du, d/dv; 1 = GMAX encoded), B = freshness (bright young rims), A = cavity AO.
// Heights are in uv units too, so the slopes are dimensionless and valid at any world scale of the tile.
const GMAX = .7;
const BAKE_HIGH_FS = /* glsl */`
varying vec2 vUv; ${NOISE_GLSL}
void crat(vec2 q,float rad,float age,float e,float th,float fl,inout vec4 acc){
  float ct=cos(th),st=sin(th);
  vec2 qr=vec2(ct*q.x+st*q.y,(-st*q.x+ct*q.y)/e);
  float l=length(qr),d=l/rad; if(d>2.6) return;
  float depth=rad*(.3-.2*age), rim=rad*(.075-.05*age), wr=mix(.07,.3,age), wo=mix(.3,.62,age);
  float t=clamp((d-fl)/(1.12-fl),0.,1.), s=t*t*(3.-2.*t), ds=6.*t*(1.-t)/(1.12-fl);
  float hb=-depth*pow(1.-s,1.35), dhb=depth*1.35*pow(max(1.-s,1e-3),.35)*ds;
  float hr,dhr;
  if(d<1.){ float x=(d-1.)/wr, g=exp(-x*x); hr=rim*g; dhr=-2.*x/wr*rim*g; }
  else { float x=(d-1.)/wo, q2=1.+x*x; hr=rim*pow(q2,-1.5); dhr=-3.*x/wo*rim*pow(q2,-2.5); }
  float win=1.-smoothstep(1.7,2.6,d);
  float dh=(dhb+dhr)*win/rad;
  vec2 dir=qr/max(l,1e-5), ge=dh*dir; ge.y/=e;
  vec2 g=vec2(ct*ge.x-st*ge.y,st*ge.x+ct*ge.y);
  float fr=(1.-age)*(1.-age)*(d<1.?smoothstep(.35,1.,d):exp(-(d-1.)*1.7));
  acc+=vec4(g,max(-hb*win/rad,0.),fr);
}
void main(){
  vec2 p=vUv; vec4 acc=vec4(0.);
  for(int q=0;q<45;q++){
    int l=q/9, k=q-l*9, i=k%3-1, j=k/3-1;
    float N=exp2(float(l)+2.), cell=1./N, s=float(l)*17.3+3.;
    vec2 id0=floor(p*N)+vec2(float(i),float(j)), idw=mod(id0,N);
    vec4 h=vec4(hash12(idw*1.13+s),hash12(idw*.71+s+5.2),hash12(idw*1.91+s+11.7),hash12(idw*.53+s+23.1));
    if(h.x>.82) continue;
    vec2 c=(id0+.18+.64*hash22(idw+s*1.7))/N, dq=p-c; dq-=floor(dq+.5);
    float rad=cell*(.1+.3*pow(h.y,1.7)), age=mix(.5,1.,pow(h.z,.6)), e=mix(.78,1.,h.w), th=hash12(idw*3.1+s+1.3)*3.1416, fl=.4*smoothstep(.62,1.,h.w);
    crat(dq,rad,age,e,th,fl,acc);
  }
  gl_FragColor=vec4(.5+.5*clamp(acc.xy/${GMAX.toFixed(2)},-1.,1.),.5+.5*clamp(acc.w*.9,0.,1.),1.-min(.5,acc.z*1.6));
}`;

function bakeTextures(renderer) {
  const tb = performance.now();
  const flat = (r, g, b, a) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; };
  const out = { detG: flat(128, 128, 0, 255), detS: flat(255, 255, 255, 255), shM: flat(255, 255, 255, 255), shF: flat(255, 255, 255, 255), micro: flat(128, 128, 128, 255), high: flat(128, 128, 128, 255), baked: false };
  if (!renderer || !(renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'))) return out;
  const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, tmp = [];
  try {
    const hN = heightTex(GRID.N), hM = heightTex(GRID.M), hF = heightTex(GRID.F); tmp.push(hN, hM, hF);
    initStats.heightTex = performance.now() - tb;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quad.frustumCulled = false; scene.add(quad); renderer.autoClear = false;
    const mats = [];
    const run = (fs, uniforms, rt) => {
      const m = new THREE.ShaderMaterial({ vertexShader: BAKE_VS, fragmentShader: fs, uniforms: { uNT: { value: 108 }, uN9: { value: 9 }, uO6: { value: 6 }, ...uniforms }, depthTest: false, depthWrite: false, toneMapped: false }); mats.push(m);
      quad.material = m; renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, cam);
    };
    const mkRT = (n, o = {}) => new THREE.WebGLRenderTarget(n, n, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, format: THREE.RGBAFormat, type: THREE.UnsignedByteType, ...o });
    const tK = keepTex();
    const hl = Math.hypot(SUN_DIR.x, SUN_DIR.z), sun = new THREE.Vector3(SUN_DIR.x / hl, SUN_DIR.z / hl, SUN_DIR.y / hl);
    const grids = { tN: { value: hN }, tM: { value: hM }, tF: { value: hF } };
    // detail clipmap
    const rtH = mkRT(DET_N, { type: THREE.HalfFloatType }); tmp.push(rtH);
    run(BAKE_DETAIL_FS, { tN: { value: hN }, uE: { value: DET_E }, tK: { value: tK } }, rtH);
    const detG = mkRT(DET_N, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, anisotropy: 8 });
    run(BAKE_DETAILG_FS, { tH: { value: rtH.texture }, uE: { value: DET_E } }, detG);
    const detS = mkRT(DET_N, { format: THREE.RedFormat });
    run(BAKE_SHADOW_FS, { ...grids, tH: { value: rtH.texture }, uE: { value: DET_E }, uN: { value: DET_N }, uDet: { value: 1 }, uD0: { value: .1 }, uRatio: { value: 1.15 }, uCavR1: { value: 1 }, uCavR2: { value: 1 }, uSteps: { value: 64 }, uSun: { value: sun } }, detS);
    // coarse shadow maps
    const shM = mkRT(SM_N, { format: THREE.RGFormat });
    run(BAKE_SHADOW_FS, { ...grids, tH: { value: rtH.texture }, uE: { value: GRID.M.E }, uN: { value: SM_N }, uDet: { value: 0 }, uD0: { value: .6 }, uRatio: { value: 1.1 }, uCavR1: { value: 3 }, uCavR2: { value: 12 }, uSteps: { value: 72 }, uSun: { value: sun } }, shM);
    const shF = mkRT(SM_N, { format: THREE.RGFormat });
    run(BAKE_SHADOW_FS, { ...grids, tH: { value: rtH.texture }, uE: { value: GRID.F.E }, uN: { value: SM_N }, uDet: { value: 0 }, uD0: { value: 5 }, uRatio: { value: 1.11 }, uCavR1: { value: 20 }, uCavR2: { value: 60 }, uSteps: { value: 64 }, uSun: { value: sun } }, shF);
    // tiling textures
    const tile = fs => { const rt = mkRT(512, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: 8 }); run(fs, {}, rt); return rt; };
    const micro = tile(BAKE_MICRO_FS), high = tile(BAKE_HIGH_FS);
    renderer.setRenderTarget(prevRT); renderer.autoClear = prevAuto;
    Object.assign(out, { detG: detG.texture, detS: detS.texture, shM: shM.texture, shF: shF.texture, micro: micro.texture, high: high.texture, baked: true });
    mats.forEach(m => m.dispose()); quad.geometry.dispose(); tmp.forEach(t => t.dispose());
  } catch (e) {
    renderer.setRenderTarget(prevRT); renderer.autoClear = prevAuto; out.baked = false;
  }
  initStats.bake = performance.now() - tb;
  return out;
}

// ---------- shared shading patch: Lommel-Seeliger-like regolith response, baked sun shadow + cavity AO, tiny specular ----------
const U = {
  uShM: { value: null }, uShF: { value: null }, uDetS: { value: null }, uDetG: { value: null }, uMicro: { value: null }, uHigh: { value: null },
  uSunW: { value: SUN_DIR.clone() }, uBlast: { value: 0 }, uQ: { value: 1 }, uIdx: { value: 0 }, uU: { value: 0 }, uPadK: { value: 0 },
  uPads: { value: PADS.map(p => new THREE.Vector4(p[0], p[1], p[2], 0)) }
};
const LUNAR_PARS = /* glsl */`
uniform sampler2D uShM, uShF, uDetS, uDetG, uMicro, uHigh; uniform vec3 uSunW; uniform float uBlast, uQ, uIdx, uU, uPadK; uniform vec4 uPads[${PADS.length}];
varying vec3 vWP; varying float vBright, vVar, vRelY;
float tSh=1., tAO=1., tFill=0.;
// sun shadow + coarse cavity AO from the clipmaps: far (±2000 m) -> mid (±320 m) -> detail (±96 m, shadow only)
vec2 bakedSample(vec2 p){
  vec2 f=texture2D(uShF,p/${(2 * GRID.F.E).toFixed(1)}+.5).rg;
  float m=max(abs(p.x),abs(p.y));
  float wM=1.-smoothstep(${(GRID.M.E * .72).toFixed(1)},${(GRID.M.E * .98).toFixed(1)},m);
  vec2 s=mix(f,texture2D(uShM,p/${(2 * GRID.M.E).toFixed(1)}+.5).rg,wM);
  float wD=1.-smoothstep(${(DET_E * .8).toFixed(1)},${(DET_E * .98).toFixed(1)},m);
  s.x=mix(s.x,texture2D(uDetS,p/${(2 * DET_E).toFixed(1)}+.5).r,wD);
  return s;
}
float lunarLS(float nl,float nv){return nl*2./(nl+nv+.32);}
`;
function lunarize(material, kind, extra) {
  material.customProgramCacheKey = () => 'lunar2-' + kind;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, U, extra?.uniforms);
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    vs = vs.replace('#include <common>', `#include <common>
varying vec3 vWP; varying float vBright, vVar, vRelY; ${kind === 'ground' ? 'attribute float aBright;' : ''} ${kind === 'rock' ? 'attribute float aVar;' : ''} ${kind === 'print' ? 'attribute float aT; uniform float uIdx, uU;' : ''}`);
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>
{ vec4 lw=vec4(transformed,1.);
#ifdef USE_INSTANCING
lw=instanceMatrix*lw;
#endif
vWP=(modelMatrix*lw).xyz; vBright=0.; vVar=0.; vRelY=0.;
${kind === 'ground' ? 'vBright=aBright;' : ''}
${kind === 'rock' ? 'vVar=aVar; vec4 ic=modelMatrix*instanceMatrix*vec4(0.,0.,0.,1.); vRelY=(vWP.y-ic.y)/length(instanceMatrix[1].xyz);' : ''}
${kind === 'print' ? 'vVar=(uIdx>4.5)?((uIdx>5.5)?1.:step(aT,uU)):0.; if(vVar<.5) gl_Position=vec4(2.,2.,2.,1.);' : ''} }`);
    fs = fs.replace('#include <common>', '#include <common>\n' + NOISE_GLSL + LUNAR_PARS + (extra?.pars || ''));
    // Lommel-Seeliger diffuse + nearly no specular (regolith is a matte back-scatterer)
    const phys = THREE.ShaderChunk.lights_physical_pars_fragment
      .replace('vec3 irradiance = dotNL * directLight.color;', 'vec3 irradiance = dotNL * directLight.color; vec3 irrLS = directLight.color * lunarLS(dotNL, saturate(dot(geometryNormal, geometryViewDir)));')
      .replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );', 'reflectedLight.directDiffuse += irrLS * BRDF_Lambert( material.diffuseColor );')
      .replace('reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );', 'reflectedLight.directSpecular += irradiance * .07 * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );');
    fs = fs.replace('#include <lights_physical_pars_fragment>', phys);
    const lights = THREE.ShaderChunk.lights_fragment_begin
      .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= mix( 1.0, tSh, step( .985, dot( inverseTransformDirection( directLight.direction, viewMatrix ), uSunW ) ) );');
    fs = fs.replace('#include <lights_fragment_begin>', lights);
    fs = fs.replace('#include <aomap_fragment>', '#include <aomap_fragment>\n\treflectedLight.indirectDiffuse *= tAO; reflectedLight.indirectSpecular *= tAO;\n\treflectedLight.indirectDiffuse += diffuseColor.rgb * tFill * mix(.55, 1., tAO);');
    fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + extra.body);
    if (extra.tail) fs = fs.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + extra.tail);
    shader.vertexShader = vs; shader.fragmentShader = fs;
  };
}

// ---------- ground material ----------
// All fine detail is sampled from the baked clipmaps (see bakeTextures); only low-frequency undulation and mottling stay analytic.
const GROUND_BODY = /* glsl */`{
  vec3 Nw=inverseTransformDirection(normal,viewMatrix);
  vec3 Vw=normalize(cameraPosition-vWP);
  float dist=length(cameraPosition-vWP), rr=length(vWP.xz);
  vec2 P=vWP.xz;
  float ndv=max(dot(Nw,Vw),.07);
  float fp=dist*.00105/ndv;
  vec2 bk=bakedSample(P); tSh=bk.x; tAO=bk.y; tFill=.036*(1.-tSh);
  vec2 dPx=dFdx(P), dPy=dFdy(P);
  float slopeK=smoothstep(.1,.5,1.-Nw.y);
  vec2 G=vec2(0.); float fresh=vBright;
  vec3 n1=vnoised(P*.21+7.); G+=n1.yz*.21*.22;
  // detail clipmap (192 m): fine-crater normals, ejecta brightness, cavity AO
  float m=max(abs(P.x),abs(P.y)), wD=1.-smoothstep(${(DET_E * .8).toFixed(1)},${(DET_E * .98).toFixed(1)},m);
  if(wD>0.){
    vec4 dm=textureGrad(uDetG,P/${(2 * DET_E).toFixed(1)}+.5,dPx/${(2 * DET_E).toFixed(1)},dPy/${(2 * DET_E).toFixed(1)});
    G+=(dm.xy*2.-1.)*wD; fresh+=dm.z*wD; tAO*=mix(1.,dm.w,wD);
  }
  // tiling regolith grain / pebbles (two scales, rotated + offset so the tiling never reads)
  vec4 mA=textureGrad(uMicro,P/5.12+vec2(.37,.11),dPx/5.12,dPy/5.12);
  G+=(mA.xy*2.-1.)*1.2*.9; float grain=mA.z-.5, pebAO=mA.w;
  if(uQ>.5){
    mat2 R=mat2(.8,.6,-.6,.8); vec2 pb=R*P/1.37, dbx=R*dPx/1.37, dby=R*dPy/1.37;
    vec4 mB=textureGrad(uMicro,pb+vec2(.71,.29),dbx,dby);
    vec2 gB=(mB.xy*2.-1.)*1.2*.32; G+=gB*R;    // rotate the tile-space slope back to world (R is orthonormal, so R^T g == g*R)
    grain+=(mB.z-.5)*.7; pebAO*=mB.w;
  }
  // highlands: superposed degraded craters of all sizes (two scales of one baked periodic tile), fading in beyond the detail clipmap
  float wHi=smoothstep(70.,260.,rr);
  if(wHi>0.){
    vec4 hA=textureGrad(uHigh,P/640.+vec2(.21,.57),dPx/640.,dPy/640.);
    vec2 gH=(hA.xy*2.-1.)*${(GMAX * .8).toFixed(3)}; float hFr=hA.z*2.-1., hAO=hA.w;
    if(uQ>.5){
      mat2 R2=mat2(.6,.8,-.8,.6); vec2 pc=R2*P/118., dcx=R2*dPx/118., dcy=R2*dPy/118.;
      vec4 hB=textureGrad(uHigh,pc+vec2(.63,.18),dcx,dcy);
      gH+=((hB.xy*2.-1.)*${(GMAX * .8 * .75).toFixed(3)})*R2; hFr+=(hB.z*2.-1.)*.6; hAO*=mix(1.,hB.w,.7);
    }
    G+=gH*wHi; fresh+=hFr*wHi*.5; tAO*=mix(1.,hAO,wHi*.75);
  }
  // massif-scale craters (40..250 m): the same tile stretched to 2.6 km and rotated, so no crater is copied between scales
  float wC=smoothstep(140.,520.,rr);
  if(wC>0.){
    mat2 R3=mat2(.8776,.4794,-.4794,.8776); vec2 pq=R3*P/2560., dqx=R3*dPx/2560., dqy=R3*dPy/2560.;
    vec4 hC=textureGrad(uHigh,pq+vec2(.47,.83),dqx,dqy);
    G+=((hC.xy*2.-1.)*${(GMAX * 1.35).toFixed(3)})*R3*wC; fresh+=(hC.z*2.-1.)*wC*.3; tAO*=mix(1.,hC.w,wC*.5);
  }
  // landing blast: smooth the fine bumps and paint a few broad domain-warped scour lobes (never a rigid radial spoke pattern)
  float bl=uBlast*(1.-smoothstep(10.,36.,rr));
  G*=1.-.4*bl;
  float scour=0.;
  if(uBlast>.001&&rr<60.){
    float warp=(fbm(P*.045+11.,2)-.5)*1.5+(vnoise(P*.17)-.5)*.4;
    float th=atan(P.y,P.x)+warp;
    float lob=.5+.5*(.55*cos(5.*th+1.3)+.3*cos(11.*th+4.1)+.15*cos(23.*th+2.2));
    lob=mix(lob,lob*(.55+.9*vnoise(vec2(th*3.,rr*.09))),.65);
    scour=uBlast*smoothstep(2.,9.,rr)*exp(-rr/17.)*(lob-.42);
  }
  // albedo: warm/cool mottling, grain, fresh bright rims, exposed slopes
  float mott=uQ>.5?fbm(P*.012+3.1,2):.5, mott2=vnoise(P*.07);
  vec3 tint=mix(vec3(1.,.975,.935),vec3(.95,.97,1.),smoothstep(.35,.65,mott));
  float lum=.76+.34*mott+(mott2-.5)*.16+grain*.6;
  vec3 albedo=vec3(.25,.242,.231)*tint*lum;
  albedo*=1.+.7*clamp(fresh,0.,1.4);
  albedo*=1.+.14*smoothstep(.05,.3,1.-Nw.y);
  albedo*=1.+scour*.38;
  albedo*=mix(.8,1.,pebAO);
  // lander footpads: contact occlusion, a faint dish under the pad and a ring of disturbed (lighter) dust
  if(uPadK>.001&&rr<12.){
    float aoP=0., ring=0.;
    for(int i=0;i<${PADS.length};i++){
      vec4 pd=uPads[i]; vec2 q=P-pd.xy; float d=length(q), rp=pd.z;
      aoP+=exp(-d*d/(rp*rp*1.7))*.55+exp(-d*d/(rp*rp*9.))*.2;
      ring+=exp(-pow((d-rp*1.5)/(rp*.45),2.));
    }
    aoP=min(aoP,.8)*uPadK; tAO*=1.-.75*aoP; albedo*=1.-.35*aoP; albedo*=1.+.1*min(ring,1.)*uPadK;
  }
  // far highlands: darker, lower-contrast regolith (mottling flattens out and the tone settles towards one soft grey); no layering, no ridged rock
  float hl=smoothstep(260.,900.,rr);
  albedo*=mix(1.,.47,hl); albedo*=mix(vec3(1.),vec3(.965,.985,1.),hl);
  albedo*=mix(1.,(.9+.2*mott)/(.76+.34*mott),hl*.6);
  albedo*=1.+.35*pow(max(dot(Vw,uSunW),0.),12.);
  diffuseColor.rgb=albedo;
  Nw=normalize(Nw+vec3(-G.x,0.,-G.y)*Nw.y);
  normal=normalize(transformDirection(Nw,viewMatrix));
}`;
function groundMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: .35 });
  lunarize(m, 'ground', { body: GROUND_BODY, tail: 'gl_FragColor.rgb*=1.-smoothstep(1500.,2150.,length(vWP.xz));' });
  return m;
}

// ---------- boulders ----------
function vn3(x, y, z, s) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => ih(ix + a, iy + b, s + (iz + c) * 131);
  const l0 = (h(0, 0, 0) * (1 - u) + h(1, 0, 0) * u) * (1 - v) + (h(0, 1, 0) * (1 - u) + h(1, 1, 0) * u) * v;
  const l1 = (h(0, 0, 1) * (1 - u) + h(1, 0, 1) * u) * (1 - v) + (h(0, 1, 1) * (1 - u) + h(1, 1, 1) * u) * v;
  return l0 * (1 - w) + l1 * w;
}
// Displaced icosahedron: lumpy noise, fracture planes (soft-min chamfers), smooth normals shared across coincident vertices.
function rockGeometry(seed, detail, flat) {
  const g = new THREE.IcosahedronGeometry(1, detail), pos = g.attributes.position, r = makeRng(seed);
  const planes = Array.from({ length: 6 + Math.floor(r() * 4) }, () => ({ v: new THREE.Vector3(r() - .5, r() - .5, r() - .5).normalize(), d: .66 + r() * .28 }));
  const o = [r() * 50, r() * 50, r() * 50];
  const sm = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * .25; };
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n = (s, s2) => vn3(v.x * s + o[0], v.y * s + o[1], v.z * s + o[2], s2);
    let rad = 1 + (n(1.6, 3) - .5) * .5 + (n(4.3, 5) - .5) * .16 + (n(11, 9) - .5) * .05;
    for (const p of planes) { const d = v.dot(p.v); if (d > .05) rad = sm(rad, p.d / d, .22); }
    pos.setXYZ(i, v.x * rad, v.y * rad * (flat ? .55 : 1), v.z * rad);
  }
  const acc = new Map(), nrm = new Float32Array(pos.count * 3), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const key = i => Math.round(pos.getX(i) * 1e4) + ',' + Math.round(pos.getY(i) * 1e4) + ',' + Math.round(pos.getZ(i) * 1e4);
  for (let i = 0; i < pos.count; i++) { const k = key(i); if (!acc.has(k)) acc.set(k, new THREE.Vector3()); }
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2);
    for (let k = 0; k < 3; k++) acc.get(key(i + k)).add(e1);
  }
  for (let i = 0; i < pos.count; i++) { const n = acc.get(key(i)).clone().normalize(); nrm[i * 3] = n.x; nrm[i * 3 + 1] = n.y; nrm[i * 3 + 2] = n.z; }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}
const ROCK_BODY = /* glsl */`{
  vec3 Nw=inverseTransformDirection(normal,viewMatrix);
  vec2 bk=bakedSample(vWP.xz); tSh=bk.x; tAO=bk.y; tFill=.036*(1.-tSh);
  float dist=length(cameraPosition-vWP), fp=dist*.00105;
  vec3 q=vWP*3.1; float e=.12;
  float b0=vnoise3(q);
  vec3 g=vec3(vnoise3(q+vec3(e,0,0))-b0,vnoise3(q+vec3(0,e,0))-b0,vnoise3(q+vec3(0,0,e))-b0)/e;
  vec3 q2=vWP*9.7+3.; float c0=vnoise3(q2);
  g+=.5*vec3(vnoise3(q2+vec3(e,0,0))-c0,vnoise3(q2+vec3(0,e,0))-c0,vnoise3(q2+vec3(0,0,e))-c0)/e*(1.-smoothstep(.02,.2,fp));
  Nw=normalize(Nw+(g-dot(g,Nw)*Nw)*.16);
  float lightK=mix(.85,2.6,vVar*vVar);
  vec3 rock=vec3(.15,.142,.134)*lightK*(.75+.5*b0)*(.85+.3*vnoise3(vWP*23.));
  vec3 dust=vec3(.255,.243,.225)*(.8+.4*vnoise(vWP.xz*.3));
  float top=smoothstep(.35,.95,Nw.y);
  rock=mix(rock,dust,.55*top*(.6+.4*b0));
  float skirt=1.-smoothstep(-.85,-.1,vRelY);
  rock=mix(rock,dust*.85,skirt*.8);
  diffuseColor.rgb=rock*mix(.7,1.,smoothstep(-.95,-.25,vRelY))*mix(1.,.5,smoothstep(220.,800.,length(vWP.xz)));   // far blocks follow the darker highland regolith
  normal=normalize(transformDirection(Nw,viewMatrix));
}`;
function rockMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: .3 });
  lunarize(m, 'rock', { body: ROCK_BODY, tail: 'gl_FragColor.rgb*=1.-smoothstep(1500.,2150.,length(vWP.xz));' });
  return m;
}

// ---------- boot prints (analytic, no canvas): soft pressed sole, pushed-soil rim, fine low-contrast tread ----------
// The decal plane is .36 x .66 units, toe toward +v. Low normal gain + mip-mapped tread = no barcode / moire at any distance.
function printTextures() {
  const W = 96, H = 192, PW = .36, PH = .66, sd = (x, y, cx, cy, rx, ry) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
  const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * .25; };
  const ht = new Float32Array(W * H), cov = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = ((i + .5) / W - .5) * PW, y = ((j + .5) / H - .5) * PH;
    const d = smin(sd(x, y, 0, .1, .092, .19), sd(x, y, 0, -.2, .072, .095), .07);
    const inside = 1 - sstep(-.01, .012, d), halo = 1 - sstep(.0, .075, d);
    cov[j * W + i] = Math.max(inside, halo * .35);
    let h = -.0125 * (1 - sstep(-.02, .006, d));                                                       // pressed sole (soft edge)
    h += .0055 * Math.exp(-(((d - .024) / .02) ** 2));                                                  // pushed-soil rim
    const lug = sstep(.3, .7, .5 + .5 * Math.cos(y * 6.2832 / .052)) * (y > -.02 ? 1 : 0) + sstep(.3, .7, .5 + .5 * Math.cos(y * 6.2832 / .052 + 1.5)) * (y <= -.02 ? 1 : 0);
    h += .0028 * lug * (1 - sstep(-.035, -.012, d)) * (1 - Math.exp(-((x / .014) ** 2)) * .8);          // tread lugs, groove down the middle
    ht[j * W + i] = h;
  }
  const nd = new Uint8Array(W * H * 4), cd = new Uint8Array(W * H * 4), hv = (x, y) => ht[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const k = 1 / (2 * PW / W);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const sx = (hv(i + 1, j) - hv(i - 1, j)) * k, sy = (hv(i, j + 1) - hv(i, j - 1)) * k * (PW / W) / (PH / H), l = Math.hypot(sx, sy, 1), o = (j * W + i) * 4;
    nd[o] = (-sx / l * .5 + .5) * 255; nd[o + 1] = (-sy / l * .5 + .5) * 255; nd[o + 2] = (1 / l * .5 + .5) * 255; nd[o + 3] = 255;
    cd[o] = 122; cd[o + 1] = 118; cd[o + 2] = 111; cd[o + 3] = Math.round(cov[j * W + i] * 255);
  }
  const map = new THREE.DataTexture(cd, W, H, THREE.RGBAFormat); map.colorSpace = THREE.SRGBColorSpace; map.generateMipmaps = true; map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter; map.anisotropy = 4; map.needsUpdate = true;
  const normalMap = new THREE.DataTexture(nd, W, H, THREE.RGBAFormat); normalMap.generateMipmaps = true; normalMap.minFilter = THREE.LinearMipmapLinearFilter; normalMap.magFilter = THREE.LinearFilter; normalMap.anisotropy = 4; normalMap.needsUpdate = true;
  return { map, normalMap };
}
function printMaterial(tex) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex.map, normalMap: tex.normalMap, normalScale: new THREE.Vector2(.9, .9), roughness: 1, metalness: 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMapIntensity: .3 });
  lunarize(m, 'print', { body: '{ vec2 bk=bakedSample(vWP.xz); tSh=bk.x; tAO=bk.y; tFill=.036*(1.-tSh); diffuseColor.a*=vVar*.8; }' });
  return m;
}

// Builds the ground, rocks and the footprint trail inside `world`. Returns { ground, rocks, footprints, sunDir, craterCount }.
//  ground     radial mesh whose vertices are heights(); userData.tick drives landing-blast scour + quality + footprint reveal
//  rocks      Group of InstancedMeshes (4 shape variants x 2 LODs), partially buried, clustered on crater rims
//  footprints Group of 2 InstancedMeshes (left/right) with a tread normal map; trails from the egress to flag/SPSS/DUSTER
//             plus live prints that appear 0.1 s after the walking astronauts' footfalls (stage 5)
export function createLunarSurface(world, renderer) {
  const t0 = performance.now(), bk = bakeTextures(renderer);
  U.uShM.value = bk.shM; U.uShF.value = bk.shF; U.uDetS.value = bk.detS; U.uDetG.value = bk.detG; U.uMicro.value = bk.micro; U.uHigh.value = bk.high;

  // --- ground: polar grid, ring spacing .5 m inside r=30 growing to ~24 m at the rim, sector count doubling so triangles stay near-isotropic
  const sp = r => r < 30 ? .5 : .5 + (r - 30) * .011, rings = []; // rings: { r, n, o } (o = first vertex index)
  { let r = 0, n = 12, o = 1; while (r < MESH_R) { r = Math.min(MESH_R, r + sp(r)); while (6.2832 * r / n > 1.6 * sp(r)) n *= 2; rings.push({ r, n, o }); o += n; } }
  const NV = rings.at(-1).o + rings.at(-1).n, pos = new Float32Array(NV * 3), nrm = new Float32Array(NV * 3), bright = new Float32Array(NV);
  pos[1] = heights(0, 0); nrm[1] = 1; bright[0] = lastBright;
  for (const { r, n, o } of rings) for (let j = 0; j < n; j++) {
    const a = j / n * 6.283185307, x = Math.cos(a) * r, z = Math.sin(a) * r, v = o + j;
    pos[v * 3] = x; pos[v * 3 + 1] = heights(x, z); pos[v * 3 + 2] = z; bright[v] = lastBright;
  }
  for (let i = 0; i < rings.length; i++) {
    const { n, o } = rings[i], pr = rings[i - 1], nx_ = rings[Math.min(rings.length - 1, i + 1)];
    for (let j = 0; j < n; j++) {
      const v = o + j, a = (pr ? pr.o + Math.floor(j * pr.n / n) : 0) * 3, b = (nx_.o + Math.floor(j * nx_.n / n)) * 3, c = (o + (j + n - 1) % n) * 3, d = (o + (j + 1) % n) * 3;
      const rx = pos[b] - pos[a], ry = pos[b + 1] - pos[a + 1], rz = pos[b + 2] - pos[a + 2], tx = pos[d] - pos[c], ty = pos[d + 1] - pos[c + 1], tz = pos[d + 2] - pos[c + 2];
      const nx = ty * rz - tz * ry, ny = tz * rx - tx * rz, nz = tx * ry - ty * rx, l = Math.hypot(nx, ny, nz) || 1;
      nrm[v * 3] = nx / l; nrm[v * 3 + 1] = ny / l; nrm[v * 3 + 2] = nz / l;
    }
  }
  let tri = 0; for (let i = 0; i < rings.length; i++) tri += i === 0 ? rings[0].n : rings[i].n === rings[i - 1].n ? 2 * rings[i].n : 3 * rings[i - 1].n;
  const idx = new Uint32Array(tri * 3); let q = 0;
  for (let j = 0; j < rings[0].n; j++) { idx[q++] = 0; idx[q++] = rings[0].o + (j + 1) % rings[0].n; idx[q++] = rings[0].o + j; }
  for (let i = 1; i < rings.length; i++) {
    const A = rings[i - 1], B = rings[i];
    if (A.n === B.n) for (let j = 0; j < A.n; j++) {
      const a = A.o + j, b = A.o + (j + 1) % A.n, c = B.o + j, d = B.o + (j + 1) % B.n;
      idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;
    } else for (let j = 0; j < A.n; j++) {
      const a = A.o + j, a1 = A.o + (j + 1) % A.n, o0 = B.o + 2 * j, o1 = B.o + 2 * j + 1, o2 = B.o + (2 * j + 2) % B.n;
      idx[q++] = a; idx[q++] = a1; idx[q++] = o1; idx[q++] = a; idx[q++] = o1; idx[q++] = o0; idx[q++] = a1; idx[q++] = o2; idx[q++] = o1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.computeBoundingSphere();
  initStats.mesh = performance.now() - t0 - initStats.bake;
  const ground = new THREE.Mesh(geo, groundMaterial());
  ground.castShadow = false; ground.receiveShadow = true; world.add(ground);
  const T = EVENTS.touchdown, L = EVENTS.liftoff;
  ground.userData.tick = (t, ctx) => {
    if (ctx?.sunDir) U.uSunW.value.copy(ctx.sunDir);
    const si = ctx?.idx ?? 5, u = ctx?.u ?? 0;
    // plume scour: ramps in as the exhaust reaches the pad, relaxes to a faint residue after touchdown, flares again at ascent lift-off
    U.uBlast.value = si < 4 ? 0 : si === 4 ? sstep(T - 4.5, T - .4, t) : si === 5 ? mixf(1, .25, sstep(T, T + 6, t)) : si === 6 ? .25 + .75 * sstep(L, L + 1.4, t) * (1 - sstep(L + 2, L + 8, t)) : 0;
    U.uPadK.value = si < 4 ? 0 : si === 4 ? sstep(T - 1.2, T, t) : si === 5 ? 1 : si === 6 ? 1 - sstep(L, L + 1.4, t) : 0;
    U.uQ.value = ctx?.quality === 'low' ? 0 : ctx?.quality === 'high' ? 2 : 1;
    U.uIdx.value = si; U.uU.value = u;                                                       // boot prints appear as the astronauts walk
  };

  // --- boulders: power-law sizes, clustered on crater rims, partially buried, none inside r<10
  const rr = makeRng(88123), rocks = new THREE.Group(); world.add(rocks);
  const blocked = (x, z, s) => {
    if (Math.hypot(x, z) < 11 + s) return true;
    for (const [px, pz, pr] of PROPS) if (Math.hypot(x - px, z - pz) < pr + s) return true;
    return distToTrails(x, z) < 1.4 + s;
  };
  const rimCraters = craters.filter(c => c.r >= 3.5 && Math.hypot(c.x, c.z) < 900);
  const size = () => Math.min(4.2, .2 * Math.pow(1 - rr(), -1 / 2.1));
  const placed = [];
  const tryPlace = (gen, n) => { for (let i = 0, got = 0; got < n && i < n * 8; i++) { const p = gen(); if (blocked(p.x, p.z, p.s)) continue; placed.push(p); got++; } };
  tryPlace(() => { const a = rr() * 6.2832, d = 14 + 76 * Math.sqrt(rr()); return { x: Math.cos(a) * d, z: Math.sin(a) * d, s: Math.min(1.9, size()) }; }, 640);
  tryPlace(() => { const c = rimCraters[Math.floor(rr() * rimCraters.length)], a = rr() * 6.2832, d = c.r * (.82 + Math.pow(rr(), 1.7) * 1.7), sc = .7 + Math.min(1.8, c.r / 22); return { x: c.x + Math.cos(a) * d, z: c.z + Math.sin(a) * d, s: Math.min(4.6, size() * sc) }; }, 760);
  tryPlace(() => { const a = rr() * 6.2832, d = 90 + 620 * Math.sqrt(rr()); return { x: Math.cos(a) * d, z: Math.sin(a) * d, s: Math.min(4.6, size() * 1.7) }; }, 280);
  // far blocks: scattered over the highland flanks (steeper = more) and along the rims of the larger craters; low-poly instances only
  {
    const hc = (x, z) => heights(x, z) + (x * x + z * z) / R_CURV, slope = (x, z) => Math.hypot(hc(x + 8, z) - hc(x - 8, z), hc(x, z + 8) - hc(x, z - 8)) / 16;
    for (let i = 0, got = 0; i < 6000 && got < 760; i++) {
      const a = rr() * 6.2832, d = 300 + 1250 * Math.sqrt(rr()), x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (rr() > .1 + 1.5 * sstep(.1, .45, slope(x, z))) continue;
      placed.push({ x, z, s: Math.min(11, 1.2 + size() * 4.4), far: true }); got++;
    }
    const big = craters.filter(c => c.r >= 28 && Math.hypot(c.x, c.z) > 300 && Math.hypot(c.x, c.z) < 1700);
    for (let i = 0; i < 260 && big.length; i++) {
      const c = big[Math.floor(rr() * big.length)], a = rr() * 6.2832, d = c.r * (.85 + Math.pow(rr(), 1.5) * .9);
      placed.push({ x: c.x + Math.cos(a) * d, z: c.z + Math.sin(a) * d, s: Math.min(12, 1.2 + size() * 4.4 * (.7 + c.r / 110)), far: true });
    }
  }
  const mat = rockMaterial();
  const groups = [[11, false], [23, false], [37, true], [53, false]].flatMap(([seed, flat]) => [{ geo: rockGeometry(seed, 3, flat), big: true, list: [] }, { geo: rockGeometry(seed, 1, flat), big: false, list: [] }]);
  const dummy = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0), nv = new THREE.Vector3();
  for (const p of placed) {
    const v = Math.floor(rr() * 4), grp = groups[v * 2 + (p.s > 1 && !p.far ? 0 : 1)], s = p.s;
    const g0 = Math.min(heights(p.x, p.z), heights(p.x + s * .7, p.z), heights(p.x - s * .7, p.z), heights(p.x, p.z + s * .7), heights(p.x, p.z - s * .7));
    dummy.position.set(p.x, g0 + s * .42 - s * (.12 + rr() * .3), p.z);
    nv.set(-(heights(p.x + .5, p.z) - heights(p.x - .5, p.z)), 1, -(heights(p.x, p.z + .5) - heights(p.x, p.z - .5))).normalize(); dummy.quaternion.setFromUnitVectors(up, nv);
    dummy.rotateY(rr() * 6.2832); dummy.rotateX((rr() - .5) * .5); dummy.rotateZ((rr() - .5) * .5);
    const asp = .8 + rr() * .5; dummy.scale.set(s * asp, s * (.55 + rr() * .3), s / asp * (.9 + rr() * .3)); dummy.updateMatrix();
    grp.list.push({ m: dummy.matrix.clone(), a: rr() });
  }
  for (const grp of groups) {
    if (!grp.list.length) continue;
    const im = new THREE.InstancedMesh(grp.geo, mat, grp.list.length), av = new Float32Array(grp.list.length);
    grp.list.forEach((e, i) => { im.setMatrixAt(i, e.m); av[i] = e.a; });
    grp.geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(av, 1));
    im.castShadow = true; im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; rocks.add(im);
  }

  // --- boot prints: instanced decals just above the ground, tilted to the slope. Each print is where an astronaut's foot lands in the
  // timeline.js choreography (astronautAt is replayed at init); it is revealed .1 s after the footfall (aT = stage-5 progress u), so no
  // print exists before anybody walked there. Standing spots get a few shuffled prints.
  const prints = [], dur5 = STAGE_STARTS[6] - STAGE_STARTS[5], reveal = t => (t + .1 - STAGE_STARTS[5]) / dur5;
  const add = (x, z, h, foot, t) => prints.push({ x, z, h, foot, aT: reveal(t) });
  for (const p of ASTRO.steps) { const off = (p.foot ? 1 : -1) * .2; add(p.x - Math.cos(p.h) * off + (rr() - .5) * .06, p.z + Math.sin(p.h) * off + (rr() - .5) * .06, p.h + (rr() - .5) * .12, p.foot, p.t); }
  for (const s of ASTRO.stands) {
    const n = s.first ? 2 : Math.max(2, Math.floor((s.t1 - s.t0) * 1.6));
    for (let i = 0; i < n; i++) { const a = rr() * 6.2832, d = s.first ? .2 : .12 + rr() * .4; add(s.x + Math.cos(a) * d * (s.first ? 1 : 1), s.z + Math.sin(a) * d, s.h + (s.first ? (i ? .25 : -.25) : (rr() - .5) * 1.2), (i + (s.first ? 0 : 1)) & 1, s.first ? s.t0 + .05 * i : s.t0 + (s.t1 - s.t0) * (i + .5) / n); }
  }
  if (!prints.length) add(LAD.baseX, LAD.baseZ + .5, 0, 0, 1e3);      // never an empty instanced mesh (also used when the timeline has no astronaut routes)
  const footprints = new THREE.Group(); world.add(footprints);
  const tex = printTextures(), pm = printMaterial(tex);
  const plane = new THREE.PlaneGeometry(.36, .66); plane.rotateX(-Math.PI / 2); plane.rotateY(Math.PI);   // toe toward local +Z
  const planeMirror = plane.clone(); { const uv = planeMirror.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); }
  const basis = new THREE.Matrix4(), fwd = new THREE.Vector3(), rgt = new THREE.Vector3(), nn = new THREE.Vector3();
  for (const foot of [0, 1]) {
    const list = prints.filter(p => p.foot === foot), geoP = (foot ? plane : planeMirror).clone(), im = new THREE.InstancedMesh(geoP, pm, list.length), at = new Float32Array(list.length);
    list.forEach((p, i) => {
      nn.set(-(heights(p.x + .3, p.z) - heights(p.x - .3, p.z)) / .6, 1, -(heights(p.x, p.z + .3) - heights(p.x, p.z - .3)) / .6).normalize();
      fwd.set(Math.sin(p.h), 0, Math.cos(p.h)); fwd.addScaledVector(nn, -fwd.dot(nn)).normalize(); rgt.crossVectors(nn, fwd);
      basis.makeBasis(rgt, nn, fwd); basis.setPosition(p.x, heights(p.x, p.z) + .018, p.z); im.setMatrixAt(i, basis); at[i] = p.aT;
    });
    geoP.setAttribute('aT', new THREE.InstancedBufferAttribute(at, 1));
    im.castShadow = false; im.receiveShadow = true; im.renderOrder = 2; im.frustumCulled = false; im.instanceMatrix.needsUpdate = true; footprints.add(im);
  }
  initStats.total = performance.now() - t0 + initStats.module;
  return { ground, rocks, footprints, sunDir: SUN_DIR, craterCount: craters.length, triangles: tri };
}
