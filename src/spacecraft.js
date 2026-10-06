// Orion, the representative HLS lander, crew, surface payloads and recovery hardware.
// Everything is procedural: shared geometry/material/texture caches are built once on first use, parts are merged
// per material (few draw calls) and every instance only clones lightweight meshes. Animation is a pure function of t.
import * as THREE from 'three';
import { TAU, clamp, mix, smooth, makeRng } from './util.js';
import { EVENTS } from './timeline.js';

const V3 = THREE.Vector3, M4 = THREE.Matrix4, Y = new V3(0, 1, 0);
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _nm = new THREE.Matrix3(), _a = new V3(), _b = new V3(), _c = new V3(), _col = new THREE.Color();
const memo = fn => { let v, done = false; return () => done ? v : (done = true, v = fn()); };

/* ------------------------------------------------------------------ geometry batching */
// Collects transformed copies of geometries and bakes them into ONE BufferGeometry (position/normal/uv/color).
class Batch {
  constructor() { this.items = []; this.base = new M4(); this.stack = []; }
  push(m) { this.stack.push(this.base.clone()); this.base.multiply(m); return this; }
  pop() { this.base = this.stack.pop(); return this; }
  // p = [x,y,z], s = number | [sx,sy,sz], r = [rx,ry,rz] (XYZ euler), o = { color, uv:[su,sv,ou,ov] }
  add(geo, p = [0, 0, 0], s = 1, r = [0, 0, 0], o) {
    const sc = typeof s === 'number' ? [s, s, s] : s;
    _e.set(r[0], r[1], r[2]);
    return this.addM(geo, new M4().compose(_a.set(p[0], p[1], p[2]), _q.setFromEuler(_e), _b.set(sc[0], sc[1], sc[2])), o);
  }
  addM(geo, local, o = {}) { this.items.push({ geo, m: this.base.clone().multiply(local), color: o.color, uv: o.uv }); return this; }
  geometry() {
    let nv = 0, ni = 0;
    for (const it of this.items) { const P = it.geo.attributes.position; nv += P.count; ni += it.geo.index ? it.geo.index.count : P.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
    const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
    let vo = 0, io = 0;
    for (const it of this.items) {
      const g = it.geo, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color, n = P.count;
      _nm.getNormalMatrix(it.m);
      let cr = 1, cg = 1, cb = 1;
      if (it.color !== undefined) { _col.set(it.color); cr = _col.r; cg = _col.g; cb = _col.b; }
      const uvT = it.uv;
      for (let i = 0; i < n; i++) {
        _a.fromBufferAttribute(P, i).applyMatrix4(it.m);
        const k = (vo + i) * 3; pos[k] = _a.x; pos[k + 1] = _a.y; pos[k + 2] = _a.z;
        if (N) { _a.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize(); nor[k] = _a.x; nor[k + 1] = _a.y; nor[k + 2] = _a.z; }
        if (U) {
          let u = U.getX(i), v = U.getY(i);
          if (uvT) { u = u * uvT[0] + (uvT[2] || 0); v = v * uvT[1] + (uvT[3] || 0); }
          uv[(vo + i) * 2] = u; uv[(vo + i) * 2 + 1] = v;
        }
        col[k] = cr * (C ? C.getX(i) : 1); col[k + 1] = cg * (C ? C.getY(i) : 1); col[k + 2] = cb * (C ? C.getZ(i) : 1);
      }
      const flip = it.m.determinant() < 0, cnt = g.index ? g.index.count : n;
      for (let i = 0; i < cnt; i += 3) {
        const a = g.index ? g.index.getX(i) : i, b = g.index ? g.index.getX(i + 1) : i + 1, c = g.index ? g.index.getX(i + 2) : i + 2;
        idx[io++] = vo + a; idx[io++] = vo + (flip ? c : b); idx[io++] = vo + (flip ? b : c);
      }
      vo += n;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.computeBoundingSphere(); geo.computeBoundingBox();
    return geo;
  }
  mesh(material, parent, o = {}) {
    const m = new THREE.Mesh(this.geometry(), material);
    m.castShadow = o.cast !== false; m.receiveShadow = o.receive !== false; if (o.name) m.name = o.name;
    parent?.add(m); return m;
  }
}

/* ------------------------------------------------------------------ unit primitives */
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 28, 1),
  cyl16: new THREE.CylinderGeometry(1, 1, 1, 16, 1),
  cyl8: new THREE.CylinderGeometry(1, 1, 1, 8, 1),
  cylOpen: new THREE.CylinderGeometry(1, 1, 1, 28, 1, true),
  sph: new THREE.SphereGeometry(1, 24, 16),
  sph12: new THREE.SphereGeometry(1, 14, 10),
  cone: new THREE.ConeGeometry(1, 1, 24, 1),
  plane: new THREE.PlaneGeometry(1, 1)
};
const geoCache = new Map();
const cached = (key, make) => { let g = geoCache.get(key); if (!g) geoCache.set(key, g = make()); return g; };
const torus = (R, t, seg = 40, tseg = 8) => cached(`t${R}_${t}_${seg}_${tseg}`, () => new THREE.TorusGeometry(R, t, tseg, seg));
const cylG = (rt, rb, h, seg = 28, open = false) => cached(`c${rt}_${rb}_${h}_${seg}_${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
const capsG = (r, len, cs = 8, rs = 24) => cached(`k${r}_${len}_${cs}_${rs}`, () => new THREE.CapsuleGeometry(r, len, cs, rs));
const trapG = (wt, wb, h, d = 1) => cached(`z${wt}_${wb}_${h}_${d}`, () => {
  const s = new THREE.Shape(); s.moveTo(-wb / 2, -h / 2); s.lineTo(wb / 2, -h / 2); s.lineTo(wt / 2, h / 2); s.lineTo(-wt / 2, h / 2); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false }); g.translate(0, 0, -d / 2); return g;
});
// Box whose side faces tile a window-band texture (5.12 x 2.56 units per tile); top/bottom use a plain strip.
const wallBoxG = (sx, sy, sz) => cached(`w${sx}_${sy}_${sz}`, () => {
  const g = new THREE.BoxGeometry(sx, sy, sz), uv = g.attributes.uv, face = [sz, sz, 0, 0, sx, sx];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i;
    if (f === 2 || f === 3) uv.setXY(k, .5, .035); else uv.setXY(k, uv.getX(k) * face[f] / 5.12, uv.getY(k) * sy / 2.56 + .06);
  }
  return g;
});
const domeG = () => cached('dome', () => new THREE.SphereGeometry(1, 20, 8, 0, TAU, 0, Math.PI / 2).rotateX(Math.PI / 2));
const lathe = (pts, seg = 40) => new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), seg);

// Cylinder between two points (arrays).
function rod(b, p0, p1, r, o, geo = G.cyl8) {
  _a.set(p0[0], p0[1], p0[2]); _b.set(p1[0], p1[1], p1[2]); _c.subVectors(_b, _a); const len = _c.length(); _c.divideScalar(len || 1);
  _q.setFromUnitVectors(Y, _c); _b.add(_a).multiplyScalar(.5);
  return b.addM(geo, new M4().compose(_b, _q, new V3(r, len, r)), o);
}
// Local frame at point p with +Z = outward normal n and +Y as close as possible to `up`.
const _fx = new V3(), _fy = new V3(), _fz = new V3();
function frameM(p, n, up = Y) {
  _fz.copy(n).normalize(); _fy.copy(up).addScaledVector(_fz, -up.dot(_fz)).normalize(); _fx.crossVectors(_fy, _fz);
  return new M4().makeBasis(_fx, _fy, _fz).setPosition(p[0], p[1], p[2]);
}
const rotY = a => new M4().makeRotationY(a), rotZ = a => new M4().makeRotationZ(a), rotX = a => new M4().makeRotationX(a);
const tr = (x, y, z) => new M4().makeTranslation(x, y, z);

// Radial grid disc (dish): y = -sag*(1-(rho/r)^2), planar uv. dir -1 = convex downwards.
function dishGeo(r, sag, rings = 10, segs = 64, dir = -1) {
  const pos = [], uv = [], idx = [];
  pos.push(0, dir * sag, 0); uv.push(.5, .5);
  for (let i = 1; i <= rings; i++) for (let j = 0; j < segs; j++) {
    const rho = i / rings, a = j / segs * TAU, x = Math.cos(a) * rho * r, z = Math.sin(a) * rho * r;
    pos.push(x, dir * sag * (1 - rho * rho), z); uv.push(.5 + x / r * .5, .5 - z / r * .5);
  }
  const tri = (a, b, c) => dir > 0 ? idx.push(a, b, c) : idx.push(a, c, b);   // dir>0 faces +Y, dir<0 faces -Y
  for (let j = 0; j < segs; j++) tri(0, 1 + (j + 1) % segs, 1 + j);
  for (let i = 1; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = 1 + (i - 1) * segs + j, b = 1 + (i - 1) * segs + (j + 1) % segs, c = 1 + i * segs + j, d = 1 + i * segs + (j + 1) % segs;
    tri(a, b, c); tri(b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ procedural textures */
const cv = (w, h = w) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function toTex(c, srgb = false, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Tileable smooth value noise, fx*fy lattice cells.
function noiseField(W, H, fx, fy, rng) {
  const g = Float32Array.from({ length: fx * fy }, rng), o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const py = y / H * fy, iy = py | 0, ty = py - iy, sy = ty * ty * (3 - 2 * ty), y0 = iy % fy * fx, y1 = (iy + 1) % fy * fx;
    for (let x = 0; x < W; x++) {
      const px = x / W * fx, ix = px | 0, tx = px - ix, sx = tx * tx * (3 - 2 * tx), x0 = ix % fx, x1 = (ix + 1) % fx;
      const a = g[y0 + x0], b = g[y0 + x1], c = g[y1 + x0], d = g[y1 + x1];
      o[y * W + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
  }
  return o;
}
// Height field -> tangent-space normal map (OpenGL convention, wraps around).
function normalTexture(h, W, H, k) {
  const c = cv(W, H), q = c.getContext('2d'), img = q.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xl = h[y * W + (x + W - 1) % W], xr = h[y * W + (x + 1) % W], yu = h[((y + H - 1) % H) * W + x], yd = h[((y + 1) % H) * W + x];
    let nx = (xl - xr) * k, ny = (yd - yu) * k, nz = 1; const il = 1 / Math.hypot(nx, ny, nz);
    const i = (y * W + x) * 4; d[i] = (nx * il * .5 + .5) * 255; d[i + 1] = (ny * il * .5 + .5) * 255; d[i + 2] = (nz * il * .5 + .5) * 255; d[i + 3] = 255;
  }
  q.putImageData(img, 0, 0); return toTex(c);
}
const grayTexture = (v, W, H) => { // v: Float32Array 0..1 -> roughness/ao canvas (all channels equal)
  const c = cv(W, H), q = c.getContext('2d'), img = q.createImageData(W, H), d = img.data;
  for (let i = 0; i < W * H; i++) { const g = clamp(v[i]) * 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g; d[i * 4 + 3] = 255; }
  q.putImageData(img, 0, 0); return toTex(c);
};

// Crinkled multi-layer insulation: gold kapton, white beta cloth or silver mylar.
function mliTextures(kind, seed) {
  const N = 512, rng = makeRng(seed), h = new Float32Array(N * N), lump = noiseField(N, N, 4, 4, rng), lump2 = noiseField(N, N, 9, 9, rng);
  const oct = [[8, 1], [16, .6], [32, .38], [64, .2]].map(([f, w]) => [noiseField(N, N, f, f, rng), w]);
  const c = cv(N), q = c.getContext('2d'), img = q.createImageData(N, N), d = img.data, rough = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    let r = 0; for (const [n, w] of oct) r += w * Math.pow(1 - Math.abs(2 * n[i] - 1), 1.8);
    r /= 2.0; h[i] = r * .8 + lump[i] * .35;
    const sh = .8 + .32 * r + .16 * (lump2[i] - .5);
    let R, Gc, B;
    if (kind === 'gold') { R = 224 * sh; Gc = 168 * sh; B = 66 * sh; rough[i] = .2 + .36 * (1 - r) + .1 * lump2[i]; }
    else if (kind === 'white') { const s = .9 + .2 * r - .06 * lump2[i]; R = 232 * s; Gc = 234 * s; B = 238 * s; rough[i] = .5 + .3 * lump2[i] + .1 * (1 - r); }
    else { R = 204 * sh; Gc = 210 * sh; B = 218 * sh; rough[i] = .24 + .3 * (1 - r) + .1 * lump2[i]; }
    d[i * 4] = R; d[i * 4 + 1] = Gc; d[i * 4 + 2] = B; d[i * 4 + 3] = 255;
  }
  q.putImageData(img, 0, 0);
  return { map: toTex(c, true), normal: normalTexture(h, N, N, kind === 'gold' ? 5.5 : 3.6), rough: grayTexture(rough, N, N) };
}

// Orion backshell: aligned thermal-protection tile grid (three bands of different tile size, no running bond), tight tone range,
// large soft blotches, bevelled dark gaps, lighter blanket panels, paint lines and (optional) scorch/soot toward the base.
function tilesTextures(scorch, seed) {
  const W = 2048, H = 768, rng = makeRng(seed);
  const bands = [{ y0: 0, y1: .3, cols: 44, rows: 6 }, { y0: .3, y1: .66, cols: 56, rows: 7 }, { y0: .66, y1: 1, cols: 68, rows: 7 }];
  const tone = Float32Array.from({ length: 4096 }, rng), streak = noiseField(W, H, 110, 3, rng), blot = noiseField(W, H, 6, 3, rng), blot2 = noiseField(W, H, 17, 6, rng), crink = noiseField(W, H, 220, 90, rng);
  // blanket panels: [u0,u1,v0,v1] in texture fractions (they wrap nowhere, so keep inside 0..1)
  const panels = [[.06, .15, .06, .5], [.31, .4, .38, .84], [.56, .65, .12, .6], [.8, .89, .44, .9]];
  const c = cv(W, H), q = c.getContext('2d'), img = q.createImageData(W, H), d = img.data, h = new Float32Array(W * H), rough = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const vy = y / H, band = vy < bands[0].y1 ? 0 : vy < bands[1].y1 ? 1 : 2, B = bands[band], by = (vy - B.y0) / (B.y1 - B.y0), rr = by * B.rows, row = Math.floor(rr), ly = rr - row;
    for (let x = 0; x < W; x++) {
      const vx = x / W, cc = vx * B.cols, col = Math.floor(cc), lx = cc - col, i0 = y * W + x;
      const tw = W / B.cols, th = H * (B.y1 - B.y0) / B.rows, ex = Math.min(lx, 1 - lx) * tw, ey = Math.min(ly, 1 - ly) * th, edge = Math.min(ex, ey);
      const seam = (row === 0 && by < 0.02) || (row === B.rows - 1 && ly > .985);
      const gap = edge < 1.7 || seam, bev = clamp((edge - 1.7) / 3.2);
      const t = tone[(band * 977 + row * 71 + col * 13) % 4096];
      let base = 168 + (t - .5) * 14 + (blot[i0] - .5) * 22 + (blot2[i0] - .5) * 8;      // +-6% per tile on top of slow blotches
      let isPanel = false;
      for (const p of panels) if (vx > p[0] && vx < p[1] && vy > p[2] && vy < p[3]) { isPanel = true; break; }
      let R = base * 1.0, Gc = base * 1.0, B2 = base * 1.025;
      if (isPanel) { const k = 214 + (crink[i0] - .5) * 36; R = k; Gc = k; B2 = k * 1.02; }
      if (!isPanel && gap) { R = 44; Gc = 46; B2 = 50; }
      else if (!isPanel) { const sh = .86 + .14 * bev; R *= sh; Gc *= sh; B2 *= sh; }
      // paint lines: thin dark band + orange stripe near the shoulder, small dark registration marks
      if (vy > .045 && vy < .06) { R = mix(R, 24, .85); Gc = mix(Gc, 26, .85); B2 = mix(B2, 30, .85); }
      else if (vy > .062 && vy < .071) { R = mix(R, 226, .85); Gc = mix(Gc, 96, .85); B2 = mix(B2, 30, .85); }
      if (scorch) {
        const s = clamp((vy - .1) * 1.6 + (blot[i0] - .5) * .5 + (streak[i0] - .5) * .65, 0, 1) * scorch;
        R = mix(R, 40, s); Gc = mix(Gc, 32, s * 1.02); B2 = mix(B2, 27, s * .98);
        if (vy > .06 && s > .35 && streak[i0] > .62) { R = mix(R, 112, .22); Gc = mix(Gc, 72, .22); B2 = mix(B2, 42, .22); }
      }
      const i = i0 * 4; d[i] = R; d[i + 1] = Gc; d[i + 2] = B2; d[i + 3] = 255;
      h[i0] = isPanel ? .62 + (crink[i0] - .5) * .5 : gap ? 0 : .35 + .65 * bev;
      rough[i0] = isPanel ? .88 : gap ? .92 : .5 + (t - .5) * .12 + .3 * scorch * clamp((vy - .1) * 2);
    }
  }
  q.putImageData(img, 0, 0);
  return { map: toTex(c, true), normal: normalTexture(h, W, H, 2.6), rough: grayTexture(rough, W, H) };
}

// Dark-amber ablator rim (low-frequency honeycomb block pattern, no linear grain).
function rimTexture(scorch, seed) {
  const W = 1024, H = 128, rng = makeRng(seed), c = cv(W, H), q = c.getContext('2d'), nz = noiseField(W, H, 14, 2, rng), nz2 = noiseField(W, H, 60, 6, rng);
  const img = q.createImageData(W, H), d = img.data, hexW = 18, hexH = 15.6;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const row = Math.floor(y / hexH), xo = x + (row & 1 ? hexW / 2 : 0), lx = (xo % hexW) / hexW - .5, ly = (y % hexH) / hexH - .5;
    const dd = Math.max(Math.abs(lx) * 1.15 + Math.abs(ly) * .55, Math.abs(ly) * 1.1), cell = clamp((.5 - dd) * 7);
    const i0 = y * W + x, tone = 1 + (nz[i0] - .5) * .5 + (nz2[i0] - .5) * .22;
    const dark = mix(1, .46, scorch), r = 128 * tone * dark, g = 76 * tone * dark, b = 40 * tone * dark, k = .38 + .62 * cell;
    const i = i0 * 4; d[i] = r * k; d[i + 1] = g * k; d[i + 2] = b * k; d[i + 3] = 255;
  }
  q.putImageData(img, 0, 0); return toTex(c, true);
}

// Plain-weave cloth normal map (suit, flag, parachute fabric).
const fabricNormal = memo(() => {
  const N = 128, p = 8, h = new Float32Array(N * N), rng = makeRng(31);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const over = (Math.floor(x / p) + Math.floor(y / p)) & 1, u = (x % p) / p, v = (y % p) / p;
    h[y * N + x] = over ? Math.pow(Math.sin(Math.PI * u), .8) * .9 : Math.pow(Math.sin(Math.PI * v), .8) * .9;
    h[y * N + x] += (rng() - .5) * .08;
  }
  return normalTexture(h, N, N, 2.4);
});

// Brushed / panelled metal normal + riveted seams for painted hull panels (white aluminium).
function panelTextures(seed, cols = 4, rows = 2) {
  const N = 512, rng = makeRng(seed), h = new Float32Array(N * N), fine = noiseField(N, N, 128, 8, rng), wob = noiseField(N, N, 12, 12, rng);
  const c = cv(N), q = c.getContext('2d'), img = q.createImageData(N, N), d = img.data;
  const pw = N / cols, ph = N / rows;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const lx = x % pw, ly = y % ph, ex = Math.min(lx, pw - lx), ey = Math.min(ly, ph - ly), e = Math.min(ex, ey);
    const seam = e < 2.2 ? 1 : 0, rivet = (e > 5 && e < 9 && ((ex < ey ? ly : lx) % 18) < 3) ? 1 : 0;
    const pid = (Math.floor(x / pw) + Math.floor(y / ph) * cols) % 8, pt = (pid * 0.137) % 1;
    let v = 232 + (pt - .5) * 12 + (wob[y * N + x] - .5) * 14 + (fine[y * N + x] - .5) * 6;
    if (seam) v = 120; else if (e < 4) v -= 22;
    if (rivet) v += 12;
    const i = (y * N + x) * 4; d[i] = v; d[i + 1] = v * 1.003; d[i + 2] = v * 1.012; d[i + 3] = 255;
    h[y * N + x] = seam ? 0 : e < 4 ? .55 : .8 + (rivet ? .3 : 0) + (fine[y * N + x] - .5) * .08;
  }
  q.putImageData(img, 0, 0);
  return { map: toTex(c, true), normal: normalTexture(h, N, N, 2.0) };
}

// Solar cell grid: blue cells, silver bus bars. 6 columns x 8 rows over the whole texture.
const cellTexture = memo(() => {
  const W = 384, H = 512, cw = 64, c = cv(W, H), q = c.getContext('2d'), rng = makeRng(77);
  q.fillStyle = '#7b848d'; q.fillRect(0, 0, W, H);
  for (let r = 0; r < 8; r++) for (let k = 0; k < 6; k++) {
    const x = k * cw, y = r * cw, t = rng(), cut = 7;
    const g = q.createLinearGradient(x, y, x + cw, y + cw);
    g.addColorStop(0, `rgb(${22 + t * 10},${52 + t * 14},${120 + t * 22})`); g.addColorStop(1, `rgb(${8 + t * 6},${24 + t * 8},${72 + t * 14})`);
    q.fillStyle = g; q.beginPath();
    q.moveTo(x + 3 + cut, y + 3); q.lineTo(x + cw - 3 - cut, y + 3); q.lineTo(x + cw - 3, y + 3 + cut); q.lineTo(x + cw - 3, y + cw - 3 - cut);
    q.lineTo(x + cw - 3 - cut, y + cw - 3); q.lineTo(x + 3 + cut, y + cw - 3); q.lineTo(x + 3, y + cw - 3 - cut); q.lineTo(x + 3, y + 3 + cut); q.closePath(); q.fill();
    q.fillStyle = 'rgba(200,214,232,.5)';                                  // fine collector fingers + bus bars
    for (let f = 0; f < 10; f++) q.fillRect(x + 9 + f * 4.6, y + 4, .7, cw - 8);
    q.fillStyle = 'rgba(214,222,232,.85)'; q.fillRect(x + 21, y + 3, 2, cw - 6); q.fillRect(x + 41, y + 3, 2, cw - 6);
    q.fillStyle = 'rgba(255,255,255,.04)'; q.fillRect(x + 3, y + 3, cw - 6, 10);
  }
  q.fillStyle = '#4c545c'; q.fillRect(0, 0, W, 7); q.fillRect(0, H - 7, W, 7); q.fillRect(0, 0, 7, H); q.fillRect(W - 7, 0, 7, H);
  return toTex(c, true);
});
const cellBackTexture = memo(() => {
  const c = cv(256, 256), q = c.getContext('2d'); q.fillStyle = '#9aa1a8'; q.fillRect(0, 0, 256, 256);
  q.strokeStyle = 'rgba(70,76,84,.55)'; q.lineWidth = 2; for (let i = 0; i <= 256; i += 32) { q.beginPath(); q.moveTo(i, 0); q.lineTo(i, 256); q.moveTo(0, i); q.lineTo(256, i); q.stroke(); }
  q.strokeStyle = 'rgba(60,64,70,.5)'; q.lineWidth = 3; q.strokeRect(2, 2, 252, 252);
  return toTex(c, true);
});

// Avcoat heat shield (planar uv over the disc). scorch 0..1: charring level.
function avcoatTexture(scorch, seed) {
  const N = 1024, c = cv(N), q = c.getContext('2d'), rng = makeRng(seed), R = N / 2;
  const base = [mix(150, 38, scorch), mix(94, 26, scorch), mix(56, 20, scorch)];
  q.fillStyle = `rgb(${base})`; q.fillRect(0, 0, N, N);
  // large soft tonal patches
  for (let i = 0; i < 90; i++) {
    const x = rng() * N, y = rng() * N, r = 30 + rng() * 120, g = q.createRadialGradient(x, y, 0, x, y, r), dark = rng() < .6;
    g.addColorStop(0, dark ? `rgba(20,12,8,${.1 + .2 * scorch})` : `rgba(210,150,90,${.1 + .08 * (1 - scorch)})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    q.fillStyle = g; q.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // radial ablation streaks (flow from the centre out)
  q.lineCap = 'round';
  for (let i = 0; i < 520; i++) {
    const a = rng() * TAU, r0 = 30 + rng() * 380, len = 30 + rng() * 150;
    q.strokeStyle = rng() < .5 ? `rgba(15,9,6,${.08 + .14 * scorch * rng()})` : `rgba(190,120,70,${.04 + .08 * rng() * (1 - scorch * .7)})`;
    q.lineWidth = .5 + rng() * 1.4; q.beginPath(); q.moveTo(R + Math.cos(a) * r0, R + Math.sin(a) * r0); q.lineTo(R + Math.cos(a) * (r0 + len), R + Math.sin(a) * (r0 + len)); q.stroke();
  }
  // honeycomb blocks: fine per-block tone variation + hairline seams (visible only up close; mip-mapped away at distance)
  const NC = 56, cell = N / NC;
  for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) {
    const v = rng() - .5; q.fillStyle = v > 0 ? `rgba(215,150,95,${v * (.12 - .06 * scorch)})` : `rgba(8,5,3,${-v * (.22 + .12 * scorch)})`; q.fillRect(i * cell, j * cell, cell, cell);
  }
  q.strokeStyle = `rgba(14,9,6,${.2 + .1 * scorch})`; q.lineWidth = 1;
  for (let i = 0; i <= NC; i++) { q.beginPath(); q.moveTo(i * cell + .5, 0); q.lineTo(i * cell + .5, N); q.moveTo(0, i * cell + .5); q.lineTo(N, i * cell + .5); q.stroke(); }
  // speckles
  for (let i = 0; i < 9000; i++) { q.fillStyle = rng() < .5 ? `rgba(10,6,4,${rng() * .5})` : `rgba(230,180,120,${rng() * .18})`; q.fillRect(rng() * N, rng() * N, 1 + rng() * 2, 1 + rng() * 2); }
  // bolt heads around the rim
  for (let i = 0; i < 72; i++) { const a = i / 72 * TAU; q.fillStyle = 'rgba(30,28,28,.9)'; q.beginPath(); q.arc(R + Math.cos(a) * R * .93, R + Math.sin(a) * R * .93, 4.5, 0, TAU); q.fill(); q.fillStyle = 'rgba(160,150,140,.5)'; q.beginPath(); q.arc(R + Math.cos(a) * R * .93 - 1, R + Math.sin(a) * R * .93 - 1, 1.6, 0, TAU); q.fill(); }
  return toTex(c, true, false);
}

