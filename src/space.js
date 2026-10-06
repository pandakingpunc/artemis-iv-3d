// Space backdrop: photoreal Earth (day/night, clouds, atmosphere), Moon (lunar photometry + procedural craters), stars, Milky Way and Sun.
// Public API (unchanged): earth(parent, r) -> group, moon(parent, r) -> mesh, createStars(scene) -> group.
// All lighting comes from ctx.sunDir via userData.tick(t, ctx); every animation is a pure function of film time t.
import * as THREE from 'three';
import { TAU, makeRng, group, planet, loader, loadTex } from './util.js';

// deterministic 64³ random lattice shared by every noise lookup
const ZERO = { value: 0 };
const NZ = (() => {
  const n = 64, rnd = makeRng(20261003), d = new Uint8Array(n * n * n * 4);
  for (let i = 0; i < d.length; i++) d[i] = rnd() * 256;
  const t = new THREE.Data3DTexture(d, n, n, n);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.generateMipmaps = false; t.needsUpdate = true;
  return { value: t };
})();

// Shader warm-up: every material is drawn once as a degenerate triangle during the first frames, so the (slow) GPU shader
// compilation happens at start-up behind the loading screen instead of as a hitch when a stage first shows the planet.
const warm = { group: null, pending: [], keys: new Set() };
const warmGeo = new THREE.BufferGeometry();
warmGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
warmGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
warmGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
function addWarm(mat) {
  const key = mat.vertexShader.length + ':' + mat.fragmentShader.length + JSON.stringify(mat.defines || {}) + mat.blending + mat.side;
  if (warm.keys.has(key)) return; warm.keys.add(key);
  if (!warm.group) { warm.pending.push(mat); return; }
  const m = new THREE.Mesh(warmGeo, mat); m.frustumCulled = false; m.renderOrder = -100; let n = 0;
  m.onBeforeRender = () => { if (++n > 3) m.visible = false; };
  warm.group.add(m);
}

// ───────────────────────────── shared GLSL ─────────────────────────────
const GLSL_NOISE = /* glsl */`
uniform sampler3D nz;                                   // 64³ random RGBA8 lattice (tiling)
uniform int uZ;                                         // always 0: keeps loops dynamic so the shader compiler does not unroll them
vec4 hash4(vec3 cell){ return texelFetch(nz, ivec3(floor(cell)) & 63, 0); }
vec3 hash3(vec3 cell){ return hash4(cell).rgb; }
// smooth value noise: one trilinear fetch with the interpolant pre-warped (cubic)
float vnoise(vec3 x){ vec3 i = floor(x), f = x - i; f = f*f*(3. - 2.*f); return texture(nz, (i + f + .5) * (1./64.)).r; }
vec3 vnoise3(vec3 x){ vec3 i = floor(x), f = x - i; f = f*f*(3. - 2.*f); return texture(nz, (i + f + .5) * (1./64.)).rgb; }
const mat3 ROT = mat3(0.00,0.80,0.60, -0.80,0.36,-0.48, -0.60,-0.48,0.64);
float fbm(vec3 p, int n){
  float s = 0., a = .5;
  for (int i = 0; i < n + uZ; i++){ s += a * vnoise(p); p = ROT * p * 2.03 + vec3(17.1, 9.2, 5.7); a *= .5; }
  return s;
}
// fbm whose octaves fade out once they get finer than a pixel (px = footprint of p per pixel at base frequency)
float fbmA(vec3 p, int n, float px){
  float s = 0., a = .5, fr = 1.;
  for (int i = 0; i < n + uZ; i++){
    float fade = 1. - smoothstep(.35, .9, px * fr);
    if (fade <= 0.) break;
    s += a * fade * (vnoise(p) - .5);
    p = ROT * p * 2.03 + vec3(17.1, 9.2, 5.7); fr *= 2.03; a *= .5;
  }
  return s + .5;
}
`;

// Sunlight colour after travelling through the atmosphere: white at noon, orange-red near the terminator
const GLSL_SUNT = /* glsl */`
vec3 sunTrans(float mu){ float m = 1. / (max(mu, 0.) + .025); return exp(-vec3(.03, .06, .15) * m); }
`;

const GLSL_CLOUD = /* glsl */`
uniform mat3 cloudRot;
vec3 swirl(vec3 p, vec3 c, float amt, float sig){
  float d = acos(clamp(dot(p, c), -1., 1.));
  float k = amt * exp(-d * d / (sig * sig));
  float s = sin(k), co = cos(k);
  return p * co + cross(c, p) * s + c * dot(c, p) * (1. - co);
}
// raw cloud coverage value (~0..1.3) for a unit direction in cloud space; oct = detail octaves, px = per-pixel footprint
float cloudRaw(vec3 p, int oct, float px){
  vec3 q = swirl(p, vec3(.55,.30,.78), 2.2, .34);
  q = swirl(q, vec3(-.80,-.35,.49), -2.4, .36);
  q = swirl(q, vec3(.10,.62,-.78), 2.0, .30);
  q = swirl(q, vec3(-.40,.50,-.77), -1.8, .28);
  vec3 w = vnoise3(q*2.6+1.7) - .5;
  q += w * .40;
  float lat = abs(q.y);
  float zone = .20*exp(-pow(lat/.14, 2.)) + .16*exp(-pow((lat-.62)/.17, 2.)) - .17*exp(-pow((lat-.30)/.09, 2.)) + .02*exp(-pow((lat-.93)/.12, 2.));
  float base = fbmA(q * vec3(2.4, 3.8, 2.4), 4, px * 3.8);
  vec3 pf = (p + w * .22) * vec3(11., 15., 11.) + 3.1;
  float fine = fbmA(pf, oct, px * 15.);
  return base + zone + (fine - .5) * .85;
}
float cloudField(vec3 p, int oct, float px){ return smoothstep(.52, .67, cloudRaw(p, oct, px)); }
`;

