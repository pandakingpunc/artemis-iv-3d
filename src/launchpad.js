// ARTEMIS IV · Kennedy LC-39B dawn launch complex and the SLS Block 1 / Orion stack.
// Everything is procedural (canvas textures, lathes, merged/instanced geometry); animation is a pure function of film time t.
//
// createSLS(parent)        -> { group, core, boosters:[left,right], coreEngineAnchor, las, icps }   (stack base y=0, top of LAS y~66)
// createLaunchSite(world)  -> { group, tower, ml, terrain, ocean, vab, arms, crewArm, masts, deluge, heightAt, seaLevel, groundLevel }
// launchGroundHeight(x,z)  -> terrain height of the coastal ground (sea level -4.6, pad concrete -2.8, ML deck top 0)
// All site animation (arms swinging away, deluge, aviation lights, water, mist, birds) runs from site.userData.tick(t, ctx).
import * as THREE from 'three';
import { TAU, clamp, mix, smooth, makeRng } from './util.js';
import { DAWN_SUN_DIR } from './sky.js';
import * as SKY from './sky.js';   // namespace import: SKY_GLSL / NOISE_GLSL are feature-detected so a sky refactor can never break this module

/* ───────────────────────── constants & small helpers ───────────────────────── */
const G0 = -2.8;                 // pad / ground level (ML deck top is y=0)
const CB = 6.3;                 // core-stage aft plane (bells protrude below it, exit plane at y=4)
const SEA = -4.6;                // sea level
const BANK_H = 260;               // horizon cloud-bank height
const EXT = 2200, HN = 768;      // height-field half extent / resolution
const TRENCH = { x0: -16, x1: 62, hz: 9, floor: -12.5 };
const TOWER = { x: -5, z: -14.8, hw: 4.5, h: 76 };
const DECK = { x0: -22, x1: 20, z0: -27, z1: 15, thick: 3 };
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

const hash = (x, y, s) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
function vnoise(x, y, s = 0, px = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = px ? v => ((v % px) + px) % px : v => v;
  const a = hash(w(ix), iy, s), b = hash(w(ix + 1), iy, s), c = hash(w(ix), iy + 1, s), d = hash(w(ix + 1), iy + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, oct = 4, s = 0, px = 0) { let a = .5, f = 1, sum = 0, n = 0; for (let i = 0; i < oct; i++) { sum += a * vnoise(x * f, y * f, s + i * 7, px ? px * f : 0); n += a; a *= .5; f *= 2; } return sum / n; }

/* geometry accumulation: collect transformed primitives, merge into one BufferGeometry (one draw call per material) */
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function merge(list) {
  let vc = 0, ic = 0, col = false;
  for (const g of list) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; col ||= !!g.attributes.color; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), cols = col ? new Float32Array(vc * 3).fill(1) : null;
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    const a = g.attributes, n = a.position.count;
    pos.set(a.position.array, vo * 3); nor.set(a.normal.array, vo * 3); if (a.uv) uv.set(a.uv.array, vo * 2); if (a.color && cols) cols.set(a.color.array, vo * 3);
    if (g.index) for (let i = 0, m = g.index.count; i < m; i++) idx[io++] = g.index.array[i] + vo; else for (let i = 0; i < n; i++) idx[io++] = vo + i;
    vo += n; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (cols) out.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
function tileUV(g, w, h, d, tile) {
  const uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, uv.getX(k) * dims[f][0] / tile, uv.getY(k) * dims[f][1] / tile); }
}
const _col = new THREE.Color();
class Acc {
  constructor() { this.list = []; this.tint = null; }
  // paint(hex): following primitives get this vertex colour, so many differently coloured parts share one material / draw call
  paint(hex) { this.tint = hex == null ? null : _col.set(hex).toArray(); return this; }
  add(g) {
    if (this.tint) { const n = g.attributes.position.count, c = new Float32Array(n * 3), t = this.tint; for (let i = 0; i < n; i++) { c[i * 3] = t[0]; c[i * 3 + 1] = t[1]; c[i * 3 + 2] = t[2]; } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
    this.list.push(g); return this;
  }
  geo(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
    if (x || y || z || rx || ry || rz || sx !== 1 || sy !== 1 || sz !== 1) { _e.set(rx, ry, rz); _q.setFromEuler(_e); _m.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz)); g.applyMatrix4(_m); }
    return this.add(g);
  }
  box(w, h, d, x, y, z, rx, ry, rz, tile) { const g = new THREE.BoxGeometry(w, h, d); if (tile) tileUV(g, w, h, d, tile); return this.geo(g, x, y, z, rx, ry, rz); }
  cyl(rt, rb, h, x, y, z, seg = 10, rx, ry, rz) { return this.geo(new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz); }
  sph(r, x, y, z, ws = 18, hs = 12, sx = 1, sy = 1, sz = 1) { return this.geo(new THREE.SphereGeometry(r, ws, hs), x, y, z, 0, 0, 0, sx, sy, sz); }
  beam(a, b, t) {
    const len = a.distanceTo(b), g = new THREE.BoxGeometry(t, len, t);
    _d.subVectors(b, a).normalize(); _q.setFromUnitVectors(_up, _d); _m.compose(_v.copy(a).add(b).multiplyScalar(.5), _q, _s.set(1, 1, 1)); g.applyMatrix4(_m);
    return this.add(g);
  }
  oriented(g, p, dir) { _q.setFromUnitVectors(_up, _d.copy(dir).normalize()); _m.compose(p, _q, _s.set(1, 1, 1)); g.applyMatrix4(_m); return this.add(g); }
  // transform every primitive collected so far by a matrix (used to bake group offsets into one global batch)
  bake(mat) { for (const g of this.list) g.applyMatrix4(mat); return this; }
  append(other) { for (const g of other.list) this.list.push(g); other.list = []; return this; }
  build(material, parent, cast = true, receive = true) {
    const o = new THREE.Mesh(merge(this.list), material); o.castShadow = cast; o.receiveShadow = receive; parent?.add(o); return o;
  }
}