// Ringsail canopy: 20 alternating orange/white gores, horizontal sail rings with dark slots, hem band.
const canopyTexture = memo(() => {
  const gores = 20, gw = 80, W = gores * gw, H = 512, c = cv(W, H), q = c.getContext('2d'), rng = makeRng(2026);
  const bands = [[132, 162, '#f06a1c'], [296, 326, '#f1efe8']];        // solid orange / white ring bands running across every gore
  for (let g = 0; g < gores; g++) { q.fillStyle = g & 1 ? '#f1efe8' : '#f06a1c'; q.fillRect(g * gw, 0, gw, H); }
  for (const [a, b, col] of bands) { q.fillStyle = col; q.fillRect(0, a, W, b - a); }
  const ring = 24;                                                     // ring panels from the vent toward the hem
  for (let y = 54, n = 0; y < H - 52; y += ring, n++) {
    q.fillStyle = n & 1 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.05)'; q.fillRect(0, y, W, ring);
    q.fillStyle = 'rgba(0,0,0,.46)'; q.fillRect(0, y, W, 3.5); q.fillStyle = 'rgba(0,0,0,.16)'; q.fillRect(0, y + 3.5, W, 5);
    q.fillStyle = 'rgba(255,255,255,.12)'; q.fillRect(0, y - 4, W, 3);
  }
  q.fillStyle = 'rgba(30,30,34,.5)'; for (const [a, b] of bands) { q.fillRect(0, a - 1.5, W, 3); q.fillRect(0, b - 1.5, W, 3); }
  for (let g = 0; g < gores; g++) {                                     // reinforcement tapes + gore shading toward seams
    const gr = q.createLinearGradient(g * gw, 0, (g + 1) * gw, 0); gr.addColorStop(0, 'rgba(0,0,0,.22)'); gr.addColorStop(.18, 'rgba(0,0,0,0)'); gr.addColorStop(.82, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.22)');
    q.fillStyle = gr; q.fillRect(g * gw, 0, gw, H);
    q.fillStyle = 'rgba(40,40,44,.65)'; q.fillRect(g * gw - 1.5, 0, 3, H);
  }
  q.fillStyle = 'rgba(30,30,34,.55)'; q.fillRect(0, 0, W, 26); q.fillStyle = 'rgba(30,30,34,.35)'; q.fillRect(0, H - 40, W, 40);   // vent band / hem band
  q.fillStyle = 'rgba(205,40,30,.65)'; q.fillRect(0, H - 30, W, 6);
  for (let i = 0; i < 20000; i++) { q.fillStyle = `rgba(${rng() < .5 ? '0,0,0' : '255,255,255'},${rng() * .06})`; q.fillRect(rng() * W, rng() * H, 1 + rng() * 3, 1); }
  return toTex(c, true);
});

const hexOf = (r, g, b) => (r << 16) | (g << 8) | b;


/* ------------------------------------------------------------------ shared materials */
const radiatorTexture = memo(() => {
  const c = cv(256, 256), q = c.getContext('2d'); q.fillStyle = '#e6e8ea'; q.fillRect(0, 0, 256, 256);
  q.fillStyle = 'rgba(70,80,92,.55)'; for (let x = 10; x < 256; x += 12) q.fillRect(x, 14, 3, 228);
  q.strokeStyle = 'rgba(60,66,74,.9)'; q.lineWidth = 6; q.strokeRect(3, 3, 250, 250);
  q.fillStyle = 'rgba(60,66,74,.8)'; q.fillRect(0, 124, 256, 6);
  return toTex(c, true);
});
const lampMat = c => new THREE.MeshBasicMaterial({ color: c });
// Soft round glow: hot core + long gaussian-like tail that reaches exactly 0 alpha before the quad edge (never a visible square).
const glowTex = memo(() => {
  const c = cv(128), q = c.getContext('2d'), g = q.createRadialGradient(64, 64, 0, 64, 64, 64);
  [[0, 1], [.05, .92], [.12, .6], [.22, .3], [.36, .13], [.52, .05], [.72, .012], [1, 0]].forEach(([o, a]) => g.addColorStop(o, `rgba(255,255,255,${a})`));
  q.fillStyle = g; q.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
});
const glowStarTex = memo(() => {                     // same glow + a faint 4-point cross streak (white strobes only)
  const c = cv(128), q = c.getContext('2d'); q.drawImage(glowTex().image, 0, 0);
  for (const [w, h] of [[128, 3], [3, 128]]) {
    const g = q.createLinearGradient(w > h ? 0 : 64, w > h ? 64 : 0, w > h ? 128 : 64, w > h ? 64 : 128);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.5, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    q.fillStyle = g; q.fillRect(w > h ? 0 : 63, w > h ? 63 : 0, w > h ? 128 : 2, w > h ? 2 : 128);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
});
const spriteMat = (c, star = false) => new THREE.SpriteMaterial({ map: star ? glowStarTex() : glowTex(), color: c, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false });

const MAT = memo(() => {
  const std = o => new THREE.MeshStandardMaterial(o), phys = o => new THREE.MeshPhysicalMaterial(o);
  const gold = mliTextures('gold', 11), white = mliTextures('white', 12), silver = mliTextures('silver', 13), tiles = tilesTextures(0, 21), tilesS = tilesTextures(.9, 22), hull = panelTextures(41, 4, 2);
  const fab = fabricNormal();
  const mli = (t, extra) => std({ map: t.map, normalMap: t.normal, roughnessMap: t.rough, roughness: 1, ...extra });
  return {
    backshell: std({ map: tiles.map, normalMap: tiles.normal, roughnessMap: tiles.rough, roughness: 1, metalness: .18, normalScale: new THREE.Vector2(1.1, 1.1) }),
    backshellScorch: std({ map: tilesS.map, normalMap: tilesS.normal, roughnessMap: tilesS.rough, roughness: 1, metalness: .1, normalScale: new THREE.Vector2(1.1, 1.1) }),
    rim: std({ map: rimTexture(0, 61), roughness: .95, metalness: 0 }),
    rimChar: std({ map: rimTexture(.8, 62), roughness: .96, metalness: 0 }),
    avcoat: std({ map: avcoatTexture(.25, 5), roughness: .93, metalness: 0 }),
    avcoatChar: std({ map: avcoatTexture(.88, 6), roughness: .96, metalness: 0 }),
    metal: std({ color: 0xffffff, vertexColors: true, metalness: .9, roughness: .34 }),
    darkMetal: std({ color: 0xffffff, vertexColors: true, metalness: .72, roughness: .46 }),
    matte: std({ color: 0xffffff, vertexColors: true, metalness: .05, roughness: .8 }),
    glass: phys({ color: 0x1b2c3c, metalness: .92, roughness: .06, clearcoat: 1, clearcoatRoughness: .03, ior: 1.52, envMapIntensity: 2.6, emissive: 0x0a1624, emissiveIntensity: 1 }),
    mliWhite: mli(white, { color: 0xd6d9de, metalness: .22, normalScale: new THREE.Vector2(.9, .9) }),
    mliSilver: mli(silver, { color: 0xffffff, metalness: .85 }),
    mliGold: mli(gold, { color: 0xffffff, metalness: .92 }),
    mliGoldBlanket: mli(gold, { color: 0xffffff, metalness: .92, normalScale: new THREE.Vector2(1.3, 1.3) }),
    radiator: std({ map: radiatorTexture(), roughness: .55, metalness: .2 }),
    hullWhite: std({ map: hull.map, normalMap: hull.normal, roughness: .5, metalness: .25 }),
    cells: phys({ map: cellTexture(), emissiveMap: cellTexture(), emissive: 0x2a5fd0, emissiveIntensity: .3, metalness: .34, roughness: .3, clearcoat: .85, clearcoatRoughness: .14, iridescence: .6, iridescenceIOR: 1.55, iridescenceThicknessRange: [180, 620], envMapIntensity: 1.5 }),
    cellBack: std({ map: cellBackTexture(), roughness: .55, metalness: .35 }),
    bell: std({ color: 0xffffff, vertexColors: true, metalness: .9, roughness: .4, side: THREE.DoubleSide }),
    suitNormal: fab,
    lampRed: lampMat(0x200000), lampGreen: lampMat(0x002008), lampWhite: lampMat(0x202020), lampAmber: lampMat(0x402000),
    glowRed: spriteMat(0xff2a1a), glowGreen: spriteMat(0x2aff6a), glowWhite: spriteMat(0xffffff, true)
  };
});

// Blinking lamp: bright core + additive halo. t-periodic only.
const blinkPulse = (t, period, width, phase = 0) => { const x = ((t + phase) % period + period) % period; return x < width ? Math.sin(x / width * Math.PI) : 0; };

/* ------------------------------------------------------------------ crew module (shared by Orion, entry and sea capsule) */
// cm: { y0 (base of the cone), rBot, rTop, h }. Builds the cone, windows, RCS ports, forward-bay cover and heat-shield dish.
function coneAt(c, theta, y) {
  const k = (c.rBot - c.rTop) / c.h, r = c.rBot - k * (y - c.y0), s = Math.sin(theta), co = Math.cos(theta);
  return { p: [s * r, y, co * r], n: new V3(s, k, co).normalize(), up: new V3(-k * s, 1, -k * co).normalize() };
}
function onCone(b, geo, c, theta, y, sx, sy, sz, o, lift = 0) {
  const f = coneAt(c, theta, y), M = frameM([f.p[0] + f.n.x * lift, f.p[1] + f.n.y * lift, f.p[2] + f.n.z * lift], f.n, f.up);
  return b.addM(geo, M.multiply(new M4().makeScale(sx, sy, sz)), o);
}
function buildCM(B, c, opts = {}) {
  const { back, avc, metal, dark, glass, matte, rim } = B;
  back.add(cylG(c.rTop, c.rBot, c.h, 72, true), [0, c.y0 + c.h / 2, 0]);
  matte.add(dishGeo(c.rTop, c.h * .05, 3, 48, 1), [0, c.y0 + c.h, 0], 1, [0, 0, 0], { color: opts.cover ?? 0xaeb4ba });   // forward-bay cover (slight dome)
  metal.add(torus(c.rTop, .028, 48, 6), [0, c.y0 + c.h, 0], 1, [Math.PI / 2, 0, 0], { color: 0x3a3f45 });
  for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + .5; metal.add(G.box, [Math.sin(a) * c.rTop * .72, c.y0 + c.h + c.h * .028, Math.cos(a) * c.rTop * .72], [.2, .035, .1], [0, a, 0], { color: 0x4a5058 }); }
  // heat shield: convex Avcoat dish, rim ring
  avc.add(dishGeo(c.rBot - .02, opts.sag ?? c.rBot * .1, 14, 72, -1), [0, c.y0, 0]);
  rim.add(torus(c.rBot - .02, c.rBot * .03, 96, 10), [0, c.y0 + .012, 0], 1, [Math.PI / 2, 0, 0], { uv: [22, 1.4] });
  // windows (trapezoid-ish): glass over a metal frame
  const wy = c.y0 + c.h * .58;
  for (const th of [.62, -.62, Math.PI + .62, Math.PI - .62]) {
    onCone(metal, trapG(c.rBot * .1, c.rBot * .17, c.rBot * .14, 1), c, th, wy, 1, 1, .03, { color: 0x8c949c }, .004);
    onCone(glass, trapG(c.rBot * .072, c.rBot * .13, c.rBot * .105, 1), c, th, wy, 1, 1, .03, undefined, .016);
  }
  // side hatch (+X): raised frame + handle
  const hy = c.y0 + c.h * .4;
  onCone(matte, trapG(.5 * c.rBot * .36, .5 * c.rBot * .42, c.rBot * .52, 1), c, Math.PI / 2, hy, 1, 1, .03, { color: 0xc4c8cc }, .006);
  onCone(metal, G.box, c, Math.PI / 2, hy, c.rBot * .1, c.rBot * .04, .04, { color: 0x6c737a }, .02);
  // RCS jet ports in two rings
  for (let i = 0; i < 12; i++) {
    const th = i * TAU / 12 + .26, y = c.y0 + c.h * (i & 1 ? .84 : .2);
    onCone(dark, G.box, c, th, y, c.rBot * .032, c.rBot * .04, .03, { color: 0x1c2024 }, .004);
  }
  // antenna / umbilical fairing blisters
  for (let i = 0; i < 3; i++) {
    const th = 1.57 + Math.PI + i * .9 - .9, y = c.y0 + c.h * .3, r = c.rBot * .07;
    onCone(matte, domeG(), c, th, y, r, r * .66, r * .55, { color: 0xc6cacd }, 0);
    onCone(metal, torus(1, .09, 24, 6), c, th, y, r, r * .66, r * .55, { color: 0x7d858c }, .002);
    onCone(dark, cylG(.28, .28, .3, 12), c, th, y, r * .6, r * .45, r * .3, { color: 0x1d2125 }, .02).items[dark.items.length - 1].m.multiply(rotX(Math.PI / 2));
  }
}

/* ------------------------------------------------------------------ Orion */
const orionTemplate = memo(() => {
  const M = MAT(), root = new THREE.Group();
  const B = { back: new Batch(), avc: new Batch(), metal: new Batch(), dark: new Batch(), glass: new Batch(), matte: new Batch(), rim: new Batch() };
  const bMLI = new Batch(), bCMA = new Batch(), bRad = new Batch(), bFront = new Batch(), bBack = new Batch(), bBell = new Batch();
  const CM = { y0: 1.3, rBot: 2.3, rTop: 1.15, h: 1.65 };
  buildCM(B, CM);
  const { metal, dark } = B;

  // docking tunnel + docking-system ring with three guide petals (top at y~3.3)
  metal.add(cylG(.86, .9, .16, 40), [0, CM.y0 + CM.h + .08, 0], 1, [0, 0, 0], { color: 0xaab1b8 });
  metal.add(cylG(.8, .82, .2, 40, true), [0, 3.07, 0], 1, [0, 0, 0], { color: 0xd0d5da });
  metal.add(torus(.8, .055, 40, 8), [0, 3.17, 0], 1, [Math.PI / 2, 0, 0], { color: 0xe6e9ec });
  dark.add(cylG(.7, .7, .03, 36), [0, 3.1, 0], 1, [0, 0, 0], { color: 0x15181c });
  metal.add(torus(.52, .03, 32, 6), [0, 3.115, 0], 1, [Math.PI / 2, 0, 0], { color: 0xcaa24a });
  for (let i = 0; i < 12; i++) { const a = i * TAU / 12; metal.add(G.box, [Math.sin(a) * .83, 3.1, Math.cos(a) * .83], [.13, .12, .1], [0, a, 0], { color: 0x8d949b }); }
  for (let i = 0; i < 3; i++) {
    const a = i * TAU / 3 + .1;
    metal.push(rotY(a)); metal.addM(G.box, tr(0, 3.145, .79).multiply(rotX(.62)).multiply(new M4().makeTranslation(0, 0, -.17)).multiply(new M4().makeScale(.36, .018, .34)), { color: 0xd6b45a }); metal.pop();
  }

  // CMA ring + ESM (white/silver MLI wrap with seams) ---------------------------------------
  bCMA.add(cylG(2.04, 2.16, .58, 72), [0, .83, 0], 1, [0, 0, 0], { uv: [4, 1] });
  metal.add(torus(2.1, .04, 72, 6), [0, 1.12, 0], 1, [Math.PI / 2, 0, 0], { color: 0xb8bec4 });
  for (let i = 0; i < 24; i++) { const a = i * TAU / 24; metal.add(G.box, [Math.sin(a) * 2.1, .83, Math.cos(a) * 2.1], [.045, .5, .03], [0, a, 0], { color: 0x9aa1a8 }); }
  for (let i = 0; i < 3; i++) { const a = i * 2.1 + .35; metal.add(G.box, [Math.sin(a) * 2.1, .86, Math.cos(a) * 2.1], [.34, .3, .12], [0, a, 0], { color: 0xc4c9ce }); }
  bMLI.add(cylG(2.16, 2.16, 2.6, 72, true), [0, -.75, 0], 1, [0, 0, 0], { uv: [5, 1.8] });
  bMLI.add(cylG(2.16, 2.0, .16, 72), [0, .47, 0], 1, [0, 0, 0], { uv: [5, .2] });
  for (const y of [.12, -.55, -1.2, -1.85]) metal.add(torus(2.17, .032, 72, 6), [0, y, 0], 1, [Math.PI / 2, 0, 0], { color: 0xb4bbc2 });
  for (let i = 0; i < 16; i++) { const a = i * TAU / 16 + .2; metal.add(G.box, [Math.sin(a) * 2.165, -.75, Math.cos(a) * 2.165], [.05, 2.5, .02], [0, a, 0], { color: 0xaeb5bc }); }
  for (let k = 0; k < 4; k++) {                                                     // radiator panels between the wing roots
    const th = k * Math.PI / 2 - .5;
    bRad.add(new THREE.CylinderGeometry(2.2, 2.2, 1.55, 14, 1, true, th, 1.0), [0, -.6, 0], 1, [0, 0, 0], { uv: [1, 1] });
  }
  for (let k = 0; k < 4; k++) { // radiator frames (top/bottom bars)
    const th = k * Math.PI / 2;
    for (const dy of [.775, -.775]) metal.add(new THREE.CylinderGeometry(2.215, 2.215, .05, 14, 1, true, th - .5, 1.0), [0, -.6 + dy, 0], 1, [0, 0, 0], { color: 0xa8afb6 });
  }
  // aft thrust structure, OMS-E bell, gimbal actuators, aux thrusters, RCS pods
  dark.add(cylG(2.1, 2.16, .09, 72), [0, -2.07, 0], 1, [0, 0, 0], { color: 0x2b3137 });
  dark.add(cylG(.95, 1.5, .18, 40), [0, -2.12, 0], 1, [0, 0, 0], { color: 0x23282d });
  metal.add(torus(.38, .04, 32, 8), [0, -1.95, 0], 1, [Math.PI / 2, 0, 0], { color: 0xb7bdc3 });
  const bellPts = [[.34, -1.84], [.3, -1.9], [.22, -2.04]];
  for (let i = 1; i <= 14; i++) { const s = i / 14, y = -2.04 - .91 * s; bellPts.push([.22 + .44 * Math.pow(s, .5), y]); }
  bellPts.push([.69, -2.955], [.665, -2.955]);
  const bell = lathe(bellPts, 56), bp = bell.attributes.position, bc = new Float32Array(bp.count * 3);
  for (let i = 0; i < bp.count; i++) {
    const t = clamp((-1.84 - bp.getY(i)) / 1.12), ramp = t < .35 ? [.64, .66, .68] : t < .75 ? [mix(.64, .42, (t - .35) / .4), mix(.66, .30, (t - .35) / .4), mix(.68, .22, (t - .35) / .4)] : [mix(.42, .13, (t - .75) / .25), mix(.30, .15, (t - .75) / .25), mix(.22, .3, (t - .75) / .25)];
    bc[i * 3] = ramp[0]; bc[i * 3 + 1] = ramp[1]; bc[i * 3 + 2] = ramp[2];
  }
  bell.setAttribute('color', new THREE.BufferAttribute(bc, 3)); bBell.add(bell);
  for (let i = 0; i < 2; i++) for (const s of [-1, 1]) rod(metal, [s * .95 * (i ? 0 : 1), -2.08, (i ? s : 0) * .95], [s * .3 * (i ? 0 : 1), -2.3, (i ? s : 0) * .3], .028, { color: 0x9aa1a8 });
  for (let k = 0; k < 4; k++) {                                                     // 8 auxiliary thrusters in 4 pods
    const a = k * Math.PI / 2 + Math.PI / 4;
    dark.push(rotY(a));
    dark.add(G.box, [0, -2.15, 1.55], [.42, .12, .3], [0, 0, 0], { color: 0x2f353b });
    for (const s of [-1, 1]) {
      dark.add(cylG(.045, .11, .34, 14, false), [s * .11, -2.32, 1.58], 1, [-.18, 0, 0], { color: 0x7a5a3a });
      dark.add(torus(.11, .012, 14, 5), [s * .11, -2.5, 1.62], 1, [Math.PI / 2 - .18, 0, 0], { color: 0x3b2f2a });
    }
    dark.pop();
  }
  for (let k = 0; k < 6; k++) {                                                     // RCS pods (4 nozzles each)
    const a = k * Math.PI / 3 + .52, y = k & 1 ? -1.6 : .2;
    dark.push(rotY(a));
    dark.add(G.box, [0, y, 2.2], [.34, .4, .1], [0, 0, 0], { color: 0x2b3137 });
    for (const [dx, dy, rz] of [[-.13, 0, Math.PI / 2], [.13, 0, Math.PI / 2], [0, .2, 0], [0, -.2, 0]]) dark.add(cylG(.04, .055, .13, 10), [dx * 1.0 + (rz ? 0 : 0), y + dy, 2.27 + (rz ? .02 : .02)], 1, [rz ? 0 : 0, 0, rz ? Math.PI / 2 : 0], { color: 0x15181c });
    dark.pop();
  }

  // four solar wings in an X configuration, three panels each, span ~8 -----------------------
  const wingY = -.45, panelW = 1.62, panelD = 2.4;
  for (let i = 0; i < 4; i++) {
    const ang = Math.PI / 4 + i * Math.PI / 2, A = rotY(ang);
    metal.push(A); bFront.push(A); bBack.push(A); dark.push(A);
    metal.add(G.box, [2.3, wingY, 0], [.5, .34, .6], [0, 0, 0], { color: 0x9097a0 });
    metal.add(cylG(.12, .12, .55, 16), [2.78, wingY, 0], 1, [0, 0, Math.PI / 2], { color: 0xc5cbd1 });
    for (const s of [-1, 1]) for (const dy of [.55, -.55]) rod(metal, [2.1, wingY + dy, s * .55], [3.0, wingY, s * .26], .042, { color: 0xb6bcc3 });
    rod(metal, [3.0, wingY - .09, 0], [8.0, wingY - .09, 0], .05, { color: 0xaab1b8 });
    for (let p = 0; p < 3; p++) {
      const x0 = 3.05 + p * (panelW + .1), cx = x0 + panelW / 2;
      bFront.addM(G.plane, tr(cx, wingY + .032, 0).multiply(rotX(-Math.PI / 2)).multiply(new M4().makeScale(panelW, panelD, 1)));
      bBack.addM(G.plane, tr(cx, wingY - .032, 0).multiply(rotX(Math.PI / 2)).multiply(new M4().makeScale(panelW, panelD, 1)));
      for (const s of [-1, 1]) metal.add(G.box, [cx, wingY, s * (panelD / 2 + .02)], [panelW + .06, .07, .05], [0, 0, 0], { color: 0x8a919a });
      for (const s of [-1, 1]) metal.add(G.box, [cx + s * (panelW / 2 + .02), wingY, 0], [.05, .07, panelD + .06], [0, 0, 0], { color: 0x8a919a });
      if (p < 2) { rod(metal, [x0 + panelW + .05, wingY, -1.18], [x0 + panelW + .05, wingY, 1.18], .036, { color: 0xc3c9cf }); }
    }
    rod(metal, [8.02, wingY, -1.2], [8.02, wingY, 1.2], .042, { color: 0xc3c9cf });
    metal.pop(); bFront.pop(); bBack.pop(); dark.pop();
  }

  // assemble meshes
  const put = (b, m, name) => b.mesh(m, root, { name });
  put(B.back, M.backshell, 'cm'); put(B.rim, M.rim, 'rim'); put(B.avc, M.avcoat, 'shield'); put(B.metal, M.metal, 'metal'); put(B.dark, M.darkMetal, 'dark');
  put(B.glass, M.glass, 'glass'); put(B.matte, M.matte, 'matte');
  put(bMLI, M.mliWhite, 'esm'); put(bCMA, M.mliSilver, 'cma'); put(bRad, M.radiator, 'radiators');
  put(bFront, M.cells, 'cells'); put(bBack, M.cellBack, 'cellback'); put(bBell, M.bell, 'bell');
  // nav lights at two wing tips + halos
  const lamp = (mat, glowMat, ang, name) => {
    const x = Math.cos(ang) * 8.05, z = -Math.sin(ang) * 8.05, l = new THREE.Mesh(G.sph12, mat); l.scale.setScalar(.085); l.position.set(x, wingY, z); l.name = name; root.add(l);
    const s = new THREE.Sprite(glowMat); s.scale.setScalar(.42); s.position.set(x, wingY, z); s.name = name + 'G'; root.add(s);
  };
  lamp(M.lampRed, M.glowRed, Math.PI / 4, 'navR'); lamp(M.lampGreen, M.glowGreen, Math.PI / 4 + Math.PI, 'navG');
  const strobe = new THREE.Mesh(G.sph12, M.lampWhite); strobe.scale.setScalar(.06); strobe.position.set(0, 3.28, -.5); root.add(strobe);
  const sg = new THREE.Sprite(M.glowWhite); sg.scale.setScalar(.38); sg.position.copy(strobe.position); sg.name = 'strobeG'; root.add(sg);
  const anchor = new THREE.Group(); anchor.name = 'engineAnchor'; anchor.position.y = -2.7; root.add(anchor);
  return root;
});