// ───────────────────────────── Earth ─────────────────────────────
const earthMap = loadTex('earth.jpg'), earthNormal = loader.load('assets/earth-normal.jpg'), earthSpec = loader.load('assets/earth-specular.jpg');
for (const t of [earthMap, earthNormal, earthSpec]) { t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; }

const EARTH_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vObj, vWP, vT, vB, vN, vC;
void main(){
  vUv = uv; vObj = position;
  vec3 n = normalize(position);
  vec3 t = normalize(vec3(n.z, 0., -n.x) + vec3(1e-5, 0., 0.));
  mat3 M = mat3(modelMatrix);
  vN = M * n; vT = M * t; vB = M * cross(n, t);
  vec4 wp = modelMatrix * vec4(position, 1.); vWP = wp.xyz; vC = modelMatrix[3].xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const EARTH_FRAG = /* glsl */`
uniform sampler2D dayMap, nrmMap, spcMap;
uniform vec3 sunDir, sunObj;
uniform float sunE;
varying vec2 vUv; varying vec3 vObj, vWP, vT, vB, vN, vC;
${GLSL_NOISE}${GLSL_SUNT}${GLSL_CLOUD}

float D_GGX(float nh, float a){ float a2 = a*a, d = nh*nh*(a2-1.)+1.; return a2 / (3.14159265*d*d); }
// anisotropic GGX: hx/hy = half-vector components along the two tangents, ax/ay roughness
float D_GGXa(float hx, float hy, float nh, float ax, float ay){ float d = hx*hx/(ax*ax) + hy*hy/(ay*ay) + nh*nh; return 1. / (3.14159265 * ax * ay * d * d); }

uvec3 pcg3d(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hashP(vec3 p){ return vec3(pcg3d(uvec3(ivec3(floor(p + 8192.))))) * (1.0 / 4294967295.0); }
vec3 dotLights(vec3 d, float F, float fw, float dens, float prob){
  vec3 p = d * F, id = floor(p), f = p - id;
  vec3 h = hashP(id + vec3(3.,7.,1.)), h2 = hashP(id + vec3(19.,5.,31.));
  float dd = length(f - (.2 + .6 * h));
  float ex = step(h2.x, dens * prob);
  float rad0 = mix(.10, .27, h2.y), px = F * fw;
  float rad = max(rad0, .62 * px);                       // never smaller than ~1 pixel: smooth round dots instead of aliased squares
  float s = (exp(-dd*dd / (rad*rad)) + .18 * exp(-dd*dd / (rad*rad*7.))) * ex * (.18 + 1.6 * h2.z * h2.z * h2.z) * (rad0*rad0) / (rad*rad);
  vec3 c = mix(vec3(1., .66, .32), vec3(1., .88, .66), h.x);
  float aa = smoothstep(.45, 1.1, px);
  return mix(s * c, vec3(0.), aa);                       // when unresolved the aggregate glow below takes over
}

// night-side lights: clustered city cores (not continent-wide fill), warm white, dimmer with distance
vec3 cityLights(vec3 d, float fw, float landM, vec3 alb, float coast){
  float lat = d.y;
  float r1 = fbm(d * 8. + vec3(11., 3., 5.), 4);
  float r2 = fbm(d * 30. + vec3(2., 9., 1.), 3);
  float r3 = fbm(d * 95. + vec3(7., 1., 3.), 2);
  float dens = smoothstep(.40, .62, r1) * (.30 + 1.1 * smoothstep(.32, .72, r2));
  dens *= 1. - smoothstep(.80, .94, abs(lat));
  dens *= mix(.30, 1., smoothstep(-.45, .45, lat));
  dens *= mix(.35, 1., coast);
  float desert = smoothstep(.18, .32, alb.r) * smoothstep(1.35, 1.9, alb.r / (alb.b + .001));
  float ice = smoothstep(.40, .60, min(alb.r, alb.b));
  dens *= (1. - .85 * desert) * (1. - ice) * landM;
  float core = smoothstep(.35, .95, dens) * (.55 + .9 * smoothstep(.3, .75, r3));
  float res = 1. - smoothstep(.0016, .006, fw);          // 1 close up, fades as the planet gets small on screen
  vec3 col = core * core * (.035 + .09 * res) * vec3(1., .80, .52);
  col += dens * dens * .010 * vec3(1., .74, .42);       // faint regional glow
  #if LOD < 2
    col += dotLights(d, 230., fw, dens, .7) * 2.4;
  #endif
  #if LOD < 1
    col += dotLights(d, 820., fw, dens, 1.0) * 1.9;
  #endif
  return col * mix(.22, 1., smoothstep(.0, .7, res));
}

void main(){
  vec3 Ng = normalize(vN), T = normalize(vT), B = normalize(vB);
  vec3 V = normalize(cameraPosition - vWP), L = sunDir;
  vec3 dir = normalize(vObj);
  float fw = length(fwidth(dir));

  vec3 alb = texture2D(dayMap, vUv).rgb;
  float oc = smoothstep(.35, .75, texture2D(spcMap, vUv, 1.0).r);
  float landM = 1. - oc;
  float lum = dot(alb, vec3(.2126, .7152, .0722));
  float ice = smoothstep(.45, .65, min(alb.r, min(alb.g, alb.b)));
  vec3 land = mix(vec3(lum), alb, 1.40) * vec3(1.34, 1.31, 1.23);
  land = mix(land, land * vec3(.78, .88, 1.0) * .17 * (.70 + .75 * fbmA(dir * 38. + 2., 3, fw * 38.)), ice);         // snow/ice: cooler and darker so it keeps structure instead of clipping
  vec3 sea = min(alb * vec3(1.1, 1.35, 1.6), vec3(.30, .44, .62)) + vec3(.001, .005, .016);   // water is never brighter than turquoise shallows (stops snowy-coast pixels leaking white)
  sea = mix(sea, alb * vec3(.40, .50, .62) * (.65 + .8 * fbmA(dir * 52. + 7., 3, fw * 52.)), ice);   // sea ice / snow-covered coast
  #if LOD < 1
    float dt = (vnoise(dir*420.) - .5) * (1. - smoothstep(.35, .9, fw*420.))
             + (vnoise(dir*1100. + 3.) - .5) * .7 * (1. - smoothstep(.35, .9, fw*1100.))
             + (vnoise(dir*2900. + 9.) - .5) * .5 * (1. - smoothstep(.35, .9, fw*2900.));
    land *= 1. + dt * .65 * (1. - .6 * ice);
    land.g *= 1. + dt * .12;
  #endif

  vec3 tn = texture2D(nrmMap, vUv).xyz * 2. - 1.;
  tn = normalize(vec3(tn.xy * 1.35 * landM * (1. - .45 * ice), max(tn.z, .2)));
  vec3 Np = normalize(T * tn.x + B * tn.y + Ng * tn.z);

  float mu = dot(Ng, L), mup = dot(Np, L);

  // cheap cloud shadow: sample the cloud layer displaced toward the sun
  float shadow = 1.;
  #if LOD < 2
    vec3 cs = normalize(dir + sunObj * (.010 / max(mu, .2)));
    float cd = cloudField(cloudRot * cs, 5, fw);
    shadow = 1. - .62 * cd;
  #endif

  vec3 sT = sunTrans(mu);
  float dm = max(mup, 0.) * smoothstep(-.02, .06, mu);
  float tw = smoothstep(-.14, .05, mu);
  vec3 skyC = mix(vec3(.09, .06, .15), vec3(.13, .22, .45), smoothstep(-.05, .35, mu)) * tw * .45;
  vec3 direct = sT * dm * sunE * shadow;

  // ocean: rippled normal + GGX sun glint + fresnel sky reflection
  vec3 rip = vnoise3(dir*900. + 1.) - .5;
  float rf = 1. - smoothstep(.2, .6, fw * 900.);
  rip *= rf * .42;
  vec3 No = normalize(Ng + (rip - Ng * dot(rip, Ng)));
  vec3 H = normalize(L + V);
  float nh = max(dot(No, H), 0.), nv = max(dot(No, V), .001);
  float Fh = .02 + .98 * pow(1. - max(dot(H, V), 0.), 5.);
  float Fv = .02 + .98 * pow(1. - max(dot(Ng, V), 0.), 5.);
  // sun glint: stretched along the plane of incidence (wind-roughened sea), broken up by swell patches instead of a round milky lamp
  vec3 Xa = cross(Ng, cross(L, V)); Xa = dot(Xa, Xa) > 1e-6 ? normalize(Xa) : T;
  Xa = normalize(Xa - No * dot(Xa, No)); vec3 Ya = cross(No, Xa);
  float aG = mix(.075, .035, rf);
  float swell = .40 + 1.25 * fbmA(dir * 46. + 5., 3, fw * 46.);
  float glint = D_GGXa(dot(H, Xa), dot(H, Ya), nh, aG * 2.3, aG * .85) * Fh / (4. * max(nv, .15)) * smoothstep(-.02, .08, mu) * clamp(swell, .3, 1.6);
  glint += .006 * D_GGX(nh, .35) * Fh;
  vec3 skyRef = vec3(.34, .54, 1.) * (.12 + .88 * smoothstep(-.12, .5, mu)) * Fv * .9;
  vec3 seaCol = sea * (direct * (1. - Fv) + skyC * .7) + skyRef * tw + glint * 6.4 * sT * sunE * shadow * (1. - ice);
  vec3 landCol = land * (direct + skyC);

  vec3 col = mix(landCol, seaCol, oc);

  // night side: city lights fade out through the terminator
  float night = 1. - smoothstep(-.10, .10, mu);
  #if LOD < 2
    float coast = smoothstep(.02, .5, texture2D(spcMap, vUv, 5.5).r);
  #else
    float coast = .6;
  #endif
  col += cityLights(dir, fw, smoothstep(.6, .3, oc), alb, coast) * night * landM;
  col += (alb + .05) * vec3(.0075, .0125, .028) * (1. + 1.4 * night);   // faint starlight/airglow ambient: the whole disc reads against space

  gl_FragColor = vec4(col, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const CLOUD_FRAG = /* glsl */`
uniform vec3 sunDir, sunObj;
uniform float sunE;
varying vec2 vUv; varying vec3 vObj, vWP, vT, vB, vN, vC;
${GLSL_NOISE}${GLSL_SUNT}${GLSL_CLOUD}
float thick(float f){ return clamp((f - .46) * 2.0, 0., 1.6); }
void main(){
  vec3 Ng = normalize(vN), dir = normalize(vObj);
  float fw = length(fwidth(dir));
  vec3 cp = cloudRot * dir;
  float f0 = cloudRaw(cp, OCT, fw);
  #if LOD > 1
  float d = smoothstep(.60, .78, f0) * .85;        // tiny Earth: sparser, thinner cloud
  #else
  float d = smoothstep(.52, .67, f0);
  #endif
  if (d < .004) discard;
  float mu = dot(Ng, sunDir);
  vec3 st = sunObj - dir * dot(sunObj, dir);
  float sl = length(st); st = sl > 1e-4 ? cloudRot * (st / sl) : vec3(0.);
  float off = .014 / clamp(mu + .1, .25, 1.1);
  float t1 = thick(cloudRaw(normalize(cp + st * off), 5, fw));
  float t2 = thick(cloudRaw(normalize(cp + st * off * 2.8), 4, fw));
  float lightK = exp(-(t1 * .65 + t2 * .35) * 1.5);
  vec3 sT = sunTrans(mu);
  float dif = pow(clamp((mu + .08) / 1.08, 0., 1.), .9);
  vec3 sky = mix(vec3(.10, .07, .16), vec3(.18, .28, .55), smoothstep(-.05, .35, mu)) * .5 * smoothstep(-.2, .2, mu);
  float self = thick(f0);
  vec3 col = sT * sunE * .80 * dif * mix(.18, 1., lightK) * mix(1., .66, clamp(self - .55, 0., 1.)) * (1. + .55 * (vnoise(cp * 75.) - .5) * (1. - smoothstep(.35, .9, fw * 75.)) + .35 * (vnoise(cp * 31. + 4.) - .5)) + sky * mix(.7, 1., lightK) + vec3(.003, .005, .011);
  gl_FragColor = vec4(col, d * .98);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ATMO_VERT = /* glsl */`
varying vec3 vWP, vC;
void main(){ vec4 wp = modelMatrix * vec4(position, 1.); vWP = wp.xyz; vC = modelMatrix[3].xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;

// Analytic single-scattering march (Rayleigh + Mie) in planet-radius units; ray stops at the planet surface.
const ATMO_FRAG = /* glsl */`
uniform vec3 sunDir, betaR;
uniform float rad, Ra, H, sunE, betaM, gMie, ext, glow;
uniform int nV, nL;
varying vec3 vWP, vC;
vec2 rs(vec3 ro, vec3 rd, float R){ float b = dot(ro, rd), c = dot(ro, ro) - R*R, h = b*b - c; if (h < 0.) return vec2(-1.); h = sqrt(h); return vec2(-b - h, -b + h); }
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715)))); }
void main(){
  vec3 ro = (cameraPosition - vC) / rad, rd = normalize(vWP - cameraPosition), L = sunDir;
  vec2 ta = rs(ro, rd, Ra);
  if (ta.y <= 0.) discard;
  vec2 tp = rs(ro, rd, 1.);
  float t0 = max(ta.x, 0.), t1 = ta.y;
  if (tp.x > 0.) t1 = min(t1, tp.x);
  float dt = (t1 - t0) / float(nV), odV = 0., j = .5 + (ign(gl_FragCoord.xy) - .5) * .3;
  vec3 sum = vec3(0.); float air = 0.;
  for (int i = 0; i < nV; i++){
    vec3 P = ro + rd * (t0 + (float(i) + j) * dt);
    float dens = exp(-max(length(P) - 1., 0.) / H);
    odV += dens * dt;
    float b = dot(P, L), perp = sqrt(max(dot(P, P) - b*b, 0.));
    float vis = b > 0. ? 1. : smoothstep(.990, 1.014, perp);
    float lp = length(P);
    air += exp(-pow((lp - 1.017) / .0085, 2.)) * (1. - smoothstep(-.20, .12, b / lp)) * dt;   // night airglow shell (~100 km)
    if (vis > .001){
      float dl = rs(P, L, Ra).y / float(nL), odL = 0.;
      for (int k = 0; k < nL; k++){ vec3 Q = P + L * ((float(k) + .5) * dl); odL += exp(-max(length(Q) - 1., 0.) / H) * dl; }
      sum += exp(-(betaR + betaM * 1.1) * (odV * ext + odL)) * (vis * dens * dt);
    }
  }
  float c = dot(rd, L);
  float phR = .0596 * (1. + c*c);
  float phM = (1. - gMie*gMie) / (12.566 * pow(1. + gMie*gMie - 2.*gMie*c, 1.5));
  vec3 col = sunE * sum * (betaR * phR + betaM * phM) + glow * air * vec3(.034, .17, .12);
  vec3 tr = exp(-(betaR + betaM * 1.1) * odV * ext);
  gl_FragColor = vec4(col, clamp(1. - dot(tr, vec3(.30, .45, .25)), 0., 1.));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Shared unit-sphere geometries per level of detail; planets are scaled meshes.
const SEG = [[128, 80], [72, 44], [40, 24]], earthGeo = [];
const earthGeometry = lod => earthGeo[lod] ??= new THREE.SphereGeometry(1, SEG[lod][0], SEG[lod][1]);
const ATMO_RA = 1.065, CLOUD_H = 1.008;
const STEPS = { low: [5, 2], medium: [8, 3], high: [12, 4] };

// Earth of radius r centred on the returned group's origin. The caller positions/rotates the group.
// userData: tick(t, ctx) (sun direction, cloud drift, quality), surface / clouds / atmosphere meshes.
export function earth(parent, r = 100) {
  const g = group(parent), lod = r >= 60 ? 0 : r >= 14 ? 1 : 2, geo = earthGeometry(lod);
  const U = {
    sunDir: { value: new THREE.Vector3(-.577, .577, .577) }, sunObj: { value: new THREE.Vector3(-.577, .577, .577) },
    cloudRot: { value: new THREE.Matrix3() }, sunE: { value: 1.3 }
  };
  const surfM = new THREE.ShaderMaterial({
    uniforms: { ...U, nz: NZ, uZ: ZERO, dayMap: { value: earthMap }, nrmMap: { value: earthNormal }, spcMap: { value: earthSpec } },
    defines: { LOD: lod }, vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG
  });
  const cloudM = new THREE.ShaderMaterial({
    uniforms: { ...U, nz: NZ }, defines: { LOD: lod, OCT: [8, 6, 4][lod] }, vertexShader: EARTH_VERT, fragmentShader: CLOUD_FRAG,
    transparent: true, depthWrite: false
  });
  const atmoU = { rad: { value: r }, Ra: { value: lod === 2 ? 1.10 : ATMO_RA }, H: { value: lod === 2 ? .024 : .014 }, betaR: { value: new THREE.Vector3(5, 12, 28) }, betaM: { value: 3 }, gMie: { value: .78 }, ext: { value: .5 }, sunE: { value: lod === 2 ? 3.4 : 2.2 }, glow: { value: lod === 2 ? .4 : 1.0 }, nV: { value: 8 }, nL: { value: 3 } };
  const atmoM = new THREE.ShaderMaterial({
    uniforms: { sunDir: U.sunDir, ...atmoU }, vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor
  });
  addWarm(surfM); addWarm(cloudM); addWarm(atmoM);
  const mk = (m, s, order) => { const o = new THREE.Mesh(geo, m); o.scale.setScalar(r * s); o.renderOrder = order; g.add(o); return o; };
  const surf = mk(surfM, 1, 0), clouds = mk(cloudM, CLOUD_H, 1);
  g.userData.surface = surf; g.userData.clouds = clouds; g.userData.atmosphere = mk(atmoM, atmoU.Ra.value, 2);
  const q = new THREE.Quaternion();
  g.userData.tick = (t, ctx) => {
    // low-Earth-orbit stage: the planet below visibly streams past (surface + clouds spin together about the local axis; pure in t)
    const spin = lod === 0 && ctx.idx === 1 ? (ctx.u || 0) * .26 : 0;
    surf.rotation.y = clouds.rotation.y = spin;
    surf.getWorldQuaternion(q);                   // world → object space for noise-space vectors
    U.sunDir.value.copy(ctx.sunDir); U.sunObj.value.copy(ctx.sunDir).applyQuaternion(q.invert());
    const a = t * .0028, c = Math.cos(a), s = Math.sin(a);
    U.cloudRot.value.set(c, 0, s, 0, 1, 0, -s, 0, c);
    const st = STEPS[ctx.quality] || STEPS.medium; atmoU.nV.value = lod === 2 ? Math.min(st[0], 5) : st[0]; atmoU.nL.value = lod === 2 ? 2 : st[1];
  };
  return planet(g);
}

// ───────────────────────────── Moon ─────────────────────────────
const MOON_N = 2048;
const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); flatNormal.needsUpdate = true;
const moonUsers = new Set();   // material uniform wrappers waiting for the derived normal map
let moonNormalTex = null;
const moonMap = loader.load('assets/moon.jpg', tex => {
  // Sobel on an upscaled, lightly blurred copy of the albedo → tangent-space normal map
  const W = MOON_N, Hh = MOON_N / 2, cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.imageSmoothingQuality = 'high'; cx.drawImage(tex.image, 0, 0, W, Hh);
  const src = cx.getImageData(0, 0, W, Hh).data, a = new Float32Array(W * Hh), b = new Float32Array(W * Hh);
  for (let i = 0; i < W * Hh; i++) a[i] = src[i * 4] / 255;
  for (let pass = 0; pass < 3; pass++) {            // 3×3 box blur ×3 (wraps in x)
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      let s = 0; for (let dy = -1; dy <= 1; dy++) { const yy = Math.min(Hh - 1, Math.max(0, y + dy)) * W; for (let dx = -1; dx <= 1; dx++) s += a[yy + ((x + dx + W) % W)]; }
      b[y * W + x] = s / 9;
    }
    a.set(b);
  }
  const out = cx.createImageData(W, Hh), d = out.data, K = 1.5;
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const ym = Math.max(0, y - 1) * W, yp = Math.min(Hh - 1, y + 1) * W, xm = (x - 1 + W) % W, xp = (x + 1) % W, row = y * W;
    const gx = (a[row + xp] - a[row + xm]) * .5 + (a[ym + xp] - a[ym + xm] + a[yp + xp] - a[yp + xm]) * .25;
    const gy = -((a[yp + x] - a[ym + x]) * .5 + (a[yp + xp] - a[ym + xp] + a[yp + xm] - a[ym + xm]) * .25);
    let nx = -gx * K * 8, ny = -gy * K * 8, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = (row + x) * 4; d[o] = (nx * .5 + .5) * 255; d[o + 1] = (ny * .5 + .5) * 255; d[o + 2] = (nz * .5 + .5) * 255; d[o + 3] = 255;
  }
  cx.putImageData(out, 0, 0);
  moonNormalTex = new THREE.CanvasTexture(cv); moonNormalTex.anisotropy = 8; moonNormalTex.wrapS = THREE.RepeatWrapping;
  for (const u of moonUsers) u.value = moonNormalTex;
});
moonMap.colorSpace = THREE.SRGBColorSpace; moonMap.wrapS = THREE.RepeatWrapping; moonMap.anisotropy = 8;