/* surface of revolution with automatic smooth/hard normals. pts = [[r,y],...] listed so that the outward normal is (dy,-dr). */
function revolve(pts, o = {}) {
  const { segs = 32, phi0 = 0, phi = TAU, smooth: sm = 40, vmode = 'y', flip = false } = o;
  const n = pts.length, sn = [], arc = [0];
  for (let i = 0; i < n - 1; i++) { const dr = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], l = Math.hypot(dr, dy) || 1; sn.push([dy / l, -dr / l]); arc.push(arc[i] + l); }
  let ymin = Infinity, ymax = -Infinity; for (const p of pts) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const rings = [], se = [], cosT = Math.cos(sm * Math.PI / 180);
  const push = (i, nrm) => { rings.push({ r: pts[i][0], y: pts[i][1], nr: nrm[0], ny: nrm[1], v: vmode === 'y' ? (pts[i][1] - ymin) / ((ymax - ymin) || 1) : arc[i] / (arc[n - 1] || 1) }); return rings.length - 1; };
  for (let i = 0; i < n; i++) {
    let E = -1, S = -1;
    if (i === 0) S = push(0, sn[0]);
    else if (i === n - 1) E = push(i, sn[i - 1]);
    else {
      const a = sn[i - 1], b = sn[i];
      if (a[0] * b[0] + a[1] * b[1] >= cosT) { const m = [a[0] + b[0], a[1] + b[1]], l = Math.hypot(m[0], m[1]) || 1; E = S = push(i, [m[0] / l, m[1] / l]); }
      else { E = push(i, a); S = push(i, b); }
    }
    if (E >= 0) se[i - 1][1] = E;
    if (S >= 0) se[i] = [S, 0];
  }
  const W = segs + 1, pos = new Float32Array(rings.length * W * 3), nor = new Float32Array(rings.length * W * 3), uv = new Float32Array(rings.length * W * 2), sg = flip ? -1 : 1;
  rings.forEach((rg, k) => {
    for (let j = 0; j <= segs; j++) {
      const a = phi0 + phi * j / segs, s = Math.sin(a), c = Math.cos(a), o3 = (k * W + j) * 3, o2 = (k * W + j) * 2;
      pos[o3] = rg.r * s; pos[o3 + 1] = rg.y; pos[o3 + 2] = rg.r * c;
      nor[o3] = sg * rg.nr * s; nor[o3 + 1] = sg * rg.ny; nor[o3 + 2] = sg * rg.nr * c;
      uv[o2] = j / segs; uv[o2 + 1] = rg.v;
    }
  });
  const idx = [];
  for (const [a, b] of se) for (let j = 0; j < segs; j++) {
    const a0 = a * W + j, a1 = a0 + 1, b0 = b * W + j, b1 = b0 + 1;
    if (flip) idx.push(a0, b0, a1, a1, b0, b1); else idx.push(a0, a1, b0, a1, b1, b0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/* ───────────────────────── procedural textures ───────────────────────── */
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function tex(c, { repeat = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  return t;
}
// low-resolution per-pixel layer drawn scaled onto a big canvas: fn(u,v) -> [r,g,b]
function layer(g, W, H, lw, lh, fn) {
  const c = canvas(lw, lh), lg = c.getContext('2d'), im = lg.createImageData(lw, lh), d = im.data;
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) { const o = fn(x / lw, y / lh), k = (y * lw + x) * 4; d[k] = o[0]; d[k + 1] = o[1]; d[k + 2] = o[2]; d[k + 3] = 255; }
  lg.putImageData(im, 0, 0); g.imageSmoothingEnabled = true; g.drawImage(c, 0, 0, W, H);
}
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// SLS core stage: sprayed orange foam, welds, stringers, ribbed intertank, heat-stained engine section, generic lettering.
// Mapped with u=.5 facing +Z, v ~ sls-local y over [5.7, 44.6].
function foamTexture() {
  const W = 1024, H = 2048, c = canvas(W, H), g = c.getContext('2d');
  const A = [214, 112, 52], B = [158, 74, 32], C = [238, 154, 88];
  layer(g, W, H, 512, 1024, (u, v) => {
    const n1 = fbm(u * 5, v * 11, 5, 11, 5), n2 = fbm(u * 24, v * 52, 3, 23, 24), n3 = vnoise(u * 160, v * 320, 37, 160), n4 = vnoise(u * 320, v * 640, 41, 320);
    const dk = ss(.5, .8, n1) * .5, lt = ss(.5, .8, n2) * (1 - dk) * .5, k = .88 + .13 * n3 + .09 * n4;
    const o = lerp3(lerp3(A, B, dk), C, lt); return [o[0] * k, o[1] * k, o[2] * k];
  });
  const row = y => (1 - (y - CB) / (44.6 - CB)) * H;
  let gr = g.createLinearGradient(0, row(CB), 0, row(15)); gr.addColorStop(0, 'rgba(28,12,6,.7)'); gr.addColorStop(1, 'rgba(28,12,6,0)'); g.fillStyle = gr; g.fillRect(0, row(15), W, row(CB) - row(15));
  gr = g.createLinearGradient(0, row(43.2), 0, row(44.6)); gr.addColorStop(0, 'rgba(255,225,190,0)'); gr.addColorStop(1, 'rgba(255,225,190,.28)'); g.fillStyle = gr; g.fillRect(0, row(44.6), W, row(43.2) - row(44.6));
  for (let k = 0; k < 72; k++) { const x = (k + .5) / 72 * W + (hash(k, 3, 5) - .5) * 5, a = .06 + hash(k, 9, 5) * .08; g.fillStyle = `rgba(62,26,10,${a})`; g.fillRect(x, row(30.4), 1.6, row(9.2) - row(30.4)); g.fillRect(x, row(43.0), 1.6, row(35.8) - row(43.0)); }
  for (let k = 0; k < 260; k++) {
    const x = hash(k, 1, 9) * W, y0 = hash(k, 2, 9) * H, len = 50 + hash(k, 3, 9) * 340, a = .03 + hash(k, 4, 9) * .07, w = 2 + hash(k, 6, 9) * 6;
    g.fillStyle = hash(k, 5, 9) > .42 ? `rgba(58,24,9,${a})` : `rgba(255,196,140,${a * .7})`; g.fillRect(x, y0, w, len);
  }
  // intertank ribs
  for (let k = 0; k < 96; k++) { const x = k / 96 * W; g.fillStyle = 'rgba(255,205,150,.22)'; g.fillRect(x, row(35.6), 5, row(30.6) - row(35.6)); g.fillStyle = 'rgba(60,24,8,.34)'; g.fillRect(x + 5, row(35.6), 3, row(30.6) - row(35.6)); }
  g.fillStyle = 'rgba(55,22,8,.2)'; g.fillRect(0, row(35.6), W, row(30.6) - row(35.6));
  // weld seams
  for (const [y, a] of [[9.0, .55], [13.9, .3], [18.8, .3], [23.7, .3], [28.2, .3], [30.6, .6], [35.6, .6], [39.2, .3], [43.2, .55], [7.5, .4]]) {
    g.fillStyle = `rgba(52,20,7,${a})`; g.fillRect(0, row(y), W, 4); g.fillStyle = 'rgba(255,200,150,.22)'; g.fillRect(0, row(y) + 4, W, 2);
  }
  // generic lettering (no agency logos)
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = 'rgba(40,14,4,.55)'; g.shadowBlur = 7;
  g.fillStyle = 'rgba(247,243,235,.95)'; g.font = '800 168px Bahnschrift, "Arial Narrow", Arial, sans-serif'; g.letterSpacing = '12px'; g.fillText('SLS', W * .53, row(26.6));
  g.font = '700 46px Bahnschrift, "Arial Narrow", Arial, sans-serif'; g.letterSpacing = '9px'; g.fillText('ARTEMIS IV', W * .53, row(22.6));
  g.shadowBlur = 0; g.fillStyle = 'rgba(32,64,150,.9)'; g.fillRect(W * .53 - 150, row(21.0), 300, 6); g.fillStyle = 'rgba(200,40,40,.9)'; g.fillRect(W * .53 - 150, row(20.5), 300, 4);
  return tex(c, { aniso: 8 });
}

// Solid rocket booster: painted white, segment joints, soot, cable-tunnel strip, vertical lettering. u=.5 faces +Z, v ~ booster y over [3, 40.8].
function boosterTexture() {
  const W = 512, H = 1536, c = canvas(W, H), g = c.getContext('2d');
  layer(g, W, H, 128, 384, (u, v) => { const n = fbm(u * 5, v * 14, 4, 51, 5), m = fbm(u * 18, v * 60, 3, 61, 18); const k = .93 + .1 * n - .05 * m; return [236 * k, 234 * k, 226 * k]; });
  const row = y => (1 - (y - 3) / (40.8 - 3)) * H;
  let gr = g.createLinearGradient(0, row(3), 0, row(12)); gr.addColorStop(0, 'rgba(40,36,32,.55)'); gr.addColorStop(1, 'rgba(40,36,32,0)'); g.fillStyle = gr; g.fillRect(0, row(12), W, row(3) - row(12));
  for (let k = 0; k < 120; k++) { const x = hash(k, 1, 4) * W, y0 = hash(k, 2, 4) * H, len = 40 + hash(k, 3, 4) * 240; g.fillStyle = `rgba(70,64,56,${.025 + hash(k, 4, 4) * .05})`; g.fillRect(x, y0, 2 + hash(k, 5, 4) * 6, len); }
  for (const y of [9.8, 16.6, 23.4, 30.2]) { g.fillStyle = 'rgba(96,98,104,.85)'; g.fillRect(0, row(y) - 3, W, 6); g.fillStyle = 'rgba(255,255,255,.4)'; g.fillRect(0, row(y) - 6, W, 3); g.fillStyle = 'rgba(120,120,120,.25)'; g.fillRect(0, row(y) + 3, W, 4); }
  g.fillStyle = 'rgba(110,112,118,.6)'; g.fillRect(0, row(37.0) - 3, W, 6); g.fillRect(0, row(3.2) - 3, W, 6);
  g.fillStyle = 'rgba(48,50,56,.85)'; g.fillRect(W * .78, row(37), 9, row(3) - row(37));
  g.fillStyle = 'rgba(190,60,50,.9)'; g.fillRect(0, row(35.4), W, 9); g.fillRect(0, row(34.4), W, 4);
  g.save(); g.translate(W * .6, row(23.5)); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '800 80px Bahnschrift, "Arial Narrow", Arial, sans-serif'; g.letterSpacing = '10px'; g.fillStyle = 'rgba(26,40,72,.92)'; g.fillText('ARTEMIS IV', 0, 0); g.restore();
  // US flag and a generic mission roundel (no agency logo), plus a stencilled panel code
  { const fx = W * .3, fy = row(31.4), fw = 104, fh = 55;
    for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#f3f1ee' : '#b3202e'; g.fillRect(fx, fy + i * fh / 13, fw, fh / 13 + .6); }
    g.fillStyle = '#2a3c78'; g.fillRect(fx, fy, fw * .4, fh * 7 / 13); g.fillStyle = 'rgba(243,241,238,.85)'; for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) g.fillRect(fx + 4 + k * 9, fy + 4 + r * 7, 2.4, 2.4);
    g.strokeStyle = 'rgba(40,40,44,.35)'; g.lineWidth = 2; g.strokeRect(fx, fy, fw, fh);
    const rx = W * .3 + fw / 2, ry = row(27.6);
    g.fillStyle = '#1d3a8a'; g.beginPath(); g.arc(rx, ry, 34, 0, TAU); g.fill(); g.strokeStyle = '#eef0f4'; g.lineWidth = 3; g.beginPath(); g.ellipse(rx, ry, 29, 11, -.5, 0, TAU); g.stroke();
    g.fillStyle = '#e24a32'; g.beginPath(); g.arc(rx + 20, ry - 12, 4, 0, TAU); g.fill(); g.fillStyle = '#eef0f4'; g.beginPath(); g.arc(rx - 9, ry + 6, 8, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(30,34,44,.4)'; g.lineWidth = 2; g.beginPath(); g.arc(rx, ry, 35, 0, TAU); g.stroke();
    g.font = '700 22px Bahnschrift, Arial, sans-serif'; g.fillStyle = 'rgba(40,44,56,.75)'; g.textAlign = 'center'; g.fillText('SEG 4', fx + fw / 2, row(20.3)); g.fillText('ARTEMIS', fx + fw / 2, row(14.2)); }
  return tex(c, { aniso: 8 });
}

// White painted skin: LVSA / adapter / fairing. rings = v positions of horizontal seams (0..1 bottom→top), seams = vertical split count.
function panelTexture(rings, seams, tint = [232, 230, 222]) {
  const W = 512, H = 256, c = canvas(W, H), g = c.getContext('2d');
  layer(g, W, H, 128, 64, (u, v) => { const n = fbm(u * 6, v * 5, 4, 71, 6); const k = .94 + .1 * n; return [tint[0] * k, tint[1] * k, tint[2] * k]; });
  for (const r of rings) { const y = (1 - r) * H; g.fillStyle = 'rgba(90,92,98,.7)'; g.fillRect(0, y - 1.5, W, 3); g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(0, y - 3.5, W, 2); for (let x = 0; x < W; x += 9) { g.fillStyle = 'rgba(70,70,76,.5)'; g.fillRect(x, y + 3, 2, 2); } }
  for (let k = 0; k < seams; k++) { const x = (k / seams) * W; g.fillStyle = 'rgba(80,82,88,.75)'; g.fillRect(x - 1, 0, 3, H); }
  for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(70,62,52,${.03 + hash(k, 1, 8) * .05})`; g.fillRect(hash(k, 2, 8) * W, hash(k, 3, 8) * H, 2 + hash(k, 4, 8) * 6, 20 + hash(k, 5, 8) * 90); }
  return tex(c, { aniso: 4 });
}

function concreteTexture(base = [146, 144, 138], seed = 3) {
  const W = 512, c = canvas(W, W), g = c.getContext('2d');
  layer(g, W, W, 256, 256, (u, v) => { const n = fbm(u * 8, v * 8, 5, seed, 8), m = vnoise(u * 64, v * 64, seed + 9, 64); const k = .8 + .3 * n + .08 * m; return [base[0] * k, base[1] * k, base[2] * k]; });
  for (let k = 0; k < 30; k++) { g.fillStyle = `rgba(40,36,30,${.05 + hash(k, 1, seed) * .08})`; g.beginPath(); g.ellipse(hash(k, 2, seed) * W, hash(k, 3, seed) * W, 8 + hash(k, 4, seed) * 50, 4 + hash(k, 5, seed) * 30, hash(k, 6, seed) * 3, 0, TAU); g.fill(); }
  g.strokeStyle = 'rgba(30,28,24,.55)'; g.lineWidth = 3; g.strokeRect(0, 0, W, W);
  return tex(c, { repeat: true, aniso: 8 });
}

function deckTexture() {
  const W = 512, c = canvas(W, W), g = c.getContext('2d');
  layer(g, W, W, 128, 128, (u, v) => { const n = fbm(u * 8, v * 8, 4, 91, 8); const k = .8 + .35 * n; return [74 * k, 80 * k, 88 * k]; });
  g.strokeStyle = 'rgba(20,22,26,.8)'; g.lineWidth = 3; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * W / 4, 0); g.lineTo(i * W / 4, W); g.moveTo(0, i * W / 4); g.lineTo(W, i * W / 4); g.stroke(); }
  g.fillStyle = 'rgba(214,170,40,.85)'; g.fillRect(0, W * .5 - 5, W, 10);
  for (let k = 0; k < 60; k++) { g.fillStyle = `rgba(20,18,16,${.06 + hash(k, 1, 12) * .1})`; g.beginPath(); g.ellipse(hash(k, 2, 12) * W, hash(k, 3, 12) * W, 6 + hash(k, 4, 12) * 40, 3 + hash(k, 5, 12) * 22, hash(k, 6, 12) * 3, 0, TAU); g.fill(); }
  return tex(c, { repeat: true, aniso: 8 });
}

function vabTexture() {
  const W = 256, H = 512, c = canvas(W, H), g = c.getContext('2d');
  layer(g, W, H, 64, 128, (u, v) => { const n = fbm(u * 3, v * 6, 3, 121, 3); const band = (Math.floor(v * 128) % 2) ? .96 : 1.03; const k = (.9 + .12 * n) * band; return [212 * k, 216 * k, 220 * k]; });
  for (let y = 0; y < H; y += 8) { g.fillStyle = 'rgba(120,128,138,.25)'; g.fillRect(0, y, W, 1.5); }
  for (let k = 0; k < 30; k++) { g.fillStyle = `rgba(70,76,84,${.04 + hash(k, 1, 7) * .06})`; g.fillRect(hash(k, 2, 7) * W, 0, 2 + hash(k, 3, 7) * 5, H); }
  return tex(c, { repeat: true, aniso: 4 });
}
function flagTexture() {
  const W = 520, H = 273, c = canvas(W, H), g = c.getContext('2d');
  for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#f3f1ee' : '#b3202e'; g.fillRect(0, i * H / 13, W, H / 13 + 1); }
  g.fillStyle = '#2a3c78'; g.fillRect(0, 0, W * .4, H * 7 / 13);
  g.fillStyle = '#f3f1ee'; for (let r = 0; r < 9; r++) for (let k = 0; k < (r % 2 ? 5 : 6); k++) { g.beginPath(); g.arc(W * .4 * ((k + (r % 2 ? 1 : .5)) / 6.2), H * 7 / 13 * ((r + .6) / 9.2), 3, 0, TAU); g.fill(); }
  return tex(c, { aniso: 4 });
}

/* ───────────────────────── SLS Block 1 + Orion ───────────────────────── */
// Stack base at y=0 (SRB aft skirts on the ML deck), top of the Launch Abort System at y≈66.
// Core r=3 (engine exit plane / coreEngineAnchor at sls-local y=4, exhaust along -Y). SRBs r≈1.5 are direct child groups at x=±4.55;
// booster-local y=1.3 is the nozzle exit (userData.engineAnchor). Returns { group, core, boosters, coreEngineAnchor, las, icps, parts }.
export function createSLS(parent) {
  const sls = new THREE.Group(); sls.name = 'SLS'; parent?.add(sls);
  const core = new THREE.Group(); core.name = 'core'; sls.add(core);
  const R = 3.0, PI = Math.PI;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const foam = foamTexture();
  const foamMat = std({ map: foam, bumpMap: foam, bumpScale: 1.1, roughness: .94, metalness: 0 });
  const ringsOf = (prof, r, y, dr, h) => prof.push([r, y], [r + dr, y + dr], [r + dr, y + h - dr], [r, y + h]);

  // — core stage barrel: boattail, engine section, LH2 tank, ribbed intertank, LOX tank, forward skirt
  const cp = [[2.35, CB], [2.6, CB + .25], [2.85, CB + .9], [R, CB + 1.8]];
  ringsOf(cp, R, 8.9, .08, .34); for (const y of [13.8, 18.7, 23.6, 28.1]) ringsOf(cp, R, y, .04, .2);
  ringsOf(cp, R, 30.5, .1, .4); ringsOf(cp, R, 35.5, .1, .4); ringsOf(cp, R, 39.1, .04, .2); ringsOf(cp, R, 43.1, .1, .4); cp.push([R, 44.6]);
  const coreMesh = new THREE.Mesh(revolve(cp, { segs: 80, phi0: PI }), foamMat); coreMesh.castShadow = coreMesh.receiveShadow = true; core.add(coreMesh);

  // — engine section hardware: heat-shield disc, 4 RS-25 bells (gold outer, black inner), feed lines
  const goldMat = std({ color: 0x9c7a3e, metalness: .78, roughness: .36 });
  const blackMat = std({ color: 0x151416, metalness: .45, roughness: .6 });
  const steelMat = std({ color: 0x8a8f96, metalness: .7, roughness: .42 });
  const gold = new Acc(), black = new Acc();
  black.geo(revolve([[0, CB], [2.35, CB]], { segs: 48 }));
  const bellO = [[.92, 0], [.88, .3], [.78, .85], [.66, 1.45], [.54, 2.0], [.42, 2.5], [.33, 2.95], [.28, 3.3], [.31, 3.6], [.43, 3.9], [.5, 4.3], [.5, 4.6], [0, 4.6]];
  const bellI = [[.85, 0], [.81, .3], [.71, .85], [.59, 1.45], [.47, 2.0], [.35, 2.5], [.26, 2.95], [.21, 3.3]];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    gold.geo(revolve(bellO, { segs: 22, smooth: 55 }), sx * 1.15, 4, sz * 1.15); black.geo(revolve(bellI, { segs: 22, flip: true }), sx * 1.15, 4, sz * 1.15);
    black.cyl(.95, .95, .12, sx * 1.15, 4.06, sz * 1.15, 20); gold.cyl(.62, .62, .5, sx * 1.15, CB + .2, sz * 1.15, 14);
  }
  gold.build(goldMat, core); black.build(blackMat, core);
  // external LOX feedline + cable tray (foam-insulated), brackets, foam ramps, umbilical plates, booster attach fittings (vertex-coloured, one draw call)
  const ext = new Acc(), polar = (a, r) => [r * Math.sin(a), r * Math.cos(a)];
  { const fa = -.88, [fx, fz] = polar(fa, R + .3);
    ext.paint(0xc9763f); ext.cyl(.3, .3, 31.5, fx, 26.6, fz, 14); ext.sph(.3, fx, 10.85, fz, 12, 8); ext.cyl(.05, .3, 2.6, fx, 43.7, fz, 12); ext.cyl(.3, .05, 2.2, fx, 9.8, fz, 12);
    ext.paint(0x8a5430); for (const y of [12, 17.2, 22.4, 27.6, 32.8, 38]) ext.cyl(.4, .4, .32, fx, y, fz, 14);
    ext.paint(0xd9985a); ext.box(1.0, 3.2, .8, fx, 40.4, fz, 0, fa, 0); ext.box(.9, 2.2, .7, fx, 14.4, fz, 0, fa, 0);
    const ca = .9, [cx, cz] = polar(ca, R + .14), [rx, rz] = polar(ca, R + .26);
    ext.paint(0xb8683a); ext.box(.78, 33.6, .3, cx, 26.6, cz, 0, ca, 0); ext.cyl(.04, .3, 2, cx, 44.2, cz, 8); ext.paint(0xe2b27a);
    for (let y = 10.2; y < 43.6; y += 3.3) ext.box(.96, .14, .46, rx, y, rz, 0, ca, 0);
    ext.paint(0x3c3f45); ext.box(1.2, 1.8, .35, (R + .1) * Math.sin(.95), 33, (R + .1) * Math.cos(.95), 0, .95, 0); ext.box(1.0, 1.4, .3, (R + .1) * Math.sin(.62), 41.5, (R + .1) * Math.cos(.62), 0, .62, 0);
    // SRB thrust fittings on the core: aft attach beam block + forward attach collar (the core keeps them after booster separation)
    ext.paint(0x4a4e55);
    for (const sx of [-1, 1]) {
      ext.box(1.5, 2.0, 3.6, sx * 3.18, 8.4, 0); ext.box(.9, .7, 4.4, sx * 3.1, 9.7, 0); ext.box(1.1, 1.3, 2.7, sx * 3.15, 35.9, 0);
      for (const sz of [-1, 1]) { ext.beam(V3(sx * 3.1, 7.5, sz * 1.5), V3(sx * 3.1, 11.4, sz * .5), .22); ext.beam(V3(sx * 3.12, 36.2, sz * 1.2), V3(sx * 3.12, 33.6, sz * .6), .2); }
    }
  }
  ext.build(std({ vertexColors: true, roughness: .8, metalness: .12 }), core);

  // — Launch Vehicle Stage Adapter, ICPS, Orion stage adapter, spacecraft adapter fairing (3 jettison panels)
  const lvsaTex = panelTexture([.06, .5, .95], 0), icpsTex = panelTexture([.1, .45, .92], 0, [238, 218, 176]), fairTex = panelTexture([.05, .5, .95], 3), lasTex = panelTexture([.2, .55, .85], 0);
  const skin = (t, c = 0xffffff) => std({ map: t, color: c, roughness: .5, metalness: .04 });
  const lvsaG = revolve([[R, 44.6], [R, 44.85], [2.84, 45.4], [1.86, 48.2], [1.78, 48.4]], { segs: 72, phi0: PI });
  const icpsP = [[1.78, 48.4], [1.72, 48.6], [1.7, 49.0]]; ringsOf(icpsP, 1.7, 50.0, .04, .2); ringsOf(icpsP, 1.7, 51.7, .04, .2); icpsP.push([1.7, 52.9], [1.66, 53.3]);
  const icpsG = revolve(icpsP, { segs: 56, phi0: PI });
  const osaG = revolve([[1.7, 53.3], [1.66, 53.55], [1.56, 54.2]], { segs: 56, phi0: PI });
  const fairG = revolve([[1.56, 54.2], [1.5, 54.5], [1.38, 56.2], [1.2, 57.6]], { segs: 60, phi0: PI });
  const put = (g, m, grp = core) => { const o = new THREE.Mesh(g, m); o.castShadow = o.receiveShadow = true; grp.add(o); return o; };
  put(lvsaG, skin(lvsaTex)); const icps = put(icpsG, skin(icpsTex)); put(osaG, skin(lvsaTex)); put(fairG, skin(fairTex));
  const bandBlack = new Acc(); bandBlack.cyl(1.73, 1.73, .4, 0, 52.5, 0, 40); bandBlack.cyl(1.6, 1.6, .2, 0, 54.3, 0, 40); bandBlack.build(std({ color: 0x2a2c30, roughness: .6, metalness: .2 }), core);

  // — Launch Abort System: ogive fairing, abort-motor tower, 4 canted abort nozzles, attitude-control ring, jettison motor
  const las = new THREE.Group(); las.name = 'LAS'; core.add(las);
  const lasP = [[1.18, 57.6], [1.16, 57.75], [1.15, 58.9], [1.1, 59.4], [.98, 59.9], [.8, 60.4], [.6, 60.8], [.46, 61.1], [.4, 61.3]];
  lasP.push([.4, 63.6], [.34, 63.8], [.34, 65.0], [.28, 65.3], [.12, 65.75], [.05, 65.8], [.05, 66.0], [0, 66.0]);
  put(revolve(lasP, { segs: 48, phi0: PI, smooth: 30 }), skin(lasTex), las);
  const lasD = new Acc().paint(0x151416);
  lasD.cyl(.415, .415, .12, 0, 62.0, 0, 28); lasD.cyl(.355, .355, .3, 0, 64.3, 0, 24); lasD.cyl(.29, .29, .1, 0, 65.45, 0, 20);
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + .39; lasD.box(.12, .12, .2, Math.sin(a) * .35, 64.5, Math.cos(a) * .35, 0, a, 0); }
  const nozzle = revolve([[.26, 0], [.2, .35], [.14, .75], [.1, 1.0], [0, 1.0]], { segs: 12 }), nozzleIn = revolve([[.22, 0], [.16, .35], [.1, .75]], { segs: 12, flip: true });
  const down = V3(0, -1, 0), cant = .5;
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + PI / 4, dir = V3(Math.sin(a) * Math.sin(cant), -Math.cos(cant), Math.cos(a) * Math.sin(cant)), p = V3(Math.sin(a) * .66, 60.95, Math.cos(a) * .66);
    for (const g of [nozzle.clone(), nozzleIn.clone()]) { _q.setFromUnitVectors(down, dir); _m.compose(p, _q, _s.set(1, 1, 1)); g.applyMatrix4(_m); lasD.list.push(g); }
  }
  // LAS tower struts, canards, jettison-motor nozzles, attitude-control ports, pitot probe
  lasD.paint(0x2a2c31);
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + PI / 4; lasD.beam(V3(Math.sin(a) * .62, 60.9, Math.cos(a) * .62), V3(Math.sin(a) * .36, 62.3, Math.cos(a) * .36), .07); lasD.beam(V3(Math.sin(a) * .5, 60.7, Math.cos(a) * .5), V3(Math.sin(a + .5) * .38, 62.0, Math.cos(a + .5) * .38), .035); }
  lasD.paint(0xdedbd2);
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU, sa = Math.sin(a), ca = Math.cos(a); lasD.geo(new THREE.BoxGeometry(.5, .018, .26), sa * .52, 65.05, ca * .52, 0, a, 0); lasD.geo(new THREE.BoxGeometry(.26, .018, .22), sa * .39, 63.0, ca * .39, 0, a + PI / 4, 0); }
  lasD.paint(0x151416);
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + .39 + .4, dir = V3(Math.sin(a) * .8, -.6, Math.cos(a) * .8); lasD.oriented(new THREE.CylinderGeometry(.045, .09, .22, 8), V3(Math.sin(a) * .31, 64.55, Math.cos(a) * .31), dir.negate()); }
  lasD.cyl(.012, .012, .5, 0, 66.0, 0, 6);
  lasD.build(std({ vertexColors: true, roughness: .55, metalness: .3 }), las);

  // — solid rocket boosters (5 segments), shared geometry, one group each
  const bTex = boosterTexture(), bodyMat = std({ map: bTex, roughness: .52, metalness: .03 });
  const bp = [[1.5, 3.0]]; for (const y of [9.72, 16.52, 23.32, 30.12]) ringsOf(bp, 1.5, y, .05, .16); ringsOf(bp, 1.5, 36.9, .06, .22);
  bp.push([1.5, 37.8], [1.38, 38.6], [1.12, 39.4], [.8, 40.1], [.4, 40.6], [0, 40.8]);
  const bodyG = revolve(bp, { segs: 56, phi0: PI });
  const dkMat = std({ color: 0x23272d, roughness: .62, metalness: .35, side: THREE.DoubleSide });
  const skirtAcc = new Acc();
  skirtAcc.geo(revolve([[0, 0], [2.12, 0], [2.12, .5], [1.96, 1.6], [1.62, 2.9], [1.52, 3.0]], { segs: 40, phi0: PI }));
  skirtAcc.geo(revolve([[1.12, 1.3], [1.04, 1.8], [.88, 2.4], [.7, 2.9], [.5, 3.3], [0, 3.3]], { segs: 28 }));
  skirtAcc.geo(revolve([[1.02, 1.3], [.94, 1.8], [.78, 2.4], [.6, 2.9]], { segs: 28, flip: true }));
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + .4; skirtAcc.cyl(.14, .22, .7, Math.sin(a) * 1.33, 38.2, Math.cos(a) * 1.33, 8, Math.sin(a) * .5, 0, Math.cos(a) * -.5); }
  for (let i = 0; i < 2; i++) skirtAcc.box(.4, .6, .4, 0, 3.4, i ? 1.52 : -1.52);
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + .4 + PI / 4; skirtAcc.cyl(.2, .12, .8, Math.sin(a) * 1.72, 2.1, Math.cos(a) * 1.72, 8, Math.cos(a) * .35, 0, -Math.sin(a) * .35); }
  const skirtG = merge(skirtAcc.list);
  const boosters = [];
  for (const side of [-1, 1]) {
    const b = new THREE.Group(); b.name = side < 0 ? 'boosterL' : 'boosterR'; b.position.x = side * 4.55; sls.add(b);
    put(bodyG, bodyMat, b); put(skirtG, dkMat, b);
    // attach hardware on the core-facing side (forward attach clamp, aft thrust fitting + struts), segment-joint clamp rings, cable raceway standoffs
    const hw = new Acc().paint(0x4a4e55), ix = -side * 1.5;
    hw.box(.6, 1.5, 2.6, ix, 35.9, 0); hw.box(.6, 1.9, 2.8, ix, 8.4, 0); hw.beam(V3(ix, 6.3, 1.1), V3(ix * 1.04, 11.6, .5), .17); hw.beam(V3(ix, 6.3, -1.1), V3(ix * 1.04, 11.6, -.5), .17);
    hw.beam(V3(ix, 10.6, 1.0), V3(ix * 1.02, 7.2, .4), .14); hw.beam(V3(ix, 10.6, -1.0), V3(ix * 1.02, 7.2, -.4), .14);
    hw.paint(0x62666e); for (const y of [9.8, 16.6, 23.4, 30.2]) hw.cyl(1.535, 1.535, .26, 0, y, 0, 32);
    hw.paint(0x2d3036); hw.cyl(1.54, 1.54, .34, 0, 36.7, 0, 32); hw.cyl(1.56, 1.56, .4, 0, 3.6, 0, 32);
    hw.build(std({ vertexColors: true, roughness: .55, metalness: .5 }), b);
    const anchor = new THREE.Group(); anchor.position.y = 1.3; b.add(anchor); b.userData.engineAnchor = anchor;
    boosters.push(b);
  }
  const coreEngineAnchor = new THREE.Group(); coreEngineAnchor.name = 'coreEngineAnchor'; coreEngineAnchor.position.y = 4; sls.add(coreEngineAnchor);
  sls.userData.parts = { las, icps };
  return { group: sls, core, boosters, coreEngineAnchor, las, icps };
}

/* ───────────────────────── coastal ground: height field, terrain, ocean ───────────────────────── */
const COAST = [[-2500, -1800], [-1800, -1250], [-900, -720], [-450, -470], [-100, -345], [250, -300], [700, -235], [1500, -130], [2400, 30]];
let FIELD = null;
function buildField() {
  if (FIELD) return FIELD;
  const N = HN, cell = 2 * EXT / (N - 1), data = new Float32Array(N * N);
  const poly = new THREE.CatmullRomCurve3(COAST.map(p => V3(p[0], 0, p[1])), false, 'centripetal').getPoints(1200), cz = new Float32Array(N);
  for (let i = 0, k = 0; i < N; i++) {
    const x = -EXT + i * cell; while (k < poly.length - 2 && poly[k + 1].x < x) k++;
    const a = poly[k], b = poly[k + 1];
    cz[i] = a.z + (b.z - a.z) * clamp((x - a.x) / ((b.x - a.x) || 1)) + 36 * (fbm(x * .0032 + 3, 1.7, 3, 81) - .5) * 2 + 7 * (fbm(x * .018, 4.2, 2, 82) - .5) * 2;
  }
  for (let j = 0; j < N; j++) {
    const z = -EXT + j * cell;
    for (let i = 0; i < N; i++) {
      const x = -EXT + i * cell, d = z - cz[i];
      const n1 = fbm(x * .003 + 9, z * .003 + 4, 3, 71), n2 = fbm(x * .011, z * .011, 2, 72), lagN = fbm(x * .0022 + 30, z * .0022 - 12, 3, 74);
      let land = G0 + (n1 - .5) * 1.5 + (n2 - .5) * .7;
      land += Math.max(0, 1 - ((d - 90) / 60) ** 2) * (.7 + 2.4 * n2);
      land = mix(land, SEA - 1.4, ss(.58, .68, lagN) * ss(70, 220, d) * ss(260, 430, Math.hypot(x, z)));
      let h;
      if (d > 0) h = mix(SEA - .1 + d * .055, land, ss(0, 46, d));
      else h = SEA - .1 + (d > -80 ? d * .03 : -2.4 + (d + 80) * .06);
      h = Math.max(h, SEA - 22);
      const pr = Math.pow(Math.pow(Math.abs(x), 4) + Math.pow(Math.abs(z + 6), 4), .25);
      h = mix(h, G0, 1 - ss(105, 200, pr));
      const cx = -Math.pow(Math.max(z - 240, 0), 2) * .00045;
      h = mix(h, G0 + .12, (1 - ss(16, 34, Math.abs(x - cx))) * ss(60, 130, z) * (z < 1800 ? 1 : 0));
      data[j * N + i] = h;
    }
  }
  const half = new Uint16Array(N * N); for (let i = 0; i < N * N; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const t = new THREE.DataTexture(half, N, N, THREE.RedFormat, THREE.HalfFloatType); t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.needsUpdate = true;
  const at = (x, z) => {
    const fx = clamp((x + EXT) / cell, 0, N - 1.001), fz = clamp((z + EXT) / cell, 0, N - 1.001), i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
    const a = data[j * N + i], b = data[j * N + i + 1], c = data[(j + 1) * N + i], d = data[(j + 1) * N + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (FIELD = { data, tex: t, at, cell });
}
// Terrain height (sea level = SEA, pad plateau = G0) for other modules that want to sit objects on the coast.
export function launchGroundHeight(x, z) { return buildField().at(x, z); }

const f1 = v => Number(v).toFixed(2);
const ROADS = [[-130, -124, 130, -124, 7], [130, -124, 130, 112, 7], [130, 112, -130, 112, 7], [-130, 112, -130, -124, 7], [45, -124, 45, -152, 6], [-130, 0, -420, -110, 7], [-420, -110, -860, -400, 7], [130, -30, 340, -62, 6]];
const GL_NOISE = `
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*vn(p);p=p*2.03+17.1;a*=.5;}return s/.9375;}
`;
const TERRAIN_HEAD = `varying vec3 vWP;uniform float uQ,uT;float gRough=.95;vec2 gGrad=vec2(0.);
${GL_NOISE}
float sdBox(vec2 p,vec2 b){vec2 d=abs(p)-b;return length(max(d,0.))+min(max(d.x,d.y),0.);}
float segD(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.));}
const vec4 ROADS[${ROADS.length}]=vec4[${ROADS.length}](${ROADS.map(r => `vec4(${f1(r[0])},${f1(r[1])},${f1(r[2])},${f1(r[3])})`).join(',')});
const float RW[${ROADS.length}]=float[${ROADS.length}](${ROADS.map(r => f1(r[4])).join(',')});
const vec4 TRK[3]=vec4[3](vec4(52.,98.,24.,10.),vec4(-46.,98.,-12.,-6.),vec4(78.,34.,30.,-22.));
`;
const TERRAIN_COLOR = `{
  vec2 p=vWP.xz;
  if(p.x>${f1(TRENCH.x0)}&&p.x<${f1(TRENCH.x1)}&&abs(p.y)<${f1(TRENCH.hz)})discard;
  float dc=length(vWP-cameraPosition),fd=1.-smoothstep(70.,520.,dc),hq=uQ>.5?1.:0.;
  float n1=fbm(p*.006),n2=uQ>.5?fbm(p*.03+5.):n1,n3=mix(.5,vn(p*.45),fd),n4=uQ>.5?mix(.5,vn(p*2.4),fd*fd):.5;
  float above=vWP.y-(${f1(SEA)});
  vec3 col=mix(vec3(.085,.115,.05),vec3(.27,.225,.105),smoothstep(.32,.72,n1));
  col=mix(col,vec3(.055,.08,.04),smoothstep(.52,.78,n2)*.42);
  col*=.8+.4*n3+.12*(n4-.5);
  float n5=mix(.5,vn(p*vec2(.9,1.3)+n1*4.),(1.-smoothstep(40.,320.,dc)));col*=.86+.28*n5;
  float sandM=1.-smoothstep(1.3,2.0+(n2-.5)*1.2,above);
  sandM=max(sandM,smoothstep(2.9,3.9,above+(n2-.5)*1.5));
  col=mix(col,vec3(.66,.57,.42)*(.86+.22*n3+.1*(n4-.5)),sandM);
  // dune relief: directional-derivative streaks (ridges across the sun axis, lit from the dawn side) replace the old soft blotches
  float dl=1.-smoothstep(160.,950.,dc);
  float dn0=vn(vec2(p.x*.026,p.y*.1)+n1*4.),dn1=vn(vec2(p.x*.026,(p.y+2.6)*.1)+n1*4.);
  col*=1.+(dn1-dn0)*(.45+1.05*sandM)*dl*1.3;
  float rp=vn(vec2(p.x*.5+n1*9.,p.y*2.3))-vn(vec2(p.x*.5+n1*9.,(p.y+.34)*2.3));
  col*=1.+rp*.3*sandM*fd*fd*hq;
  // wet sand follows a slow swash line instead of a fixed contour
  float swl=.85+.42*sin(uT*.6+p.x*.05+n1*7.)+(n2-.5)*.5;
  float wet=1.-smoothstep(-.2,swl,above);
  col=mix(col,col*vec3(.52,.5,.5),wet);gRough=mix(.92,.28,wet);
  col+=exp(-pow((above-swl)/.09,2.))*.1*sandM*fd;
  col=mix(col,vec3(.035,.06,.05),(1.-smoothstep(-1.6,0.,above))*.8);
  vec2 pc=p-vec2(0.,-6.);
  float padD=sdBox(pc,vec2(92.,98.))-9.;
  col=mix(col,vec3(.30,.275,.24)*(.8+.4*n3)*(.9+.2*n4),(1.-smoothstep(0.,26.,padD))*.95);
  float cx=-pow(max(p.y-240.,0.),2.)*.00045,dx=abs(p.x-cx),along=smoothstep(70.,100.,p.y);
  float lane=smoothstep(3.,3.8,dx)*(1.-smoothstep(13.4,14.2,dx))*along,shoulder=(1.-smoothstep(14.,19.,dx))*along;
  vec3 rock=vec3(.5,.485,.45)*(.82+.32*n3)*(.9+.18*n4)*(.88+.2*vn(vec2(p.x*1.4,p.y*.035)));
  col=mix(col,vec3(.2,.19,.16)*(.8+.4*n3),shoulder*(1.-lane)*.9);col=mix(col,rock,lane);
  float rd=1e3;for(int i=0;i<${ROADS.length};i++)rd=min(rd,segD(p,ROADS[i].xy,ROADS[i].zw)-RW[i]*.5);
  float road=1.-smoothstep(-.3,.9,rd);col=mix(col,vec3(.095,.097,.105)*(.85+.3*n3),road);gRough=mix(gRough,.7,road);
  float onPad=1.-smoothstep(-.4,.6,padD);
  vec3 conc=vec3(.5,.49,.46)*(.84+.3*n3+.1*(n2-.5));
  if(onPad>.001){
    // slab joints with a chamfered edge, per-slab tone, hairline cracks, oil stains and vehicle tyre tracks
    vec2 sl=floor(p/8.5),gq=abs(fract(p/8.5)-.5);float mg=max(gq.x,gq.y),jt=smoothstep(.484,.5,mg);
    conc*=.92+.15*h21(sl+3.7);
    conc*=1.-.3*jt*fd;conc+=.035*smoothstep(.465,.484,mg)*(1.-jt)*fd;
    float ck=1.-smoothstep(0.,.022,abs(vn(p*.55+sl*7.)-.5));conc*=1.-.22*ck*fd*hq;
    conc*=1.-.3*smoothstep(.62,.82,fbm(p*.11+3.))*fd;
    float tr=0.;for(int i=0;i<3;i++){float d=segD(p+(vec2(vn(p*.25),vn(p*.25+9.))-.5)*.6,TRK[i].xy,TRK[i].zw);tr=max(tr,1.-smoothstep(.1,.42,abs(d-.95)));}
    conc*=1.-.3*tr*(.45+.55*vn(p*vec2(1.6,.35)))*fd;
    float rr=length(vec2(p.x,p.y*1.2)),sg=smoothstep(0.,6.,uT),ang=atan(p.y,p.x),rays=.5+.9*vn(vec2(ang*6.+n1*3.,rr*.028));
    float streak=smoothstep(-20.,8.,p.x)*(1.-smoothstep(55.,135.,p.x))*exp(-pow(p.y/17.,2.));
    float sc=exp(-rr/38.)*.85*(.5+.5*sg)*(.65+.5*rays)+streak*.65*(.45+.55*sg)+.22*smoothstep(.5,.8,n2)+sg*exp(-rr/90.)*(.1+.38*rays*rays)*(.4+.6*vn(p*.2));
    conc=mix(conc,vec3(.05,.045,.04),clamp(sc,0.,.9));
    vec2 bp=p*2.7;float b0=vn(bp);gGrad=vec2(vn(bp+vec2(.08,0.))-b0,vn(bp+vec2(0.,.08))-b0)*onPad*fd*fd*hq*1.1;
  }
  col=mix(col,conc,onPad);gRough=mix(gRough,.88,onPad);
  diffuseColor.rgb=col;
}`;

function buildTerrain(F) {
  const NA = 360, rings = [0]; let r = 0;
  while (r < 2150) { r += r < 420 ? 4.7 : 4.7 * (1 + (r - 420) * .0035); rings.push(r); }
  const NR = rings.length, W = NA + 1, pos = new Float32Array(NR * W * 3), nor = new Float32Array(NR * W * 3), uv = new Float32Array(NR * W * 2), e = 3;
  for (let ri = 0; ri < NR; ri++) for (let ai = 0; ai < W; ai++) {
    const a = ai / NA * TAU, x = rings[ri] * Math.cos(a), z = rings[ri] * Math.sin(a), o = (ri * W + ai) * 3;
    pos[o] = x; pos[o + 1] = F.at(x, z); pos[o + 2] = z;
    const dx = F.at(x + e, z) - F.at(x - e, z), dz = F.at(x, z + e) - F.at(x, z - e), l = Math.hypot(dx, 2 * e, dz);
    nor[o] = -dx / l; nor[o + 1] = 2 * e / l; nor[o + 2] = -dz / l; uv[(ri * W + ai) * 2] = x / 100; uv[(ri * W + ai) * 2 + 1] = z / 100;
  }
  const idx = new Uint32Array((NR - 1) * NA * 6); let k = 0;
  for (let ri = 0; ri < NR - 1; ri++) for (let ai = 0; ai < NA; ai++) { const a = ri * W + ai, b = a + 1, c = a + W, d = c + 1; idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .95, metalness: 0 });
  m.userData.uQ = { value: 1 }; m.userData.uT = { value: 0 };
  m.onBeforeCompile = sh => {
    sh.uniforms.uQ = m.userData.uQ; sh.uniforms.uT = m.userData.uT;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP=(modelMatrix*vec4(transformed,1.)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + TERRAIN_HEAD).replace('#include <color_fragment>', '#include <color_fragment>\n' + TERRAIN_COLOR).replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal=normalize(normal-(viewMatrix*vec4(gGrad.x,0.,gGrad.y,0.)).xyz*.9);').replace('#include <roughnessmap_fragment>', 'float roughnessFactor=gRough;').replace('#include <fog_fragment>', '#include <fog_fragment>\n#ifdef USE_FOG\ngl_FragColor.rgb=mix(gl_FragColor.rgb,fogColor,smoothstep(1450.,2100.,length(vWP.xz)));\n#endif');
  };
  m.customProgramCacheKey = () => 'lc39b-terrain';
  const o = new THREE.Mesh(g, m); o.receiveShadow = true; o.castShadow = false; o.frustumCulled = false; o.name = 'terrain';
  return o;
}

const FALLBACK_SKY = `
uniform vec3 uSunDir;uniform float uTime,uCloud,uSeed,uStars;
vec3 skyColor(vec3 d,bool full,int oct){float e=max(d.y,0.),s=max(dot(d,uSunDir),0.);vec3 c=mix(vec3(.2,.13,.17),vec3(.01,.025,.09),smoothstep(0.,.5,e));return c+vec3(1.,.42,.14)*(pow(s,6.)*.5+pow(s,90.)*2.);}
`;
function buildOcean(F) {
  const hasSky = !!(SKY.NOISE_GLSL && SKY.SKY_GLSL && SKY.NOISE_GLSL.includes('fbm') && SKY.SKY_GLSL.includes('skyColor'));
  const skyChunk = hasSky ? SKY.NOISE_GLSL + SKY.SKY_GLSL : FALLBACK_SKY;
  const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { t: { value: 0 }, uH: { value: F.tex }, uExt: { value: EXT }, uSea: { value: SEA }, uQ: { value: 1 }, uSunDir: { value: DAWN_SUN_DIR }, uTime: { value: 0 }, uCloud: { value: 1 }, uSeed: { value: 7 }, uStars: { value: 0 } }]);
  const m = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, fog: true,
    vertexShader: `varying vec3 vWP;