function navTick(M, t) {
  const r = blinkPulse(t, 1.7, .3), g = blinkPulse(t, 1.7, .3, .85), w = blinkPulse(t, 3.4, .12, 1.1);
  M.lampRed.color.setRGB(.14 + r * 7, .01 + r * .35, .01 + r * .25); M.glowRed.opacity = r * .95;
  M.lampGreen.color.setRGB(.01 + g * .3, .12 + g * 7, .02 + g * .9); M.glowGreen.opacity = g * .95;
  M.lampWhite.color.setRGB(.12 + w * 6, .12 + w * 6, .12 + w * 6); M.glowWhite.opacity = w * .85;
}

// Orion CM + ESM. Local +Y is the nose: docking port top at y≈+3.3. Main engine exit at y≈-2.95
// (attach exhaust at userData.engineAnchor, y=-2.7). Four solar wings (X configuration, 3 panels each) span about ±8.
export function orion(parent, scale = 1) {
  const g = orionTemplate().clone(true); g.scale.setScalar(scale); parent?.add(g);
  const M = MAT();
  g.userData.engineAnchor = g.getObjectByName('engineAnchor');
  g.userData.tick = t => navTick(M, t);
  return g;
}


/* ------------------------------------------------------------------ generic HLS lander */
const landerLamps = memo(() => ({ red: lampMat(0x200000), green: lampMat(0x002008), white: lampMat(0x202020), flood: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.0, 2.6) }), gRed: spriteMat(0xff2a1a), gGreen: spriteMat(0x2aff6a), gWhite: spriteMat(0xffffff, true) }));

// One landing leg in hinge space (origin at the upper hinge, leg extends toward +X / -Y): primary + telescoping strut, gold blanket,
// knee ball, contact probe and a ribbed octagonal footpad (not a dish). Instanced four times and folded by setLegs().
const LEG_D = [2.85, -4.64], LEG_HINGE = [2.9, 5.0], LEG_FOLD = 21.5 * Math.PI / 180;
const legGeos = memo(() => {
  const at = s => [LEG_D[0] * s, LEG_D[1] * s, 0], bm = new Batch(), bd = new Batch(), bb = new Batch(), fy = -LEG_HINGE[1];
  rod(bm, at(0), at(.58), .17, { color: 0xc9ced3 }, G.cyl16); rod(bm, at(.55), at(1), .1, { color: 0xe2e5e8 }, G.cyl16);
  rod(bb, at(.12), at(.5), .235, undefined, G.cyl16);
  bm.add(G.sph, [LEG_D[0], fy + .42, 0], .2, [0, 0, 0], { color: 0xb6bcc3 });
  const fx = LEG_D[0];
  bm.add(cylG(.84, .9, .1, 8), [fx, fy + .05, 0], 1, [0, Math.PI / 8, 0], { color: 0xc3c8cd });                 // pad plate
  bm.add(cylG(.62, .72, .09, 8), [fx, fy + .14, 0], 1, [0, Math.PI / 8, 0], { color: 0xb4babf });
  bm.add(cylG(.26, .36, .22, 16), [fx, fy + .25, 0], 1, [0, 0, 0], { color: 0xd2d6da });
  for (let r = 0; r < 8; r++) { const a = r * Math.PI / 4; bm.add(G.box, [fx + Math.cos(a) * .52, fy + .2, Math.sin(a) * .52], [.52, .1, .06], [0, -a, 0], { color: 0xaab1b8 }); }
  for (let r = 0; r < 8; r++) { const a = (r + .5) * Math.PI / 4; bd.add(G.box, [fx + Math.cos(a) * .72, fy + .085, Math.sin(a) * .72], [.2, .07, .09], [0, -a, 0], { color: 0x3e444a }); }
  rod(bm, [fx, fy + .02, 0], [fx, fy - 1.1, 0], .035, { color: 0xd2d6da });                                      // contact probe (3 of 4 legs in the old model; all 4 are fine)
  return { metal: bm.geometry(), dark: bd.geometry(), blanket: bb.geometry() };
});
const strutGeo = memo(() => new Batch().add(G.cyl8, [0, 0, 0], 1, [0, 0, 0], { color: 0x30363c }).geometry());
const _lm = new M4(), _lm2 = new M4(), _lm3 = new M4(), _lA = new V3(), _lB = new V3(), _lC = new V3(), _lq = new THREE.Quaternion(), _lq2 = new THREE.Quaternion(), _lone = new V3(1, 1, 1);

const landerTemplate = memo(() => {
  const M = MAT(), L = landerLamps(), root = new THREE.Group();
  const bMetal = new Batch(), bDark = new Batch(), bTank = new Batch(), bBlanket = new Batch(), bCabin = new Batch(), bGlass = new Batch(), bMatte = new Batch(), bRad = new Batch(), bBell = new Batch();

  // ---- crew cabin (rounded pressure module) with docking adapter on top (hatch at y=10.3)
  const prof = [[0, 5.5], [1.66, 5.5], [1.68, 5.54], [2.1, 5.78], [2.3, 6.2], [2.32, 7.5], [2.2, 8.1], [1.78, 8.75], [1.3, 9.2], [1.0, 9.34], [.95, 9.38], [.95, 9.9]];
  bCabin.add(lathe(prof, 56), [0, 0, 0], 1, [0, 0, 0], { uv: [4, 3] });
  bMetal.add(cylG(1.14, 1.14, .22, 40), [0, 9.98, 0], 1, [0, 0, 0], { color: 0xb8bec4 });
  bMetal.add(cylG(1.02, 1.1, .22, 40), [0, 10.19, 0], 1, [0, 0, 0], { color: 0xd4d9de });
  bDark.add(cylG(.78, .78, .04, 36), [0, 10.29, 0], 1, [0, 0, 0], { color: 0x2a2f35 });
  bMetal.add(torus(.86, .045, 40, 8), [0, 10.3, 0], 1, [Math.PI / 2, 0, 0], { color: 0xe4e7ea });
  bMetal.add(torus(.5, .03, 28, 6), [0, 10.31, 0], 1, [Math.PI / 2, 0, 0], { color: 0xcaa24a });
  for (let i = 0; i < 12; i++) { const a = i * TAU / 12; bMetal.add(G.box, [Math.sin(a) * 1.1, 10.2, Math.cos(a) * 1.1], [.16, .16, .1], [0, a, 0], { color: 0x8a9198 }); }
  for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + .5; bMetal.addM(G.box, rotY(a).multiply(tr(0, 10.46, .96)).multiply(rotX(.5)).multiply(new M4().makeScale(.3, .02, .3)), { color: 0xd0d5da }); }
  bBlanket.add(cylG(2.1, 1.7, .34, 56, true), [0, 5.66, 0], 1, [0, 0, 0], { uv: [6, .6] });              // gold blanket skirt under the cabin
  // windows (trapezoid glass in frames): two forward, two side
  const cabCone = { y0: 7.5, rBot: 2.32, rTop: 2.2, h: .6 }, cabCone2 = { y0: 8.1, rBot: 2.2, rTop: 1.78, h: .65 };
  for (const th of [.5, -.5, Math.PI / 2 + .25, -Math.PI / 2 - .25]) {
    onCone(bMetal, trapG(.62, .95, .72, 1), cabCone, th, 7.78, 1, 1, .05, { color: 0x7a828a }, .01);
    onCone(bGlass, trapG(.46, .8, .56, 1), cabCone, th, 7.78, 1, 1, .05, undefined, .03);
  }
  onCone(bGlass, G.sph12, cabCone2, 0, 8.6, .09, .09, .05, undefined, .03);                        // small docking-camera window
  // hatch on +Z with porthole + grab handle
  const hatchCone = { y0: 6.2, rBot: 2.3, rTop: 2.32, h: 1.2 };
  onCone(bMatte, trapG(1.0, 1.12, 1.5, 1), hatchCone, 0, 6.85, 1, 1, .12, { color: 0xcfd2d6 }, .02);
  onCone(bMetal, torus(.22, .035, 24, 6), hatchCone, 0, 7.0, 1, 1, 1, { color: 0x7d858c }, .1);
  onCone(bGlass, cylG(.14, .14, .03, 20), hatchCone, 0, 7.0, 1, 1, 1, undefined, .085).items[bGlass.items.length - 1].m.multiply(rotX(Math.PI / 2));
  for (const x of [-.46, .46]) rod(bMetal, [x, 6.4, 2.5], [x, 7.1, 2.5], .03, { color: 0x666d74 });
  // side radiators (flat panels on short standoffs) and star trackers
  for (const th of [Math.PI / 2 + .75, -Math.PI / 2 - .75]) {
    onCone(bRad, G.box, hatchCone, th, 6.9, 1.3, 1.25, .06, undefined, .1);
    onCone(bMetal, G.box, hatchCone, th, 6.85, .1, 1.1, .1, { color: 0x6d747b }, .04);
  }
  onCone(bDark, cylG(.12, .12, .22, 14), cabCone, 2.5, 8.9, 1, 1, 1, { color: 0x101316 }, .1).items[bDark.items.length - 1].m.multiply(rotX(Math.PI / 2));
  // RCS quads on the cabin base
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4;
    bDark.push(rotY(a));
    bDark.add(G.box, [0, 5.95, 2.45], [.5, .5, .24], [0, 0, 0], { color: 0x2a3036 });
    for (const [dx, dy, rx, rz] of [[-.3, 0, 0, Math.PI / 2], [.3, 0, 0, -Math.PI / 2], [0, .34, 0, 0], [0, -.34, 0, Math.PI]]) bDark.add(cylG(.05, .12, .26, 14), [dx, 5.95 + dy, 2.5], 1, [0, 0, rz], { color: 0x14181b });
    bDark.pop();
  }
  // antennas: S-band dish on a boom, whips, camera mast
  const dishPts = [[.66, .3], [.32, .08], [0, 0], [0, -.04], [.34, .04], [.68, .27]];
  const dishG = lathe(dishPts, 28);
  rod(bMetal, [-2.15, 8.2, .3], [-3.1, 9.0, .5], .05, { color: 0x9aa1a8 });
  bMetal.addM(dishG, tr(-3.15, 9.0, .5).multiply(rotX(.85)).multiply(rotZ(.28)).multiply(new M4().makeScale(1, 1, 1)), { color: 0xe3e6e8 });
  rod(bMetal, [-3.15, 9.0, .5], [-3.15 + .02, 9.0 + .35, .5 + .45], .018, { color: 0x8a9198 });
  bMetal.add(G.sph12, [-3.13, 9.38, .98], .06, [0, 0, 0], { color: 0xcaa24a });
  for (const [x, z, h] of [[.7, -.2, 2.2], [-.5, -.7, 1.7]]) rod(bMetal, [x, 9.3, z], [x * 1.15, 9.3 + h, z * 1.15], .018, { color: 0xb6bcc2 });

  // ---- decks, truss and propellant tanks
  bDark.add(cylG(3.2, 3.2, .16, 56), [0, 5.46, 0], 1, [0, 0, 0], { color: 0x474d54 });
  bMetal.add(torus(3.2, .06, 56, 8), [0, 5.54, 0], 1, [Math.PI / 2, 0, 0], { color: 0xaab1b8 });
  for (let i = 0; i < 24; i++) { const a = i * TAU / 24; bMetal.add(G.box, [Math.sin(a) * 2.55, 5.55, Math.cos(a) * 2.55], [.5, .02, .04], [0, a, 0], { color: 0x8a9198 }); }
  bBlanket.add(G.box, [0, 6.1, -2.55], [2.3, 1.3, 1.0], [0, 0, 0], { uv: [2, 1.2] });             // gold-foil science/cargo bay behind the cabin
  bMetal.add(G.box, [0, 5.62, -2.55], [2.4, .06, 1.1], [0, 0, 0], { color: 0x8a9198 });
  for (const x of [-2.05, 2.05]) bMatte.add(G.box, [x, 5.82, -1.6], [.55, .42, .5], [0, 0, 0], { color: 0xc9ccd0 });
  bDark.add(cylG(2.9, 2.9, .12, 56), [0, 1.98, 0], 1, [0, 0, 0], { color: 0x3a4046 });
  bBlanket.add(cylG(1.75, 1.75, .06, 40), [0, 1.9, 0], 1, [0, 0, 0], { uv: [3, 3] });
  bMetal.add(torus(2.9, .1, 56, 8), [0, 2.0, 0], 1, [Math.PI / 2, 0, 0], { color: 0xb2b9c0 });
  bMetal.add(torus(2.9, .1, 56, 8), [0, 5.2, 0], 1, [Math.PI / 2, 0, 0], { color: 0xb2b9c0 });
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4, a2 = (k + 1) * Math.PI / 4, p = (ang, y) => [Math.sin(ang) * 2.9, y, Math.cos(ang) * 2.9];
    rod(bMetal, p(a, 2.0), p(a, 5.2), .085, { color: 0xaab1b8 });
    rod(bDark, p(a, 2.0), p(a2, 5.2), .05, { color: 0x2f353b }); rod(bDark, p(a2, 2.0), p(a, 5.2), .05, { color: 0x2f353b });
  }
  const tankG = capsG(1.08, 1.1, 8, 40);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2, x = Math.sin(a) * 1.62, z = Math.cos(a) * 1.62;
    bTank.add(tankG, [x, 3.68, z], 1, [0, 0, 0], { uv: [3, 2.2] });
    for (const y of [3.15, 4.2]) bDark.add(torus(1.095, .035, 40, 6), [x, y, z], 1, [Math.PI / 2, 0, 0], { color: 0x2c3238 });
    bMetal.add(cylG(.22, .26, .2, 20), [x, 5.34, z], 1, [0, 0, 0], { color: 0xa6adb4 });
    bDark.add(cylG(.08, .08, .6, 12), [x * 1.05, 2.15, z * 1.05], 1, [0, 0, 0], { color: 0x24292e });
  }
  bMetal.add(torus(2.1, .045, 56, 8), [0, 2.38, 0], 1, [Math.PI / 2, 0, 0], { color: 0xb6bcc3 });
  for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + Math.PI / 4; rod(bMetal, [Math.sin(a) * 2.1, 2.38, Math.cos(a) * 2.1], [Math.sin(a) * .7, 2.4, Math.cos(a) * .7], .04, { color: 0xb6bcc3 }); }

  // ---- descent engine: thrust structure + bell (exit near y~1.05)
  bDark.add(cylG(.55, .7, .9, 24), [0, 2.65, 0], 1, [0, 0, 0], { color: 0x30363c });
  bMetal.add(torus(.7, .05, 32, 8), [0, 2.2, 0], 1, [Math.PI / 2, 0, 0], { color: 0xb7bdc3 });
  for (const s of [-1, 1]) { rod(bMetal, [s * 1.4, 2.0, 0], [s * .6, 2.3, 0], .04, { color: 0xb7bdc3 }); rod(bMetal, [0, 2.0, s * 1.4], [0, 2.3, s * .6], .04, { color: 0xb7bdc3 }); }
  const bellPts = [[.7, 2.45], [.48, 2.4], [.3, 2.25]];
  for (let i = 1; i <= 16; i++) { const s = i / 16; bellPts.push([.3 + .72 * Math.pow(s, .55), 2.25 - 1.2 * s]); }
  bellPts.push([1.04, 1.04], [1.0, 1.04]);
  const bell = lathe(bellPts, 56), bp = bell.attributes.position, bc = new Float32Array(bp.count * 3);
  for (let i = 0; i < bp.count; i++) {
    const t = clamp((2.45 - bp.getY(i)) / 1.41), c0 = [.66, .68, .7], c1 = [.38, .27, .2], c2 = [.14, .15, .22];
    const u = t < .4 ? t / .4 : (t - .4) / .6, A = t < .4 ? c0 : c1, B = t < .4 ? c1 : c2;
    bc[i * 3] = mix(A[0], B[0], u); bc[i * 3 + 1] = mix(A[1], B[1], u); bc[i * 3 + 2] = mix(A[2], B[2], u);
  }
  bell.setAttribute('color', new THREE.BufferAttribute(bc, 3)); bBell.add(bell);

  // ---- landing-leg hinges (the folding legs themselves are instanced in lander(), see legGeos / setLegs)
  for (let i = 0; i < 4; i++) {
    const ang = i * Math.PI / 2 + Math.PI / 4;
    for (const B of [bMetal, bDark]) B.push(rotY(ang));
    bMetal.add(G.sph, [2.9, 5.0, 0], .2, [0, 0, 0], { color: 0x9aa1a8 });
    for (const s of [-1, 1]) bMetal.add(G.sph12, [2.9, 2.0, s * .75], .1, [0, 0, 0], { color: 0xa6adb4 });
    rod(bDark, [2.9, 5.0, 0], [2.9, 4.4, 0], .12, { color: 0x30363c });
    for (const B of [bMetal, bDark]) B.pop();
  }

  // ---- egress platform, ladder and cargo-lift mast on the +Z side
  bMetal.add(G.box, [0, 5.4, 3.5], [2.2, .1, 2.5], [0, 0, 0], { color: 0x8c949b });
  for (let i = 0; i < 9; i++) bDark.add(G.box, [-.9 + i * .225, 5.46, 3.5], [.04, .02, 2.4], [0, 0, 0], { color: 0x30363c });
  for (const [x, z] of [[-1.05, 2.3], [1.05, 2.3], [-1.05, 4.7], [1.05, 4.7]]) rod(bMetal, [x, 5.4, z], [x, 6.35, z], .035, { color: 0xc6ccd1 });
  for (const y of [5.95, 6.35]) {
    rod(bMetal, [-1.05, y, 2.3], [-1.05, y, 4.7], .03, { color: 0xc6ccd1 }); rod(bMetal, [1.05, y, 2.3], [1.05, y, 4.7], .03, { color: 0xc6ccd1 });
    if (y > 6) rod(bMetal, [-1.05, y, 4.7], [-.55, y, 4.7], .03, { color: 0xc6ccd1 });
  }
  rod(bMetal, [-1.1, 5.35, 4.75], [-1.5, 5.0, 2.9], .06, { color: 0x9aa1a8 }); rod(bMetal, [1.1, 5.35, 4.75], [1.5, 5.0, 2.9], .06, { color: 0x9aa1a8 });
  const top = [0, 5.3, 4.75], bot = [0, .12, 5.55];
  for (const x of [-.46, .46]) rod(bMetal, [x, top[1], top[2]], [x, bot[1], bot[2]], .05, { color: 0xc9ced3 });
  for (let i = 0; i < 13; i++) { const s = (i + .6) / 13.6; rod(bMetal, [-.46, mix(top[1], bot[1], s), mix(top[2], bot[2], s)], [.46, mix(top[1], bot[1], s), mix(top[2], bot[2], s)], .03, { color: 0xe0e3e6 }); }
  for (const x of [-.46, .46]) bDark.add(G.box, [x, .06, 5.6], [.3, .06, .3], [0, 0, 0], { color: 0x30363c });
  rod(bMetal, [1.75, .1, 4.0], [1.75, 5.35, 4.0], .05, { color: 0xb8bec4 }); rod(bMetal, [1.45, .1, 4.0], [1.45, 5.35, 4.0], .05, { color: 0xb8bec4 });
  bMetal.add(G.box, [1.6, 1.9, 4.0], [.55, .1, .55], [0, 0, 0], { color: 0x8f969d }); bDark.add(G.box, [1.6, 5.5, 4.0], [.5, .22, .3], [0, 0, 0], { color: 0x2c3238 });
  bMatte.add(G.box, [1.6, 2.35, 4.0], [.4, .4, .4], [0, 0, 0], { color: 0xcfd2d6 });
  // floodlights
  for (const x of [-.8, .8]) { const f = new THREE.Mesh(G.box, L.flood); f.scale.set(.22, .1, .22); f.position.set(x, 5.28, 4.9); root.add(f); }

  // ---- assemble
  const put = (b, m, n) => b.mesh(m, root, { name: n });
  put(bCabin, M.hullWhite, 'cabin'); put(bMetal, M.metal, 'metal'); put(bDark, M.darkMetal, 'dark'); put(bTank, M.mliGold, 'tanks'); put(bBlanket, M.mliGoldBlanket, 'blankets');
  put(bGlass, M.glass, 'glass'); put(bMatte, M.matte, 'matte'); put(bRad, M.radiator, 'radiators'); put(bBell, M.bell, 'bell');
  const lamp = (mat, gl, x, y, z, name, size = .9) => {
    const l = new THREE.Mesh(G.sph12, mat); l.scale.setScalar(.09); l.position.set(x, y, z); root.add(l);
    const s = new THREE.Sprite(gl); s.scale.setScalar(size); s.position.set(x, y, z); s.name = name; root.add(s);
  };
  lamp(L.white, L.gWhite, 0, 10.55, 0, 'strobe', .6); lamp(L.red, L.gRed, -2.0, 5.7, 3.0, 'navR', .42); lamp(L.green, L.gGreen, 2.0, 5.7, 3.0, 'navG', .42);
  const anchor = new THREE.Group(); anchor.name = 'engineAnchor'; anchor.position.y = 1.5; root.add(anchor);
  return root;
});

