// Per-world lighting, fog, environment map and filmic grading. app.js calls looks.apply(worldKey) whenever the active world changes.
// World keys: launch, orbit, transfer, dock, surface, return, entry, splash.
// Everything here assumes the HDR pipeline in post.js: lights are scene-linear, the sky/env are authored as linear radiance.
import * as THREE from 'three';
import { DAWN_SUN_DIR } from './sky.js';

const v3 = a => new THREE.Vector3(...a).normalize();
const SPACE_POST = { exposure: 1.02, bloom: .1, bloomThreshold: 1, bloomKnee: .7, bloomRadius: .8, flare: .1, flareThreshold: 5, streak: .025, streakThreshold: 5,
  contrast: 1.14, saturation: 1.07, temperature: .02, lift: [.002, .005, .011], shadowTint: [.95, .985, 1.06], highlightTint: [1.04, 1.005, .95], vignette: .3, grain: .028 };

const defaults = {
  ambient: { sky: 0x6f86b0, ground: 0x15131a, i: .2 }, sun: { color: 0xfff0dc, i: 3.3, offset: [-100, 100, 100] }, fill: { color: 0x8fb0e8, i: .16, pos: [90, 45, 140] },
  shadowExtent: 45, fog: null, stars: true, envI: 1, post: SPACE_POST,
  env: { zenith: 0x000000, horizon: 0x000000, nadir: 0x000000 }
};

