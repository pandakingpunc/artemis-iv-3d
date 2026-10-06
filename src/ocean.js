// Pacific splashdown ocean: one clear wind direction, four directional Gerstner wave trains (40 .. 3 m, sharp crests), two baked directional
// ripple fields (wavelengths 0.15 .. 2 m, streaked across the wind) instead of isotropic noise, analytic per-pixel normals, dawn-sky fresnel
// reflection, GGX sun glitter widened by the energy the pixel footprint cannot resolve, Jacobian crest foam and a distance haze that dissolves
// exactly into the sky dome's horizon colour (sky.js skyHaze). 1 world unit = 0.735 m (the capsule is 5 m = 6.8 units).
import * as THREE from 'three';
import { makeRng } from './util.js';
import { DAWN_SUN_DIR, NOISE_GLSL, SKY_GLSL } from './sky.js';
import * as TL from './timeline.js';

const G = 9.81, N_WAVES = 8, M = 1 / .735;       // M = world units per metre
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Wind blows toward +Z (80 deg from +X, almost straight at the dawn camera, so the glitter path runs along the wave fronts).
// Four trains, two components each: swell, long chop, short chop, wind ripple. The spread widens as the wavelength shrinks, like a real spectrum.
// [wavelength m, amplitude m, travel direction deg from +X toward +Z, steepness share Q·k·A]; the shares sum to .78 so crests sharpen but never loop.
const WIND_DEG = 80;
const WAVES = [[40, .27, WIND_DEG + 4, .10], [30, .20, WIND_DEG - 9, .08], [22, .17, WIND_DEG + 14, .12], [15.5, .11, WIND_DEG - 6, .10],
  [10.5, .075, WIND_DEG + 20, .12], [7.2, .052, WIND_DEG - 16, .10], [4.8, .034, WIND_DEG + 27, .09], [3.2, .02, WIND_DEG - 30, .07]];
const WIND = [Math.cos(WIND_DEG * Math.PI / 180), Math.sin(WIND_DEG * Math.PI / 180)];
// Ripple layers: tile length (units), wavelength range (m), direction spread (deg), rms slope, tile scroll speed (u/s), phase rate (rad/s)
const RIP = [{ L: 24.7, lam: [.45, 2.2], spread: 36, sigma: .11, speed: .95, w: 2.1, lc: 1.5 }, { L: 8.3, lam: [.14, .6], spread: 48, sigma: .075, speed: 1.35, w: 3.4, lc: .34 }];