// Generic representative lander (no provider). Footpads rest on y=0, top docking hatch at y=10.3,
// descent engine exit near y≈1.5 (userData.engineAnchor). Footprint radius about 6.5. Egress platform + ladder on +Z.
// userData.setLegs(k): k=0 legs folded down against the cage (orbit / docking), k=1 deployed (default). Pure and cheap.
export function lander(parent) {
  const g = landerTemplate().clone(true); parent?.add(g); const L = landerLamps(), M = MAT(), lg = legGeos();
  g.userData.engineAnchor = g.getObjectByName('engineAnchor');
  const mk = (geo, mat, n) => { const m = new THREE.InstancedMesh(geo, mat, n); m.castShadow = m.receiveShadow = true; m.frustumCulled = false; g.add(m); return m; };
  const iM = mk(lg.metal, M.metal, 4), iD = mk(lg.dark, M.darkMetal, 4), iB = mk(lg.blanket, M.mliGoldBlanket, 4), iS = mk(strutGeo(), M.darkMetal, 8);
  let lastK = -1;
  const setLegs = k => {
    k = clamp(k); if (k === lastK) return; lastK = k;
    const a = -(1 - k) * LEG_FOLD, ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i < 4; i++) {
      const ang = i * Math.PI / 2 + Math.PI / 4;
      _lm.makeRotationY(ang); _lm2.makeTranslation(LEG_HINGE[0], LEG_HINGE[1], 0); _lm3.makeRotationZ(a);
      _lm.multiply(_lm2).multiply(_lm3); iM.setMatrixAt(i, _lm); iD.setMatrixAt(i, _lm); iB.setMatrixAt(i, _lm);
      for (let sIdx = 0; sIdx < 2; sIdx++) {
        const sd = sIdx ? 1 : -1, dx = LEG_D[0] * .4, dy = LEG_D[1] * .4;
        _lA.set(2.9, 2.0, sd * .75); _lB.set(LEG_HINGE[0] + dx * ca - dy * sa, LEG_HINGE[1] + dx * sa + dy * ca, sd * .06);
        _lC.subVectors(_lB, _lA); const len = _lC.length(); _lC.divideScalar(len);
        _lq.setFromUnitVectors(Y, _lC); _lq2.setFromAxisAngle(Y, ang); _lq2.multiply(_lq);
        _lB.add(_lA).multiplyScalar(.5).applyAxisAngle(Y, ang);
        _lm2.compose(_lB, _lq2, _lA.set(.065, len, .065)); iS.setMatrixAt(i * 2 + sIdx, _lm2);
      }
    }
    iM.instanceMatrix.needsUpdate = iD.instanceMatrix.needsUpdate = iB.instanceMatrix.needsUpdate = iS.instanceMatrix.needsUpdate = true;
  };
  setLegs(1);
  g.userData.setLegs = setLegs;
  g.userData.tick = t => {
    const w = blinkPulse(t, 2.6, .14, .4), r = blinkPulse(t, 2.1, .22), gr = blinkPulse(t, 2.1, .22, 1.05);
    L.white.color.setRGB(.12 + w * 6, .12 + w * 6, .12 + w * 6); L.gWhite.opacity = w * .9;
    L.red.color.setRGB(.14 + r * 6, .01, .01); L.gRed.opacity = r * .85; L.green.color.setRGB(.01, .12 + gr * 6, .02 + gr * .6); L.gGreen.opacity = gr * .85;
  };
  return g;
}


/* ------------------------------------------------------------------ astronaut */
const suitMat = memo(() => new THREE.MeshPhysicalMaterial({
  color: 0xffffff, vertexColors: true, roughness: .74, metalness: 0, normalMap: fabricNormal(), normalScale: new THREE.Vector2(.5, .5),
  sheen: .8, sheenRoughness: .55, sheenColor: new THREE.Color(0xd8e2ff), clearcoat: .12, clearcoatRoughness: .5
}));
const visorMat = memo(() => new THREE.MeshPhysicalMaterial({ color: 0xe6b04a, metalness: .8, roughness: .05, clearcoat: 1, clearcoatRoughness: .03, envMapIntensity: 3.6, emissive: 0x4a2c0a, emissiveIntensity: .9 }));
const helmetLampMat = memo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.5, 2.2) }));

const SUIT = { white: 0xeeeff0, off: 0xd9dbde, grey: 0x7c828a, dark: 0x2a2e33, glove: 0xc9ccd0, boot: 0x3b3f45, bootTop: 0xb8bbbf, gold: 0xd9a63a, red: 0xc8261c, orange: 0xe8742a, green: 0x39c46a };
const uvW = { uv: [14, 10] };

// Lunar-dust soiling baked into vertex colours: grey-brown gradient below y0 (local), full by y1.
function stain(geo, y0, y1, amt, col = [.52, .46, .4]) {
  const p = geo.attributes.position, c = geo.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const k = clamp((y0 - p.getY(i)) / (y0 - y1)) * amt, n = .85 + .15 * Math.sin(p.getX(i) * 37 + p.getZ(i) * 29 + p.getY(i) * 11);
    c.setXYZ(i, mix(c.getX(i), col[0] * n, k), mix(c.getY(i), col[1] * n, k), mix(c.getZ(i), col[2] * n, k));
  }
  return geo;
}
const astroParts = memo(() => {
  const out = {};
  const mk = (stripes) => {
    const P = {};
    // torso + PLSS + helmet shell: origin at hip pivot (world y = 1.3)
    let b = new Batch(); const w = (c, extra) => ({ color: c, uv: [14, 10], ...extra });
    b.add(capsG(.3, .3, 8, 28), [0, .4, 0], [1.3, 1, .86], [0, 0, 0], w(SUIT.white));
    b.add(cylG(.34, .36, .13, 28), [0, -.04, 0], 1, [0, 0, 0], w(SUIT.off));
    b.add(torus(.32, .05, 28, 8), [0, -.11, 0], 1, [Math.PI / 2, 0, 0], w(SUIT.grey));
    b.add(torus(.3, .05, 28, 8), [0, .86, 0], 1, [Math.PI / 2, 0, 0], w(SUIT.grey));
    b.add(cylG(.24, .3, .12, 24), [0, .8, 0], 1, [0, 0, 0], w(SUIT.off));
    for (const s of [-1, 1]) {
      b.add(G.sph, [s * .5, .68, 0], .18, [0, 0, 0], w(SUIT.off));
      b.add(torus(.16, .04, 20, 6), [s * .5, .58, 0], 1, [0, 0, Math.PI / 2], w(SUIT.grey));
    }
    // helmet
    b.add(G.sph, [0, 1.06, .0], [.43, .45, .45], [0, 0, 0], w(SUIT.white));
    b.add(torus(.32, .04, 24, 8), [0, .9, .0], 1, [Math.PI / 2, 0, 0], w(SUIT.grey));
    b.add(G.sph, [0, 1.13, -.18], [.4, .38, .3], [0, 0, 0], w(SUIT.off));
    b.add(torus(.4, .022, 28, 6), [0, 1.06, .0], [1.05, 1.1, 1.05], [Math.PI / 2 + .2, 0, 0], w(SUIT.grey));         // neck / helmet ring detail
    // PLSS
    b.add(G.box, [0, .42, -.43], [.66, .82, .3], [0, 0, 0], w(SUIT.off));
    b.add(G.box, [0, .42, -.5], [.6, .76, .2], [0, 0, 0], w(SUIT.white));
    b.add(cylG(.15, .15, .62, 20), [0, .82, -.43], 1, [0, 0, Math.PI / 2], w(SUIT.white));
    b.add(G.box, [0, .3, -.6], [.42, .3, .03], [0, 0, 0], w(SUIT.grey));
    b.add(G.box, [0, .62, -.605], [.5, .2, .02], [0, 0, 0], w(SUIT.gold));
    b.add(G.box, [-.2, .05, -.56], [.14, .16, .16], [0, 0, 0], w(SUIT.dark)); b.add(G.box, [.2, .05, -.56], [.14, .16, .16], [0, 0, 0], w(SUIT.dark));
    for (let i = 0; i < 7; i++) b.add(G.box, [0, .5 - i * .05, -.61], [.4, .018, .02], [0, 0, 0], w(SUIT.dark));          // vent grille slats
    for (const x of [-.31, .31]) { b.add(G.box, [x, .45, -.43], [.04, .8, .26], [0, 0, 0], w(SUIT.grey)); b.add(cylG(.05, .05, .1, 10), [x * 1.05, .08, -.5], 1, [0, 0, Math.PI / 2], w(SUIT.dark)); }
    b.add(G.box, [0, .42, -.62], [.64, .012, .012], [0, 0, 0], w(SUIT.grey)); b.add(G.box, [-.16, .45, -.605], [.012, .74, .012], [0, 0, 0], w(SUIT.grey)); b.add(G.box, [.16, .45, -.605], [.012, .74, .012], [0, 0, 0], w(SUIT.grey));
    b.add(cylG(.045, .045, .06, 10), [-.22, .72, -.625], 1, [Math.PI / 2, 0, 0], w(SUIT.orange)); b.add(cylG(.045, .045, .06, 10), [.22, .72, -.625], 1, [Math.PI / 2, 0, 0], w(SUIT.green));
    b.add(G.box, [0, .78, -.64], [.5, .1, .04], [0, 0, 0], w(0xbfc2c6));
    rod(b, [.24, .86, -.5], [.28, 1.35, -.55], .012, w(SUIT.grey)); b.add(G.sph12, [.28, 1.36, -.55], .025, [0, 0, 0], w(SUIT.grey));
    // chest control box + hoses
    b.add(G.box, [0, .34, .27], [.34, .2, .09], [0, 0, 0], w(SUIT.dark));
    b.add(G.box, [0, .42, .3], [.3, .03, .05], [0, 0, 0], w(SUIT.grey));
    b.add(G.sph12, [-.1, .34, .325], .02, [0, 0, 0], w(SUIT.orange)); b.add(G.sph12, [0, .34, .325], .02, [0, 0, 0], w(SUIT.green)); b.add(G.sph12, [.1, .34, .325], .02, [0, 0, 0], w(SUIT.off));
    for (const s of [-1, 1]) {
      const path = new THREE.CatmullRomCurve3([new V3(s * .24, .55, -.4), new V3(s * .42, .5, -.15), new V3(s * .36, .42, .17), new V3(s * .2, .4, .27)]);
      b.add(new THREE.TubeGeometry(path, 14, .027, 6), [0, 0, 0], 1, [0, 0, 0], w(SUIT.dark));
    }
    P.torso = stain(b.geometry(), .15, -.1, .3);

    // visor shell + helmet lamps (own meshes)
    const vis = new THREE.SphereGeometry(.462, 48, 28, Math.PI / 2 - 1.04, 2.08, .72, 1.28); vis.scale(1, 1.04, 1.05); vis.translate(0, 1.06, 0); P.visor = vis;
    // soft bezel: a slightly larger, slightly lower band around the visor edge (white-grey), so the visor never ends in a hard flat cut
    const bez = new THREE.SphereGeometry(.455, 48, 28, Math.PI / 2 - 1.14, 2.28, .62, 1.48); bez.scale(1, 1.04, 1.05); bez.translate(0, 1.06, 0);
    { const bc = new Float32Array(bez.attributes.position.count * 3).fill(.78); bez.setAttribute('color', new THREE.BufferAttribute(bc, 3)); P.bezel = bez; }
    b = new Batch();
    b.add(G.box, [0, 1.51, .2], [.24, .03, .05], [0, 0, 0]); b.add(G.box, [.455, 1.08, .1], [.03, .08, .08], [0, 0, 0]); b.add(G.box, [-.455, 1.08, .1], [.03, .08, .08], [0, 0, 0]);
    P.lamps = b.geometry();

    // upper arm (origin at shoulder), forearm + glove (origin at elbow)
    b = new Batch();
    b.add(capsG(.125, .27, 8, 20), [0, -.27, 0], [1, 1, 1], [0, 0, 0], w(SUIT.white));
    b.add(torus(.13, .035, 20, 6), [0, -.54, 0], 1, [Math.PI / 2, 0, 0], w(SUIT.grey));
    P.upper = b.geometry();
    b = new Batch();
    b.add(capsG(.11, .24, 8, 20), [0, -.24, 0], [1, 1, 1], [0, 0, 0], w(SUIT.white));
    b.add(torus(.108, .03, 20, 6), [0, -.46, 0], 1, [Math.PI / 2, 0, 0], w(SUIT.grey));
    b.add(cylG(.115, .125, .08, 18), [0, -.5, 0], 1, [0, 0, 0], w(SUIT.glove));
    b.add(G.sph, [0, -.61, .0], [.115, .15, .09], [0, 0, 0], w(SUIT.glove));
    b.add(capsG(.04, .08, 4, 8), [.0, -.7, .0], [1.5, 1, 1], [0, 0, 0], w(SUIT.glove));
    b.add(capsG(.034, .09, 4, 8), [.1, -.6, .03], 1, [0, 0, -.7], w(SUIT.glove));
    P.fore = stain(b.geometry(), -.4, -.75, .45, [.5, .45, .4]);

    // thigh (origin at hip), shin + boot (origin at knee)
    b = new Batch();
    b.add(capsG(.17, .26, 8, 22), [0, -.29, 0], [1.08, 1, 1.02], [0, 0, 0], w(SUIT.white));
    b.add(torus(.17, .045, 22, 6), [0, -.58, 0], 1, [Math.PI / 2, 0, 0], w(SUIT.grey));
    b.add(G.sph, [0, -.02, 0], .2, [0, 0, 0], w(SUIT.off));
    if (stripes) for (const y of [-.12, -.22]) b.add(cylG(.186, .19, .055, 22, true), [0, y, 0], [1.08, 1, 1.02], [0, 0, 0], w(SUIT.red));
    P.thigh = stain(b.geometry(), -.25, -.6, .3);
    b = new Batch();
    b.add(capsG(.15, .2, 8, 22), [0, -.26, 0], [1.05, 1, 1.02], [0, 0, 0], w(SUIT.white));
    b.add(cylG(.16, .17, .1, 20), [0, -.5, 0], 1, [0, 0, 0], w(SUIT.grey));
    if (stripes) for (const y of [-.18, -.28]) b.add(cylG(.165, .168, .055, 22, true), [0, y, 0], [1.05, 1, 1.02], [0, 0, 0], w(SUIT.red));
    for (const y of [-.52, -.57, -.62]) b.add(torus(.13 - (y + .52) * -.12, .02, 18, 6), [0, y, 0], 1, [Math.PI / 2, 0, 0], w(SUIT.boot));        // ankle bellows
    b.add(capsG(.17, .26, 8, 18), [0, -.6, .1], [1.15, .82, 1.05], [Math.PI / 2, 0, 0], w(SUIT.bootTop));                    // boot shell
    b.add(capsG(.15, .12, 6, 14), [0, -.66, .36], [1.25, .85, 1.2], [Math.PI / 2, 0, 0], w(SUIT.boot));                       // rounded toe cap
    b.add(G.box, [0, -.725, .1], [.38, .06, .7], [0, 0, 0], w(SUIT.dark));                                                   // sole
    for (let l = 0; l < 6; l++) b.add(G.box, [0, -.762, -.12 + l * .12], [.36, .03, .045], [0, 0, 0], w(0x16181b));         // tread lugs
    b.add(G.box, [0, -.745, -.18], [.36, .05, .14], [0, 0, 0], w(SUIT.dark));
    P.shin = stain(b.geometry(), -.3, -.75, .85);
    return P;
  };
  out.plain = mk(false); out.striped = mk(true);
  return out;
});

let astronautCount = 0;
// Suited astronaut standing on y=0 (≈2.8 tall), facing +Z. userData.walk(phase) poses a low-gravity lope.
// opts.stripes forces / forbids the red leg stripes (default: every second astronaut created gets them).
export function astronaut(parent, x = 0, z = 0, opts = {}) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent?.add(g);
  const stripes = opts.stripes ?? (astronautCount++ % 2 === 1);
  const parts = astroParts()[stripes ? 'striped' : 'plain'], suit = suitMat();
  const mesh = (geo, mat, par) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; par.add(m); return m; };
  const body = new THREE.Group(); body.position.y = 1.3; g.add(body);
  mesh(parts.torso, suit, body); mesh(parts.visor, visorMat(), body).receiveShadow = false; mesh(parts.bezel, suit, body).receiveShadow = false; mesh(parts.lamps, helmetLampMat(), body).castShadow = false;
  const limb = (geo, par, px, py, pz) => { const gr = new THREE.Group(); gr.position.set(px, py, pz); par.add(gr); mesh(geo, suit, gr); return gr; };
  const arms = [-1, 1].map(s => { const sh = limb(parts.upper, body, s * .5, .68, 0), el = limb(parts.fore, sh, 0, -.54, 0); return { sh, el, s }; });
  const legs = [-1, 1].map(s => { const hp = limb(parts.thigh, g, s * .21, 1.27, 0), kn = limb(parts.shin, hp, 0, -.58, 0); return { hp, kn, s }; });
  const [aL, aR] = arms, [lL, lR] = legs;
  // low-gravity lope: counter-swinging limbs, forward lean, twist and crouch. The caller adds position/heading/bounce.
  const pose = phase => {
    const s = Math.sin(phase), c = Math.cos(phase), a = Math.abs(s);
    lL.hp.rotation.x = -s * .62; lR.hp.rotation.x = s * .62;
    lL.kn.rotation.x = .14 + .78 * Math.pow(Math.max(0, c), 1.2); lR.kn.rotation.x = .14 + .78 * Math.pow(Math.max(0, -c), 1.2);
    aL.sh.rotation.x = s * .5; aR.sh.rotation.x = -s * .5; aL.sh.rotation.z = .16; aR.sh.rotation.z = -.16;
    aL.el.rotation.x = -(.42 + .3 * Math.max(0, -s)); aR.el.rotation.x = -(.42 + .3 * Math.max(0, s));
    const crouch = -.075 * (1 - a);
    body.position.y = 1.3 + crouch; lL.hp.position.y = lR.hp.position.y = 1.27 + crouch * .7;
    body.rotation.set(.17 + .05 * a, s * .12, c * .035);
  };
  pose(0);
  g.userData.walk = pose; g.userData.stripes = stripes;
  return g;
}


/* ------------------------------------------------------------------ flag */
const flagTexture = memo(() => {
  const W = 1024, H = 512, c = cv(W, H), q = c.getContext('2d');
  const bg = q.createLinearGradient(0, 0, W, 0); bg.addColorStop(0, '#f2f4f5'); bg.addColorStop(1, '#e4e8eb'); q.fillStyle = bg; q.fillRect(0, 0, W, H);
  q.fillStyle = '#16345f'; q.fillRect(0, 0, 300, H);
  q.fillStyle = '#ffffff'; for (let i = 0; i < 26; i++) { const sx = 18 + (i * 97) % 266, sy = 18 + (i * 61) % 476; q.globalAlpha = .55; q.fillRect(sx, sy, 3, 3); } q.globalAlpha = 1;
  q.strokeStyle = '#f2f4f5'; q.lineWidth = 12; q.beginPath(); q.arc(150, 256, 98, 0, TAU); q.stroke();
  q.fillStyle = '#f2f4f5'; q.beginPath(); q.moveTo(150, 190); q.lineTo(188, 300); q.lineTo(112, 300); q.closePath(); q.fill();      // chevron mark
  q.fillStyle = '#e46b2c'; q.beginPath(); q.moveTo(150, 215); q.lineTo(175, 285); q.lineTo(125, 285); q.closePath(); q.fill();
  q.fillStyle = '#ff9a47'; q.fillRect(300, 442, 724, 50); q.fillStyle = '#16345f'; q.fillRect(300, 430, 724, 12);
  q.fillStyle = '#16345f'; q.textAlign = 'center'; q.font = 'bold 128px "Segoe UI", Arial'; q.fillText('ARTEMIS', 662, 250); q.font = 'bold 96px "Segoe UI", Arial'; q.fillText('IV', 662, 370);
  q.strokeStyle = 'rgba(0,0,0,.25)'; q.lineWidth = 8; q.strokeRect(0, 0, W, H);
  return toTex(c, true, false);
});
const flagMat = memo(() => {
  const n = fabricNormal().clone(); n.repeat.set(52, 26); n.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ map: flagTexture(), normalMap: n, normalScale: new THREE.Vector2(.45, .45), roughness: .88, metalness: 0, side: THREE.DoubleSide });
});
const flagGeo = memo(() => {
  const w = 2.8, h = 1.4, sx = 56, sy = 28, g = new THREE.PlaneGeometry(w, h, sx, sy), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + w / 2, yn = (p.getY(i) + h / 2) / h;                  // yn: 0 bottom .. 1 top (rod)
    const free = smooth(x / .5) * (.2 + .8 * (1 - yn)), pleat = Math.sin(x * 21.4) * .016 * smooth((yn - .78) / .22) * smooth(x / .3);
    let z = free * (Math.sin(x * 5.1 + .6) * .06 + Math.sin(x * 11.7 + 1.9 + yn * 2) * .028 + Math.sin(x * 2.3 + 2.4) * .08 + Math.sin(x * 23 + yn * 9) * .006);
    z += Math.sin(x * 2.0 + .7) * .06 * Math.pow(1 - yn, 2) + pleat;
    p.setZ(i, z); p.setY(i, p.getY(i) - Math.sin(x * 4.2) * .018 * Math.pow(1 - yn, 3) * smooth(x / .4));
  }
  g.computeVertexNormals(); return g;
});
const flagPole = memo(() => {
  const b = new Batch(), col = c => ({ color: c });
  b.addM(G.cone, tr(0, -.14, 0).multiply(rotX(Math.PI)).multiply(new M4().makeScale(.09, .28, .09)), col(0x80878e));
  b.add(cylG(.16, .16, .03, 24), [0, .03, 0], 1, [0, 0, 0], col(0x9aa1a8));
  rod(b, [0, 0, 0], [0, 4.02, 0], .052, col(0xd2d6da), G.cyl16);
  rod(b, [0, .0, 0], [0, 1.25, 0], .068, col(0xbfc5ca), G.cyl16);
  for (const y of [1.25, 2.55]) b.add(torus(.06, .016, 16, 6), [0, y, 0], 1, [Math.PI / 2, 0, 0], col(0x8f969d));
  b.add(G.sph, [0, 4.07, 0], .075, [0, 0, 0], col(0xd7b55a));
  rod(b, [0, 3.72, 0], [2.86, 3.72, 0], .03, col(0xe0e3e6), G.cyl8);
  b.add(G.sph12, [2.88, 3.72, 0], .045, [0, 0, 0], col(0xe0e3e6));
  for (let i = 0; i < 4; i++) b.add(cylG(.07, .07, .06, 12), [.25 + i * .75, 3.72, 0], 1, [0, 0, Math.PI / 2], col(0xc3c9ce));
  return b.geometry();
});