const MOON_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vP, vCam;
void main(){
  vUv = uv; vP = position;
  vCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`;

const MOON_FRAG = /* glsl */`
uniform sampler2D map, nmap;
uniform vec3 sunObj;
uniform float sunE;
varying vec2 vUv; varying vec3 vP, vCam;
${GLSL_NOISE}

// Procedural impact craters on a 3D hash grid: accumulates a surface-gradient (normal tilt) and an albedo modifier.
void craters(vec3 d, vec3 n, float F, float fw, float prob, float depth, inout vec3 grad, inout float am){
  float fade = 1. - smoothstep(.035, .11, F * fw);
  if (fade <= 0.) return;
  vec3 p = d * F, ip = floor(p), fp = p - ip, side = step(.5, fp) * 2. - 1.;
  for (int i = 0; i < 8 + uZ; i++){
    vec3 cell = ip + vec3(float(i & 1), float((i >> 1) & 1), float(i >> 2)) * side;
    vec3 h = hash3(cell + 5.), h2 = hash3(cell + 41.);
    if (h2.z > prob) continue;
    vec3 off = p - (cell + .2 + .6 * h);
    off -= n * dot(off, n);
    float rc = mix(.13, .34, h2.x * h2.x), x = length(off) / rc;
    if (x > 2.) continue;
    vec3 dir = off / (length(off) + 1e-5);
    float age = h2.y;                                     // 0 = fresh/sharp, 1 = degraded
    float sh = mix(1., .45, age) * depth * fade;
    float slope = x < 1. ? 4. * x * (1. - x * x) * .115 : 0.;   // smooth bowl, slope eases to zero at the rim (no hard ring)
    slope += -2. * (x - 1.04) / .0196 * .020 * exp(-pow((x - 1.04) / .14, 2.));  // soft raised rim
    grad += dir * slope * sh;
    float fl = x < 1. ? (1. - x * x) : 0.;
    am += fade * (-.05 * fl * (1. - .5 * age) + .14 * (1. - age) * exp(-pow((x - 1.3) / .5, 2.)));
  }
}

void main(){
  vec3 n = normalize(vP), V = normalize(vCam - vP), L = normalize(sunObj);
  float fw = length(fwidth(n));
  vec3 T = normalize(vec3(n.z, 0., -n.x) + vec3(1e-5, 0., 0.)), B = cross(n, T);

  float pole = smoothstep(.78, .95, abs(n.y));            // hide the equirect pinch
  float a = dot(texture2D(map, vUv).rgb, vec3(.3333));
  float mag = 1. - smoothstep(.0015, .006, fw);               // texture magnified: blend toward a blurred copy, add procedural regolith detail
  a = mix(a, dot(textureLod(map, vUv, 1.7).rgb, vec3(.3333)), mag * .7);
  float rough = fbm(n * 38., 3);
  a = mix(a, .15 * (.55 + 1.2 * rough), pole);
  a = clamp(.19 * pow(a / .20, 1.45), .02, .42);        // true lunar albedo (~.12): darker than white spacecraft paint, stronger maria contrast
  a *= 1. + .55 * ((vnoise(n * 650.) - .5) * (1. - smoothstep(.35, .9, fw * 650.)) + (vnoise(n * 1900. + 4.) - .5) * (1. - smoothstep(.35, .9, fw * 1900.)));
  a *= .86 + .28 * fbmA(n * 5. + 3., 3, fw * 5.);
  a *= .78 + .44 * fbmA(n * 85. + 1., 4, fw * 85.);

  vec3 tn = texture2D(nmap, vUv).xyz * 2. - 1.;
  tn.xy *= .62 * (1. - pole) * mix(.40, 1., mag);               // far away the albedo-derived normals turn into hammered-metal pitting
  vec3 Np = normalize(T * tn.x + B * tn.y + n * max(tn.z, .3));

  vec3 grad = vec3(0.); float am = 0.;
  float dens = mix(.9, .45, smoothstep(.10, .26, a));       // highlands are more cratered than maria
  craters(n, n, 5., fw, dens * .30, 1., grad, am);
  craters(n, n, 12., fw, dens * .38, .95, grad, am);
  craters(n, n, 28., fw, dens * .42, .9, grad, am);
  craters(n, n, 66., fw, dens * .34, .75, grad, am);
  craters(n, n, 150., fw, dens * .30, .65, grad, am);
  float gl = length(grad); if (gl > .42) grad *= .42 / gl;
  Np = normalize(Np - grad * (1. - .6 * pole));
  a *= 1. + am;

  float mu0g = dot(n, L), mu0 = max(dot(Np, L), 0.), mv = max(dot(n, V), .03);
  float ls = 2. * mu0 / (mu0 + mv + 1e-3);                  // Lommel–Seeliger: flat disc at full phase
  float refl = pow(mix(mu0, ls, .50), 1.22) * smoothstep(-.02, .035, mu0g);   // crisper terminator, long grazing shadows
  refl *= 1. + .32 * smoothstep(.96, 1., dot(L, V));        // opposition surge
  vec3 tint = vec3(1., .975, .935);
  vec3 col = a * tint * (sunE * refl + vec3(.5, .55, .6) * .005);   // neutral earthshine (no blue haze: there is no atmosphere)
  gl_FragColor = vec4(col, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Moon of radius r; returns a mesh the caller positions/rotates.
export function moon(parent, r = 100) {
  const seg = r >= 100 ? [96, 60] : r >= 30 ? [64, 40] : [40, 24];
  const nmap = { value: moonNormalTex || flatNormal };
  if (!moonNormalTex) moonUsers.add(nmap);
  const sunObj = new THREE.Vector3(-.577, .577, .577), u = { nz: NZ, uZ: ZERO, map: { value: moonMap }, nmap, sunObj: { value: sunObj }, sunE: { value: .66 } };
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg[0], seg[1]), new THREE.ShaderMaterial({ uniforms: u, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG }));
  parent?.add(m); addWarm(m.material);
  const q = new THREE.Quaternion();
  m.userData.tick = (t, ctx) => { m.getWorldQuaternion(q); sunObj.copy(ctx.sunDir).applyQuaternion(q.invert()); };
  return planet(m);
}

// ───────────────────────────── Stars, Milky Way, Sun ─────────────────────────────
const GN = new THREE.Vector3(.55, .80, .08).normalize();                 // galactic north (band plane normal)
const GC = new THREE.Vector3(-.62, .22, -.75).normalize().sub(GN.clone().multiplyScalar(GN.dot(new THREE.Vector3(-.62, .22, -.75).normalize()))).normalize(); // core direction in plane

// rough blackbody colour (linear sRGB, max-normalised) for T in kelvin
function blackbody(T) {
  const t = T / 100, c = [0, 0, 0];
  c[0] = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -.1332);
  c[1] = t <= 66 ? 99.47 * Math.log(t) - 161.1 : 288.1 * Math.pow(t - 60, -.0755);
  c[2] = t >= 66 ? 255 : t <= 19 ? 0 : 138.5 * Math.log(t - 10) - 305.0;
  const lin = c.map(v => Math.pow(Math.min(255, Math.max(0, v)) / 255, 2.2));
  const m = Math.max(...lin); return lin.map(v => v / m);
}