// Earth/Moon glow lobes in env maps are placed from the world layout in app.js (directions seen from the camera focus).
export const LOOKS = {
  launch: {
    ambient: { sky: 0xa09aae, ground: 0x3a2e28, i: .95 }, sun: { color: 0xffc28c, i: 3.8, offset: [-150, 52, 70] }, fill: { color: 0x86a2dc, i: .5, pos: [100, 40, 150] },
    shadowExtent: 140, fog: () => new THREE.FogExp2(0x45424b, .0015), stars: false, envI: .85,
    env: { zenith: 0x040a14, horizon: 0x45424b, nadir: 0x1a1613, hp: .55, glow: { dir: DAWN_SUN_DIR, color: 0xff7a34, k: .9, pow: 7 }, core: { dir: DAWN_SUN_DIR, color: 0xffb070, k: 7, pow: 120 } },
    post: { exposure: 1, bloom: .1, bloomThreshold: .95, bloomKnee: .7, bloomRadius: .76, flare: .03, flareThreshold: 4, streak: .03, streakThreshold: 4, streakTint: [1, .62, .35],
      glare: .36, glareDir: DAWN_SUN_DIR.toArray(), glareTint: [1, .62, .34], rays: .1, raysThreshold: 2.2,
      contrast: 1.12, saturation: 1.06, temperature: .08, tint: .02, lift: [.006, .004, .01], shadowTint: [.92, .965, 1.08], highlightTint: [1.07, 1, .9], vignette: .32, grain: .03 }
  },
  // Orbit: the Sun hangs just over the Earth's limb ahead of the camera (screen ~70%,45%), Orion is rim-lit from behind and filled by earthshine from below.
  orbit: {
    ambient: { sky: 0x7898d0, ground: 0x24385e, i: .5 }, sun: { color: 0xfff1de, i: 3.6, offset: [-58, -19, -149] }, fill: { color: 0xbccaee, i: 1.05, pos: [-30, -28, 90] },
    shadowExtent: 50, envI: 1.15,
    env: { zenith: 0x000104, horizon: 0x010308, nadir: 0x03081a, sun: { E: .75, r: 2.6, color: 0xfff0d8 }, earth: { dir: [-.08, -.72, -.69], color: 0x4a86d8, k: .6, r: 52 } },
    post: { ...SPACE_POST, glare: .1, glareTint: [1, .84, .6], bloom: .1, flare: .008, flareThreshold: 8 }
  },
  // Transfer: Sun from the upper left, a little more lateral than before, so Earth and Moon read as gibbous phases and Orion gets a clear key/shadow split.
  transfer: {
    ambient: { sky: 0x5f7fb8, ground: 0x141c30, i: .24 }, sun: { color: 0xfff1de, i: 3.6, offset: [-95, 50, 115] }, fill: { color: 0x86acf0, i: .3, pos: [70, -10, 110] },
    shadowExtent: 50, envI: 1,
    env: { zenith: 0x000104, horizon: 0x010308, nadir: 0x010308, sun: { E: .55, r: 2.6, color: 0xfff0d8 }, earth: { dir: [-.62, -.1, -.78], color: 0x4a86d8, k: .5, r: 20 }, moon: { dir: [.3, .15, -.94], color: 0xb4aca0, k: .12, r: 8 } }
  },
  // Dock: the sunlit Moon below throws a warm grey bounce onto the undersides (fill from the Moon's direction + brighter hemisphere ground).
  dock: {
    ambient: { sky: 0x667788, ground: 0x6a645c, i: .46 }, sun: { color: 0xfff0dc, i: 3.8, offset: [-100, 100, 100] }, fill: { color: 0xb8ae9e, i: .85, pos: [10, -70, -70] },
    shadowExtent: 55, envI: 1,
    env: { zenith: 0x000104, horizon: 0x010308, nadir: 0x4a4640, hp: .5, sun: { E: .55, r: 2.6, color: 0xfff0d8 }, moon: { dir: [0, -.7, -.7], color: 0xb4aca0, k: .32, r: 40 } },
    post: { ...SPACE_POST, exposure: 1.1, saturation: 1.02, bloom: .06 }
  },
  surface: {
    ambient: { sky: 0x3a4a6e, ground: 0x2d2a27, i: .07 }, sun: { color: 0xfff0dc, i: 5.8, offset: [-180, 32, 100] }, fill: { color: 0x7d9de0, i: .13, pos: [-170, 60, -360] },
    shadowExtent: 140, envI: 1.1,
    env: { zenith: 0x000000, horizon: 0x020203, nadir: 0x3a3631, hp: .4, sun: { E: .5, r: 2.4, color: 0xffe8cc }, earth: { dir: [-.42, .06, -.9], color: 0x5f93e0, k: .5, r: 14 } },
    post: { exposure: 1.3, bloom: .06, bloomThreshold: 1.05, bloomKnee: .7, bloomRadius: .72, flare: .03, flareThreshold: 5, streak: .02, streakThreshold: 5,
      contrast: 1.26, saturation: .84, temperature: .05, lift: [.002, .004, .009], shadowTint: [.95, .98, 1.05], highlightTint: [1.03, 1.0, .97], vignette: .34, grain: .03, ca: 0 }
  },
  // Return: Sun ahead and above (upper right of centre) so Orion is rim-lit and a planet near it gets a bright crescent; strong earthshine fill
  // and a higher exposure keep the shadow side and the wings readable.
  return: {
    ambient: { sky: 0x7898d0, ground: 0x24385e, i: .5 }, sun: { color: 0xfff1de, i: 3.6, offset: [-37, -16, -144] }, fill: { color: 0xbccaee, i: 1.0, pos: [40, 8, 100] },
    shadowExtent: 50, envI: 1.2,
    env: { zenith: 0x000104, horizon: 0x010308, nadir: 0x020510, sun: { E: .75, r: 2.6, color: 0xfff0d8 }, earth: { dir: [.6, -.1, -.79], color: 0x4a86d8, k: 1, r: 34 }, moon: { dir: [-.6, .2, -.77], color: 0xb4aca0, k: .22, r: 9 } },
    post: { ...SPACE_POST, exposure: 1.16, glare: .1, glareTint: [1, .84, .6], flare: .008, flareThreshold: 8 }
  },
  entry: {
    ambient: { sky: 0x5f86cc, ground: 0x2a4c8c, i: .26 }, sun: { color: 0xfff1de, i: 3.4, offset: [-100, 100, 100] }, fill: { color: 0xff9248, i: .3, pos: [-90, 40, 60] },
    shadowExtent: 45, envI: 1,
    env: { zenith: 0x000104, horizon: 0x010308, nadir: 0x010308, sun: { E: .5, r: 2.6, color: 0xfff0d8 }, earth: { dir: [0, -.77, -.64], color: 0x4a86d8, k: .55, r: 42 } },
    post: { ...SPACE_POST, tone: 'agx', exposure: 1.0, saturation: 1.22, highlightTint: [1.05, .99, .9], bloom: .08, bloomThreshold: 1.2, bloomKnee: .9, bloomRadius: .8, flare: .01, flareThreshold: 7, streak: .02, streakThreshold: 6, streakTint: [1, .6, .3], temperature: .03, hazeAxis: [-1, .27, 0] }
  },
  splash: {
    ambient: { sky: 0x8a86a8, ground: 0x1d2a34, i: .6 }, sun: { color: 0xffc896, i: 3.4, offset: [-130, 60, 70] }, fill: { color: 0x86a8dc, i: .45, pos: [100, 40, 150] },
    shadowExtent: 60, fog: () => new THREE.FogExp2(0x45424b, .0016), stars: false, envI: .9,
    env: { zenith: 0x040a14, horizon: 0x45424b, nadir: 0x0e171f, hp: .55, glow: { dir: DAWN_SUN_DIR, color: 0xff7a34, k: .9, pow: 7 }, core: { dir: DAWN_SUN_DIR, color: 0xffb070, k: 7, pow: 120 } },
    post: { exposure: 1, bloom: .1, bloomThreshold: 1.1, bloomKnee: .7, bloomRadius: .62, flare: .03, flareThreshold: 4, streak: .01, streakThreshold: 10, streakTint: [1, .66, .4],
      glare: .34, glareDir: DAWN_SUN_DIR.toArray(), glareTint: [1, .66, .38], rays: .09, raysThreshold: 2.2,
      contrast: 1.1, saturation: 1.06, temperature: .05, tint: -.02, lift: [.004, .006, .01], shadowTint: [.9, 1, 1.08], highlightTint: [1.07, 1, .9], vignette: .32, grain: .03 }
  }
};