// Mission flag, base at the group origin, about 4 tall. Static gentle wrinkles (no wind on the Moon), top rod.
export function flag(parent) {
  const g = new THREE.Group(); parent?.add(g);
  const pole = new THREE.Mesh(flagPole(), MAT().metal); pole.castShadow = pole.receiveShadow = true; g.add(pole);
  const cloth = new THREE.Mesh(flagGeo(), flagMat()); cloth.position.set(1.42, 3.0, 0); cloth.castShadow = cloth.receiveShadow = true; g.add(cloth);
  return g;
}

/* ------------------------------------------------------------------ DUSTER rover */
const dusterTemplate = memo(() => {
  const M = MAT(), root = new THREE.Group();
  const bGold = new Batch(), bMetal = new Batch(), bDark = new Batch(), bCell = new Batch(), bBack = new Batch(), bMatte = new Batch(), bGlass = new Batch();
  const col = c => ({ color: c });
  // chassis (long axis X, forward = -X), gold-foil wrapped
  bGold.add(G.box, [0, .98, 0], [2.3, .74, 1.5], [0, 0, 0], { uv: [4, 2] });
  bGold.add(G.box, [0, 1.42, .0], [1.9, .16, 1.28], [0, 0, 0], { uv: [4, 2] });
  bGold.add(G.box, [-1.18, .95, 0], [.14, .55, 1.1], [0, 0, 0], { uv: [2, 2] });
  for (const z of [-.76, .76]) bMetal.add(G.box, [0, .62, z], [2.34, .06, .05], [0, 0, 0], col(0x9aa1a8));
  for (const x of [-1.16, 1.16]) bMetal.add(G.box, [x, 1.0, 0], [.05, .76, 1.54], [0, 0, 0], col(0x8f969d));
  for (const z of [-.76, .76]) bMatte.add(G.box, [.2, 1.0, z * 1.01], [.9, .45, .03], [0, 0, 0], col(0xe4e7ea));           // radiator panels on the flanks
  // rocker-bogie style suspension and wheels
  for (const sz of [-1, 1]) {
    rod(bMetal, [-.9, .34, sz * .95], [-.15, .9, sz * .76], .045, col(0xb0b6bc)); rod(bMetal, [.9, .34, sz * .95], [.15, .9, sz * .76], .045, col(0xb0b6bc));
    rod(bMetal, [-.9, .34, sz * .88], [-.9, .34, sz * 1.06], .06, col(0xc5cbd1)); rod(bMetal, [.9, .34, sz * .88], [.9, .34, sz * 1.06], .06, col(0xc5cbd1));
  }
  // solar panel on struts, tilted toward -X
  const panelM = tr(-.1, 1.95, 0).multiply(rotZ(.32));
  bCell.addM(G.plane, panelM.clone().multiply(rotX(-Math.PI / 2)).multiply(new M4().makeScale(2.1, 1.55, 1)), { uv: [1.1, 1] });
  bBack.addM(G.plane, panelM.clone().multiply(tr(0, -.02, 0)).multiply(rotX(Math.PI / 2)).multiply(new M4().makeScale(2.1, 1.55, 1)));
  for (const [dx, dz] of [[-.8, .62], [-.8, -.62], [.8, .62], [.8, -.62]]) rod(bMetal, [dx, 1.5, dz], [dx, 1.95 + (dx + .1) * Math.tan(.32) - .03, dz], .03, col(0xb5bbc1));
  for (const s of [-1, 1]) bMetal.addM(G.box, panelM.clone().multiply(tr(0, 0, s * .79)).multiply(new M4().makeScale(2.16, .05, .05)), col(0x8a919a));
  for (const s of [-1, 1]) bMetal.addM(G.box, panelM.clone().multiply(tr(s * 1.06, 0, 0)).multiply(new M4().makeScale(.05, .05, 1.6)), col(0x8a919a));
  // camera mast with stereo head, dish and whip
  rod(bMetal, [.75, 1.5, .3], [.75, 2.55, .3], .04, col(0xd0d4d8));
  rod(bMetal, [.75, 1.5, -.3], [.75, 2.1, -.3], .03, col(0xb4babf)); bMetal.add(G.sph12, [.75, 2.1, -.3], .05, [0, 0, 0], col(0xcaa24a));
  const head = new THREE.Group(); head.name = 'camHead'; head.position.set(.75, 2.62, .3); root.add(head);
  { const hb = new Batch(); hb.add(G.box, [0, 0, 0], [.2, .16, .34], [0, 0, 0], col(0x3a4046)); for (const z of [-.1, .1]) { hb.add(cylG(.05, .05, .08, 14), [-.13, 0, z], 1, [0, 0, Math.PI / 2], col(0x0b0c0e)); hb.add(cylG(.065, .065, .02, 14), [-.17, 0, z], 1, [0, 0, Math.PI / 2], col(0x1c2a3a)); } hb.add(G.box, [.0, .12, 0], [.14, .06, .2], [0, 0, 0], col(0xcfd3d6)); const hm = hb.mesh(M.darkMetal, head); head.userData.m = hm; }
  rod(bMetal, [-.7, 1.55, -.55], [-.7, 2.1, -.55], .025, col(0xb4babf));
  bMetal.addM(lathe([[.3, .1], [.12, .02], [0, 0], [0, -.03], [.13, -.0], [.31, .07]], 24), tr(-.7, 2.18, -.55).multiply(rotX(-.9)), col(0xe2e5e8));
  rod(bMetal, [-1.0, 1.5, .5], [-1.05, 2.45, .55], .012, col(0xc3c9ce));
  // front instrument bay: dust sensor ring + sampling arm
  bDark.add(G.box, [-1.35, .75, 0], [.3, .35, .8], [0, 0, 0], col(0x2c3238));
  bMetal.add(torus(.32, .03, 24, 6), [-1.55, .8, 0], 1, [0, Math.PI / 2, 0], col(0xc9ced3));
  rod(bMetal, [-1.3, .85, .3], [-1.75, .95, .38], .028, col(0xc6ccd1)); rod(bMetal, [-1.75, .95, .38], [-1.9, .55, .42], .026, col(0xc6ccd1));
  bDark.add(G.box, [-1.93, .5, .43], [.14, .06, .1], [0, 0, 0], col(0x2c3238));
  bGlass.add(G.sph12, [-1.28, 1.2, .35], .06, [0, 0, 0]);
  const put = (b, m, n) => b.mesh(m, root, { name: n });
  put(bGold, M.mliGold, 'foil'); put(bMetal, M.metal, 'metal'); put(bDark, M.darkMetal, 'dark'); put(bCell, M.cells, 'cells'); put(bBack, M.cellBack, 'back'); put(bMatte, M.matte, 'matte'); put(bGlass, M.glass, 'glass');
  // wheels: pivot groups so tick can roll them (axis Z)
  const wb = new Batch(), R = .42, W = .3;
  wb.add(cylG(R, R, W, 28), [0, 0, 0], 1, [Math.PI / 2, 0, 0], col(0x23282d));
  for (let i = 0; i < 18; i++) { const a = i / 18 * TAU; wb.add(G.box, [Math.cos(a) * R, Math.sin(a) * R, 0], [.07, .07, W + .02], [0, 0, a], col(0x14171a)); }
  wb.add(cylG(R * .55, R * .55, W + .03, 22), [0, 0, 0], 1, [Math.PI / 2, 0, 0], col(0x7b828a));
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; wb.add(G.box, [Math.cos(a) * R * .3, Math.sin(a) * R * .3, 0], [R * .35, .03, W + .05], [0, 0, a], col(0xaab1b8)); }
  wb.add(cylG(.07, .07, W + .08, 14), [0, 0, 0], 1, [Math.PI / 2, 0, 0], col(0xd2d6da));
  const wgeo = wb.geometry(); root.userData.wheels = [];
  for (const sx of [-.9, .9]) for (const sz of [-1.05, 1.05]) {
    const pv = new THREE.Group(); pv.name = 'wheel'; pv.position.set(sx, .3, sz); root.add(pv);
    const m = new THREE.Mesh(wgeo, M.darkMetal); m.castShadow = m.receiveShadow = true; pv.add(m); root.userData.wheels.push(pv);
  }
  return root;
});

// DUSTER candidate payload: small rover, base at origin (~2.8 tall incl. mast). Moves toward -X (wheels roll with world x).
export function duster(parent) {
  const g = new THREE.Group(); parent?.add(g);
  const c = dusterTemplate().clone(true); g.add(c);
  const pivots = c.children.filter(o => o.name === 'wheel'), head = c.getObjectByName('camHead');
  g.userData.tick = t => {
    const rot = -g.position.x / .42;                                   // rolling without slipping while it drives toward -X
    for (const p of pivots) p.rotation.z = rot;
    head.rotation.y = Math.sin(t * .35) * .7;
  };
  g.userData.tick(0);
  return g;
}

/* ------------------------------------------------------------------ SPSS seismometer station */
const spssTemplate = memo(() => {
  const M = MAT(), root = new THREE.Group();
  const bGold = new Batch(), bMetal = new Batch(), bDark = new Batch(), bCell = new Batch(), bBack = new Batch(), bMatte = new Batch();
  const col = c => ({ color: c });
  // gold-foil sensor drum with a silver domed sun-shield
  bGold.add(cylG(1.08, 1.12, 1.15, 40), [0, .78, 0], 1, [0, 0, 0], { uv: [4, 1.4] });
  bGold.add(cylG(1.2, 1.2, .08, 40), [0, .26, 0], 1, [0, 0, 0], { uv: [3, .3] });
  bMetal.add(new THREE.SphereGeometry(1, 36, 12, 0, TAU, 0, Math.PI / 2), [0, 1.32, 0], [1.14, .5, 1.14], [0, 0, 0], col(0xdfe3e7));
  bMetal.add(torus(1.12, .045, 40, 8), [0, 1.34, 0], 1, [Math.PI / 2, 0, 0], col(0x9aa1a8));
  for (let i = 0; i < 8; i++) { const a = i * TAU / 8 + .2; bDark.add(G.box, [Math.sin(a) * 1.0, 1.52, Math.cos(a) * 1.0], [.04, .02, .22], [0, a, -.38], col(0x1d2227)); }
  bMetal.add(torus(.72, .03, 28, 6), [0, 1.62, 0], 1, [Math.PI / 2, 0, 0], col(0xc0c6cb));
  bMetal.add(G.sph12, [0, 1.84, 0], .08, [0, 0, 0], col(0xcaa24a));
  for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + .5; rod(bMetal, [Math.sin(a) * 1.0, .24, Math.cos(a) * 1.0], [Math.sin(a) * 1.55, .06, Math.cos(a) * 1.55], .05, col(0xaab1b8)); bDark.add(cylG(.22, .26, .06, 18), [Math.sin(a) * 1.58, .03, Math.cos(a) * 1.58], 1, [0, 0, 0], col(0x3a4046)); }
  for (let i = 0; i < 8; i++) { const a = i * TAU / 8; bMetal.add(G.box, [Math.sin(a) * 1.115, .78, Math.cos(a) * 1.115], [.04, 1.0, .03], [0, a, 0], col(0xb0b6bc)); }
  // solar panel on a tilted frame toward +X (faces the low sun from -X)
  const panelM = tr(3.0, 1.15, 0).multiply(rotZ(.95));
  bCell.addM(G.plane, panelM.clone().multiply(rotX(-Math.PI / 2)).multiply(new M4().makeScale(1.85, 2.3, 1)), { uv: [1, 1] });
  bBack.addM(G.plane, panelM.clone().multiply(tr(0, -.03, 0)).multiply(rotX(Math.PI / 2)).multiply(new M4().makeScale(1.85, 2.3, 1)));
  for (const s of [-1, 1]) { bMetal.addM(G.box, panelM.clone().multiply(tr(0, 0, s * 1.16)).multiply(new M4().makeScale(1.9, .06, .06)), col(0x8a919a)); bMetal.addM(G.box, panelM.clone().multiply(tr(s * .94, 0, 0)).multiply(new M4().makeScale(.06, .06, 2.34)), col(0x8a919a)); }
  for (const s of [-1, 1]) { rod(bMetal, [2.2, .05, s * 1.1], [2.46, .42, s * 1.1], .04, col(0xb2b8be)); rod(bMetal, [3.95, .05, s * 1.05], [3.5, 1.8, s * 1.05], .04, col(0xb2b8be)); rod(bMetal, [2.2, .05, s * 1.1], [3.95, .05, s * 1.05], .03, col(0x9aa1a8)); }
  // antenna mast with patch + whip, small electronics box with fins, cable
  rod(bMetal, [.5, 1.0, -.8], [.5, 2.6, -.8], .03, col(0xd0d4d8)); bMetal.add(G.box, [.5, 2.66, -.8], [.34, .04, .34], [0, .3, 0], col(0xe3e6e8));
  rod(bMetal, [-.6, 1.3, .7], [-.55, 2.5, .72], .012, col(0xc3c9ce));
  bGold.add(G.box, [1.2, .35, -1.3], [.7, .45, .55], [0, .2, 0], { uv: [1, 1] });
  for (let i = 0; i < 7; i++) bMetal.add(G.box, [1.2 - .28 + i * .095, .62, -1.3], [.025, .08, .5], [0, .2, 0], col(0xcfd3d6));
  const path = new THREE.CatmullRomCurve3([new V3(.9, .35, -.6), new V3(1.5, .06, -.9), new V3(1.6, .05, -1.3)]);
  bDark.add(new THREE.TubeGeometry(path, 14, .035, 6), [0, 0, 0], 1, [0, 0, 0], col(0x1f2428));
  bMatte.add(G.box, [-1.35, .3, .5], [.5, .38, .42], [0, -.3, 0], col(0xd3d6d9));
  const put = (b, m, n) => b.mesh(m, root, { name: n });
  put(bGold, M.mliGold, 'foil'); put(bMetal, M.metal, 'metal'); put(bDark, M.darkMetal, 'dark'); put(bCell, M.cells, 'cells'); put(bBack, M.cellBack, 'back'); put(bMatte, M.matte, 'matte');
  return root;
});
// SPSS candidate payload: seismic station, base at origin, solar panel toward +X.
export function spss(parent) { const g = spssTemplate().clone(true); parent?.add(g); return g; }


/* ------------------------------------------------------------------ entry capsule */
// Glowing char: even incandescent field, yellow-orange at the stagnation point (a little off-centre), cooling to deep orange toward the shoulder.
// Only soft mottling and faint radial ablation flow - no seams, so the heated shield never reads as a grid.
const shieldGlowTex = memo(() => {
  const N = 512, c = cv(N), q = c.getContext('2d'), rng = makeRng(404), nz = noiseField(N, N, 7, 7, rng), nz2 = noiseField(N, N, 23, 23, rng), img = q.createImageData(N, N), d = img.data;
  const flow = Float32Array.from({ length: 96 }, rng), fl = a => { const p = (a / TAU + .5) * 96, i = Math.floor(p), f = p - i, s = f * f * (3 - 2 * f); return flow[i % 96] * (1 - s) + flow[(i + 1) % 96] * s; };
  const sx = .06, sy = -.04;                                                                      // stagnation offset (uv space -1..1)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const px = x / N * 2 - 1, py = y / N * 2 - 1, r = Math.hypot(px, py), rs = Math.hypot(px - sx, py - sy), a = Math.atan2(py, px);
    const core = Math.exp(-rs * rs * 2.6), shoulder = smooth((r - .72) / .3);
    const k = (.3 + .7 * core) * (1 - .45 * shoulder) * (.88 + .24 * nz[y * N + x] + .06 * (nz2[y * N + x] - .5)) * (.95 + .1 * (fl(a) - .5) * smooth(r / .5));
    const hot = clamp(core * 1.15 + .1 - shoulder * .3), i = (y * N + x) * 4;                       // hot: 0 = orange, 1 = yellow
    d[i] = clamp(k * 1.0) * 255; d[i + 1] = clamp(k * mix(.34, .8, hot)) * 255; d[i + 2] = clamp(k * mix(.04, .22, hot * hot)) * 255; d[i + 3] = 255;
  }
  q.putImageData(img, 0, 0); return toTex(c, true, false);
});
// Backshell wake glow: strongest along the shoulder, streaming up the cone in streaks.
const backGlowTex = memo(() => {
  const W = 512, H = 256, c = cv(W, H), q = c.getContext('2d'), rng = makeRng(405), nz = noiseField(W, H, 40, 3, rng);
  const img = q.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = 1 - y / H, k = Math.pow(clamp(1 - v / .5), 2.2) * (.55 + .8 * nz[y * W + x]), g = clamp(k) * 255, i = (y * W + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
  }
  q.putImageData(img, 0, 0); return toTex(c, true, true);
});
const entryMats = memo(() => {
  const M = MAT(), shield = M.avcoatChar.clone(), back = M.backshellScorch.clone(), rim = M.rimChar.clone();
  shield.emissiveMap = shieldGlowTex(); shield.emissive = new THREE.Color(0, 0, 0);
  back.emissiveMap = backGlowTex(); back.emissive = new THREE.Color(0, 0, 0);
  rim.emissive = new THREE.Color(0, 0, 0);
  return { shield, back, rim };
});
const entryTemplate = memo(() => {
  const M = MAT(), E = entryMats(), root = new THREE.Group();
  const B = { back: new Batch(), avc: new Batch(), metal: new Batch(), dark: new Batch(), glass: new Batch(), matte: new Batch(), rim: new Batch() };
  const c = { y0: 0, rBot: 2.8, rTop: 1.25, h: 2.4 };
  buildCM(B, c, { sag: .3, cover: 0x6b6862 });                             // forward-bay cover scorched
  // separation clamps, charred seal ring, umbilical stubs, vent/antenna blades
  for (let i = 0; i < 6; i++) { const a = i * TAU / 6 + .3; B.dark.add(G.box, [Math.sin(a) * 2.78, .12, Math.cos(a) * 2.78], [.28, .16, .14], [0, a, 0], { color: 0x181a1c }); }
  B.avc.add(torus(2.8, .06, 72, 8), [0, .1, 0], 1, [Math.PI / 2, 0, 0], { color: 0x2a1b14 });
  for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + 1.0; B.metal.add(G.box, [Math.sin(a) * 1.55, c.h - .32, Math.cos(a) * 1.55], [.04, .38, .28], [0, a, -.0], { color: 0x59606a }); }
  const put = (b, m, n) => b.mesh(m, root, { name: n });
  put(B.back, E.back, 'cm'); put(B.rim, E.rim, 'rim'); B.avc.mesh(E.shield, root, { name: 'shield', receive: false }); put(B.metal, M.metal, 'metal'); put(B.dark, M.darkMetal, 'dark'); put(B.glass, M.glass, 'glass'); put(B.matte, M.matte, 'matte');
  return root;
});
const _hc = new THREE.Color();
// Orion crew module alone for atmospheric entry. Heat shield faces local -Y (shield plane at y≈-.15, r≈2.8), scorched backshell.
// userData.setHeat(h 0..1): even char glow on the shield (yellow-orange at the stagnation point, orange toward the shoulder, cherry embers when cooling), warm backshell
// rim and a plasma-side point light (intensity 0 at h=0, so the light count of the entry world never changes).
export function entryCapsule(parent) {
  const g = entryTemplate().clone(true); parent?.add(g);
  g.userData.shieldRadius = 2.8; g.userData.shieldY = -.15;
  const E = entryMats(), light = new THREE.PointLight(0xff7a2c, 0, 90, 1.7); light.position.set(0, -1.7, 0); light.name = 'heatLight'; g.add(light);
  let last = -1;
  g.userData.setHeat = h => {
    h = clamp(h); if (h === last) return; last = h;
    const I = 1.1 * Math.pow(h, 1.3), w = smooth((h - .3) / .6);                          // w: 0 = deep red, 1 = full orange/yellow (the map holds the spatial gradient)
    _hc.setRGB(1, mix(.22, 1, w), mix(.12, 1, w * w));
    E.shield.emissive.copy(_hc).multiplyScalar(I);
    _hc.setRGB(1, mix(.14, .42, w), mix(.03, .1, w)); E.rim.emissive.copy(_hc).multiplyScalar(I * .32);
    _hc.setRGB(1, mix(.1, .4, w), mix(.02, .12, w)); E.back.emissive.copy(_hc).multiplyScalar(h * h * .75);
    light.intensity = 100 * Math.pow(h, 1.4);
  };
  g.userData.setHeat(0);
  return g;
}