const STAR_VERT = /* glsl */`
attribute vec4 aStar; attribute float aSize;
uniform float uRes; varying vec4 vS;
void main(){
  vS = aStar;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.);
  gl_PointSize = max(aSize * uRes, 1.5);
}`;
const STAR_FRAG = /* glsl */`
varying vec4 vS;
void main(){
  vec2 p = (gl_PointCoord - .5) * 2.;
  float r2 = dot(p, p);
  float core = exp(-r2 * 5.5), halo = .10 * exp(-sqrt(r2) * 4.5);
  float I = (core + halo) * vS.a * (1. - smoothstep(.75, 1., sqrt(r2)));
  gl_FragColor = vec4(vS.rgb * I, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const FLARE_FRAG = /* glsl */`
varying vec4 vS;
void main(){
  vec2 p = (gl_PointCoord - .5) * 2.;
  float r = length(p);
  vec2 q = vec2(p.x + p.y, p.x - p.y) * .7071;
  float sp = exp(-abs(p.x) * 34.) * exp(-abs(p.y) * 2.6) + exp(-abs(p.y) * 34.) * exp(-abs(p.x) * 2.6)
           + .35 * (exp(-abs(q.x) * 40.) * exp(-abs(q.y) * 3.2) + exp(-abs(q.y) * 40.) * exp(-abs(q.x) * 3.2));
  float I = (exp(-r*r*26.) * .55 + exp(-r * 7.) * .10 + sp * .55) * (1. - smoothstep(.55, 1., r)) * vS.a;
  gl_FragColor = vec4(vS.rgb * I, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const MW_VERT = /* glsl */`
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.); }`;
const MW_FRAG = /* glsl */`
uniform vec3 gN, gC; uniform int oct; uniform float gain;
varying vec3 vDir;
${GLSL_NOISE}
void main(){
  vec3 d = normalize(vDir);
  float b = dot(d, gN);
  vec3 pl = normalize(d - gN * b);
  float l = acos(clamp(dot(pl, gC), -1., 1.));
  // wavy band centre-line + width that swells toward the core
  float wob = (vnoise(d * 2.3 + 3.) - .5) * .10 + (vnoise(d * 5.1) - .5) * .035;
  float bb = b + wob;
  float swell = mix(.78, 1.35, exp(-l*l / 1.6));
  float band = exp(-bb*bb / (2. * .13*.13*swell*swell));
  float core = exp(-l*l / (2. * .70*.70)) * exp(-bb*bb / (2. * .24*.24));
  float haze = exp(-bb*bb / (2. * .38*.38)) * .022;
  float w = band * mix(.34, 1., exp(-l*l / 2.4)) + core * 1.25 + haze;
  if (w < .004) discard;
  float cl  = fbm(d * 3.4 + vec3(4., 1., 7.), oct);                      // large-scale star-cloud structure
  float cl2 = fbm(d * 11. + vec3(9., 2., 1.), oct > 3 ? 4 : 3);           // finer clumps
  // dust lanes: ridged noise → thin dark filaments, concentrated on the band centre
  vec3 q = pl * 3.2 + gN * (bb * 15.) + (vnoise3(d * 3.1) - .5) * .9;     // stretched along the band: lanes run with the galaxy, not in blobs
  float rg = 1. - abs(2. * fbm(q, oct) - 1.);
  float rg2 = 1. - abs(2. * fbm(q * vec3(2.6, 2.6, 2.6) + 3., 3) - 1.);
  float lane = (smoothstep(.74, .95, rg) * .8 + smoothstep(.80, .97, rg2) * .5) * exp(-pow((bb - .012) / .075, 2.));
  float light = w * (.20 + 1.6 * cl * cl) * (.55 + .95 * cl2);
  light *= 1. - .85 * clamp(lane, 0., 1.);
  float coreness = clamp(core * 1.5 + band * exp(-l*l / .9) * .4, 0., 1.);
  vec3 arm = vec3(.55, .70, 1.00), cr = vec3(1.0, .80, .54);
  float warmP = smoothstep(.35, .75, cl2) * .35;                              // patchy warm/blue colour variation across the arms
  vec3 col = mix(mix(arm, cr, warmP), cr, coreness * coreness * .8) * light * .058 * gain;
  col *= 1. + .3 * vec3(.2, .1, -.1) * (cl2 - .5);                         // subtle colour variation between clouds
  gl_FragColor = vec4(col, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SUN_VERT = /* glsl */`
uniform vec3 uDir; uniform float uS; varying vec2 vUv;
void main(){ vUv = position.xy; vec3 c = mat3(viewMatrix) * uDir * 1700.; gl_Position = projectionMatrix * vec4(c + vec3(position.xy * uS, 0.), 1.); }`;
const SUN_FRAG = /* glsl */`
uniform float uS, uRd; varying vec2 vUv;
void main(){
  float r = length(vUv), x = r * uS, k = x / uRd;
  float fade = pow(1. - smoothstep(.35, 1., r), 2.);
  float disc = 1. - smoothstep(.96, 1.04, k);
  float limb = sqrt(max(1. - k*k, 0.));
  vec3 dcol = mix(vec3(1., .72, .45), vec3(1., .98, .94), sqrt(limb)) * 40. * disc;
  vec3 glare = vec3(1., .93, .80) * (2.6 * exp(-k * .75) + .20 * exp(-k * .24) + .02 * exp(-k * .06)) * fade;
  float streak = exp(-abs(vUv.y * uS) / (uRd * .30)) * exp(-abs(vUv.x * uS) / (uRd * 6.)) * .30;
  vec3 col = dcol + glare + vec3(1., .9, .75) * streak * fade;
  gl_FragColor = vec4(col, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Starfield on an infinitely distant sphere (camera-translation independent), Milky Way band and the Sun.
export function createStars(scene) {
  const N = 18000, FLARES = 12, rnd = makeRng(4102026 ^ 0x9e3779b9);
  const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += rnd(); return (s - 2) * 1.73; };
  const e1 = new THREE.Vector3().crossVectors(GN, new THREE.Vector3(0, 0, 1)).normalize(), e2 = new THREE.Vector3().crossVectors(GN, e1);
  const raw = [], R = 1800, tmpV = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    if (rnd() < .45) { const b = gauss() * .20, lo = rnd() * TAU; tmpV.copy(e1).multiplyScalar(Math.cos(lo) * Math.cos(b)).addScaledVector(e2, Math.sin(lo) * Math.cos(b)).addScaledVector(GN, Math.sin(b)); }
    else { const z = rnd() * 2 - 1, a = rnd() * TAU, rr = Math.sqrt(1 - z * z); tmpV.set(Math.cos(a) * rr, z, Math.sin(a) * rr); }
    const lo = -1.4, hi = 7.2, k = 10 ** (.5 * lo), K = 10 ** (.5 * hi);          // N(<m) ∝ 10^(0.5 m)
    const mag = Math.log10(k + rnd() * (K - k)) / .5;
    const r = rnd(), T = r < .12 ? 11000 + rnd() * 14000 : r < .42 ? 6500 + rnd() * 2500 : r < .67 ? 5200 + rnd() * 900 : 3500 + rnd() * 1500;
    raw.push({ x: tmpV.x, y: tmpV.y, z: tmpV.z, mag, T });
  }
  raw.sort((a, b) => a.mag - b.mag);                                                // brightest first → drawRange drops the faintest on low quality
  const pos = new Float32Array(N * 3), st = new Float32Array(N * 4), sz = new Float32Array(N);
  raw.forEach((s, i) => {
    const f = 10 ** (-.4 * (s.mag - 6)), c = blackbody(s.T), sat = .5 + .4 * Math.min(1, f / 8), peak = Math.min(2.8, .36 * Math.pow(f, .30));
    pos.set([s.x * R, s.y * R, s.z * R], i * 3);
    st.set([1 + (c[0] - 1) * sat, 1 + (c[1] - 1) * sat, 1 + (c[2] - 1) * sat, peak], i * 4);
    sz[i] = Math.min(5.6, 1.0 + .55 * Math.log2(f + 1));
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aStar', new THREE.BufferAttribute(st, 4)); geo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const uRes = { value: 1 };
  const pm = (frag, extra = {}) => new THREE.ShaderMaterial({ uniforms: { uRes }, vertexShader: STAR_VERT, fragmentShader: frag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...extra });
  const points = new THREE.Points(geo, pm(STAR_FRAG)); points.frustumCulled = false; points.renderOrder = -1;
  const v2 = new THREE.Vector2();
  points.onBeforeRender = renderer => { const rt = renderer.getRenderTarget(); renderer.getDrawingBufferSize(v2); uRes.value = (rt ? rt.height : v2.y) / 900; };

  // diffraction flares on the brightest stars
  const fg = new THREE.BufferGeometry(), fp = new Float32Array(FLARES * 3), fs = new Float32Array(FLARES * 4), fz = new Float32Array(FLARES);
  for (let i = 0; i < FLARES; i++) {
    fp.set(pos.subarray(i * 3, i * 3 + 3), i * 3); fs.set(st.subarray(i * 4, i * 4 + 4), i * 4);
    const k = 1 - i / FLARES; fs[i * 4 + 3] = .42 + .5 * k; fz[i] = 14 + 38 * k * k;
  }
  fg.setAttribute('position', new THREE.BufferAttribute(fp, 3)); fg.setAttribute('aStar', new THREE.BufferAttribute(fs, 4)); fg.setAttribute('aSize', new THREE.BufferAttribute(fz, 1));
  fg.boundingSphere = geo.boundingSphere;
  const flares = new THREE.Points(fg, pm(FLARE_FRAG)); flares.frustumCulled = false; flares.renderOrder = -1;

  // dense faint star clouds along the galactic band (unresolved stars)
  const DN = 60000, dp = new Float32Array(DN * 3), ds = new Float32Array(DN * 4), dz = new Float32Array(DN).fill(1);
  for (let i = 0; i < DN; i++) {
    const b = gauss() * (.09 + .10 * rnd()), lo = (rnd() < .5 ? rnd() : rnd() * rnd()) * TAU * (rnd() < .5 ? 1 : -1) * .5;      // thicker/denser toward the core
    tmpV.copy(e1).multiplyScalar(Math.cos(lo) * Math.cos(b)).addScaledVector(e2, Math.sin(lo) * Math.cos(b)).addScaledVector(GN, Math.sin(b));
    dp.set([tmpV.x * R, tmpV.y * R, tmpV.z * R], i * 3);
    const warm = rnd(), c = blackbody(warm < .35 ? 8500 + rnd() * 6000 : 4000 + warm * 4200), br = .08 + .24 * rnd() * rnd() * rnd() + .03 * rnd();
    ds.set([1 + (c[0] - 1) * .5, 1 + (c[1] - 1) * .5, 1 + (c[2] - 1) * .5, br], i * 4);
  }
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.BufferAttribute(dp, 3)); dg.setAttribute('aStar', new THREE.BufferAttribute(ds, 4)); dg.setAttribute('aSize', new THREE.BufferAttribute(dz, 1));
  dg.boundingSphere = geo.boundingSphere;
  const faint = new THREE.Points(dg, pm(STAR_FRAG)); faint.frustumCulled = false; faint.renderOrder = -1;

  const mwU = { nz: NZ, uZ: ZERO, gN: { value: GN }, gC: { value: GC }, oct: { value: 5 }, gain: { value: 1 } };
  const milky = new THREE.Mesh(new THREE.SphereGeometry(1750, 48, 32), new THREE.ShaderMaterial({
    uniforms: mwU, vertexShader: MW_VERT, fragmentShader: MW_FRAG, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  milky.frustumCulled = false; milky.renderOrder = -2;

  const sunU = { uDir: { value: new THREE.Vector3(-.577, .577, .577) }, uS: { value: 600 }, uRd: { value: 20 } };
  const sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: sunU, vertexShader: SUN_VERT, fragmentShader: SUN_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  sunMesh.frustumCulled = false; sunMesh.renderOrder = -1;

  const stars = group(scene); stars.add(milky, faint, points, flares, sunMesh);
  warm.group = new THREE.Group(); scene.add(warm.group);
  for (const m of warm.pending.splice(0)) { warm.keys.delete(m.vertexShader.length + ':' + m.fragmentShader.length + JSON.stringify(m.defines || {}) + m.blending + m.side); addWarm(m); }
  for (const o of [milky, faint, flares, sunMesh]) addWarm(o.material);
  const COUNT = { low: N >> 2, medium: N, high: N }, OCT = { low: 3, medium: 5, high: 6 };
  stars.userData = { points, flares, milky, sun: sunMesh, count: N };
  stars.userData.tick = (t, ctx) => {
    sunU.uDir.value.copy(ctx.sunDir);
    mwU.gain.value = ctx.idx >= 4 && ctx.idx <= 6 ? .42 : 1;       // lunar surface: calm, near-black sky (the band must not read as haze over the horizon)
    const q = ctx.quality || 'medium'; geo.setDrawRange(0, COUNT[q]); mwU.oct.value = OCT[q]; flares.visible = faint.visible = q !== 'low';
  };
  return stars;
}