#include <fog_pars_vertex>
void main(){vec4 wp=modelMatrix*vec4(position,1.);vWP=wp.xyz;vec4 mvPosition=viewMatrix*wp;gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`,
    fragmentShader: `uniform float t,uExt,uSea,uQ;uniform sampler2D uH;varying vec3 vWP;
#include <common>
#include <fog_pars_fragment>
${GL_NOISE}
${skyChunk}
float ggx(float nh,float a){float a2=a*a,k=nh*nh*(a2-1.)+1.;return a2/(3.14159*k*k);}
void main(){
  vec2 p=vWP.xz;float g=texture2D(uH,p/(2.*uExt)+.5).r,depth=uSea-g;depth=mix(depth,14.,smoothstep(uExt-300.,uExt-40.,max(abs(p.x),abs(p.y))));
  vec3 V=cameraPosition-vWP;float dist=length(V);V/=dist;
  float near=exp(-dist/420.),mid=exp(-dist/1150.),amp=smoothstep(.05,1.6,depth)*(.35+.65*smoothstep(1.,4.,depth));
  vec2 q=p+vec2(vn(p*.017+t*.04),vn(p*.017+7.-t*.03))*7.-3.5;
  // long ocean swell (visible out to the horizon) + shorter wind waves + capillary ripples near the camera
  float a0=dot(q,vec2(.16,.987))*.105-t*.6,a1=dot(q,vec2(.42,.91))*.55-t*1.15,a2=dot(q,vec2(-.8,.6))*.95-t*1.45,a3=dot(q,vec2(.97,-.23))*1.7-t*1.9,a4=dot(q,vec2(.2,-.98))*3.1-t*2.6,a5=dot(q,vec2(-.6,-.8))*2.3-t*2.1;
  vec2 gr=(vec2(.16,.987)*cos(a0)*.11*(.45+.9*vn(p*.0052+9.))+vec2(-.38,.925)*cos(dot(q,vec2(-.38,.925))*.073-t*.5+1.3)*.085*(.4+.9*vn(p*.0035+3.)))*(.22+.78*mid)+(vec2(.42,.91)*cos(a1)*.05+vec2(-.8,.6)*cos(a2)*.045)*(.35+.65*near)+(vec2(.97,-.23)*cos(a3)*.05+vec2(.2,-.98)*cos(a4)*.045+vec2(-.6,-.8)*cos(a5)*.04)*uQ*near;
  vec2 rip=vec2(vn(p*1.3+vec2(t*.4,-t*.3)),vn(p*1.3+31.+vec2(-t*.3,t*.5)))-.5;
  gr=(gr+rip*.2*uQ*near)*amp;
  vec3 n=normalize(vec3(-gr.x,1.,-gr.y));
  vec3 R=reflect(-V,n);R.y=abs(R.y)+.07+.16*smoothstep(80.,1400.,dist);R=normalize(R);
  float NV=max(dot(n,V),0.),F=.02+.98*pow(1.-NV,5.);
  vec3 body=mix(vec3(.04,.15,.15),vec3(.005,.02,.045),smoothstep(.2,5.,depth));
  vec3 refl=skyColor(R,false,uQ>.5?2:1);
  // wind lanes: long cat's-paw bands of rougher / calmer water break up the sea out to the horizon
  float lane=vn(p*vec2(.006,.032)+vec2(t*.012,0.))*.6+vn(p*vec2(.019,.085)-vec2(t*.02,t*.008))*.4;
  refl*=1.+(lane-.5)*.7*(1.-near)*smoothstep(0.,1.2,depth);
  vec3 col=mix(body,refl*.8,clamp(F*.52,0.,1.));
  // sun glitter: facets are wide across the view direction, so the glints are short horizontal dashes that thin out with distance
  vec3 H=normalize(V+uSunDir);float al=.17+.12*smoothstep(150.,1600.,dist);
  float sp1=vn(p*vec2(.55,1.35)+vec2(t*.45,t*.3))*.55+vn(p*vec2(1.7,3.7)-vec2(t*.6,-t*.5))*.45+(rip.x+rip.y)*.5;
  float sp2=vn(p*vec2(.07,.3)+vec2(t*.1,-t*.07))*.58+vn(p*vec2(.17,.6)-vec2(t*.13,t*.05))*.42;
  float spk=smoothstep(.5,.95,mix(sp2*1.1,sp1,near));
  float gl=(ggx(max(dot(n,H),0.),al)*.05+ggx(max(H.y,0.),.34)*.14*(.16+2.1*spk*(.45+.55*near)))*(.3+F);
  // surf: a swash sheet with a bright runup edge, plus three broken wave fronts that steepen, break and run up the beach
  float foam=0.,bright=0.;
  if(depth<2.9&&depth>-.6){
    float wob=vn(p*.08+t*.05);
    float sw=.09+.1*(.5+.5*sin(t*.55+p.x*.045+wob*6.));
    float lc=vn(p*1.2+vec2(t*.22,-t*.16))*.55+vn(p*3.4-vec2(0.,t*.3))*.45,lace=smoothstep(.38,.66,lc);
    foam=(1.-smoothstep(sw*.6,sw*1.7,depth))*(.5+.5*lace);
    bright=exp(-pow((depth-sw)/.022,2.))*.8;
    for(int k=0;k<3;k++){
      float kf=float(k),ph=fract(t*.075+kf*.333+.16*vn(p*.018+kf*13.));
      float f=depth-(.1+2.2*pow(1.-ph,1.6));
      float w=smoothstep(0.,.12,ph)*(1.-smoothstep(.82,1.,ph))*smoothstep(.32,.58,vn(vec2(p.x*.05+kf*17.,kf*3.+t*.03)));
      float lead=exp(-pow(f/.05,2.)),trail=f<0.?exp(f/.34)*step(sw,depth):0.;
      foam+=w*(lead*.95+trail*.7*lace);bright+=w*lead*.9;
    }
    foam=clamp(foam,0.,1.);
  }
  vec3 foamC=(vec3(.52,.48,.47)+refl*.35)*(1.+bright*.9);
  col=mix(col,foamC,foam*.8);
  float alpha=smoothstep(0.,.35,depth);alpha=max(mix(alpha,1.,smoothstep(.4,2.5,depth)),foam*.92);
#ifdef USE_FOG
 #ifdef FOG_EXP2
  float fogF=1.-exp(-fogDensity*fogDensity*vFogDepth*vFogDepth);
 #else
  float fogF=smoothstep(fogNear,fogFar,vFogDepth);
 #endif
#else
  float fogF=1.-exp(-pow(dist*.0015,2.));
#endif
  vec3 farC=mix(skyColor(normalize(vec3(-V.x,.012,-V.z)),false,1)*.34,vec3(.02,.028,.06),.35);
  col=mix(col,farC,fogF);
  // swell relief survives the haze: facets tilted toward the dawn sun catch light, the lee side and calm lanes go darker
  float rel=(gr.y*2.0+(lane-.5)*.6)*exp(-dist/2800.)*smoothstep(0.,1.,depth);col*=1.+rel;col+=vec3(1.,.5,.22)*max(rel,0.)*.1;
  // horizon haze: the sea dissolves into a warm veil toward the sun
  float hz=1.-exp(-dist/2600.);col=mix(col,farC*1.35+vec3(.02,.01,.012),hz*hz*.5);
  col+=vec3(1.,.56,.26)*min(gl,12.)*exp(-dist/3200.)*(1.-foam*.7);
  alpha*=1.-smoothstep(4700.,5800.,dist);
  gl_FragColor=vec4(col,alpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`
  });
  const o = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000), m); o.rotation.x = -Math.PI / 2; o.position.y = SEA; o.renderOrder = 1; o.frustumCulled = false; o.name = 'ocean';
  return o;
}

// Thin broken low cloud bank lying on the sea horizon (open cylinder inside the sky dome, warm toward the dawn sun, only over water).
function makeCloudBank(F) {
  const m = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 }, uSunDir: { value: DAWN_SUN_DIR }, uH: { value: F.tex }, uExt: { value: EXT }, uSea: { value: SEA }, uA: { value: 1 } },
    transparent: true, depthWrite: false, side: THREE.BackSide,
    vertexShader: 'varying vec3 vP;void main(){vec4 w=modelMatrix*vec4(position,1.);vP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}',
    fragmentShader: `uniform float t,uExt,uSea,uA;uniform vec3 uSunDir;uniform sampler2D uH;varying vec3 vP;
#include <common>
${GL_NOISE}
void main(){
  float h=clamp((vP.y-uSea)/${BANK_H.toFixed(1)},0.,1.);
  vec2 hd=normalize(vP.xz+1e-4);float wA=smoothstep(-.55,1.,dot(hd,normalize(uSunDir.xz)));
  vec2 c=vP.xz*.0058+vec2(h*3.1+t*.0035,h*1.7);
  float n=fbm(c)*.62+fbm(c*2.7+vec2(5.,t*.006))*.38,streak=vn(vP.xz*.021+vec2(h*5.,0.));
  float prof=smoothstep(.02,.2,h)*(1.-smoothstep(.34,.95,h)),dens=smoothstep(.42,.7,n+(streak-.5)*.2)*prof;
  float g=texture2D(uH,vP.xz/(2.*uExt)+.5).r,sea=smoothstep(-.1,.7,uSea-g);
  vec3 hor=mix(vec3(.12,.085,.125),vec3(.78,.27,.075),pow(wA,3.4));
  vec3 shd=mix(vec3(.05,.035,.075),vec3(.22,.09,.08),wA),lit=mix(vec3(.3,.14,.17),vec3(1.,.46,.16)*1.15,wA);
  vec3 col=mix(shd,lit,clamp(smoothstep(.04,.6,h)*(.45+.7*(n-.4)*2.)+.18,0.,1.));
  col=mix(col,hor*1.1,.35);
  gl_FragColor=vec4(col,dens*sea*uA*.62);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`
  });
  const o = new THREE.Mesh(new THREE.CylinderGeometry(2000, 2000, BANK_H, 96, 1, true), m); o.position.y = SEA + BANK_H / 2 - 4; o.renderOrder = 1; o.frustumCulled = false; o.name = 'cloud-bank';
  return o;
}

/* ───────────────────────── instanced glow lights & deluge sprites ───────────────────────── */
function quadGeo(n) {
  const base = new THREE.PlaneGeometry(1, 1), g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv); g.instanceCount = n; return g;
}
const inst = (g, name, arr, size) => g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
// items: [x,y,z, r,g,b, worldSize, intensity, mode(0 steady,1 aviation flash,2 flicker), phase]
function makeLights(items) {
  const n = items.length, g = quadGeo(n), P = new Float32Array(n * 3), C = new Float32Array(n * 3), S = new Float32Array(n * 2), M = new Float32Array(n * 2);
  items.forEach((it, i) => { P.set(it.slice(0, 3), i * 3); C.set(it.slice(3, 6), i * 3); S[i * 2] = it[6]; S[i * 2 + 1] = it[7]; M[i * 2] = it[8] || 0; M[i * 2 + 1] = it[9] ?? hash(i, 5, 17); });
  inst(g, 'aPos', P, 3); inst(g, 'aCol', C, 3); inst(g, 'aS', S, 2); inst(g, 'aM', M, 2);
  const m = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec3 aPos,aCol;attribute vec2 aS,aM;uniform float t;varying vec2 vUv;varying vec3 vC;varying float vSz;
void main(){vUv=uv;vSz=aS.x;vec4 mv=viewMatrix*modelMatrix*vec4(aPos,1.);float d=-mv.z,k=1.;
if(aM.x>.5&&aM.x<1.5){float f=fract(t/1.5+aM.y);k=.03+smoothstep(0.,.04,f)*(1.-smoothstep(.1,.32,f));}
else if(aM.x>1.5&&aM.x<2.5)k=.78+.22*sin(t*17.+aM.y*40.)*sin(t*7.3+aM.y*11.);
else if(aM.x>3.5){float f=fract(t/9.+aM.y);k=.12+2.*smoothstep(0.,.02,f)*(1.-smoothstep(.04,.16,f));}
else if(aM.x>2.5)k=(.8+.2*sin(t*23.+aM.y*40.)*sin(t*9.1+aM.y*7.))*(1.-smoothstep(3.5,7.5,t));
float s=max(aS.x,d*.0034)*(aM.x>1.5?.85+.3*k:1.)*(aS.x<4.?2.1:1.);mv.xy+=position.xy*s;vC=aCol*aS.y*k;gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `varying vec2 vUv;varying vec3 vC;varying float vSz;
#include <common>
void main(){vec2 c=vUv-.5;float r=length(c)*2.,sm=1.-smoothstep(3.,8.,vSz);
// small lamps: tight hot core plus a faint cross glint; big glows (ignition light) keep the soft falloff
float core=pow(max(1.-r,0.),mix(2.2,6.5,sm)),cr=(exp(-abs(c.x)*70.)*exp(-abs(c.y)*7.)+exp(-abs(c.y)*70.)*exp(-abs(c.x)*7.))*.5*sm*step(r,1.);
float a=core+cr;gl_FragColor=vec4(vC*a,1.);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`
  });
  const o = new THREE.Mesh(g, m); o.frustumCulled = false; o.renderOrder = 6; return o;
}

// Ballistic soft-sprite emitter bank, a pure function of t. E = [x,y,z, dx,dy,dz] per emitter; p = { speed, spread, grav, life, size0, size1, rate, col, alpha }.
function makeSprayBank(E, per, p) {
  const n = E.length * per, g = quadGeo(n), P = new Float32Array(n * 3), D = new Float32Array(n * 3), Rr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const e = E[i % E.length]; P.set(e.slice(0, 3), i * 3); D.set(e.slice(3, 6), i * 3); for (let k = 0; k < 4; k++) Rr[i * 4 + k] = hash(i, k, 29 + (p.seed || 0)); }
  inst(g, 'aPos', P, 3); inst(g, 'aDir', D, 3); inst(g, 'aR', Rr, 4);
  const m = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 }, env: { value: 0 }, map: { value: null }, uCol: { value: new THREE.Color(...p.col) } }, transparent: true, depthWrite: false,
    vertexShader: `attribute vec3 aPos,aDir;attribute vec4 aR;uniform float t,env;varying vec2 vUv;varying float vA;
void main(){vUv=uv;float life=fract(t*(${f1(p.rate)}+.45*${f1(p.rate)}*aR.x)+aR.y),tt=life*${f1(p.life)};
vec3 d=normalize(aDir+(aR.xyz-.5)*vec3(${f1(p.spread)},${f1(p.spread * .7)},${f1(p.spread)})),q=aPos+d*(${f1(p.speed[0])}+${f1(p.speed[1])}*aR.z)*tt+vec3(0.,(${f1(-p.grav)})*tt*tt,0.);
vec4 mv=viewMatrix*modelMatrix*vec4(q,1.);float s=mix(${f1(p.size0)},${f1(p.size1)},life)*(.7+.6*aR.w);mv.xy+=position.xy*s;
vA=env*(1.-life)*smoothstep(0.,.08,life)*${f1(p.alpha)};gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `uniform sampler2D map;uniform vec3 uCol;varying vec2 vUv;varying float vA;
#include <common>
void main(){float a=texture2D(map,vUv).a;gl_FragColor=vec4(uCol,a*vA);
#include <colorspace_fragment>
}`
  });
  const o = new THREE.Mesh(g, m); o.frustumCulled = false; o.renderOrder = 7; o.visible = false; o.userData.count = n;
  return o;
}
function softMap() {
  const c = canvas(64, 64), g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.35, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Low ground mist drifting over the marsh and lagoons (cheap alpha plane, fades when the camera is high or close).
function makeMist() {
  const m = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 }, uCol: { value: new THREE.Color(.2, .15, .14) } }, transparent: true, depthWrite: false,
    vertexShader: 'varying vec3 vWP;void main(){vec4 w=modelMatrix*vec4(position,1.);vWP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}',
    fragmentShader: `uniform float t;uniform vec3 uCol;varying vec3 vWP;
#include <common>
${GL_NOISE}
void main(){vec2 p=vWP.xz;float n=fbm(p*.0042+vec2(t*.012,t*.004))*.7+fbm(p*.013-vec2(t*.02,0.))*.3;
float r=length(p-cameraPosition.xz),f=smoothstep(70.,220.,r)*(1.-smoothstep(1100.,2000.,r))*smoothstep(110.,300.,length(p));
float h=cameraPosition.y-vWP.y,a=smoothstep(.4,.78,n)*f*.55*(1.-smoothstep(70.,300.,h));
gl_FragColor=vec4(uCol,a);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`
  });
  const o = new THREE.Mesh(new THREE.PlaneGeometry(4800, 4800), m); o.rotation.x = -Math.PI / 2; o.position.y = G0 + 2.2; o.renderOrder = 2; o.frustumCulled = false; o.name = 'mist';
  return o;
}
// A few flocks of birds crossing behind the pad at dawn (instanced, flapping in the vertex shader).
function makeBirds(n) {
  const g = new THREE.InstancedBufferGeometry(), S = new Float32Array(n * 4);
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, .35, -1, 0, -.1, 1, 0, -.1, 0, 0, -.45], 3)); g.setIndex([0, 1, 3, 0, 3, 2]);
  for (let i = 0; i < n; i++) { const fl = i % 3; S[i * 4] = hash(i, 1, 41); S[i * 4 + 1] = hash(fl, 2, 41); S[i * 4 + 2] = hash(i, 3, 41) * .5 + fl * .5; S[i * 4 + 3] = hash(i, 4, 41); }
  inst(g, 'aS', S, 4); g.instanceCount = n;
  const m = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 } }, side: THREE.DoubleSide,
    vertexShader: `attribute vec4 aS;uniform float t;varying float vD;
void main(){float ph=aS.x*6.2831,spd=6.5+3.*aS.y,s=t*spd+aS.z*120.+aS.y*200.,L=520.;float m=mod(s,L);
vec3 base=vec3(190.+aS.z*70.,26.+aS.w*30.+aS.y*14.,-100.-aS.y*90.);
float w=m*.035+ph;vec3 pos=base+vec3(-m,sin(t*.8+ph)*2.5,sin(w)*14.);
vec3 f=normalize(vec3(-1.,0.,cos(w)*.5)),r=normalize(cross(f,vec3(0.,1.,0.)));
float fl=sin(t*(7.+3.*aS.w)+ph*3.)*.55*abs(position.x),sz=.9+.5*aS.w;
vec3 q=pos+(r*position.x+vec3(0.,position.y+fl,0.)+f*position.z)*sz;
vec4 mv=viewMatrix*vec4(q,1.);vD=-mv.z;gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `varying float vD;
#include <common>
void main(){gl_FragColor=vec4(vec3(.012,.012,.016)+vec3(.1,.06,.05)*smoothstep(600.,1500.,vD),1.);
#include <colorspace_fragment>
}`
  });
  const o = new THREE.Mesh(g, m); o.frustumCulled = false; o.name = 'birds'; return o;
}

// Scrub clump: 4 lumpy blobs with smooth normals and a dark underside (vertex colours), merged into one tiny geometry for instancing.
function bushGeometry() {
  const list = [], offs = [[0, 0, 0, 1], [.78, -.12, .34, .68], [-.62, -.06, -.5, .74], [.12, .04, -.86, .55]];
  offs.forEach(([ox, oy, oz, s], i) => {
    const g = new THREE.IcosahedronGeometry(1, i ? 0 : 1), p = g.attributes.position, nr = g.attributes.normal, col = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k), r = 1 + (hash(Math.round(x * 9), Math.round(y * 9), Math.round(z * 9) + i * 5) - .5) * .42;
      p.setXYZ(k, x * r * s + ox, y * r * s * .6 + oy, z * r * s + oz); nr.setXYZ(k, x, y * 1.3, z);
      const sh = .42 + .58 * ss(-.9, .8, y); col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = sh * (.88 + .24 * hash(Math.round(x * 5), Math.round(z * 5), i));
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); list.push(g);
  });
  return merge(list);
}

// Far scrub: one lumpy 20-triangle blob (the near LOD above has four overlapping blobs).
function bushFarGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 0), p = g.attributes.position, nr = g.attributes.normal, col = new Float32Array(p.count * 3);
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k), y = p.getY(k), z = p.getZ(k), r = 1 + (hash(Math.round(x * 9), Math.round(y * 9), Math.round(z * 9) + 3) - .5) * .5;
    p.setXYZ(k, x * r * 1.15, y * r * .62, z * r * 1.15); nr.setXYZ(k, x, y * 1.3, z);
    col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = (.42 + .58 * ss(-.9, .8, y)) * (.9 + .2 * hash(Math.round(x * 5), Math.round(z * 5), 4));
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return merge([g]);
}
// paint a geometry with a base colour modulated by (optionally) a per-vertex shade function
function tint(g, hex, shade = () => 1) {
  const c = new THREE.Color(hex), p = g.attributes.position, a = new Float32Array(p.count * 3);
  for (let k = 0; k < p.count; k++) { const s = shade(p.getX(k), p.getY(k), p.getZ(k), k); a[k * 3] = c.r * s; a[k * 3 + 1] = c.g * s; a[k * 3 + 2] = c.b * s; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g;
}
// Slash pine: trunk + five jittered, rotated cone tiers (no longer one perfect cone).
function pineGeometry() {
  const list = [], trunk = new THREE.CylinderGeometry(.2, .42, 5.6, 6); trunk.translate(0, 2.8, 0); list.push(tint(trunk, 0x4a3524, (x, y) => .6 + .4 * y / 5.6));
  const tiers = [[2.9, 3.6, 3.0, 0x1d3a1b], [2.45, 3.2, 5.0, 0x234120], [1.95, 2.9, 7.0, 0x294a25], [1.4, 2.6, 8.9, 0x2f5329], [.8, 2.3, 10.6, 0x36602f]];
  tiers.forEach(([r, h, y0, c], i) => {
    const g = new THREE.ConeGeometry(r, h, 8, 1, false), p = g.attributes.position;
    for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k), z = p.getZ(k), j = y < 0 ? 1 + (hash(Math.round(x * 7), Math.round(z * 7), i) - .5) * .34 : 1; p.setXYZ(k, x * j, y, z * j); }
    g.rotateY(hash(i, 3, 5) * 6.28); g.translate(0, y0 + h / 2, 0); g.computeVertexNormals();
    list.push(tint(g, c, (x, y) => .55 + .55 * ss(y0, y0 + h, y + 0)));
  });
  return merge(list);
}
// Cabbage palm: bent ringed trunk and a crown of ten drooping fronds (double-sided strips).
function palmGeometry() {
  const list = [], H = 10.5, tr = new THREE.CylinderGeometry(.2, .36, H, 6, 7, true), tp = tr.attributes.position;
  for (let k = 0; k < tp.count; k++) { const f = (tp.getY(k) + H / 2) / H; tp.setX(k, tp.getX(k) + f * f * 2.0); tp.setY(k, tp.getY(k) + H / 2); }
  tr.computeVertexNormals(); list.push(tint(tr, 0x75583a, (x, y) => (Math.floor(y / .6) % 2 ? .78 : 1) * (.7 + .3 * y / H)));
  const cx = 2.0, fc = [0x2c5a26, 0x3b6c2c, 0x4a7a33];
  for (let i = 0; i < 11; i++) {
    const a = i / 11 * TAU + (hash(i, 1, 2) - .5) * .35, L = 3.5 + hash(i, 2, 2) * 1.3, S = 6, pos = [], nor = [], col = [], idx = [], px = Math.cos(a), pz = -Math.sin(a), cc = new THREE.Color(fc[i % 3]);
    for (let s = 0; s <= S; s++) {
      const t = s / S, hx = Math.sin(a) * L * t, hz = Math.cos(a) * L * t, hy = L * (.36 * t - .62 * t * t) + (i % 2 ? .1 : .4) * t, w = .75 * (Math.sin(Math.min(1, t * 1.05 + .1) * Math.PI) * .85 + .15) * (1 - t * .3), sh = .55 + .5 * t + .12 * hash(i, s, 6);
      for (const sd of [-1, 1]) { pos.push(cx + hx + px * w * sd, H + hy - Math.abs(sd) * 0 - w * .35 * (1 - t * .5), hz + pz * w * sd); nor.push(0, 1, 0); col.push(cc.r * sh, cc.g * sh, cc.b * sh); }
      if (s < S) { const b = s * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); list.push(g);
  }
  const nut = new THREE.IcosahedronGeometry(.55, 0); nut.translate(cx, H - .3, 0); list.push(tint(nut, 0x3a2f1c));
  return merge(list);
}
// Live oak: short trunk and a broad crown of four lumpy blobs with a dark underside.
function oakGeometry() {
  const list = [], trunk = new THREE.CylinderGeometry(.3, .55, 3.4, 6); trunk.translate(0, 1.7, 0); list.push(tint(trunk, 0x4a3a2a, (x, y) => .6 + .4 * y / 3.4));
  [[0, 5.0, 0, 2.7], [1.9, 4.4, .8, 1.9], [-1.8, 4.5, -.7, 2.0], [.3, 4.3, -1.9, 1.7]].forEach(([ox, oy, oz, s], i) => {
    const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position, nr = g.attributes.normal;
    for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k), z = p.getZ(k), r = 1 + (hash(Math.round(x * 9), Math.round(y * 9), Math.round(z * 9) + i * 7) - .5) * .4; p.setXYZ(k, x * r * s * 1.25 + ox, y * r * s * .72 + oy, z * r * s * 1.25 + oz); nr.setXYZ(k, x, y * 1.2, z); }
    list.push(tint(g, [0x2c4f26, 0x335a2a, 0x2a4a24, 0x37602c][i], (x, y) => .4 + .75 * ss(oy - s * .7, oy + s * .7, y)));
  });
  return merge(list);
}

/* ───────────────────────── LC-39B launch complex ───────────────────────── */
// Pad centre at the origin (the SLS stands on the ML deck, deck top y=0, pad concrete G0=-2.8). Ocean toward -Z, crawlerway toward +Z,
// Mobile Launcher tower behind the rocket (-Z side, between the SRBs' plane), VAB far to the left, three lightning masts around the pad.
// All animation lives in site.userData.tick(t, ctx): arms swing away at t>=0, deluge 0..6 s, blinking aviation lights, water/foam.
export function createLaunchSite(world) {
  const site = new THREE.Group(); site.name = 'LC-39B'; world.add(site);
  const F = buildField(), rand = makeRng(39021), ticks = [], L = [];
  const std = o => new THREE.MeshStandardMaterial(o);
  const PI = Math.PI, c = TOWER.hw - .35, H = TOWER.h;
  const terrain = buildTerrain(F); site.add(terrain);
  const ocean = buildOcean(F); site.add(ocean);
  const bank = makeCloudBank(F); site.add(bank);
  const mist = makeMist(); site.add(mist);
  ticks.push((t, cx) => { const u = ocean.material.uniforms; u.t.value = t; u.uTime.value = t; u.uQ.value = cx.quality === 'low' ? 0 : 1; terrain.material.userData.uQ.value = u.uQ.value; terrain.material.userData.uT.value = t; bank.material.uniforms.t.value = t; bank.visible = cx.quality !== 'low'; mist.material.uniforms.t.value = t; mist.visible = cx.quality !== 'low'; });

  /* — Mobile Launcher deck with exhaust opening, flame trench + deflector — */
  const deckTex = deckTexture(); deckTex.repeat.set(1 / 18, 1 / 18);
  const ds = new THREE.Shape(); ds.moveTo(DECK.x0, -DECK.z1); ds.lineTo(DECK.x1, -DECK.z1); ds.lineTo(DECK.x1, -DECK.z0); ds.lineTo(DECK.x0, -DECK.z0); ds.closePath();
  const hx = 6.7, hy = 2.9, hole = new THREE.Path();
  hole.moveTo(-hx + hy, -hy); hole.lineTo(hx - hy, -hy); hole.absarc(hx - hy, 0, hy, -PI / 2, PI / 2, false); hole.lineTo(-hx + hy, hy); hole.absarc(-hx + hy, 0, hy, PI / 2, 3 * PI / 2, false); ds.holes.push(hole);
  const dg = new THREE.ExtrudeGeometry(ds, { depth: DECK.thick, bevelEnabled: false, curveSegments: 14 }); dg.rotateX(-PI / 2); dg.translate(0, -DECK.thick, 0);
  const deck = new THREE.Mesh(dg, std({ map: deckTex, roughness: .72, metalness: .35 })); deck.castShadow = deck.receiveShadow = true; deck.name = 'ML-deck'; site.add(deck);
  // static steel/paint is batched by vertex colour into two meshes (PAINT: painted steel, METAL: bare metal) to keep draw calls low
  const C_RED = 0x8c5a48, C_GREY = 0x6d7580, C_WHITE = 0xe4e2dc, C_DARK = 0x1b1e23;
  const paintMat = std({ vertexColors: true, metalness: .3, roughness: .56 }), metalMat = std({ vertexColors: true, metalness: .55, roughness: .45 });
  const PAINT = new Acc(), METAL = new Acc();
  const A = new Acc().paint(C_GREY), W = new Acc().paint(0x7d8186), K = new Acc().paint(C_DARK);
  // perimeter rail + posts + ribs
  const rx0 = DECK.x0 + .3, rx1 = DECK.x1 - .3, rz0 = DECK.z0 + .3, rz1 = DECK.z1 - .3;
  for (const y of [.55, 1.1]) { A.box(rx1 - rx0, .1, .1, (rx0 + rx1) / 2, y, rz0); A.box(rx1 - rx0, .1, .1, (rx0 + rx1) / 2, y, rz1); A.box(.1, .1, rz1 - rz0, rx0, y, (rz0 + rz1) / 2); A.box(.1, .1, rz1 - rz0, rx1, y, (rz0 + rz1) / 2); }
  for (let x = rx0; x <= rx1 + .1; x += 4.2) { A.box(.14, 1.1, .14, x, .55, rz0); A.box(.14, 1.1, .14, x, .55, rz1); }
  for (let z = rz0; z <= rz1 + .1; z += 4.2) { A.box(.14, 1.1, .14, rx0, .55, z); A.box(.14, 1.1, .14, rx1, .55, z); }
  for (let x = DECK.x0 + 1.5; x < DECK.x1; x += 3.2) { A.box(.5, DECK.thick, .45, x, -DECK.thick / 2, DECK.z0 - .2); A.box(.5, DECK.thick, .45, x, -DECK.thick / 2, DECK.z1 + .2); }
  for (let z = DECK.z0 + 1.5; z < DECK.z1; z += 3.2) { A.box(.45, DECK.thick, .5, DECK.x0 - .2, -DECK.thick / 2, z); A.box(.45, DECK.thick, .5, DECK.x1 + .2, -DECK.thick / 2, z); }
  // tower base pedestal, hold-down rings, equipment
  A.box(TOWER.hw * 2 + 2, 1.4, TOWER.hw * 2 + 2, TOWER.x, .7, TOWER.z);
  for (const s of [-1, 1]) { K.cyl(2.3, 2.3, .5, s * 4.55, -.25, 0, 28); A.box(.7, .5, 1.6, s * 4.55, -.25, 2.6); A.box(.7, .5, 1.6, s * 4.55, -.25, -2.6); }
  for (let i = 0; i < 14; i++) { const x = DECK.x0 + 3 + rand() * (DECK.x1 - DECK.x0 - 6), z = rz0 + 1.5 + rand() * (rz1 - rz0 - 3); if (Math.abs(x) < 9 && Math.abs(z) < 7) continue; if (Math.abs(x - TOWER.x) < 7 && Math.abs(z - TOWER.z) < 7) continue; W.box(1.4 + rand() * 3, .8 + rand() * 1.6, 1.2 + rand() * 2.2, x, .6, z); }
  PAINT.append(A).append(W).append(K);
  // tail-service masts that tilt away at lift-off
  const tsm = [];
  { const T = new Acc().paint(C_WHITE); for (const s of [-1, 1]) { T.box(1.3, 9, 1.3, s * 2.0, 4.5, -6.4); } PAINT.append(T);
    const fl = new THREE.Group(); fl.position.set(0, 8.8, -5.7); site.add(fl); const f = new Acc().paint(C_WHITE); for (const s of [-1, 1]) { f.box(1.1, .22, 2.4, s * 2.0, 0, 1.2); f.box(.5, .5, .5, s * 2.0, .3, 2.2); } f.build(paintMat, fl); tsm.push(fl); }

  // flame trench: open pit east of the pad (terrain shader discards the same rectangle), walls, scorched floor, deflector
  const trenchMap = concreteTexture([92, 88, 84], 5), mT = std({ map: trenchMap, color: 0xb0aaa4, roughness: .95 });
  const T = new Acc(), tl = TRENCH.x1 - TRENCH.x0, td = G0 - TRENCH.floor, tcx = (TRENCH.x0 + TRENCH.x1) / 2, tcy = (G0 + TRENCH.floor) / 2;
  const wy = (G0 - .06 + TRENCH.floor) / 2, wh = td - .06;   // wall tops sit just under the terrain so they never z-fight with it
  for (const s of [-1, 1]) T.box(tl + 3, wh, 1.5, tcx, wy, s * (TRENCH.hz + .75), 0, 0, 0, 12);
  T.box(1.5, wh, TRENCH.hz * 2 + 3, TRENCH.x0 - .75, wy, 0, 0, 0, 0, 12); T.box(1.5, wh, TRENCH.hz * 2 + 3, TRENCH.x1 + .75, wy, 0, 0, 0, 0, 12);
  T.box(tl, .5, TRENCH.hz * 2, tcx, TRENCH.floor - .25, 0, 0, 0, 0, 12);
  T.build(mT, site, false, true);
  const wedge = new THREE.Shape(); wedge.moveTo(-15, TRENCH.floor); wedge.lineTo(-15, -8.4); wedge.lineTo(0, -4.9); wedge.lineTo(32, TRENCH.floor); wedge.closePath();
  const wg = new THREE.ExtrudeGeometry(wedge, { depth: TRENCH.hz * 2 - 1.6, bevelEnabled: false }); wg.translate(0, 0, -(TRENCH.hz - .8));
  const wm = new THREE.Mesh(wg, std({ color: 0x2a2724, roughness: .95 })); wm.receiveShadow = true; site.add(wm);

  /* — Mobile Launcher tower: lattice, floors, pipes, elevator, crane — */
  const tower = new THREE.Group(); tower.name = 'ML-tower'; tower.position.set(TOWER.x, 0, TOWER.z); site.add(tower);
  { const S = new Acc().paint(C_RED), Fl = new Acc().paint(C_GREY), P = new Acc().paint(C_WHITE), Wh = new Acc().paint(C_GREY), Kd = new Acc().paint(C_DARK), bay = 4, corners = [[-c, -c], [c, -c], [c, c], [-c, c]];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) S.box(.7, H, .7, sx * c, H / 2, sz * c);
    for (let k = 0; k <= H / bay; k++) {
      const y = k * bay;
      for (let f = 0; f < 4; f++) {
        const [ax, az] = corners[f], [bx, bz] = corners[(f + 1) % 4];
        if (k > 0) S.beam(V3(ax, y, az), V3(bx, y, bz), .3);
        if (k < H / bay) { S.beam(V3(ax, y, az), V3(bx, y + bay, bz), .2); S.beam(V3(bx, y, bz), V3(ax, y + bay, az), .2); }
      }
      if (k > 0) Fl.box(2 * c, .16, 2 * c, 0, y, 0);
    }
    for (const x of [-2.7, -1.35, 1.35, 2.7]) { P.cyl(.28, .28, 60, x, 30, c + .55, 8); for (let y = 5; y < 58; y += 6) P.cyl(.36, .36, .28, x, y, c + .55, 8); }
    Wh.box(2.8, H, 2.8, 0, H / 2, -c - 1.7); for (let y = 3; y < H; y += 8) Kd.box(2.2, .9, .1, 0, y, -c - 3.15);
    for (const y of [16, 30, 46]) { Wh.box(3.4, 4.2, 5.4, c + 2.2, y + 2.1, -.5); Kd.box(.1, 1.2, 3.8, c + 3.95, y + 2.6, -.5); Fl.box(4.2, .22, 7.2, c + 2.2, y - .1, -.5); for (const s of [-1, 1]) S.box(.1, 1, .1, c + 3.9, y + .5, -.5 + s * 3.5); S.beam(V3(c + 3.9, y + 1, -4), V3(c + 3.9, y + 1, 3), .08); }
    for (let k = 0; k < 10; k++) { const z0 = k % 2 ? 2.6 : -2.6; S.beam(V3(c + 1.1, k * 4, z0), V3(c + 1.1, (k + 1) * 4, -z0), .22); S.beam(V3(c + 1.5, k * 4, z0), V3(c + 1.5, (k + 1) * 4, -z0), .22); }
    S.beam(V3(0, H, 0), V3(0, H + 8, 0), .5); S.beam(V3(-6, H + 4.2, 0), V3(14, H + 4.2, 0), .34); S.beam(V3(0, H + 8, 0), V3(14, H + 4.2, 0), .12); S.beam(V3(0, H + 8, 0), V3(-6, H + 4.2, 0), .12); S.box(3, 1.6, 2.4, -5, H + 3.2, 0); S.box(2.2, 1.8, 2.2, 2, H + 1.4, 0); for (let k = 1; k < 5; k++) S.beam(V3(k * 3.4, H + 4.2, 0), V3(k * 3.4 - 1.7, H + 4.2 - .0, 0), .1); S.cyl(.07, .07, 8, 0, H + 12, 0, 6);
    const TW = new Acc(); TW.append(S).append(Fl).append(P).append(Wh).append(Kd); TW.build(paintMat, tower);
    for (const y of [10, 24, 38, 52, 64]) for (const s of [-1, 1]) L.push([TOWER.x + s * 3.3, y, TOWER.z + c + 1.2, 1., .7, .38, .55, 1.7, 0]);
    for (const s of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { L.push([TOWER.x + s[0] * c, H + .6, TOWER.z + s[1] * c, 1, .12, .08, .9, 5, 1]); L.push([TOWER.x + s[0] * c, 38, TOWER.z + s[1] * c, 1, .12, .08, .8, 4, 1]); }
    L.push([TOWER.x, H + 12, TOWER.z, 1, .12, .08, 1.1, 6, 1, .2]);
  }

  /* — umbilical / service arms and the crew access arm: swing away at ignition — */
  const arms = [], tgt = V3(-TOWER.x, 0, -TOWER.z);
  const addArm = (y, side, r, crew, t0) => {
    const px = side * c, pz = c, dx = tgt.x - px, dz = tgt.z - pz, a0 = Math.atan2(dx, dz), len = Math.hypot(dx, dz) - r - .2;
    const pivot = new THREE.Group(); pivot.position.set(px, y, pz); pivot.rotation.y = a0; tower.add(pivot);
    const S = new Acc().paint(C_RED), Wh = new Acc().paint(C_WHITE), Dk = new Acc().paint(C_DARK);
    if (crew) {
      Wh.box(1.9, 2.5, len, 0, 0, len / 2); Wh.box(3.4, 3.3, 3.4, 0, .15, len - .5); Dk.box(1.3, 2.1, .12, 0, -.2, len + 1.22);
      S.box(.18, 2.6, .18, 0, 0, 0); for (const s of [-1, 1]) S.beam(V3(s * .8, -1.4, 0), V3(s * .8, -1.4, len), .18);
    } else {
      const w = .8, n = Math.max(2, Math.round(len / 1.5)), dz2 = len / n;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) S.beam(V3(sx * w, sy * w, 0), V3(sx * w, sy * w, len), .2);
      for (let i = 0; i <= n; i++) { const z = i * dz2; S.beam(V3(-w, -w, z), V3(w, -w, z), .12); S.beam(V3(-w, w, z), V3(w, w, z), .12); S.beam(V3(-w, -w, z), V3(-w, w, z), .12); S.beam(V3(w, -w, z), V3(w, w, z), .12); if (i < n) { const z2 = z + dz2; S.beam(V3(-w, -w, z), V3(-w, w, z2), .1); S.beam(V3(w, -w, z), V3(w, w, z2), .1); S.beam(V3(-w, w, z), V3(w, w, z2), .1); } }
      Wh.box(2.5, 2.9, .5, 0, 0, len + .25); Wh.cyl(.22, .22, len, 0, w + .45, len / 2, 8, PI / 2, 0, 0); Wh.cyl(.22, .22, len, .5, w + .45, len / 2, 8, PI / 2, 0, 0);
    }
    const AR = new Acc(); AR.append(S).append(Wh).append(Dk); AR.build(paintMat, pivot);
    arms.push({ pivot, a0, side, t0 });
    return pivot;
  };
  const armSpec = [[11.5, 1, 3, 0.55], [24, -1, 3, .7], [34, 1, 3, .4], [42, -1, 3, .85], [51.5, 1, 1.7, .3], [56.4, -1, 1.56, .1]];
  for (const s of armSpec) addArm(s[0], s[1], s[2], false, s[3]);
  const crewArm = addArm(58.9, -1, 1.15, true, 0);
  ticks.push(t => {
    for (let i = 0; i < arms.length; i++) { const a = arms[i]; a.pivot.rotation.y = a.a0 + a.side * 1.95 * smooth((t - a.t0) / 1.35); }
    const e = -1.2 * smooth((t - .35) / .9); for (let i = 0; i < tsm.length; i++) tsm[i].rotation.x = e;
  });

  /* — lightning-protection masts with catenary wires (the iconic 39B silhouette) — */
  const MH = 98, masts = [[90, -107], [-138, -24], [-125, 80]], tops = masts.map(m => V3(m[0], MH, m[1]));   // 3rd mast sits left of the camera's ascent arc (it used to rise right in front of the lens)
  { const M = new Acc().paint(0x9aa1a8), n = 24, rb = 2.8, rt = .75;
    for (const [mx, mz] of masts) {
      const lv = []; for (let k = 0; k <= n; k++) { const r = mix(rb, rt, Math.pow(k / n, .85)), pts = []; for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + .5; pts.push(V3(mx + Math.cos(a) * r, G0 + k * (MH - G0) / n, mz + Math.sin(a) * r)); } lv.push(pts); }
      for (let k = 0; k < n; k++) for (let i = 0; i < 3; i++) {
        const th = mix(.4, .18, k / n); M.beam(lv[k][i], lv[k + 1][i], th);
        if (k > 0 || true) M.beam(lv[k][i], lv[k][(i + 1) % 3], .13);
        M.beam(lv[k][i], lv[k + 1][(i + (k % 2 ? 1 : 2)) % 3], .1);
      }
      M.cyl(.06, .12, 9, mx, MH + 4.4, mz, 6); M.sph(.5, mx, MH + 9, mz, 8, 6);
      L.push([mx, MH + 9.5, mz, 1, .1, .06, 1.1, 6, 1], [mx, 52, mz, 1, .1, .06, .9, 4, 1, .4]);
    }
    METAL.append(M);
    // Only short, steep guy wires remain: the long inter-mast catenaries cut straight through the hero frame (rocket + plume) during the climb.
    // They fade out when the camera is close (no big smeared lines) and far away (no shimmer).
    const Wr = new Acc(), wire = (a, b, sag, r) => { const pts = []; for (let i = 0; i <= 10; i++) { const s = i / 10; pts.push(V3(mix(a.x, b.x, s), mix(a.y, b.y, s) - sag * 4 * s * (1 - s), mix(a.z, b.z, s))); } Wr.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, r, 4, false)); };
    for (const [mx, mz] of masts) { const dir = V3(mx, 0, mz).normalize(); for (const s of [-.5, .5]) { const d2 = dir.clone().applyAxisAngle(_up, s); wire(V3(mx, MH - 2, mz), V3(mx + d2.x * 95, G0 + 2, mz + d2.z * 95), 3, .1); } }
    const wm2 = std({ color: 0x23262b, metalness: .5, roughness: .5, transparent: true });
    wm2.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a*=smoothstep(55.,150.,length(vViewPosition))*(1.-smoothstep(380.,800.,length(vViewPosition)))*.7;'); };
    Wr.build(wm2, site, false, false);
  }

  /* — water tower, LH2 / LOX spheres, flare stack, service buildings, light poles, fence — */
  { const Wt = new Acc().paint(0x7c828a), Tk = new Acc().paint(0xe6e6e2), Rd = new Acc().paint(0xb02a2a), wx = -95, wz = -30, wh = 52;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) Wt.beam(V3(wx + sx * 8, G0, wz + sz * 8), V3(wx + sx * 4.2, G0 + wh, wz + sz * 4.2), .6);
    for (let y = 0; y < wh; y += 13) { const k0 = y / wh, k1 = (y + 13) / wh, h0 = mix(8, 4.2, k0), h1 = mix(8, 4.2, Math.min(k1, 1)); for (const [a, b] of [[[-1, -1], [1, -1]], [[1, -1], [1, 1]], [[1, 1], [-1, 1]], [[-1, 1], [-1, -1]]]) { Wt.beam(V3(wx + a[0] * h0, G0 + y, wz + a[1] * h0), V3(wx + b[0] * h1, G0 + y + 13, wz + b[1] * h1), .22); Wt.beam(V3(wx + b[0] * h0, G0 + y, wz + b[1] * h0), V3(wx + a[0] * h1, G0 + y + 13, wz + a[1] * h1), .22); } }
    const tankP = []; for (let i = 0; i <= 28; i++) { const th = -PI / 2 + PI * i / 28; tankP.push([Math.max(0, 7.4 * Math.cos(th)), 7.6 + 7.6 * Math.sin(th)]); }
    const tank = revolve(tankP, { segs: 56, smooth: 80 });
    Tk.geo(tank, wx, G0 + wh, wz); Rd.cyl(7.55, 7.55, 1.6, wx, G0 + wh + 7, wz, 36);
    METAL.append(Wt); PAINT.append(Tk).append(Rd);
    L.push([wx, G0 + wh + 15.8, wz, 1, .1, .06, 1.2, 6, 1, .15]);
    const sp = new Acc(), legs = new Acc().paint(0x8a9096), sph = (x, z, r, lh) => {
      sp.sph(r, x, G0 + lh + r, z, 56, 36); sp.cyl(r + .06, r + .06, .5, x, G0 + lh + r, z, 40);
      for (let i = 0; i < 8; i++) { const a = i / 8 * TAU, ay = G0 + lh + r - Math.cos(.95) * r * .95; legs.beam(V3(x + Math.sin(.95) * r * Math.sin(a), ay + r * .05, z + Math.sin(.95) * r * Math.cos(a)), V3(x + (r + 1.5) * Math.sin(a), G0, z + (r + 1.5) * Math.cos(a)), .42); }
      legs.cyl(r * .9, r * .9, .5, x, G0 + .25, z, 8); L.push([x, G0 + lh + 2 * r + .4, z, 1, .1, .06, 1, 5, 1, hash(x | 0, 1, 2)]);
    };
    sph(45, -152, 9.5, 5); sph(80, -132, 6.5, 4.5);
    sp.build(std({ color: 0xe9e8e4, metalness: .35, roughness: .32 }), site); METAL.append(legs);
    // cryo lines from the pad toward the spheres, supported on short piers
    const Pp = new Acc().paint(C_WHITE); for (const [x0, z0, x1, z1] of [[30, -26, 45, -142], [34, -26, 80, -126]]) { Pp.beam(V3(x0, G0 + 2.2, z0), V3(x1, G0 + 2.2, z1), .55); for (let k = 0; k <= 6; k++) { const px = mix(x0, x1, k / 6), pz = mix(z0, z1, k / 6); Pp.box(.4, 2.2, .4, px, G0 + 1.1, pz); } }
    PAINT.append(Pp);
    // flare stack
    const Fs = new Acc().paint(0x555a60), fx = -260, fz = -60; Fs.cyl(.45, .6, 54, fx, G0 + 27, fz, 8); for (let i = 0; i < 3; i++) { const a = i * TAU / 3; Fs.beam(V3(fx + Math.cos(a) * 5, G0, fz + Math.sin(a) * 5), V3(fx, G0 + 40, fz), .18); }
    METAL.append(Fs); L.push([fx, G0 + 55, fz, 1, .52, .16, 4, 2.2, 2, .3], [fx, G0 + 55, fz, 1, .8, .45, 1.8, 2.6, 2, .7]);
  }
  { // service buildings, bunkers
    const B = new Acc(), Bd = new Acc().paint(0x555b62), bt = vabTexture();
    const spots = [[-80, 52, 24, 7, 36, 0], [-60, 80, 30, 6, 18, 0], [86, 64, 26, 8, 22, 0], [100, -70, 20, 6, 28, .3], [-100, -85, 18, 7, 24, 0], [-30, -108, 30, 5, 14, 0], [70, 92, 14, 5, 12, 0], [-108, 20, 12, 5, 12, 0], [112, 22, 16, 6, 20, 0], [20, -112, 22, 6, 12, 0]];
    for (const [x, z, w, h, d, ry] of spots) { const y = F.at(x, z); B.box(w, h, d, x, y + h / 2 - .2, z, 0, ry, 0, 14); Bd.box(w * .5, 1.4, d * 1.01, x, y + h + .4, z, 0, ry, 0); }
    B.build(std({ map: bt, color: 0xc2c4c6, roughness: .85 }), site); PAINT.append(Bd);
    // light poles (instanced into one mesh) + glows, perimeter fence
    const Lp = new Acc().paint(0x70767c), pts = [];
    for (const [x, z] of [[-70, -98], [-20, -98], [30, -98], [80, -98], [118, -60], [118, 0], [118, 50], [100, 100], [40, 100], [-30, 100], [-100, 100], [-118, 40], [-118, -30], [-110, -90]]) {
      const y = F.at(x, z); Lp.cyl(.16, .3, 22, x, y + 11, z, 6); Lp.box(2.2, .3, .7, x, y + 22.3, z); pts.push([x, y + 22.6, z, 1, .72, .42, .9, 2.0, 0]);
    }
    METAL.append(Lp); L.push(...pts);
    for (let i = 0; i < 26; i++) { const a = i / 26 * TAU, x = Math.cos(a) * 124, z = Math.sin(a) * 118 - 6; if (z > 60 && Math.abs(x) < 36) continue; L.push([x, F.at(x, z) + 1.6, z, 1, .55, .22, .6, 1.5, 0, 0]); }
    const Fp = new Acc().paint(0x5b6168), lp = [], R = 168, zc = -6; const ring = [[-R, -R], [R, -R], [R, R], [-R, R]];
    for (let i = 0; i < 4; i++) { const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % 4], n = Math.round(Math.hypot(bx - ax, bz - az) / 7); for (let k = 0; k <= n; k++) { const x = mix(ax, bx, k / n), z = mix(az, bz, k / n) + zc; if (z > 60 && Math.abs(x) < 38) continue; const y = F.at(x, z); Fp.box(.2, 3.4, .2, x, y + 1.7, z); if (k < n) { const x2 = mix(ax, bx, (k + 1) / n), z2 = mix(az, bz, (k + 1) / n) + zc, y2 = F.at(x2, z2); if (!(z2 > 60 && Math.abs(x2) < 38)) for (const hh of [1.0, 3.0]) lp.push(x, y + hh, z, x2, y2 + hh, z2); } } }
    METAL.append(Fp);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); const fence = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x4a5058, transparent: true, opacity: .75 })); fence.frustumCulled = false; site.add(fence);
  }

  /* — Vehicle Assembly Building (distant, hazy, with a flag panel) — */
  const vab = new THREE.Group(); vab.name = 'VAB'; { const vx = -880, vz = -420; vab.position.set(vx, F.at(vx, vz), vz); vab.scale.setScalar(.85); site.add(vab);
    const vt = vabTexture(), mWall = std({ map: vt, color: 0xd5d9de, roughness: .82 }), B = new Acc(), Rf = new Acc().paint(0x2c3036), Dr = new Acc().paint(0x2a3038);
    B.box(62, 88, 78, 0, 44, 0, 0, 0, 0, 26); B.box(48, 28, 98, 52, 14, 8, 0, 0, 0, 26); B.box(40, 6, 52, -6, 91, 4, 0, 0, 0, 26);
    Rf.box(64, 1.6, 80, 0, 88.6, 0); Rf.box(50, 1.2, 100, 52, 28.4, 8); Rf.box(6, 5, 6, 12, 92, -20); Rf.box(5, 14, 5, -26, 96, 10); Rf.box(.8, 22, .8, 22, 100, 18);
    for (const x of [-21, -7, 7, 21]) Dr.box(6.4, 62, .3, x, 31, 39.1);
    Dr.box(.3, 62, 8, 31.1, 31, 0);
    B.build(mWall, vab); Rf.append(Dr).bake(new THREE.Matrix4().compose(vab.position, _q.identity(), vab.scale)); PAINT.append(Rf);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(40, 21), new THREE.MeshBasicMaterial({ map: flagTexture(), color: 0xdcdcdc })); flag.position.set(31.3, 64, -22); flag.rotation.y = PI / 2; vab.add(flag);
    L.push([vx - 24, vab.position.y + 78, vz - 31, 1, .1, .06, 2.4, 7, 1, .1], [vx + 24, vab.position.y + 78, vz + 31, 1, .1, .06, 2.4, 7, 1, .1], [vx + 3, vab.position.y + 88, vz + 19, 1, .1, .06, 2.2, 7, 1, .6]);
  }

  /* — Cape lighthouse on the far shore (banded tower, slow sweeping flash) — */
  { const lx = -610, lz = -440, ly = F.at(lx, lz), Lw = new Acc().paint(0xe6e4de), Lb = new Acc().paint(0x1c1d21);
    for (let i = 0; i < 6; i++) { const y0 = i * 6, r0 = 2.6 - i * .16, r1 = 2.6 - (i + 1) * .16; (i % 2 ? Lw : Lb).cyl(r1, r0, 6, 0, y0 + 3, 0, 20); }
    Lw.cyl(1.9, 1.9, .5, 0, 36.2, 0, 20); Lb.cyl(1.4, 1.4, 3, 0, 38, 0, 16); Lw.cyl(0, 1.7, 1.6, 0, 40.3, 0, 16);
    Lw.append(Lb).bake(new THREE.Matrix4().compose(V3(lx, ly, lz), _q.identity(), V3(1.15, 1.15, 1.15))); PAINT.append(Lw);
    L.push([lx, ly + 38 * 1.15, lz, 1, .9, .7, 4, 9, 4, .2]); }

  /* — pad apron detail: cable trays with cross-straps, junction boxes, equipment skids, bollards (batched into the paint/metal meshes) — */
  { const pr = makeRng(7711), Tr = new Acc().paint(0x8f8c86), Jb = new Acc(), Eq = new Acc();
    const trays = [[22, -13, 94, -22], [-24, -13, -88, -28], [-44, 17, -70, 92], [46, 17, 78, 90]];
    for (const [x0, z0, x1, z1] of trays) {
      const len = Math.hypot(x1 - x0, z1 - z0), ry = Math.atan2(x1 - x0, z1 - z0), ux = (x1 - x0) / len, uz = (z1 - z0) / len;
      Tr.geo(new THREE.BoxGeometry(.9, .3, len), (x0 + x1) / 2, G0 + .15, (z0 + z1) / 2, 0, ry, 0);
      Tr.paint(0x6c6a66); for (const s of [-1, 1]) Tr.geo(new THREE.BoxGeometry(.1, .42, len), (x0 + x1) / 2 - uz * s * .45, G0 + .21, (z0 + z1) / 2 + ux * s * .45, 0, ry, 0);
      for (let d = 2; d < len; d += 2.6) Tr.geo(new THREE.BoxGeometry(1.04, .06, .22), x0 + ux * d, G0 + .33, z0 + uz * d, 0, ry, 0);
      Tr.paint(0x8f8c86);
      for (let d = 12; d < len - 4; d += 15 + pr() * 8) Jb.paint(pr() > .5 ? 0xc9c6bd : 0x59606a).box(.9 + pr() * .6, .8 + pr() * .5, .8 + pr() * .5, x0 + ux * d + uz * 1.4, G0 + .5, z0 + uz * d - ux * 1.4, 0, ry, 0);
    }
    const cols = [0xb9b6ad, 0x9fa4a8, 0xc4682c, 0x7a8a96, 0x30343a, 0xd8d6ce];
    for (let tries = 0, n = 0; tries < 200 && n < 28; tries++) {
      const a = pr() * TAU, r = 38 + pr() * 54, x = Math.cos(a) * r, z = Math.sin(a) * r * .92 - 6;
      if ((x > -22 && x < 66 && Math.abs(z) < 13) || (x > -26 && x < 24 && z > -31 && z < 19) || (Math.abs(x - TOWER.x) < 12 && Math.abs(z - TOWER.z) < 12) || Math.hypot(x, z + 6) > 96 || (z > 58 && Math.abs(x) < 30)) continue;
      if (trays.some(([x0, z0, x1, z1]) => { const dx = x1 - x0, dz = z1 - z0, k = clamp(((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz)); return Math.hypot(x - x0 - dx * k, z - z0 - dz * k) < 3; })) continue;
      const kind = pr(), col = cols[(pr() * cols.length) | 0], ry = pr() * PI; n++;
      Eq.paint(col);
      if (kind < .45) { const w = 1.6 + pr() * 1.8, h = 1.1 + pr() * 1.3, d = 1.4 + pr() * 1.6; Eq.box(w, h, d, x, G0 + h / 2, z, 0, ry, 0); Eq.paint(0x2a2d32).box(w * .9, .12, d * .9, x, G0 + h + .06, z, 0, ry, 0); }
      else if (kind < .75) { const rr = .55 + pr() * .35, h = 1.6 + pr() * 1.3; Eq.cyl(rr, rr, h, x, G0 + h / 2 + .25, z, 14); Eq.paint(0x2a2d32).cyl(rr * 1.02, rr * 1.02, .2, x, G0 + .25, z, 14); Eq.box(rr * 2.6, .25, rr * 2.6, x, G0 + .12, z, 0, ry, 0); Eq.paint(col).sph(rr, x, G0 + h + .25, z, 12, 6, 1, .55, 1); }
      else { Eq.box(1.2, 1.5, .9, x, G0 + .75, z, 0, ry, 0); Eq.paint(0x2a2d32); for (let i = -2; i <= 2; i++) Eq.box(.08, 1.0, .5, x + Math.cos(ry) * i * .22, G0 + .8, z - Math.sin(ry) * i * .22 + .55 * 0, 0, ry, 0); }
    }
    Eq.paint(0xd4a416); for (let i = 0; i < 16; i++) { const x = -20 + i * 5.2; if (x > -22 && x < 24) continue; Eq.cyl(.14, .14, 1.0, x, G0 + .5, 17, 8); }
    PAINT.append(Tr).append(Jb).append(Eq);
  }

  /* — vegetation: scrub (near/far LOD, instanced), pines, palms and live oaks — */
  { const dm = new THREE.Object3D(), col = new THREE.Color(), vm = (o = {}) => std({ color: 0xffffff, roughness: 1, vertexColors: true, ...o });
    const NBN = 760, NBF = 1700, bushN = new THREE.InstancedMesh(bushGeometry(), vm(), NBN), bushF = new THREE.InstancedMesh(bushFarGeometry(), vm(), NBF);
    let nn = 0, nf = 0;
    const roadD = (x, z) => { let d = 1e9; for (const r of ROADS) { const ax = r[0], az = r[1], bx = r[2], bz = r[3], px = x - ax, pz = z - az, bxx = bx - ax, bzz = bz - az, k = clamp((px * bxx + pz * bzz) / (bxx * bxx + bzz * bzz)); d = Math.min(d, Math.hypot(px - bxx * k, pz - bzz * k) - r[4] * .5); } return d; };
    const onLane = (x, z, w) => z > 50 && Math.abs(x + Math.pow(Math.max(z - 240, 0), 2) * .00045) < w;
    for (let tries = 0; tries < 12000 && (nn < NBN || nf < NBF); tries++) {
      const r = 125 + 1350 * Math.pow(rand(), 1.6), a = rand() * TAU, x = Math.cos(a) * r, z = Math.sin(a) * r, h = F.at(x, z), near = r < 300;
      if (h < SEA + 1.1 || roadD(x, z) < 7 || onLane(x, z, 22)) continue;
      if (rand() > .18 + 1.1 * ss(.38, .62, fbm(x * .0045, z * .0045, 3, 301))) continue;
      if (Math.pow(Math.pow(Math.abs(x), 4) + Math.pow(Math.abs(z + 6), 4), .25) < 125) continue;
      if (near ? nn >= NBN : nf >= NBF) continue;
      const s = .8 + Math.pow(rand(), 2) * 2.3 * (.55 + .45 * Math.min(1, r / 450));
      dm.position.set(x, h + s * .12, z); dm.rotation.set(0, rand() * TAU, 0); dm.scale.set(s * (.9 + rand() * .5), s * (.8 + rand() * .5), s * (.9 + rand() * .5)); dm.updateMatrix();
      const k = rand(), v = .7 + rand() * .5; if (k < .5) col.setRGB(.075 * v, .115 * v, .05 * v); else if (k < .8) col.setRGB(.13 * v, .135 * v, .065 * v); else col.setRGB(.2 * v, .16 * v, .09 * v);
      if (near) { bushN.setMatrixAt(nn, dm.matrix); bushN.setColorAt(nn++, col); } else { bushF.setMatrixAt(nf, dm.matrix); bushF.setColorAt(nf++, col); }
    }
    for (const [b, n] of [[bushN, nn], [bushF, nf]]) { b.count = n; b.instanceMatrix.needsUpdate = true; b.instanceColor.needsUpdate = true; b.castShadow = false; b.receiveShadow = true; b.frustumCulled = false; site.add(b); }
    ticks.push((t, cx) => { const lo = cx.quality === 'low'; bushN.count = lo ? nn >> 1 : nn; bushF.count = lo ? nf >> 2 : nf; });
    // trees: three variants, each its own instanced mesh with vertex-coloured foliage
    const treeSpecs = [
      { geo: pineGeometry(), n: 150, name: 'pines', ok: (x, z, h, r) => h > SEA + 2.7 && r > 240 && fbm(x * .006 + 50, z * .006, 3, 311) > .52, scale: () => .85 + rand() * 1.2 },
      { geo: palmGeometry(), n: 80, name: 'palms', ok: (x, z, h, r) => h > SEA + 1.6 && h < SEA + 6.5 && r > 150 && fbm(x * .004 + 80, z * .004, 3, 321) > .4, scale: () => .8 + rand() * .7 },
      { geo: oakGeometry(), n: 70, name: 'oaks', ok: (x, z, h, r) => h > SEA + 2.5 && r > 200 && fbm(x * .005 + 20, z * .005 + 9, 3, 331) > .5, scale: () => .55 + rand() * .7 }
    ];
    const treeMeshes = [];
    for (const sp of treeSpecs) {
      const mesh = new THREE.InstancedMesh(sp.geo, vm({ side: THREE.DoubleSide }), sp.n); let np = 0;
      for (let tries = 0; tries < sp.n * 30 && np < sp.n; tries++) {
        const r = 150 + 1350 * Math.pow(rand(), 1.25), a = rand() * TAU, x = Math.cos(a) * r, z = Math.sin(a) * r, h = F.at(x, z);
        if (!sp.ok(x, z, h, r) || roadD(x, z) < 12 || onLane(x, z, 30)) continue;
        const s = sp.scale(); dm.position.set(x, h - .1, z); dm.rotation.set((rand() - .5) * .05, rand() * TAU, (rand() - .5) * .05); dm.scale.set(s * (.85 + rand() * .3), s, s * (.85 + rand() * .3)); dm.updateMatrix(); mesh.setMatrixAt(np, dm.matrix);
        const v = .75 + rand() * .5; col.setRGB(v * (.92 + rand() * .16), v, v * (.9 + rand() * .15)); mesh.setColorAt(np, col); np++;
      }
      mesh.count = np; mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false; mesh.name = sp.name; site.add(mesh); treeMeshes.push([mesh, np]);
    }
    ticks.push((t, cx) => { const lo = cx.quality === 'low'; for (const [m, n] of treeMeshes) m.count = lo ? n >> 1 : n; });
  }

  { const pm = PAINT.build(paintMat, site); pm.name = 'site-paint'; const mm = METAL.build(metalMat, site); mm.name = 'site-metal'; }

  /* — dawn rim light from behind and pad search-lights on the vehicle — */
  const rim = new THREE.DirectionalLight(0xff9a58, 1.5); rim.position.copy(DAWN_SUN_DIR).multiplyScalar(500); site.add(rim); site.add(rim.target);
  const spots = [];
  for (const [sx, sz, ty] of [[58, 66, 38], [-62, 60, 44]]) {
    const sp = new THREE.SpotLight(0xffe0b0, 0, 320, .26, .7, 2); sp.position.set(sx, G0 + 22, sz); sp.target.position.set(0, ty, 0); site.add(sp, sp.target); spots.push(sp);
    L.push([sx, G0 + 22.5, sz, 1, .78, .48, .9, 2.6, 0]);
  }
  ticks.push((t, cx) => { const k = cx.quality === 'low' ? 0 : 7000; for (let i = 0; i < spots.length; i++) spots[i].intensity = k; });

  const birds = makeBirds(18); site.add(birds); ticks.push((t, cx) => { birds.visible = cx.quality !== 'low' && t < 40; birds.material.uniforms.t.value = t; });

  // ignition glow in the trench and over the pad (fades out by t≈7.5)
  // far ships and an offshore platform on the horizon: tiny warm lights, one slow red beacon
  L.push([620, SEA + 14, -1750, 1, .8, .5, .9, 1.6, 0], [633, SEA + 10, -1752, 1, .7, .4, .7, 1.2, 0], [640, SEA + 27, -1748, 1, .12, .08, .8, 3.2, 1, .3], [-260, SEA + 9, -1880, 1, .85, .55, .8, 1.4, 0], [-247, SEA + 7, -1878, .9, .9, 1, .6, 1.1, 0], [980, SEA + 6, -1500, 1, .8, .5, .7, 1.1, 0]);
  L.push([12, -6, 0, 1, .52, .2, 16, 4, 3, .2], [26, -8, 1.5, 1, .5, .18, 18, 3, 3, .5], [44, -9, -1, 1, .46, .16, 20, 2.2, 3, .8], [0, 1, 0, 1, .56, .26, 24, 3.2, 3, .35], [0, 2, 0, 1, .5, .22, 110, .55, 3, .6]);

  /* — glow lights & deluge — */
  const lights = makeLights(L); site.add(lights); ticks.push(t => { lights.material.uniforms.t.value = t; });
  const sMap = softMap(), dE = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) dE.push([sx * 8.2, .5, sz * 3.6, sx * .55, .85, sz * .45]);
  for (const x of [4, 14, 25, 38, 52]) for (const sz of [-1, 1]) dE.push([x, G0 + .3, sz * 8.6, 0, .2, -sz * .8]);
  dE.push([24, -4, 0, 1, .5, 0], [-9, G0 + .5, -2, -1, .6, 0], [-9, G0 + .5, 3, -1, .6, .3]);
  const deluge = makeSprayBank(dE, 44, { speed: [8, 13], spread: .7, grav: 3.6, life: 2.1, size0: 1.1, size1: 5.5, rate: .5, col: [.86, .93, 1], alpha: .42 });
  const vapor = makeSprayBank([[3.5, 34, 1.5, .6, .4, .6], [-3.4, 33, 1.2, -.6, .4, .6], [2.2, 46, 2, .4, .5, .6], [-2, 45, 2.2, -.4, .5, .7], [1.9, 53, 1.4, .5, .5, .5], [0, 27, 3.4, 0, .3, 1], [4.9, 38, 1, 1, .6, .2], [-4.9, 38, 1, -1, .6, .2]], 14, { speed: [.5, 1.6], spread: 1.1, grav: -.35, life: 4, size0: 1.2, size1: 7, rate: .25, col: [.92, .95, 1], alpha: .3, seed: 7 });
  deluge.material.uniforms.map.value = vapor.material.uniforms.map.value = sMap; site.add(deluge, vapor);
  ticks.push((t, cx) => {
    const env = (.62 + .38 * smooth(t / 1.1)) * (1 - smooth((t - 4.2) / 2.6)), ve = 1 - smooth((t - .4) / 3.4), low = cx.quality === 'low';
    deluge.visible = env > .002 && !low; deluge.material.uniforms.t.value = t; deluge.material.uniforms.env.value = env; deluge.geometry.instanceCount = low ? deluge.userData.count >> 1 : deluge.userData.count;
    vapor.visible = ve > .002; vapor.material.uniforms.t.value = t; vapor.material.uniforms.env.value = ve; vapor.geometry.instanceCount = low ? vapor.userData.count >> 1 : vapor.userData.count;
  });

  site.userData.tick = (t, cx) => { for (let i = 0; i < ticks.length; i++) ticks[i](t, cx); };
  return { group: site, tower, ml: deck, terrain, ocean, vab, arms: arms.map(a => a.pivot), crewArm, masts: tops, deluge, heightAt: F.at, seaLevel: SEA, groundLevel: G0 };
}