/* ------------------------------------------------------------------ sea capsule + parachutes */
// Slightly flattened ringsail dome, hem at y=0, apex vent open. Gore seams crease inward, panels billow. (uv.y: 1 at the vent, 0 at the hem)
function canopyGeo(R = 8, gores = 20, sub = 4, rings = 26) {
  const segs = gores * sub, phi0 = .13, phi1 = 1.66, flat = .66, pos = [], uv = [], idx = [];
  const hem = Math.cos(phi1) * R * flat;
  for (let i = 0; i <= rings; i++) {
    const s = i / rings, phi = phi0 + (phi1 - phi0) * s;
    for (let j = 0; j <= segs; j++) {
      const th = j / segs * TAU, gp = (j / segs * gores) % 1, bulge = Math.pow(Math.sin(Math.PI * gp), .75);
      const rho = Math.sin(phi) * R * (1 + .052 * bulge * Math.pow(Math.sin(phi), 1.1) - .07 * Math.pow(s, 7));
      const y = Math.cos(phi) * R * flat - hem + bulge * .1 * Math.sin(phi);
      pos.push(Math.cos(th) * rho, y, Math.sin(th) * rho); uv.push(j / segs, 1 - s);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * (segs + 1) + j, b = a + 1, c = a + segs + 1, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals(); return g;
}
const bagGeo = memo(() => {
  const g = new THREE.SphereGeometry(1, 40, 28), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), th = Math.atan2(z, x), cap = 1 - y * y;
    const crease = Math.pow(Math.abs(Math.sin(th * 4)), 2.5) * .035 * cap, n = 1 + .02 * Math.sin(x * 4 + z * 3) * Math.sin(y * 3.5 + 1.3) + .008 * Math.sin(y * 9 + x * 3) - crease;
    p.setXYZ(i, x * n, y * n, z * n);
  }
  g.computeVertexNormals(); return g;
});
const BAG = { top: 1.95, n: 5 };
const seaTemplate = memo(() => {
  const M = MAT(), root = new THREE.Group();
  const B = { back: new Batch(), avc: new Batch(), metal: new Batch(), dark: new Batch(), glass: new Batch(), matte: new Batch(), rim: new Batch() };
  const c = { y0: -1.3, rBot: 3.4, rTop: 1.55, h: 3.25 };               // base sits well below the water line (y=0)
  buildCM(B, c, { sag: .34 });
  const top = c.y0 + c.h; BAG.top = top;
  B.dark.add(cylG(1.2, 1.2, .06, 36), [0, top + .01, 0], 1, [0, 0, 0], { color: 0x16181b });                // open forward bay
  for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + .5; B.metal.add(G.box, [Math.sin(a) * 1.1, top + .08, Math.cos(a) * 1.1], [.2, .16, .14], [0, a, 0], { color: 0xaab1b8 }); B.metal.add(torus(.1, .022, 12, 6), [Math.sin(a) * 1.1, top + .2, Math.cos(a) * 1.1], 1, [0, 0, 0], { color: 0xd8dde0 }); }
  B.metal.add(cylG(.03, .03, .8, 8), [0, top + .45, 0], 1, [0, 0, 0], { color: 0xc4cad0 });                   // recovery beacon mast
  const put = (b, m, n) => b.mesh(m, root, { name: n });
  put(B.back, M.backshellScorch, 'cm'); put(B.rim, M.rimChar, 'rim'); put(B.avc, M.avcoatChar, 'shield'); put(B.metal, M.metal, 'metal'); put(B.dark, M.darkMetal, 'dark'); put(B.glass, M.glass, 'glass'); put(B.matte, M.matte, 'matte');
  return root;
});
const bagMat = memo(() => {
  const n = fabricNormal().clone(); n.repeat.set(10, 7); n.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ color: 0xf1f0ec, roughness: .52, metalness: 0, normalMap: n, normalScale: new THREE.Vector2(.18, .18), side: THREE.DoubleSide });
});
const strapGeo = memo(() => {                                              // two orange belts (horizontal + meridian) with buckles, bag-local
  const b = new Batch(), o = { color: 0xe8631a };
  b.add(torus(.9, .05, 36, 6), [0, -.05, 0], [1, 1, 1], [Math.PI / 2 - .12, 0, 0], o);
  b.add(torus(.9, .042, 36, 6), [0, 0, 0], [1, 1, 1], [0, Math.PI / 2, 0], o);
  b.add(G.box, [0, -.05, .93], [.16, .12, .05], [0, 0, 0], { color: 0xc9ced3 }); b.add(G.box, [.93, 0, 0], [.05, .14, .16], [0, 0, 0], { color: 0xc9ced3 });
  return b.geometry();
});