// Procedural environment: gradient dome + sun disc + Earth/Moon glow lobes + dawn glow. Authored in linear radiance.
const ENV_FRAG = /* glsl */`
varying vec3 p;
uniform vec3 zen,hor,nad; uniform float hp;
uniform vec3 sunDir,sunCol; uniform vec2 sunC;
uniform vec3 glowDir,glowCol; uniform float glowPow;
uniform vec3 coreCol; uniform float corePow;
uniform vec3 eDir,eCol; uniform vec2 eC;
uniform vec3 mDir,mCol; uniform vec2 mC;
void main(){
  vec3 d=normalize(p); float h=d.y;
  vec3 c=h>0.?mix(hor,zen,pow(clamp(h,0.,1.),hp)):mix(hor,nad,smoothstep(0.,.5,-h));
  c+=sunCol*smoothstep(sunC.x,sunC.y,dot(d,sunDir));
  float g=max(dot(d,glowDir),0.); c+=glowCol*pow(g,glowPow)+coreCol*pow(g,corePow);
  c+=eCol*smoothstep(eC.x,eC.y,dot(d,eDir));
  c+=mCol*smoothstep(mC.x,mC.y,dot(d,mDir));
  gl_FragColor=vec4(c,1.);
}`;
const cone = (deg, soft = .55) => new THREE.Vector2(Math.cos(deg * Math.PI / 180), Math.cos(deg * soft * Math.PI / 180));
const rgb = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);