// Tileable directional ripple field. A sum of cosines with integer wave vectors (periodic), directions spread around the wind (streaks across it,
// not swirls). RGBA16F, mip chain built here: RG = gradient of the cosine-phase field, BA = of the sine-phase field; gradient(t) = cos(wt)·RG + sin(wt)·BA.
function rippleTexture(seed, { L, lam, spread, sigma }) {
  const N = 256, NC = 40, rng = makeRng(seed), TAU = Math.PI * 2, wind = WIND_DEG * Math.PI / 180;
  const cT = new Float32Array(N), sT = new Float32Array(N); for (let i = 0; i < N; i++) { cT[i] = Math.cos(TAU * i / N); sT[i] = Math.sin(TAU * i / N); }
  const comps = [], seen = new Set();
  for (let guard = 0; comps.length < NC && guard < 4000; guard++) {
    const lu = lam[0] * M * Math.pow(lam[1] / lam[0], rng()), ang = wind + (rng() + rng() + rng() - 1.5) * (spread * Math.PI / 180) * .85;
    const m = Math.round(L / lu * Math.cos(ang)), n = Math.round(L / lu * Math.sin(ang)), key = m * 4096 + n;
    if ((!m && !n) || seen.has(key) || Math.abs(m) > 120 || Math.abs(n) > 120) continue;
    seen.add(key);
    const kl = Math.hypot(m, n);
    comps.push({ m, n, ux: m / kl, uz: n / kl, s: Math.pow(L / kl, .35), ph: Math.floor(rng() * N) });   // phase quantised to 1/N cycle: table look-ups only
  }
  let e = 0; for (const c of comps) e += c.s * c.s * .5; const norm = sigma / Math.sqrt(e);
  let cur = new Float32Array(N * N * 4);
  for (const k of comps) {
    const sx = k.s * norm * k.ux, sz = k.s * norm * k.uz;
    for (let j = 0, o = 0; j < N; j++) {
      const base = k.n * j + k.ph;
      for (let i = 0; i < N; i++, o += 4) {
        const id = (k.m * i + base) & (N - 1), co = cT[id], si = sT[id];   // sin / cos of (k·x + phase)
        cur[o] -= sx * si; cur[o + 1] -= sz * si; cur[o + 2] += sx * co; cur[o + 3] += sz * co;
      }
    }
  }
  const mips = []; let n = N;
  for (;;) {
    const h = new Uint16Array(n * n * 4); for (let i = 0; i < h.length; i++) h[i] = THREE.DataUtils.toHalfFloat(cur[i]);
    mips.push({ data: h, width: n, height: n });
    if (n === 1) break;
    const m2 = n >> 1, nx = new Float32Array(m2 * m2 * 4);
    for (let j = 0; j < m2; j++) for (let i = 0; i < m2; i++) for (let q = 0; q < 4; q++)
      nx[(j * m2 + i) * 4 + q] = (cur[((2 * j) * n + 2 * i) * 4 + q] + cur[((2 * j) * n + 2 * i + 1) * 4 + q] + cur[((2 * j + 1) * n + 2 * i) * 4 + q] + cur[((2 * j + 1) * n + 2 * i + 1) * 4 + q]) * .25;
    cur = nx; n = m2;
  }
  const t = new THREE.DataTexture(mips[0].data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mipmaps = mips; t.generateMipmaps = false; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

// Returns { object, update(t), heightAt(x, z, t) }. Mean sea level is y=0. opts: { seed = 7, clouds = 1 } (must match the sky it reflects).
export function createOcean(world, opts = {}) {
  const { seed = 7, clouds = 1, sunDir = DAWN_SUN_DIR } = opts;
  const rand = makeRng(4417);
  const waves = WAVES.map(([lenM, aM, deg, st]) => {
    const a = deg * Math.PI / 180, len = lenM * M, A = aM * M, k = 2 * Math.PI / len;
    return { dx: Math.cos(a), dz: Math.sin(a), k, A, w: Math.sqrt(G * k * M), ph: rand() * 6.2832, Q: st / (k * A), R: len * 12 };
  });
  const WA = waves.map(v => new THREE.Vector4(v.dx, v.dz, v.k, v.A)), WB = waves.map(v => new THREE.Vector4(v.w, v.ph, v.Q, v.R));

  // Radial grid, dense around the capsule and growing outward (spacing ≈ 1 m near the origin, ≈ 25 m at the rim).
  const SECT = 360, RMAX = 2100, rings = [0];
  for (let r = 0; r < RMAX;) { r += 1 + .012 * r; rings.push(Math.min(r, RMAX)); }
  const pos = new Float32Array(rings.length * SECT * 3), idx = new Uint32Array((rings.length - 1) * SECT * 6);
  rings.forEach((r, i) => { for (let j = 0; j < SECT; j++) { const a = j / SECT * Math.PI * 2, o = (i * SECT + j) * 3; pos[o] = Math.cos(a) * r; pos[o + 2] = Math.sin(a) * r; } });
  let q = 0;
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < SECT; j++) {
    const a = i * SECT + j, b = i * SECT + (j + 1) % SECT, c = (i + 1) * SECT + j, d = (i + 1) * SECT + (j + 1) % SECT;
    idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RMAX + 5);

  const uniforms = {
    uTime: { value: 0 }, uWA: { value: WA }, uWB: { value: WB }, uSunDir: { value: sunDir }, uCloud: { value: clouds }, uSeed: { value: seed }, uStars: { value: 0 },
    uPix: { value: .0011 }, uQ: { value: 1 }, uOct: { value: 2 }, uCapK: { value: 0 }, uR1: { value: rippleTexture(9101, RIP[0]) }, uR2: { value: rippleTexture(9102, RIP[1]) }
  };
  const material = new THREE.ShaderMaterial({
    uniforms, fog: false,
    vertexShader: /* glsl */`
uniform float uTime; uniform vec4 uWA[${N_WAVES}]; uniform vec4 uWB[${N_WAVES}];
varying vec3 vWP; varying vec2 vRest;
void main(){
  vec3 p=position; float r=length(p.xz); vec3 o=vec3(0.);
  for(int i=0;i<${N_WAVES};i++){
    vec4 a=uWA[i],b=uWB[i];
    float att=1.-smoothstep(b.w,b.w*2.,r);
    float th=a.z*(a.x*p.x+a.y*p.z)-b.x*uTime+b.y;
    float A=a.w*att, c=cos(th);
    o.y+=A*sin(th); o.xz+=b.z*A*a.xy*c;
  }
  vec4 w=modelMatrix*vec4(p+o,1.);
  vWP=w.xyz; vRest=p.xz;
  gl_Position=projectionMatrix*viewMatrix*w;
}`,
    fragmentShader: NOISE_GLSL + SKY_GLSL + /* glsl */`
uniform vec4 uWA[${N_WAVES}]; uniform vec4 uWB[${N_WAVES}]; uniform float uPix,uQ,uOct,uCapK; uniform sampler2D uR1,uR2;
varying vec3 vWP; varying vec2 vRest;
const vec2 WD=vec2(${WIND[0].toFixed(4)},${WIND[1].toFixed(4)}), WP=vec2(${(-WIND[1]).toFixed(4)},${WIND[0].toFixed(4)});
void main(){
  vec3 V=normalize(cameraPosition-vWP);
  float dist=length(cameraPosition-vWP);
  float fp=dist*uPix/max(V.y,.05);                    // pixel footprint along the view direction (world units)
  float r=length(vRest);
  float nx=0.,nz=0.,cy=0.,jx=0.,jz=0.,jxz=0.,lost=0.,hgt=0.;
  for(int i=0;i<${N_WAVES};i++){
    vec4 a=uWA[i],b=uWB[i];
    float att=1.-smoothstep(b.w,b.w*2.,r);
    float th=a.z*(a.x*vRest.x+a.y*vRest.y)-b.x*uTime+b.y;
    float s=sin(th),c=cos(th);
    float vis=1.-smoothstep(.16,.7,fp*a.z);           // waves the pixel cannot resolve move their energy into the glitter lobe
    float kA=a.z*a.w*att, w=kA*vis;
    nx+=a.x*w*c; nz+=a.y*w*c; cy+=b.z*w*s;
    jx+=b.z*w*a.x*a.x*s; jz+=b.z*w*a.y*a.y*s; jxz+=b.z*w*a.x*a.y*s;
    lost+=(1.-vis)*kA*kA*.5; hgt+=a.w*att*s;
  }
  if(uQ>.5){
    // wind ripples: two baked directional fields, scrolled along the wind and slowly evolving (cos/sin phase pair), mild gusts
    float gust=.86+.28*vnoise(vRest*.021+vec2(uTime*.03,3.));
    vec2 wob=(vec2(vnoise(vRest*.045),vnoise(vRest*.045+17.))-.5)*1.6;        // breaks the tile period
    vec4 t1=texture2D(uR1,(vRest+wob-WD*uTime*${RIP[0].speed.toFixed(2)})/${RIP[0].L.toFixed(2)});
    vec4 t2=texture2D(uR2,(vRest-wob*.5-WD*uTime*${RIP[1].speed.toFixed(2)}+31.)/${RIP[1].L.toFixed(2)});
    vec2 g1=cos(uTime*${RIP[0].w.toFixed(2)})*t1.xy+sin(uTime*${RIP[0].w.toFixed(2)})*t1.zw, g2=cos(uTime*${RIP[1].w.toFixed(2)})*t2.xy+sin(uTime*${RIP[1].w.toFixed(2)})*t2.zw;
    float v1=1.-smoothstep(.1,.5,fp/${RIP[0].lc.toFixed(2)}), v2=1.-smoothstep(.1,.5,fp/${RIP[1].lc.toFixed(2)});
    nx+=gust*(g1.x*v1+g2.x*v2); nz+=gust*(g1.y*v1+g2.y*v2);
    lost+=${(RIP[0].sigma ** 2).toFixed(5)}*(1.-v1)+${(RIP[1].sigma ** 2).toFixed(5)}*(1.-v2);
  }
  vec3 N=normalize(vec3(-nx,1.-cy,-nz));
  float nv=clamp(dot(N,V),0.,1.);
  float F=.02+.98*pow(1.-nv,5.);
  vec3 R=reflect(-V,N); R.y=abs(R.y)+.004;
  vec3 refl=skyColorEx(normalize(R),false,int(uOct),uOct>2.5);       // cirrus only on the high tier (barely visible in the water)
  // water body: deep navy, teal where crests are thick; backlit crests glow
  float hN=clamp(hgt*.55+.5,0.,1.);
  vec3 sunC=vec3(1.,.55,.27);
  vec3 amb=vec3(.15,.175,.25);
  vec3 body=mix(vec3(.02,.1,.16),vec3(.045,.22,.2),hN*hN)*amb;
  body+=vec3(.015,.05,.06)*max(dot(N,uSunDir),0.)*sunC*.5;
  float back=pow(max(dot(-V,normalize(uSunDir+N*.35)),0.),3.5);
  vec3 sss=back*smoothstep(.2,1.,hN)*sunC*vec3(.02,.3,.3)*.32*(1.-F);
  // sun glitter (GGX lobe widened by the wave detail we could not resolve)
  vec3 H=normalize(uSunDir+V); float nh=max(dot(N,H),0.), nl=max(dot(N,uSunDir),0.);
  float al=.035+sqrt(lost)*.8, a2=al*al, dd=nh*nh*(a2-1.)+1.;
  float D=a2/(3.14159*dd*dd);
  float Vis=.5/(nl*sqrt(a2+(1.-a2)*nv*nv)+nv*sqrt(a2+(1.-a2)*nl*nl)+1e-4);
  float Fs=.02+.98*pow(1.-max(dot(V,H),0.),5.);
  vec3 spec=min(D*Vis*Fs*nl*2.2,60.)*vec3(1.,.58,.28);
  // the floating capsule (always at the origin) shades the water: contact darkening plus a long dawn shadow streak away from the sun
  if(uCapK>.001){
    vec2 sd=-normalize(uSunDir.xz), sp=vec2(-sd.y,sd.x); float sa=dot(vRest,sd), sc=dot(vRest,sp);
    float shd=smoothstep(-1.,1.5,sa)*(1.-smoothstep(38.,70.,sa))*(1.-smoothstep(2.6,4.6,abs(sc)));
    shd=max(shd,exp(-dot(vRest,vRest)/21.2)*.6)*uCapK;
    spec*=1.-.85*shd; sss*=1.-.8*shd; refl*=1.-.35*shd; body*=1.-.5*shd;
  }
  vec3 col=mix(body+sss,refl,F)+spec;
  // crest foam from the Jacobian of the horizontal displacement: only where crests of several trains pile up, in soft patches stretched along the crest
  float J=(1.-jx)*(1.-jz)-jxz*jxz;
  float fw=1.-smoothstep(.15,.6,fp*.5);
  float cap=(1.-smoothstep(.5,.78,J))*fw;
  if(uQ>.5&&cap>0.){
    float al2=dot(vRest,WD), ac2=dot(vRest,WP);
    float fn=.65*vnoise(vec2(ac2*.2,al2*.6-uTime*.25))+.35*vnoise(vec2(ac2*.5+9.,al2*1.4-uTime*.4));
    cap*=smoothstep(.3,.6,fn+cap*.3);
    vec3 foamC=(vec3(.34,.35,.38)+vec3(.9,.5,.28)*nl*1.2)*(.55+.45*clamp(hgt*.5+.5,0.,1.))+refl*.15;
    col=mix(col,foamC*.7,clamp(cap*.6,0.,.6));
  }
  // distance haze == sky colour on the horizon line, so the plane never shows an edge
  float hz=1.-exp(-pow(dist/1100.,2.4));
  vec3 hd=normalize(vec3(-V.x,0.,-V.z));
  col=mix(col,skyHaze(hd),hz);
  gl_FragColor=vec4(col,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`
  });
  const ocean = new THREE.Mesh(geo, material);
  ocean.castShadow = ocean.receiveShadow = false; ocean.matrixAutoUpdate = true;
  world.add(ocean);

  // Same wave set as the vertex shader. The Gerstner surface moves points sideways, so the rest position is found by
  // inverting that displacement (6 fixed-point steps, error < 1 cm for this steepness).
  const rest = { x: 0, z: 0 };
  const displace = (x0, z0, t, out) => {
    const r = Math.hypot(x0, z0); let y = 0, ox = 0, oz = 0;
    for (const v of waves) {
      const att = 1 - sstep(v.R, v.R * 2, r), th = v.k * (v.dx * x0 + v.dz * z0) - v.w * t + v.ph, A = v.A * att;
      y += A * Math.sin(th); const c = v.Q * A * Math.cos(th); ox += c * v.dx; oz += c * v.dz;
    }
    out.x = ox; out.z = oz; return y;
  };
  const heightAt = (x, z, t) => {
    let x0 = x, z0 = z;
    for (let i = 0; i < 6; i++) { displace(x0, z0, t, rest); x0 = x - rest.x; z0 = z - rest.z; }
    return displace(x0, z0, t, rest);
  };
  const T_CAP = TL.EVENTS?.splash ?? 176.46, setT = t => { uniforms.uTime.value = t; uniforms.uCapK.value = sstep(T_CAP, T_CAP + .7, t); };
  const update = setT;
  ocean.userData.tick = (t, ctx) => {
    setT(t);
    const ql = ctx?.quality; uniforms.uQ.value = ql === 'low' ? 0 : 1; uniforms.uOct.value = ql === 'low' ? 1 : ql === 'high' ? 3 : 2;
  };
  return { object: ocean, update, heightAt };
}