// Canopy vertex program: reefed bulge, streamer, breathing / gore flutter, collapse onto the water. Uniforms are per canopy material, program is shared.
function canopyMaterial(map, nmap) {
  const U = { uInfl: { value: 1 }, uStream: { value: 0 }, uCrumple: { value: 0 }, uBreath: { value: 0 }, uTime: { value: 0 }, uPhase: { value: 0 }, uR: { value: RC } };
  const m = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: .22, normalMap: nmap, normalScale: new THREE.Vector2(.35, .35), roughness: .78, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uInfl,uStream,uCrumple,uBreath,uTime,uPhase,uR;').replace('#include <begin_vertex>', /* glsl */`
vec3 transformed = vec3(position);
{
  float s = 1. - uv.y, th = atan(position.z, position.x);
  // reefed ringsail: tall narrow inverted pear (widest just below the crown, straight taper to a pinched skirt, ragged + lopsided)
  // -> disreef (k: 0..1) opens to the broad shallow dome (wider than tall)
  float k = smoothstep(.1, .95, uInfl), rk = (1. - k) * (1. - uStream);
  float rb = sin(.13 + 1.53 * s);
  float rt = mix(.06, .36, smoothstep(0., .42, s)) - .16 * clamp((s - .4) / .6, 0., 1.);
  rt *= 1. + rk * (.1 * sin(th * 2. + uPhase * 1.3) + .06 * sin(th * 5. - uPhase + s * 6.) + .05 * sin(th * 9. + uTime * 2.6 + uPhase * 3.) * smoothstep(.5, 1., s));
  rt *= 1. + rk * uBreath * .05;
  float rf = mix(rt / rb, 1., k);
  float hf = mix(1.4, 1., k);
  rf *= mix(1., .11 + .06 * s, uStream); hf *= mix(1., 2.1, uStream);
  float live = smoothstep(.18, .9, uInfl);
  rf *= 1. + live * (uBreath * .045 * (.4 + .6 * s) + .017 * sin(th * 20. + uTime * 3.3 + uPhase) * smoothstep(.55, 1., s));
  hf *= 1. + live * uBreath * .035;
  float dy = live * .22 * sin(th * 5. + uTime * 1.9 + uPhase * 2.) * smoothstep(.7, 1., s) + rk * .55 * sin(th * 5. - uTime * 3.1 + uPhase * 2.) * smoothstep(.65, 1., s);
  vec2 lean = vec2(cos(uPhase * 2.1), sin(uPhase * 2.1)) * rk * .75 * pow(1. - s, 1.6);
  float c = uCrumple;
  float lobes = .66 + .14 * sin(th * 3. + uPhase) + .08 * sin(th * 7. - uPhase * 1.7 + s * 5.);
  rf = mix(rf, rf * lobes * (.92 + .14 * s), c);
  float wr = sin(th * 6. + s * 13. + uPhase) * sin(th * 4. - s * 9. + uPhase * 1.3) + .5 * sin(th * 11. + s * 5.);
  float ridge = c * (.1 + .75 * (1. - s) * clamp(wr * .36 + .5, 0., 1.) * (.6 + .4 * sin(s * 20. + th * 2.))) + c * .22 * (.5 + .5 * sin(th * 9. + uPhase)) * smoothstep(.6, 1., s);   // wrinkles only ever rise, so the sheet never dips under the water
  transformed.xz = position.xz * rf + lean * uR * .5;
  transformed.y = position.y * hf * mix(1., .05, c) + dy + ridge;
}`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uCrumple;').replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n{ vec3 fn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))); if (dot(fn, normal) < 0.) fn = -fn; normal = normalize(mix(normal, fn, uCrumple * .85)); }');
  };
  m.customProgramCacheKey = () => 'canopy-v2';
  m.userData.U = U; return m;
}

const _sv = [new V3(), new V3(), new V3(), new V3(), new V3()], _sq = new THREE.Quaternion(), _se = new THREE.Euler(), _sm = new M4(), _ss = new V3();
const eo3 = x => 1 - Math.pow(1 - clamp(x), 3);
const CAP_C = [0, .4, 0], HANG = 22 * Math.PI / 180, RC = 11.5, LL = 11.2, LEAN = .26;

// Floating crew module (scorched, five white uprighting bags on the nose) with three ringsail main parachutes above it.
// Returns { group, chutes, chuteMaterial, chuteLines, update(t) }. update(t) is pure in absolute film time and animates the whole descent from EVENTS:
//   drogues -> pilot chutes pull the mains out as streamers (chuteDeploy) -> reefed inflation -> disreef to full breathing canopies,
//   the capsule swinging while hanging tilted, splash settle (splash), bags inflating, canopy cut-away + collapse onto the water (chuteRelease).
// The director only places / lowers `group`. chuteMaterial is an unused compatibility stub (canopies own their materials: no ghost fade).
export function seaCapsule(parent) {
  const g = new THREE.Group(); parent?.add(g);
  const hold = new THREE.Group(), inner = seaTemplate().clone(true); inner.position.set(-CAP_C[0], -CAP_C[1], -CAP_C[2]); hold.position.set(...CAP_C); hold.add(inner); g.add(hold);
  const top = BAG.top, chutes = new THREE.Group(); g.add(chutes);
  // bags + straps (instanced; they inflate after splash)
  const bags = new THREE.InstancedMesh(bagGeo(), bagMat(), BAG.n), straps = new THREE.InstancedMesh(strapGeo(), MAT().matte, BAG.n);
  for (const m of [bags, straps]) { m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; inner.add(m); }
  const beaconMat = spriteMat(0xffa030), beacon = new THREE.Sprite(beaconMat); beacon.scale.setScalar(.7); beacon.position.set(0, top + .86, 0); inner.add(beacon);
  const beaconLamp = new THREE.Mesh(G.sph12, new THREE.MeshBasicMaterial({ color: 0x402000 })); beaconLamp.scale.setScalar(.06); beaconLamp.position.copy(beacon.position); inner.add(beaconLamp);
  // canopies, pilots, drogues, risers
  const cm = canopyTexture(), nrm = fabricNormal().clone(); nrm.repeat.set(70, 18); nrm.needsUpdate = true;
  const geo = canopyGeo(RC), pilotGeo = canopyGeo(1), N = 3;
  const mats = [0, 1, 2].map(() => canopyMaterial(cm, nrm));
  const plainMat = new THREE.MeshStandardMaterial({ map: cm, emissiveMap: cm, emissive: 0xffffff, emissiveIntensity: .25, normalMap: nrm, normalScale: new THREE.Vector2(.3, .3), roughness: .8, side: THREE.DoubleSide });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xf2f0ea, transparent: true, opacity: .34 });
  const riserMat = new THREE.MeshStandardMaterial({ color: 0xf0eee8, roughness: .75, emissive: 0x66625a });
  const canopies = [], pilots = [], drogues = [], risers = [], knots = [];
  const mk = (geom, mat) => { const m = new THREE.Mesh(geom, mat); m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; chutes.add(m); return m; };
  for (let i = 0; i < N; i++) { canopies.push(mk(geo, mats[i])); pilots.push(mk(pilotGeo, plainMat)); risers.push(mk(G.cyl8, riserMat)); const k = mk(G.sph12, riserMat); k.scale.setScalar(.2); knots.push(k); }
  for (let i = 0; i < 2; i++) drogues.push(mk(pilotGeo, plainMat));
  for (const c of canopies) c.rotation.order = 'XZY';
  // every suspension line lives in ONE dynamic LineSegments: 3x20 main + 2x8 drogue + 3x6 pilot
  const SEG = 3 * 20 + 2 * 8 + 3 * 6, lpos = new Float32Array(SEG * 6), lg = new THREE.BufferGeometry(), lattr = new THREE.BufferAttribute(lpos, 3); lattr.setUsage(THREE.DynamicDrawUsage);
  lg.setAttribute('position', lattr); const lines = new THREE.LineSegments(lg, lineMat); lines.frustumCulled = false; chutes.add(lines);
  const chuteMaterial = new THREE.MeshBasicMaterial({ visible: false });

  // cluster of three: leaning outward, staggered heights / phases / release times
  const layout = [0, 1, 2].map(i => { const a = .55 + i * TAU / 3; return { a, ca: Math.cos(a), sa: Math.sin(a), conf: 11.2 + [0, 1.8, -1.2][i], ph: i * 2.1, yaw: i * 1.1, d: [0, .14, .3][i], rel: [0, .4, .8][i], wind: [1, .8, 1.15][i], rest: [[-14, 4], [-26, 0], [-24, -12]][i], bulge: [7, 1.5, 3][i] }; });
  // released canopies travel on a downwind arc (planar quadratic bezier start -> rest, bulging away from the capsule) so none passes over it
  const rK0 = 9.4 - LL * Math.sin(LEAN);
  for (const L of layout) {
    L.sx = L.ca * (rK0 + Math.sin(LEAN) * LL); L.sz = L.sa * (rK0 + Math.sin(LEAN) * LL);
    const mx = (L.sx + L.rest[0]) / 2, mz = (L.sz + L.rest[1]) / 2, ml = Math.hypot(mx, mz) || 1; L.cx = mx + mx / ml * L.bulge; L.cz = mz + mz / ml * L.bulge;
  }
  const rK = 9.4 - LL * Math.sin(LEAN), WIND = [-1, 0, .16], T0 = EVENTS.chuteDeploy, TS = EVENTS.splash, TR = EVENTS.chuteRelease;
  const bagBase = [], bagYaw = [];
  for (let i = 0; i < BAG.n; i++) { const a = i * TAU / BAG.n + .3, r = 1.12; bagBase.push([Math.sin(a) * r, top + .55, Math.cos(a) * r, .78 + (i % 2) * .05]); bagYaw.push(a); }
  const setLine = (k, ax, ay, az, bx, by, bz) => { const o = k * 6; lpos[o] = ax; lpos[o + 1] = ay; lpos[o + 2] = az; lpos[o + 3] = bx; lpos[o + 4] = by; lpos[o + 5] = bz; };
  const sL = Math.sin(LEAN), cL = Math.cos(LEAN);

  const update = t => {
    const A = _sv[0], B = _sv[1], Kc = _sv[2], Nz = _sv[3], P = _sv[4];
    // ---- capsule: pendulum + hang tilt on the risers, relaxing at splash
    const sw = (1 - smooth((t - (TS - .9)) / .95)) * (.55 + .45 * smooth((t - T0) / 1.6)), afloat = t < TS ? 1 : 0;
    const phx = Math.sin(t * 1.62 + .4) * .105 * sw, phz = Math.sin(t * 1.62 + 2.0) * .056 * sw;
    const tau = Math.max(0, t - TS), settle = t < TS ? 1 : Math.exp(-tau * 3.1) * Math.cos(tau * 5.2);
    hold.rotation.set(phz, 0, HANG * settle * .85 + phx);
    if (t >= TS) { const k = Math.exp(-tau * .75); hold.rotation.x += Math.sin(t * 2.6 + 1.1) * .045 * k; hold.rotation.z += Math.sin(t * 2.1) * .05 * k; }
    hold.position.set(CAP_C[0] + Math.sin(phx) * 1.6 * afloat, CAP_C[1], CAP_C[2] + Math.sin(phz) * 1.1 * afloat);
    hold.updateMatrix(); hold.updateMatrixWorld(true);
    Nz.set(0, top, 0).sub(A.set(CAP_C[0], CAP_C[1], CAP_C[2])).applyQuaternion(hold.quaternion).add(hold.position);

    // ---- uprighting bags pop open after splash
    for (let i = 0; i < BAG.n; i++) {
      const b = bagBase[i], k = t < TS + .3 ? 0 : eo3((t - TS - .3 - i * .1) / 1.15), s = b[3], on = k > 0;
      const kk = on ? (.2 + .8 * k) * (1 + .1 * Math.sin(k * Math.PI)) : .001;
      _se.set(0, bagYaw[i], 0); _sq.setFromEuler(_se);
      _sm.compose(A.set(b[0], b[1] - s * (1 - kk), b[2]), _sq, _ss.set(.88 * kk, s * kk, .88 * kk)); bags.setMatrixAt(i, _sm);
      _sm.compose(A.set(b[0], b[1] - s * (1 - kk) + .02, b[2]), _sq, _ss.setScalar(.88 * kk)); straps.setMatrixAt(i, _sm);
    }
    bags.instanceMatrix.needsUpdate = straps.instanceMatrix.needsUpdate = true;
    const bl = t > TS + 2.2 ? blinkPulse(t, 1.1, .16) : 0; beaconMat.opacity = bl * .9; beaconLamp.material.color.setRGB(.2 + bl * 6, .1 + bl * 2.6, .02);

    // ---- drogues: cut away as the pilot chutes pull the mains out
    const dt = t - T0, drogueOn = dt < .7;
    for (let i = 0; i < 2; i++) {
      const d = drogues[i]; d.visible = drogueOn;
      if (!drogueOn) { for (let j = 0; j < 8; j++) setLine(60 + i * 8 + j, 0, -9, 0, 0, -9, 0); continue; }
      const cut = Math.max(0, dt - .1), sx = i ? 1 : -1, bx = sx * 2.2 + sx * cut * 9 + WIND[0] * cut * 2, by = 17 + cut * 16 - 6.4 * cut * cut, bz = -2 + cut * 3, Rd = 2.3 * (1 + Math.sin(t * 5 + i) * .03);
      d.position.set(bx, by, bz); d.scale.set(Rd, Rd * 1.2, Rd); d.rotation.set(.1 * sx, i * 1.3, -.15 * sx - cut * .6 * sx); d.updateMatrix();
      for (let j = 0; j < 8; j++) { const a = j / 8 * TAU; A.set(Math.cos(a) * .95, 0, Math.sin(a) * .95).applyMatrix4(d.matrix); setLine(60 + i * 8 + j, A.x, A.y, A.z, cut > 0 ? bx : Nz.x + sx * .4, cut > 0 ? by - 5 : Nz.y, cut > 0 ? bz : Nz.z); }
    }

    // ---- the three mains
    for (let i = 0; i < N; i++) {
      const L = layout[i], c = canopies[i], U = mats[i].userData.U, ti = t - T0 - L.d, tr = t - TR - L.rel, released = tr > 0;
      // inflation stages: streamer -> reefed (with pulsing) -> disreef to full
      const stream = ti < 0 ? 1 : 1 - smooth((ti - .5) / .55), ext = .35 + .65 * eo3(ti / .55);
      const reef = .2 * smooth((ti - .55) / .85) * (1 + .12 * Math.sin(ti * 6.3)), full = smooth((ti - 2.0) / 1.7);
      let infl = ti < 0 ? 0 : Math.min(1, reef + full * .8), br = Math.sin(t * 2.2 + L.ph) * .6 + Math.sin(t * 3.7 + L.ph * 1.7) * .4;
      let crumple = 0, land = 0, slack = 0, tiltR = LEAN + .05 * Math.sin(t * .9 + L.ph);
      let ox, oy, oz, rx, rz;
      // confluence (knot) at rest and the axis direction of the canopy
      const swayX = -Math.sin(phx) * 3.4, swayZ = Math.sin(phz) * 2.2;
      const kx0 = L.ca * rK + swayX, kz0 = L.sa * rK + swayZ, ky0 = L.conf;
      let kx = kx0, ky = ky0, kz = kz0;
      const tl = tiltR + (-phx * L.ca + phz * L.sa) * .35;
      if (!released) {
        ox = kx0 + L.ca * sL * LL * ext; oz = kz0 + L.sa * sL * LL * ext; oy = ky0 + cL * LL * ext;
        rx = tl * L.sa; rz = -tl * L.ca;
      } else {
        // cut away: deflate while falling, drift downwind, flop onto the water, sink
        const Df = 2.9 + L.wind * .5, f = clamp(tr / Df), fall = Math.pow(f, 1.45);
        const y0 = L.conf + cL * LL, e = 1 - Math.pow(1 - f, 3), e1 = 1 - e, tail = Math.max(0, tr - Df);
        ox = e1 * e1 * L.sx + 2 * e1 * e * L.cx + e * e * L.rest[0] + WIND[0] * L.wind * .3 * tail;
        oz = e1 * e1 * L.sz + 2 * e1 * e * L.cz + e * e * L.rest[1] + WIND[2] * L.wind * .3 * tail + Math.sin(tr * .9 + L.ph) * .4 * f * (1 - f);
        oy = y0 * (1 - fall) + .3;
        infl = mix(infl, .5, smooth(tr / 1.0)); br *= 1 - smooth(tr / .5);
        land = smooth((tr - Df * .72) / 1.0); crumple = Math.max(.7 * smooth((tr - .15) / (Df * .8)), smooth((tr - Df * .5) / 2.0)); slack = smooth(tr / 1.4);
        rx = tl * L.sa * (1 - smooth(tr / 1.5)) + .55 * Math.sin(L.a + 1) * smooth(tr / 1.6) * (1 - land);
        rz = -tl * L.ca * (1 - smooth(tr / 1.5)) - .75 * smooth(tr / 1.6) * (1 - land);
        oy += -smooth((tr - Df) / 7.5) * .3 * land;
        kx = ox; ky = oy - LL * (1 - .93 * slack); kz = oz;
      }
      U.uInfl.value = infl; U.uStream.value = stream; U.uCrumple.value = crumple; U.uBreath.value = br; U.uTime.value = t; U.uPhase.value = L.ph;
      const vis = ti > -.02; c.visible = vis;
      c.position.set(ox, oy, oz); c.rotation.set(rx, L.yaw + (released ? tr * .08 : 0), rz); c.updateMatrix();
      // hem radius (mirrors the vertex shader at s = 1) for the suspension lines
      const live = smooth((infl - .18) / .72), kd = smooth((infl - .1) / .85), Rh = RC * .94 * (1 - stream * .83) * mix(.2007, 1, kd) * (1 + live * br * .045) * (1 + crumple * .02);
      const hide = !vis || (released && land > .6);
      for (let j = 0; j < 20; j++) {
        const a = j / 20 * TAU; A.set(Math.cos(a) * Rh, 0, Math.sin(a) * Rh).applyMatrix4(c.matrix);
        if (hide) setLine(i * 20 + j, 0, -9, 0, 0, -9, 0); else setLine(i * 20 + j, A.x, A.y, A.z, kx, ky - 4 * land, kz);
      }
      knots[i].visible = risers[i].visible = vis && !(released && land > .5); knots[i].position.set(kx, ky, kz);
      // riser: capsule nose -> knot; after cut-away it retracts with the canopy
      let rbx = Nz.x + L.ca * .9, rby = Nz.y - .15, rbz = Nz.z + L.sa * .9;
      if (released) { const e = smooth(tr / .4); rbx = mix(rbx, kx, e); rby = mix(rby, ky, e); rbz = mix(rbz, kz, e); }
      B.set(rbx, rby, rbz); Kc.set(kx, ky, kz); P.subVectors(Kc, B); const len = Math.max(.01, P.length()); P.divideScalar(len);
      risers[i].position.copy(B).add(Kc).multiplyScalar(.5); risers[i].quaternion.setFromUnitVectors(Y, P); risers[i].scale.set(.07, len, .07);
      // pilot chute riding above the apex while the mains deploy
      const pil = pilots[i], pOn = ti > -.05 && ti < 2.2 && !released; pil.visible = pOn;
      for (let j = 0; j < 6; j++) setLine(80 + i * 6 + j, 0, -9, 0, 0, -9, 0);
      if (pOn) {
        const apexY = oy + cL * 8.2 * (1.4 - .4 * smooth((infl - .1) / .85)) * (1 + 1.1 * stream), pk = eo3((ti + .05) / .45), py = apexY + 3.2 + pk * 3.6;
        const Rp = 1.25 * smooth(1 - (ti - 1.6) / .6) * (.4 + .6 * pk);
        pil.position.set(ox + Math.sin(ti * 7) * .2, py, oz); pil.scale.set(Rp, Rp * 1.1, Rp); pil.rotation.set(0, ti * 2, 0); pil.updateMatrix();
        for (let j = 0; j < 6; j++) { const a = j / 6 * TAU; A.set(Math.cos(a) * .95, 0, Math.sin(a) * .95).applyMatrix4(pil.matrix); setLine(80 + i * 6 + j, A.x, A.y, A.z, ox, apexY, oz); }
      }
    }
    lattr.needsUpdate = true;
  };
  update(0);
  g.userData.tick = t => update(t);
  return { group: g, chutes, chuteMaterial, chuteLines: [lines], update };
}


/* ------------------------------------------------------------------ foam / wake sheets (shared by the ship and the rescue boats) */
// Flat strips just above the waterline. uv.x runs along the sheet (0..1), uv.y across it (0..1). Pure function of uTime (film time).
function foamMaterial(mode, o = {}) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, toneMapped: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: { uTime: { value: 0 }, uMode: { value: mode }, uLen: { value: o.len ?? 100 }, uCell: { value: o.cell ?? 6 }, uAmt: { value: o.amt ?? 1 }, uSpeed: { value: o.speed ?? 3 }, uTint: { value: new THREE.Color(o.tint ?? 0xd9dde0) }, uAcross: { value: o.across ?? 5 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: /* glsl */`
uniform float uTime, uMode, uLen, uCell, uAmt, uSpeed, uAcross; uniform vec3 uTint; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h(i), h(i + vec2(1., 0.)), f.x), mix(h(i + vec2(0., 1.)), h(i + vec2(1., 1.)), f.x), f.y); }
void main(){
  float along = vUv.x * uLen / uCell, v = vUv.y;
  float adv = uTime * uSpeed / uCell;
  float fn = n(vec2(along - adv, v * uAcross)) * .55 + n(vec2(along * 2.3 - adv * 1.4, v * uAcross * 2.1 + 3.)) * .3 + n(vec2(along * 5.1 - adv * 1.8, v * uAcross * 4.7 + 7.)) * .15;
  float a;
  if (uMode < .5) { a = pow(1. - v, 1.6) * smoothstep(0., .08, v + .02) * (.28 + 1.1 * fn);                       // hull contact ribbon: solid at the hull
  } else if (uMode < 1.5) { a = pow(1. - v, 1.2) * pow(1. - vUv.x, .75) * (.2 + 1.3 * fn) * smoothstep(0., .04, vUv.x); } // bow wave sheet
  else { float c = abs(v - .5) * 2.; a = exp(-c * c * 2.4) * pow(1. - vUv.x, 1.15) * (.15 + 1.25 * fn) * smoothstep(0., .03, vUv.x) * smoothstep(1., .85, 1. - vUv.x * .0 - c * .15); }
  a = clamp(a * uAmt, 0., .92);
  if (a < .01) discard;
  gl_FragColor = vec4(uTint * (.8 + .35 * fn), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`
  });
}
// Strip along a polyline: pts = [[x,z,width], ...] with the strip centred (mode 2) or extending to the +normal side (modes 0/1).
function stripGeo(pts, y, centred, normalSign = 1) {
  const pos = [], uv = [], idx = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const nx = -dz * normalSign, nz = dx * normalSign, w = p[2];
    const o0 = centred ? -w / 2 : 0, o1 = centred ? w / 2 : w;
    pos.push(p[0] + nx * o0, y, p[1] + nz * o0, p[0] + nx * o1, y, p[1] + nz * o1); uv.push(i / (n - 1), 0, i / (n - 1), 1);
  }
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeBoundingSphere(); return g;
}

/* ------------------------------------------------------------------ recovery ship (generic grey amphibious transport dock) */
// 1 unit = 0.74 m (the capsule is 6.8 units = 5 m). Length 270 units (200 m), beam 38 at the waterline (28 m), draft 9.5, deck 14 above the water.
// Hull rows from the keel up: [y, half-beam factor, colour]. Anti-fouling red below the waterline, narrow dark boot-topping, grey topsides.
const SHIP = { zS: -128, zB: 142, beam: 18.5, yK: -9.5, yD: 14, rake: 20, bowStart: 28 };
const HULL_ROWS = [[-9.5, .3, 'red'], [-7.6, .6, 'red'], [-3.2, .9, 'red'], [-.9, 1, 'red'], [.9, 1.005, 'boot'], [2.5, 1.02, 'hull'], [7, 1.08, 'hull'], [14, 1.17, 'hull'], [14.05, 1.13, 'deck']];
const HULL_COL = { red: [.4, .12, .09], boot: [.06, .07, .08], hull: [.5, .54, .58], deck: [.3, .33, .36] };
const shipW = z => {
  if (z < SHIP.zS + 34) return SHIP.beam * mix(.84, 1, smooth((z - SHIP.zS) / 34));
  if (z <= SHIP.bowStart) return SHIP.beam;
  const t = clamp((z - SHIP.bowStart) / (SHIP.zB - SHIP.bowStart)); return Math.max(.0, SHIP.beam * Math.pow(1 - Math.pow(t, 1.85), .62));
};
const shipRingPts = z => {                 // [{x,y,z,c}] around the section: keel, starboard rows (+x), deck centre, port rows
  const w = shipW(z), t = clamp((z - SHIP.bowStart) / (SHIP.zB - SHIP.bowStart)), side = [];
  const zs = y => z + SHIP.rake * smooth(t) * Math.pow(clamp((y - SHIP.yK) / (SHIP.yD - SHIP.yK)), 1.3);
  const R = HULL_ROWS.map(([y, f, c]) => ({ x: w * f, y, z: zs(y), c: HULL_COL[c] }));
  const pts = [{ x: 0, y: SHIP.yK, z: zs(SHIP.yK), c: HULL_COL.red }, ...R, { x: 0, y: SHIP.yD + .05, z: zs(SHIP.yD), c: HULL_COL.deck }];
  for (let r = R.length - 1; r >= 0; r--) pts.push({ ...R[r], x: -R[r].x });
  return pts;
};

const deckTexture = memo(() => {                         // flight deck 39 x 84 units: non-skid, border, centre line, two landing circles, numerals
  const W = 512, H = 1100, c = cv(W, H), q = c.getContext('2d'), rng = makeRng(818);
  q.fillStyle = '#4a5158'; q.fillRect(0, 0, W, H);
  for (let i = 0; i < 26000; i++) { q.fillStyle = `rgba(${rng() < .5 ? '0,0,0' : '255,255,255'},${rng() * .08})`; q.fillRect(rng() * W, rng() * H, 2, 2); }
  q.strokeStyle = '#d9c25a'; q.lineWidth = 7; q.strokeRect(12, 12, W - 24, H - 24);
  q.strokeStyle = '#e8e8e4'; q.lineWidth = 5; q.beginPath(); q.moveTo(256, 40); q.lineTo(256, H - 40); q.stroke();
  for (const cy of [290, 810]) {
    q.lineWidth = 10; q.beginPath(); q.arc(256, cy, 190, 0, TAU); q.stroke(); q.lineWidth = 5; q.beginPath(); q.arc(256, cy, 140, 0, TAU); q.stroke();
    q.fillStyle = '#e8e8e4'; q.fillRect(206, cy - 9, 100, 18); q.fillRect(247, cy - 50, 18, 100);
  }
  q.fillStyle = '#e8e8e4'; q.font = 'bold 150px "Segoe UI", Arial'; q.textAlign = 'center'; q.fillText('24', 256, 560);
  q.fillStyle = 'rgba(230,200,70,.9)'; for (let y = 60; y < H - 60; y += 70) q.fillRect(30, y, 6, 36), q.fillRect(W - 36, y, 6, 36);
  return toTex(c, true, false);
});
const foreDeckTexture = memo(() => {
  const W = 512, H = 1024, c = cv(W, H), q = c.getContext('2d'), rng = makeRng(819);
  q.fillStyle = '#545b62'; q.fillRect(0, 0, W, H);
  for (let i = 0; i < 24000; i++) { q.fillStyle = `rgba(${rng() < .5 ? '0,0,0' : '255,255,255'},${rng() * .07})`; q.fillRect(rng() * W, rng() * H, 2, 2); }
  q.strokeStyle = 'rgba(20,24,28,.5)'; q.lineWidth = 2; for (let y = 0; y < H; y += 64) { q.beginPath(); q.moveTo(0, y); q.lineTo(W, y); q.stroke(); }
  q.strokeStyle = '#d9c25a'; q.lineWidth = 6; q.strokeRect(10, 0, W - 20, H);
  return toTex(c, true, false);
});
const shipTextures = memo(() => {
  const rng = makeRng(808);
  // weathering / plating map for the hull (u along length, v around the section)
  const c1 = cv(512, 256), q1 = c1.getContext('2d'); q1.fillStyle = '#e8e8e8'; q1.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 160; i++) { const x = rng() * 512, w = 1 + rng() * 3, y = rng() * 256, h = 20 + rng() * 120; q1.fillStyle = `rgba(${rng() < .5 ? '70,48,36' : '24,30,36'},${.02 + rng() * .06})`; q1.fillRect(x, y, w, h); }
  q1.fillStyle = 'rgba(30,36,44,.14)'; for (let x = 0; x < 512; x += 64) q1.fillRect(x, 0, 1, 256);
  for (let y = 0; y < 256; y += 85) q1.fillRect(0, y, 512, 1);
  for (let i = 0; i < 3500; i++) { q1.fillStyle = `rgba(${rng() < .5 ? '0,0,0' : '255,255,255'},${rng() * .06})`; q1.fillRect(rng() * 512, rng() * 256, 2, 2); }
  // superstructure: grey paint, panel lines and window bands; emissive twin lights some windows
  const c2 = cv(512, 256), q2 = c2.getContext('2d'), e2 = cv(512, 256), qe = e2.getContext('2d');
  q2.fillStyle = '#9ca6af'; q2.fillRect(0, 0, 512, 256); qe.fillStyle = '#000'; qe.fillRect(0, 0, 512, 256);
  q2.fillStyle = 'rgba(40,48,56,.25)'; for (let x = 0; x < 512; x += 85) q2.fillRect(x, 0, 2, 256); q2.fillRect(0, 128, 512, 2);
  for (let r = 0; r < 2; r++) for (let k = 0; k < 5; k++) {
    const x = 22 + k * 100, y = 30 + r * 128;
    q2.fillStyle = '#4f5a63'; q2.fillRect(x - 4, y - 4, 64, 48); q2.fillStyle = '#0c141b'; q2.fillRect(x, y, 56, 40);
    q2.fillStyle = 'rgba(120,160,190,.35)'; q2.fillRect(x + 3, y + 3, 22, 8);
    if (rng() < .7) { qe.fillStyle = `rgb(${200 + rng() * 55},${140 + rng() * 40},${60 + rng() * 30})`; qe.fillRect(x, y, 56, 40); }
  }
  q2.fillStyle = '#7e8993'; q2.fillRect(0, 238, 512, 18); q2.fillStyle = 'rgba(0,0,0,.35)'; q2.fillRect(0, 238, 512, 2);
  for (let i = 0; i < 2500; i++) { q2.fillStyle = `rgba(${rng() < .5 ? '0,0,0' : '255,255,255'},${rng() * .05})`; q2.fillRect(rng() * 512, rng() * 256, 2, 2); }
  // hangar door / transom well-deck plates
  const c4 = cv(512, 192), q4 = c4.getContext('2d'); q4.fillStyle = '#5e6870'; q4.fillRect(0, 0, 512, 192);
  q4.fillStyle = '#2c333a'; q4.fillRect(16, 16, 232, 160); q4.fillRect(264, 16, 232, 160); q4.strokeStyle = '#d9c25a'; q4.lineWidth = 5; q4.strokeRect(16, 16, 232, 160); q4.strokeRect(264, 16, 232, 160);
  q4.strokeStyle = 'rgba(0,0,0,.4)'; q4.lineWidth = 2; for (let x = 16; x < 496; x += 29) { q4.beginPath(); q4.moveTo(x, 16); q4.lineTo(x, 176); q4.stroke(); }
  const c5 = cv(512, 256), q5 = c5.getContext('2d'); q5.fillStyle = '#7e8892'; q5.fillRect(0, 0, 512, 256);
  q5.fillStyle = '#05080b'; q5.fillRect(80, 60, 352, 130); q5.fillStyle = '#16202a'; q5.fillRect(80, 160, 352, 30); q5.strokeStyle = '#d9c25a'; q5.lineWidth = 6; q5.strokeRect(76, 56, 360, 138);
  q5.strokeStyle = 'rgba(0,0,0,.35)'; q5.lineWidth = 2; for (let x = 0; x < 512; x += 40) { q5.beginPath(); q5.moveTo(x, 0); q5.lineTo(x, 256); q5.stroke(); }
  // hull number decal
  const c6 = cv(256, 128), q6 = c6.getContext('2d'); q6.clearRect(0, 0, 256, 128); q6.fillStyle = '#f2f2ee'; q6.font = 'bold 104px "Segoe UI", Arial'; q6.textAlign = 'center'; q6.textBaseline = 'middle'; q6.fillText('R 24', 128, 70);
  return { hull: toTex(c1, true), super: toTex(c2, true), superEm: toTex(e2, true), hangar: toTex(c4, true, false), transom: toTex(c5, true, false), number: toTex(c6, true, false) };
});

const shipMats = memo(() => {
  const T = shipTextures(), std = o => new THREE.MeshStandardMaterial(o), fd = foreDeckTexture();
  return {
    hull: std({ map: T.hull, vertexColors: true, roughness: .62, metalness: .12 }),
    super: std({ map: T.super, emissiveMap: T.superEm, emissive: 0xffffff, emissiveIntensity: .8, roughness: .62, metalness: .15 }),
    deck: std({ map: deckTexture(), roughness: .92, metalness: .02 }),
    foreDeck: std({ map: fd, roughness: .92, metalness: .02 }),
    hangar: std({ map: T.hangar, roughness: .7, metalness: .2 }),
    transom: std({ map: T.transom, roughness: .65, metalness: .15 }),
    number: std({ map: T.number, transparent: true, alphaTest: .35, roughness: .6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    lampR: lampMat(0x200000), lampG: lampMat(0x002008), lampW: lampMat(0x202020),
    glowR: spriteMat(0xff2a1a), glowG: spriteMat(0x2aff6a), glowW: spriteMat(0xffffff, true)
  };
});

// Smooth normals across duplicate positions (bow stem / keel centre line / stern) so no shading seam shows.
function weldNormals(g) {
  const p = g.attributes.position, n = g.attributes.normal, map = new Map(), key = i => `${Math.round(p.getX(i) * 200)}|${Math.round(p.getY(i) * 200)}|${Math.round(p.getZ(i) * 200)}`;
  for (let i = 0; i < p.count; i++) { const k = key(i); let e = map.get(k); if (!e) map.set(k, e = [0, 0, 0, []]); e[0] += n.getX(i); e[1] += n.getY(i); e[2] += n.getZ(i); e[3].push(i); }
  for (const [, e] of map) { if (e[3].length < 2) continue; const l = Math.hypot(e[0], e[1], e[2]) || 1; for (const i of e[3]) n.setXYZ(i, e[0] / l, e[1] / l, e[2] / l); }
}
function shipHullGeo() {
  const N = 84, pos = [], col = [], uv = [], idx = [];
  let M = 0;
  for (let k = 0; k <= N; k++) {
    const s = k / N, z = mix(SHIP.zS, SHIP.zB, Math.pow(s, 1) ), ring = shipRingPts(k === N ? SHIP.zB - .001 : z); M = ring.length;
    ring.forEach((p, i) => { pos.push(p.x, p.y, p.z); col.push(p.c[0], p.c[1], p.c[2]); uv.push((z - SHIP.zS) / 96, i / M * 2); });
  }
  for (let k = 0; k < N; k++) for (let i = 0; i < M; i++) {
    const a = k * M + i, b = k * M + (i + 1) % M, c = (k + 1) * M + i, d = (k + 1) * M + (i + 1) % M; idx.push(a, b, c, b, d, c);
  }
  // stern cap fan
  const cs = pos.length / 3; { let cx = 0, cy = 0, cz = 0; for (let i = 0; i < M; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; } pos.push(cx / M, cy / M, cz / M); col.push(.35, .38, .42); uv.push(0, 0); for (let i = 0; i < M; i++) idx.push(cs, (i + 1) % M, i); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // make sure winding faces outward (deck normals up)
  const n = g.attributes.normal, p = g.attributes.position; let sum = 0; for (let i = 0; i < p.count; i += 7) sum += n.getX(i) * p.getX(i) + n.getY(i) * (p.getY(i) - 2) + n.getZ(i) * (p.getZ(i) - 2);
  if (sum < 0) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); }
  weldNormals(g); g.computeBoundingSphere(); return g;
}
function transomGeo() {
  const ring = shipRingPts(SHIP.zS), sh = new THREE.Shape();
  ring.slice(1, ring.length - 1).forEach((p, i) => i ? sh.lineTo(p.x, p.y) : sh.moveTo(p.x, p.y));
  const g = new THREE.ShapeGeometry(sh), p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + 21) / 42, (p.getY(i) - SHIP.yK) / (SHIP.yD - SHIP.yK));
  g.rotateY(Math.PI); g.translate(0, 0, SHIP.zS - .1); return g;
}
const wallTileG = (sx, sy, sz, tw = 34, th = 21) => cached(`wt${sx}_${sy}_${sz}_${tw}`, () => {
  const g = new THREE.BoxGeometry(sx, sy, sz), uv = g.attributes.uv, face = [sz, sz, 0, 0, sx, sx];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i;
    if (f === 2 || f === 3) uv.setXY(k, .5, .035); else uv.setXY(k, uv.getX(k) * face[f] / tw, uv.getY(k) * sy / th + .06);
  }
  return g;
});

// Crew silhouette (survival suit + helmet), origin at the feet, ~2.3 units tall, facing +Z.
function addCrew(b, x, y, z, yaw, o = {}) {
  const suit = o.suit ?? 0xe8651e, pose = o.pose ?? 'stand', m = tr(x, y, z).multiply(new M4().makeRotationY(yaw)); b.push(m);
  const h = pose === 'stand' ? 0 : -.5;
  b.add(capsG(.36, pose === 'stand' ? .55 : .35, 4, 10), [0, 1.0 + h * .7, 0], [1.1, 1, .8], [pose === 'stand' ? 0 : .35, 0, 0], { color: suit });
  b.add(capsG(.15, .5, 4, 8), [-.28, .25 + h * .2, 0], 1, [pose === 'stand' ? 0 : -1.2, 0, 0], { color: suit }); b.add(capsG(.15, .5, 4, 8), [.28, .25 + h * .2, 0], 1, [pose === 'stand' ? 0 : -1.2, 0, 0], { color: suit });
  b.add(G.sph12, [0, 1.72 + h * 1.0, pose === 'stand' ? 0 : .22], .3, [0, 0, 0], { color: o.helmet ?? 0xeceae4 });
  b.add(G.sph12, [0, 1.7 + h * 1.0, (pose === 'stand' ? 0 : .22) + .15], [.2, .13, .12], [0, 0, 0], { color: 0x1a2430 });
  rod(b, [-.45, 1.2 + h * .7, 0], [-.36, .78 + h * .5, .38], .11, { color: suit }); rod(b, [.45, 1.2 + h * .7, 0], [.36, .78 + h * .5, .38], .11, { color: suit });
  b.pop();
}
// Rigid inflatable at the origin, bow +Z. About 15 units (11 m) long; waterline y=0 cuts the tubes and the V hull.
function addRhib(b, x, y, z, yaw, s = 1, crew = true) {
  b.push(tr(x, y, z).multiply(new M4().makeRotationY(yaw)).multiply(new M4().makeScale(s, s, s)));
  const tube = { color: 0xdc5a1c }, grey = { color: 0x7b8690 }, dark = { color: 0x1c2024 }, floor = { color: 0x5a636c };
  const pts = [[-2.25, -6.8], [-2.3, -3], [-1.95, 1.8], [-1.1, 5.2], [0, 7.3]];
  for (const sx of [-1, 1]) for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], c = pts[i + 1]; rod(b, [sx * Math.abs(a[0]), .3, a[1]], [sx * Math.abs(c[0]), .3, c[1]], .78, tube, G.cyl16);
    b.add(G.sph12, [sx * Math.abs(c[0]), .3, c[1]], .78, [0, 0, 0], tube);
  }
  b.add(G.sph12, [-2.25, .3, -6.8], .78, [0, 0, 0], tube); b.add(G.sph12, [2.25, .3, -6.8], .78, [0, 0, 0], tube);
  b.add(G.box, [0, -.15, -.6], [3.4, .3, 13.4], [0, 0, 0], floor);                                    // floor / V hull body
  b.addM(trapG(2.6, 3.6, 3.2, .4), tr(0, -.18, 5.6).multiply(rotX(Math.PI / 2)), grey);                // bow wedge
  b.add(G.box, [0, -.7, -.6], [1.6, .9, 13.0], [0, 0, 0], { color: 0x2c3238 });                          // keel
  b.add(G.box, [0, 1.35, -1.6], [2.2, 1.3, 1.5], [0, 0, 0], grey);                                      // centre console
  b.addM(G.box, tr(0, 2.2, -.9).multiply(rotX(-.55)).multiply(new M4().makeScale(2.0, .08, 1.0)), { color: 0x0e1822 });
  b.add(G.box, [0, 1.0, -3.2], [2.0, .6, 1.2], [0, 0, 0], dark);                                         // bench
  for (const sx of [-.75, .75]) { b.add(G.box, [sx, .8, -7.3], [.8, 1.8, 1.0], [0, 0, 0], dark); b.add(cylG(.16, .16, 1.2, 10), [sx, -.3, -7.9], 1, [0, 0, 0], dark); }
  rod(b, [0, 2.0, -2.4], [0, 4.4, -2.6], .06, grey); b.add(G.box, [0, 4.5, -2.65], [1.6, .08, .08], [0, 0, 0], grey);   // radar arch / antenna
  if (crew) {
    addCrew(b, -.6, .1, -2.0, .1, { pose: 'stand' }); addCrew(b, .7, .1, -2.0, -.1, { pose: 'stand', suit: 0xd8531a });
    addCrew(b, -.95, .1, 2.2, -.2, { pose: 'kneel' }); addCrew(b, .95, .1, 2.8, .2, { pose: 'kneel', suit: 0xd8531a });
  }
  b.pop();
}

const shipTemplate = memo(() => {
  const M = MAT(), S = shipMats(), root = new THREE.Group(), zA = SHIP.yD;
  const hull = new THREE.Mesh(shipHullGeo(), S.hull); hull.castShadow = hull.receiveShadow = true; root.add(hull);
  const bSuper = new Batch(), bMast = new Batch(), bRail = new Batch(), bGlass = new Batch(), bBoat = new Batch(), bDark = new Batch(), bAir = new Batch();
  const rng = makeRng(909), grey = 0x8d98a1, light = 0xb4bcc4;
  // --- hangar block, deckhouse levels, bridge
  bSuper.add(wallTileG(34, 12.5, 18), [0, zA + 6.25, -31.5]);
  bSuper.add(wallTileG(33, 17, 66), [0, zA + 8.5, 6]);
  bSuper.add(wallTileG(27, 11, 52), [0, zA + 22.5, 11]);
  bSuper.add(wallTileG(21, 8, 24), [0, zA + 32, 19]);
  for (const [y, w, l, zc] of [[zA + 17.05, 33.6, 66.6, 6], [zA + 28.05, 27.6, 52.6, 11], [zA + 36.05, 21.6, 24.6, 19], [zA + 12.55, 34.6, 18.6, -31.5]]) bMast.add(G.box, [0, y, zc], [w, .22, l], [0, 0, 0], { color: 0x78838c });
  // bridge glazing (sloped windshield + wing windows) and bridge wings
  bGlass.addM(G.box, tr(0, zA + 34.5, 31.2).multiply(rotX(.22)).multiply(new M4().makeScale(19.5, 2.6, .25)));
  for (const s of [-1, 1]) { bGlass.add(G.box, [s * 10.8, zA + 34.5, 19.5], [.25, 2.4, 11], [0, 0, 0]); bMast.add(G.box, [s * 14.5, zA + 30.3, 25], [8, .35, 5.6], [0, 0, 0], { color: 0x78838c }); bGlass.add(G.box, [s * 18.4, zA + 31.6, 25], [.2, 2.2, 5], [0, 0, 0]); }
  // --- enclosed mast (hexagonal tower), radar pedestal, yardarms, whips, domes
  bMast.add(cylG(4.9, 6.6, 28, 8), [0, zA + 54, -2], 1, [0, Math.PI / 8, 0], { color: 0x8a949d });
  for (let i = 0; i < 5; i++) bMast.add(cylG(6.7 - i * .45, 6.7 - i * .45, .45, 8), [0, zA + 40.5 + i * 6.2, -2], 1, [0, Math.PI / 8, 0], { color: 0x6d7881 });
  bMast.add(cylG(5.6, 5.6, .6, 8), [0, zA + 68.3, -2], 1, [0, Math.PI / 8, 0], { color: 0x66717a });
  for (let i = 0; i < 12; i++) { const a = i * TAU / 12; bMast.add(G.box, [Math.sin(a) * 5.1, zA + 69.5, -2 + Math.cos(a) * 5.1], [.14, 1.8, .14], [0, 0, 0], { color: 0xb8bec4 }); }
  bMast.add(G.box, [0, zA + 70.2, -2 + 5.1], [10.2, .14, .14], [0, 0, 0], { color: 0xb8bec4 });
  bMast.add(cylG(.9, 1.2, 3, 14), [0, zA + 70.4, -2], 1, [0, 0, 0], { color: 0x4a525a });
  rod(bMast, [0, zA + 69, -2], [0, zA + 90, -2], .22, { color: 0xc4cad0 });
  rod(bMast, [-5, zA + 80, -2], [5, zA + 80, -2], .14, { color: 0xc4cad0 }); rod(bMast, [-3.5, zA + 85, -2], [3.5, zA + 85, -2], .12, { color: 0xc4cad0 });
  bMast.add(G.sph, [-12, zA + 40.5, 6], 3.3, [0, 0, 0], { color: 0xe7e9ea }); bMast.add(cylG(1.4, 1.7, 1.8, 14), [-12, zA + 38.7, 6], 1, [0, 0, 0], { color: 0x8c969f });
  bMast.add(G.sph, [11, zA + 40.5, 24], 2.6, [0, 0, 0], { color: 0xe7e9ea }); bMast.add(cylG(1.1, 1.3, 1.6, 14), [11, zA + 39, 24], 1, [0, 0, 0], { color: 0x8c969f });
  // funnels / exhaust stacks and roof equipment
  for (const s of [-1, 1]) { bMast.add(G.box, [s * 9.5, zA + 34, -20], [5, 12, 8], [0, 0, 0], { color: 0x7d8890 }); bDark.add(G.box, [s * 9.5, zA + 40.2, -20], [4.2, .4, 6.8], [0, 0, 0], { color: 0x15181b }); }
  for (let i = 0; i < 60; i++) { const lvl = rng(), y = lvl < .5 ? zA + 17.2 : zA + 28.3, wx = lvl < .5 ? 15 : 12, wz = lvl < .5 ? 30 : 24, zc = lvl < .5 ? 6 : 11; bMast.add(G.box, [(rng() - .5) * 2 * wx, y + .8, zc + (rng() - .5) * 2 * wz], [.8 + rng() * 2.2, 1.0 + rng() * 1.6, .8 + rng() * 2.2], [0, rng() * 3, 0], { color: rng() < .5 ? grey : light }); }
  // --- foredeck: gun mount, windlass, bollards, anchors, VLS hatches
  bMast.add(G.sph, [0, zA + 2.2, 112], [3.2, 2.2, 3.2], [0, 0, 0], { color: 0xd8dbdd }); bMast.add(cylG(3.4, 3.8, 1.2, 18), [0, zA + .6, 112], 1, [0, 0, 0], { color: 0x6f7a84 });
  rod(bMast, [0, zA + 2.6, 112], [0, zA + 2.6, 118], .3, { color: 0x3a4148 });
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) bDark.add(G.box, [-6 + i * 4, zA + .18, 62 + j * 4.2], [3.0, .28, 3.0], [0, 0, 0], { color: 0x2a3036 });
  bMast.add(cylG(1.4, 1.4, 4, 12), [0, zA + 1.6, 92], 1, [0, 0, Math.PI / 2], { color: 0x4a525a });
  for (const [x, z] of [[-8, 100], [8, 100], [-10, 132], [10, 132], [-18, -118], [18, -118], [-19, -40], [19, -40], [-19, 60], [19, 60]]) bMast.add(cylG(.7, .9, 1.7, 10), [x, zA + .85, z], 1, [0, 0, 0], { color: 0x3a4148 });
  // --- crane + davits on the flight-deck edge, RHIBs on the boat deck, a helicopter in the aft landing spot
  rod(bMast, [-19, zA, -48], [-19, zA + 12, -48], .5, { color: 0x8c969f }); rod(bMast, [-19, zA + 12, -48], [-27, zA + 8, -48], .35, { color: 0x8c969f }); rod(bMast, [-27, zA + 8, -48], [-27, zA + 1, -48], .08, { color: 0x1d2024 });
  addRhib(bBoat, -23.5, zA + 5, 7, 0, 1.0, true); addRhib(bBoat, 23.5, zA + 5, 7, 0, 1.0, false);
  for (const s of [-1, 1]) { bDark.add(G.box, [s * 23.5, zA + 1.2, 7], [5, 2.6, 17], [0, 0, 0], { color: 0x30363c }); }
  const hx = 0, hz = -104, hy = zA + .1, hc = { color: 0x535c4f }, hd = { color: 0x23282c };
  bAir.add(capsG(1.5, 6.2, 6, 12), [hx, hy + 3.6, hz], [1, 1.1, 1], [Math.PI / 2, 0, 0], hc); bAir.add(capsG(.45, 8, 4, 8), [hx, hy + 4.2, hz - 9.5], 1, [Math.PI / 2, 0, 0], hc);
  bAir.add(G.box, [hx, hy + 5, hz - 14], [.2, 3.2, 2.6], [0, 0, 0], hc); bAir.add(cylG(.4, .4, 1.4, 8), [hx, hy + 5.8, hz + 1], 1, [0, 0, 0], hd);
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + .3; bAir.add(G.box, [hx + Math.sin(a) * 5.4, hy + 6.55, hz + 1 + Math.cos(a) * 5.4], [.45, .06, 10.8], [0, a, 0], hd); }
  for (const s of [-1, 1]) { bAir.add(cylG(.22, .22, 2.4, 6), [hx + s * 1.6, hy + 1.2, hz + 1.8], 1, [0, 0, 0], hd); bAir.add(cylG(.25, .25, .9, 8), [hx + s * 1.6, hy + .25, hz + 1.8], 1, [0, 0, Math.PI / 2], hd); }
  bAir.add(cylG(.2, .2, .9, 8), [hx, hy + .25, hz - 12], 1, [0, 0, Math.PI / 2], hd);
  // --- guard rails along both gunwales and around the bow
  const posts = [];
  for (let z = SHIP.zS + 2; z <= SHIP.zB - 6; z += 6) { const w = shipW(z) * HULL_ROWS[7][1] - .5, t = clamp((z - SHIP.bowStart) / (SHIP.zB - SHIP.bowStart)), zz = z + SHIP.rake * smooth(t); posts.push([w, zz]); }
  for (const s of [-1, 1]) {
    for (let i = 0; i < posts.length; i++) {
      const [x, z] = posts[i]; bRail.add(G.box, [s * x, zA + 1.7, z], [.18, 3.4, .18], [0, 0, 0], { color: 0xc3c9cf });
      if (i) { const [x0, z0] = posts[i - 1], dx = s * (x - x0), dz = z - z0, l = Math.hypot(dx, dz); for (const y of [1.7, 3.3]) bRail.addM(G.box, tr(s * (x + x0) / 2, zA + y, (z + z0) / 2).multiply(new M4().makeRotationY(Math.atan2(dx, dz))).multiply(new M4().makeScale(.12, .12, l)), { color: 0xc3c9cf }); }
    }
  }
  // --- decals: deck markings, foredeck, hangar doors, transom well deck, hull numbers, plates
  const deckQ = new THREE.Mesh(new THREE.PlaneGeometry(39.2, 84).rotateX(-Math.PI / 2), S.deck); deckQ.position.set(0, zA + .08, -85.5); deckQ.receiveShadow = true; root.add(deckQ);
  const fore = new THREE.Mesh(new THREE.PlaneGeometry(40, 82).rotateX(-Math.PI / 2), S.foreDeck); fore.position.set(0, zA + .08, 80); fore.receiveShadow = true; root.add(fore);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(30, 9.5).rotateY(Math.PI), S.hangar); door.position.set(0, zA + 5.4, -40.6); root.add(door);
  const transom = new THREE.Mesh(transomGeo(), S.transom); transom.receiveShadow = true; root.add(transom);
  const nb = new Batch();
  for (const s of [-1, 1]) { nb.addM(G.plane, tr(s * 21.1, 6.5, 60).multiply(new M4().makeRotationY(s * Math.PI / 2)).multiply(new M4().makeScale(18, 9, 1))); nb.addM(G.plane, tr(s * 20.2, 7.5, -80).multiply(new M4().makeRotationY(s * Math.PI / 2)).multiply(new M4().makeScale(18, 9, 1))); }
  nb.mesh(S.number, root, { cast: false, name: 'hullNumber' });
  const put = (b, m, n, o) => b.mesh(m, root, { name: n, ...o });
  put(bSuper, S.super, 'super'); put(bMast, M.matte, 'mast'); put(bRail, M.metal, 'rails', { cast: false }); put(bGlass, M.glass, 'glass'); put(bBoat, M.matte, 'boats'); put(bDark, M.darkMetal, 'dark'); put(bAir, M.matte, 'helo');
  // spinning radar, nav lights
  const radar = new THREE.Group(); radar.name = 'radar'; radar.position.set(0, zA + 71.9, -2); root.add(radar);
  const rb = new Batch(); rb.add(G.box, [0, 0, 0], [12, 1.4, .4], [0, 0, 0], { color: 0xaab1b8 }); rb.add(G.box, [0, -1, 0], [1.2, .9, 1.2], [0, 0, 0], { color: 0x4a525a }); rb.mesh(M.matte, radar);
  const lamp = (mat, x, y, z, glowMat, name, size) => { const l = new THREE.Mesh(G.sph12, mat); l.scale.setScalar(.5); l.position.set(x, y, z); root.add(l); const sp = new THREE.Sprite(glowMat); sp.scale.setScalar(size); sp.position.set(x, y, z); sp.name = name; root.add(sp); };
  lamp(S.lampR, 18.4, zA + 31.6, 27.8, S.glowR, 'navR', 9); lamp(S.lampG, -18.4, zA + 31.6, 27.8, S.glowG, 'navG', 9); lamp(S.lampW, 0, zA + 90.4, -2, S.glowW, 'mastLight', 12);
  lamp(S.lampW, 0, zA + 3.4, -122, S.glowW, 'sternLight', 7);
  // foam: hull contact ribbon, bow wave, stern wake (all follow the ship; film-time driven)
  const FY = 1.1, ringW = [], bowZ = SHIP.zB;
  const per = [];
  for (let k = 0; k <= 60; k++) { const z = mix(SHIP.zS, bowZ - .5, k / 60), w = shipW(z) * HULL_ROWS[3][1] + .3; per.push([w, z + 0, 5.5 + 3 * Math.sin(k * .7)]); }
  for (const sgn of [-1, 1]) {
    const line = per.map(p => [sgn * p[0], p[1], p[2]]);
    const m = new THREE.Mesh(stripGeo(line, FY, false, sgn), foamMaterial(0, { len: 270, cell: 8, speed: 5, amt: .9, across: 2 })); m.renderOrder = 3; m.name = 'foamHull'; root.add(m);
    const bw = []; for (let k = 0; k <= 24; k++) { const s = k / 24; bw.push([sgn * (1.2 + s * 40), bowZ - 4 - s * 62, 2.5 + s * 12]); }
    const b = new THREE.Mesh(stripGeo(bw, FY + .1, false, sgn), foamMaterial(1, { len: 70, cell: 6, speed: 7, amt: 1.2, across: 2.2 })); b.renderOrder = 3; b.name = 'foamBow'; root.add(b);
  }
  const wk = []; for (let k = 0; k <= 40; k++) { const s = k / 40; wk.push([Math.sin(s * 3) * 1.5, SHIP.zS - 4 - s * 300, 30 + s * 70]); }
  const wake = new THREE.Mesh(stripGeo(wk, FY - .1, true, 1), foamMaterial(2, { len: 300, cell: 10, speed: 9, amt: 1.1, across: 7, tint: 0xcfd6da })); wake.renderOrder = 3; wake.name = 'foamWake'; root.add(wake);
  return root;
});

// Representative recovery ship (generic grey amphibious transport dock), waterline at y=0, bow toward +Z.
// 270 units long (about 200 m at 1 unit = 0.74 m, a 6.8-unit capsule = 5 m), beam 38 at the waterline, flight deck 14 above the water, mast top ~104.
// Hull number "R 24", helicopter on the aft spot, two RHIBs, enclosed mast. userData.length = 270. Includes contact foam, bow wave and stern wake sheets.
export function recoveryShip(parent) {
  const g = shipTemplate().clone(true); parent?.add(g);
  const S = shipMats(), radar = g.getObjectByName('radar'), foams = [];
  g.traverse(o => { if (o.isMesh && o.name.startsWith('foam')) { o.material = o.material.clone(); foams.push(o.material); } });
  g.userData.length = 270; g.userData.beam = 38;
  g.userData.tick = t => {
    radar.rotation.y = t * 2.2;
    const r = blinkPulse(t, 2.4, .5), gg = blinkPulse(t, 2.4, .5, 1.2), w = blinkPulse(t, 1.6, .14, .3);
    S.lampR.color.setRGB(.12 + r * 5, .01, .01); S.lampG.color.setRGB(.01, .12 + gg * 5, .03); S.lampW.color.setRGB(.15 + w * 6, .15 + w * 6, .15 + w * 6);
    S.glowR.opacity = r * .6; S.glowG.opacity = gg * .6; S.glowW.opacity = w * .85;
    for (const m of foams) m.uniforms.uTime.value = t;
  };
  return g;
}

/* ------------------------------------------------------------------ rescue boat (RHIB) */
const boatTemplate = memo(() => {
  const M = MAT(), root = new THREE.Group(), b = new Batch(), bl = new Batch();
  addRhib(b, 0, 0, 0, 0, 1, true);
  b.mesh(M.matte, root, { name: 'boat' });
  const lamp = (mat, x, y, z, glowMat, name, size) => { const l = new THREE.Mesh(G.sph12, mat); l.scale.setScalar(.14); l.position.set(x, y, z); root.add(l); const sp = new THREE.Sprite(glowMat); sp.scale.setScalar(size); sp.position.set(x, y, z); sp.name = name; root.add(sp); };
  const S = shipMats(); lamp(S.lampR, -1.6, 1.7, 5.5, S.glowR, 'bR', 1.6); lamp(S.lampG, 1.6, 1.7, 5.5, S.glowG, 'bG', 1.6); lamp(S.lampW, 0, 4.6, -2.65, S.glowW, 'bW', 2.2);
  // spray / wake sheets
  const FY = .75, wk = []; for (let k = 0; k <= 16; k++) { const s = k / 16; wk.push([0, -7.5 - s * 46, 5 + s * 13]); }
  const wake = new THREE.Mesh(stripGeo(wk, FY, true, 1), foamMaterial(2, { len: 46, cell: 4, speed: 8, amt: 1.2, across: 4 })); wake.renderOrder = 3; wake.name = 'foamWake'; root.add(wake);
  for (const sgn of [-1, 1]) {
    const bw = []; for (let k = 0; k <= 10; k++) { const s = k / 10; bw.push([sgn * (.5 + s * 5.5), 7 - s * 9, .8 + s * 2.4]); }
    const m = new THREE.Mesh(stripGeo(bw, FY + .05, false, sgn), foamMaterial(1, { len: 10, cell: 2.5, speed: 6, amt: 1.3, across: 2 })); m.renderOrder = 3; m.name = 'foamBow'; root.add(m);
  }
  return root;
});
// Rescue boat (rigid inflatable, ~15 units = 11 m long, four crew in orange survival suits), waterline y=0, bow +Z, with bow spray and wake sheets.
export function rescueBoat(parent) {
  const g = boatTemplate().clone(true); parent?.add(g); const S = shipMats(), foams = [];
  g.traverse(o => { if (o.isMesh && o.name.startsWith('foam')) { o.material = o.material.clone(); foams.push(o.material); } });
  g.userData.length = 15;
  g.userData.tick = t => { const w = blinkPulse(t, 1.2, .12, .5); S.glowW.opacity = w * .8; for (const m of foams) m.uniforms.uTime.value = t; };
  return g;
}

/* ------------------------------------------------------------------ spent upper stage (ICPS-like) */
const foamTexture = memo(() => {
  const W = 1024, H = 512, c = cv(W, H), q = c.getContext('2d'), rng = makeRng(515), nz = noiseField(W, H, 12, 6, rng), nz2 = noiseField(W, H, 90, 40, rng);
  const img = q.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i0 = y * W + x, k = .86 + (nz[i0] - .5) * .22 + (nz2[i0] - .5) * .1, seam = (x % 128 < 2) || (y % 128 < 2) ? .72 : 1;
    const i = i0 * 4; d[i] = 214 * k * seam; d[i + 1] = 128 * k * seam; d[i + 2] = 62 * k * seam; d[i + 3] = 255;
  }
  q.putImageData(img, 0, 0); return toTex(c, true);
});
const stageTemplate = memo(() => {
  const root = new THREE.Group(), M = MAT(), R = 4.2;
  const bFoam = new Batch(), bWhite = new Batch(), bMetal = new Batch(), bDark = new Batch(), bBell = new Batch();
  // body from aft (y=-11) to forward (y=+11): engine skirt, LH2 tank (foam), interstage ring, LOX tank dome, forward skirt, adapter cone toward Orion
  bFoam.add(cylG(R, R, 12.4, 64, true), [0, -3.4, 0], 1, [0, 0, 0], { uv: [3, 1.6] });
  bFoam.add(new THREE.SphereGeometry(R, 48, 14, 0, TAU, 0, Math.PI / 2).scale(1, .32, 1), [0, 2.8, 0], 1, [0, 0, 0], { uv: [3, .4] });
  bWhite.add(cylG(R, R, 3.2, 64, true), [0, 4.4, 0], 1, [0, 0, 0], { color: 0xe9ecee });
  bWhite.add(cylG(R * .97, R, 1.6, 64, true), [0, -10.2, 0], 1, [0, 0, 0], { color: 0xe3e6e8 });
  bWhite.add(cylG(R * .86, R * .97, 2.4, 64, true), [0, 7.3, 0], 1, [0, 0, 0], { color: 0xe3e6e8 });
  bWhite.add(cylG(R * .86, R * .86, .02, 64), [0, 8.5, 0], 1, [0, 0, 0], { color: 0xcfd3d6 });
  for (const y of [-9.4, 2.8, 5.9, 8.5]) bMetal.add(torus(R * (y > 7 ? .86 : 1) + .02, .09, 64, 6), [0, y, 0], 1, [Math.PI / 2, 0, 0], { color: 0xa8aeb4 });
  for (let i = 0; i < 24; i++) { const a = i * TAU / 24; bMetal.add(G.box, [Math.sin(a) * (R + .03), 4.4, Math.cos(a) * (R + .03)], [.12, 3.0, .05], [0, a, 0], { color: 0xb5bbc1 }); }
  bDark.add(cylG(R * .98, R * .98, .15, 64), [0, -11.05, 0], 1, [0, 0, 0], { color: 0x23282d });
  for (let i = 0; i < 6; i++) { const a = i * TAU / 6; bDark.add(G.box, [Math.sin(a) * (R * .8), -10.9, Math.cos(a) * (R * .8)], [.8, .25, .5], [0, a, 0], { color: 0x30363c }); }
  // RL10 engine: thrust structure + extendable nozzle
  bMetal.add(cylG(.9, 1.3, 1.2, 20), [0, -10.2, 0], 1, [0, 0, 0], { color: 0x9aa1a8 });
  const np = [[.5, -10.7], [.45, -11.0]]; for (let i = 0; i <= 14; i++) { const s = i / 14; np.push([.45 + .55 * Math.pow(s, .6), -11.0 - 3.6 * s]); } np.push([1.02, -14.62], [.98, -14.62]);
  const bell = lathe(np, 40), bp = bell.attributes.position, bc = new Float32Array(bp.count * 3);
  for (let i = 0; i < bp.count; i++) { const tt = clamp((-10.7 - bp.getY(i)) / 3.9); bc[i * 3] = mix(.66, .3, tt); bc[i * 3 + 1] = mix(.68, .22, tt); bc[i * 3 + 2] = mix(.7, .2, tt); }
  bell.setAttribute('color', new THREE.BufferAttribute(bc, 3)); bBell.add(bell);
  // Orion adapter: conical frustum with ring + separation clamps at the forward end
  bWhite.add(cylG(R * .5, R * .86, 3.2, 48, true), [0, 10.1, 0], 1, [0, 0, 0], { color: 0xdfe3e6 });
  bMetal.add(torus(R * .5, .1, 48, 6), [0, 11.7, 0], 1, [Math.PI / 2, 0, 0], { color: 0xb8bec4 });
  for (let i = 0; i < 8; i++) { const a = i * TAU / 8; bDark.add(G.box, [Math.sin(a) * R * .5, 11.5, Math.cos(a) * R * .5], [.35, .4, .25], [0, a, 0], { color: 0x2a3036 }); }
  // propellant lines, vent ducts and RCS blocks
  for (let i = 0; i < 4; i++) { const a = i * TAU / 4 + .4; rod(bMetal, [Math.sin(a) * (R + .15), -9, Math.cos(a) * (R + .15)], [Math.sin(a) * (R + .15), 1.5, Math.cos(a) * (R + .15)], .1, { color: 0xb2b8be }); }
  for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + 1; bDark.add(G.box, [Math.sin(a) * (R + .1), -9.4, Math.cos(a) * (R + .1)], [.9, .8, .5], [0, a, 0], { color: 0x2c3238 }); }
  const put = (b, m, n) => b.mesh(m, root, { name: n });
  put(bFoam, new THREE.MeshStandardMaterial({ map: foamTexture(), roughness: .9, metalness: 0 }), 'foam'); put(bWhite, M.matte, 'white'); put(bMetal, M.metal, 'metal'); put(bDark, M.darkMetal, 'dark'); put(bBell, M.bell, 'bell');
  return root;
});
// Spent ICPS-like upper stage: axis along local Y, forward (Orion adapter) end at +11.7, RL10 nozzle exit at -14.6, radius 4.2, orange foam LH2 tank.
export function spentStage(parent) {
  const g = stageTemplate().clone(true); parent?.add(g); g.userData.length = 26.3; g.userData.radius = 4.2; return g;
}