function buildEnv(pmrem, spec, sunDirW) {
  const z = new THREE.Vector3(0, 1, 0), none = { value: new THREE.Color(0) };
  const U = {
    zen: { value: rgb(spec.zenith) }, hor: { value: rgb(spec.horizon) }, nad: { value: rgb(spec.nadir) }, hp: { value: spec.hp ?? .5 },
    sunDir: { value: sunDirW.clone() }, sunCol: none, sunC: { value: new THREE.Vector2(2, 3) },
    glowDir: { value: z }, glowCol: none, glowPow: { value: 4 }, coreCol: none, corePow: { value: 100 },
    eDir: { value: z }, eCol: none, eC: { value: new THREE.Vector2(2, 3) }, mDir: { value: z }, mCol: none, mC: { value: new THREE.Vector2(2, 3) }
  };
  if (spec.sun) { const r = spec.sun.r * Math.PI / 180; U.sunCol = { value: rgb(spec.sun.color, spec.sun.E / (Math.PI * r * r)) }; U.sunC.value = cone(spec.sun.r, .8); }
  if (spec.glow) { U.glowDir = { value: spec.glow.dir.clone() }; U.glowCol = { value: rgb(spec.glow.color, spec.glow.k) }; U.glowPow.value = spec.glow.pow; }
  if (spec.core) { U.coreCol = { value: rgb(spec.core.color, spec.core.k) }; U.corePow.value = spec.core.pow; }
  if (spec.earth) { U.eDir = { value: v3(spec.earth.dir) }; U.eCol = { value: rgb(spec.earth.color, spec.earth.k) }; U.eC.value = cone(spec.earth.r, .3); }
  if (spec.moon) { U.mDir = { value: v3(spec.moon.dir) }; U.mCol = { value: rgb(spec.moon.color, spec.moon.k) }; U.mC.value = cone(spec.moon.r, .4); }
  const s = new THREE.Scene();
  const m = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), new THREE.ShaderMaterial({ uniforms: U, vertexShader: 'varying vec3 p;void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: ENV_FRAG, side: THREE.BackSide, depthWrite: false, toneMapped: false }));
  s.add(m);
  const rt = pmrem.fromScene(s, 0, .1, 100);
  m.geometry.dispose(); m.material.dispose();
  return rt.texture;
}

const copyArr = (d, s) => { for (let i = 0; i < 3; i++) d[i] = s[i]; };
const ARR = ['streakTint', 'glareDir', 'glareTint', 'hazeAxis', 'lift', 'gamma', 'gain', 'shadowTint', 'highlightTint'];
const NUM = ['exposure', 'bloom', 'bloomThreshold', 'bloomKnee', 'bloomRadius', 'flare', 'flareThreshold', 'streak', 'streakThreshold', 'glare', 'rays', 'raysThreshold', 'haze', 'saturation', 'contrast', 'pivot', 'temperature', 'tint', 'vignette', 'grain', 'ca'];

const gauss = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));

// ctx: { renderer, scene, ambient, sun, fill, stars, post, setShadowExtent }
// Returns { apply(key), frame(tickCtx), sunOffset } — sunOffset is the vector from the camera focus to the sun light (world space).
// frame() runs every frame after choreography with tickCtx = { t, idx, u, world, camera, sunDir, quality } for in-stage grading changes.
export function createLooks(ctx) {
  const sunOffset = new THREE.Vector3(), fogs = {}, envs = {}, built = {};
  let current = null, base = null;
  const work = { tone: 'aces', streakTint: [1, 1, 1], glareDir: [0, 0, -1], glareTint: [1, .86, .62], hazeAxis: [-1, .3, 0], lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], shadowTint: [1, 1, 1], highlightTint: [1, 1, 1] };
  const tmpC = new THREE.Color(), tmpC2 = new THREE.Color();
  const add = (k, v) => { work[k] = (work[k] ?? DEF[k]) + v; };
  const pm = new THREE.PMREMGenerator(ctx.renderer);
  const resolve = key => {
    if (built[key]) return built[key];
    const d = LOOKS[key] || {}, L = { ...defaults, ...d };
    L.ambient = { ...defaults.ambient, ...d.ambient }; L.sun = { ...defaults.sun, ...d.sun }; L.fill = { ...defaults.fill, ...d.fill };
    L.env = { ...defaults.env, ...d.env }; L.post = { ...d.post || SPACE_POST };
    return built[key] = L;
  };
  // Environment maps are generated once up front so stage cuts never hitch and texture counts stay stable.
  for (const key of Object.keys(LOOKS)) { const L = resolve(key); envs[key] = buildEnv(pm, L.env, new THREE.Vector3(...L.sun.offset).normalize()); }
  pm.dispose();

  const api = {
    sunOffset,
    apply(key) {
      if (key === current) return; current = key;
      const L = resolve(key); base = L;
      const a = ctx.ambient; a.color.set(L.ambient.sky); a.groundColor.set(L.ambient.ground); a.intensity = L.ambient.i;
      ctx.sun.color.set(L.sun.color); ctx.sun.intensity = L.sun.i; sunOffset.fromArray(L.sun.offset);
      ctx.fill.color.set(L.fill.color); ctx.fill.intensity = L.fill.i; ctx.fill.position.fromArray(L.fill.pos);
      ctx.setShadowExtent(L.shadowExtent);
      if (L.fog && !fogs[key]) fogs[key] = L.fog();
      ctx.scene.fog = L.fog ? fogs[key] : null;
      ctx.stars.visible = L.stars;
      ctx.scene.environment = envs[key]; ctx.scene.environmentIntensity = L.envI;
      ctx.post.setLook(L.post);
      work.tone = L.post.tone || 'aces';
    },
    frame(tc) {
      if (!base) return;
      const { t, u, idx } = tc, key = current, P = base.post, w = work;
      // start from the world's base grade each frame (pure function of t -> seeking is deterministic)
      for (const k of NUM) w[k] = P[k]; for (const k of ARR) copyArr(w[k], P[k] || DEFARR[k]);
      const d = add;
      const L = base;
      if (L.post.glare > 0 && key !== 'launch' && key !== 'splash') { const sd = tc.sunDir; w.glareDir[0] = sd.x; w.glareDir[1] = sd.y; w.glareDir[2] = sd.z; }   // space worlds: glare follows the sun light
      if (key === 'launch') {
        const ign = Math.exp(-t / 1.6) * (t > 0 ? 1 : 0), sep = gauss(t, 11.7, .45);
        d('bloom', .09 * ign + .035 * sep); d('exposure', .08 * ign + .04 * sep); d('temperature', .1 * ign); d('streak', .03 * ign);
        d('exposure', .05 * u);                                         // dawn slowly brightens as the stack climbs
        ctx.sun.intensity = L.sun.i * (1 + .1 * u);
      } else if (key === 'orbit') {
        const burn = u > .58 ? Math.min(1, (u - .58) / .06) : 0;
        d('bloom', .03 * burn); d('temperature', .04 * burn); d('streak', .02 * burn);
      } else if (key === 'dock') {
        d('exposure', .03 * Math.sin(u * Math.PI));
      } else if (key === 'surface') {
        if (idx === 4) { const burn = u < .91 ? 1 - .45 * u : Math.exp(-(u - .91) * 40); d('bloom', .04 * burn); d('exposure', -.03 * burn * (1 - u)); d('temperature', .03 * burn); }
        else if (idx === 6) { const burn = u < .9 ? 1 - u : 0; d('bloom', .035 * burn); d('temperature', .03 * burn); }
        else if (idx === 5) d('exposure', .03 * Math.sin(u * Math.PI));
      } else if (key === 'entry') {
        const heat = Math.sin(u * Math.PI), h2 = heat * heat;
        d('bloom', .045 * h2); d('exposure', -.42 * h2); d('temperature', .24 * heat); d('saturation', .22 * h2); d('contrast', .06 * heat);
        d('streak', .01 * h2); d('ca', .0022 * h2); d('vignette', .1 * h2); d('flare', .005 * h2);
        d('bloomRadius', .08 * h2); d('haze', .0045 * heat * Math.sqrt(heat));            // refraction behind the hot body
        // plasma spill from the wake side (the module flies toward +x/-y): white-hot at peak, orange to red as the heat decays
        ctx.fill.intensity = L.fill.i * (.3 + 2.4 * h2); ctx.fill.position.set(-90, 36 + 14 * u, 62);
        tmpC.set(0xff3c12); tmpC2.set(0xffe0c0); ctx.fill.color.copy(tmpC).lerp(tmpC2, Math.pow(heat, .8));
        ctx.ambient.intensity = L.ambient.i * (1 + .45 * h2);
      } else if (key === 'splash') {
        const hit = gauss(u, .43, .02);
        d('exposure', .07 * u); d('bloom', .025 * hit); d('temperature', .04 * u);
      }
      ctx.post.setLook(w);
    }
  };
  return api;
}
const DEFARR = { streakTint: [.55, .75, 1], glareDir: [0, 0, -1], glareTint: [1, .86, .62], hazeAxis: [-1, .3, 0], lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], shadowTint: [1, 1, 1], highlightTint: [1, 1, 1] };
const DEF = { exposure: 1, bloom: .1, bloomThreshold: 1, bloomKnee: .6, bloomRadius: .7, flare: 0, flareThreshold: 2.5, streak: 0, streakThreshold: 3, glare: 0, rays: 0, raysThreshold: 1.2, haze: 0, saturation: 1, contrast: 1, pivot: .46, temperature: 0, tint: 0, vignette: .28, grain: .03, ca: .0022 };
