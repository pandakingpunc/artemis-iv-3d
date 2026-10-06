// Exhaust, launch smoke, lunar dust, re-entry plasma, splash/foam and gas puffs. All animation is a pure function of absolute time t.
// Exports: flame, createLaunchPlume, createLandingDust, createEntryPlasma, createWaveRings (original API) and new:
// createBurstPuffs, createRcsPuffs, createSeparationPuffs, createChuteDeployPuff.
// Shaders output linear HDR (values > 1 feed bloom). They include three's tonemapping/colorspace chunks, so they are
// correct both when drawn straight to the canvas and when rendered into a half-float target by the post chain.
import * as THREE from 'three';
import { TAU, clamp, makeRng, group } from './util.js';
import { heights } from './terrain.js';
import { EVENTS } from './timeline.js';


// ---------- shared GLSL ----------
const NOISE = `
float h13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float vnoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
  return mix(mix(mix(h13(i),h13(i+vec3(1,0,0)),f.x),mix(h13(i+vec3(0,1,0)),h13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h13(i+vec3(0,0,1)),h13(i+vec3(1,0,1)),f.x),mix(h13(i+vec3(0,1,1)),h13(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*vnoise(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s*1.07;}
float fbmN(vec3 p,int o){float a=.5,s=0.,w=0.;for(int i=0;i<4;i++){if(i>=o)break;s+=a*vnoise(p);w+=a;p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s/w;}
`;
const OUT = `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;

// Additive emissive shaders get uDirect=1 when drawn straight to the canvas (tone mapping must see colour*alpha there).
function directSwitch(renderer) { this.uniforms.uDirect.value = renderer.getRenderTarget() === null ? 1 : 0; }

// Tight HDR-friendly glow profile (hot core, long soft tail).
function glowTexture() {
  const N = 128, data = new Uint16Array(N * N * 4), one = THREE.DataUtils.toHalfFloat(1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = Math.hypot(x - 63.5, y - 63.5) / 64, e = r >= 1 ? 0 : (1 - r) * (1 - r) * (3 - 2 * (1 - r));
    const v = (.85 * Math.exp(-((r / .12) ** 2)) + .3 * Math.exp(-((r / .3) ** 2)) + .08 * Math.exp(-((r / .6) ** 2))) * e, i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = one; data[i + 3] = THREE.DataUtils.toHalfFloat(v);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType); t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
}
const glowTex = glowTexture();
function hdrGlow(parent, r, g, b, size, x = 0, y = 0, z = 0) {
  const o = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  o.position.set(x, y, z); o.scale.setScalar(size); o.renderOrder = 6; parent.add(o); return o;
}



// ---------- engine exhaust ----------
const FLAME_VS = `
uniform float uLen,uRmax,uRise;
varying vec2 vUv;varying vec3 vSide,vW;
void main(){
  vec3 cl=(inverse(modelMatrix)*vec4(cameraPosition,1.)).xyz;
  vec3 w=vec3(cl.x,0.,cl.z);float lw=length(w);w=lw>1e-3?w/lw:vec3(1.,0.,0.);
  vec3 side=vec3(-w.z,0.,w.x);
  vUv=vec2(position.x,position.y);vSide=side;vW=w;
  vec3 lp=side*position.x*uRmax+vec3(0.,-position.y*uLen+uRise,0.);
  gl_Position=projectionMatrix*modelViewMatrix*vec4(lp,1.);
}`;
const FLAME_FS = `
uniform float uT,uA,uLen,uRmax,uRise,uGain,uDirect,uWide,uOct;
uniform vec3 uSigO,uSigC;uniform vec4 uAmp,uTurb,uDia;
uniform vec3 uC0,uC1,uC2,uC3;
varying vec2 vUv;varying vec3 vSide,vW;
${NOISE}
vec3 ramp(float T){return T<.4?mix(uC0,uC1,T/.4):T<.75?mix(uC1,uC2,(T-.4)/.35):mix(uC2,uC3,clamp((T-.75)/.5,0.,1.));}
void main(){
  float yc=clamp(vUv.y-uRise/uLen*0.,0.,1.),yl=yc*uLen,s=vUv.x*uRmax;
  float sigO=mix(uSigO.x,uSigO.y,pow(yc,uSigO.z))*uWide,sigC=mix(uSigC.x,uSigC.y,pow(yc,uSigC.z))*sqrt(uWide);
  float rs=sigO*2.2,dz=sqrt(max(rs*rs-s*s,0.));
  vec3 P=vSide*s+vW*dz+vec3(0.,-yl,0.);
  vec3 q=vec3(P.x,P.y+uT*uTurb.z,P.z)*uTurb.y;
  vec3 wq;
  if(uOct>2.5)wq=vec3(vnoise(q*.9+vec3(3.1,0.,0.)),vnoise(q*.9+vec3(0.,7.7,0.)),vnoise(q*.9+vec3(0.,0.,5.3)))-.5;
  else{float w1=vnoise(q*.9+vec3(3.1,0.,0.));wq=vec3(w1,.7*w1+.15,.85-w1)-.5;}
  float n=fbmN(q+wq*uTurb.w,int(uOct));
  float tb=uTurb.x*smoothstep(0.,.5,yc);
  float sp=s+wq.x*tb*sigO*2.6,spc=s+wq.x*tb*sigC*1.1;
  float eo=exp(-sp*sp/(2.*sigO*sigO)),ec=exp(-spc*spc/(2.*sigC*sigC));
  float head=smoothstep(0.,uAmp.w,yl),tail=pow(max(1.-yc,0.),uAmp.z);
  float tongue=clamp((1.-yc)*1.6+(n-.5)*tb*3.2,0.,1.);
  float dO=uAmp.x*eo*head*tail*tongue*mix(1.,n*1.9,tb*.75);
  float dC=uAmp.y*ec*head*pow(max(1.-yc*1.6,0.),uAmp.z*1.3)*mix(1.,.45+n*1.1,tb*.7);
  float dia=0.;
  if(uDia.x>0.){
    float pitch=uDia.y*(1.+.5*yc),yy=yl+.05*sin(uT*53.+yl*3.)+uDia.w;
    float f=fract(yy/pitch);
    float lens=sin(f*3.14159);
    float rr=abs(sp)/(sigC*(.55+.9*lens)+.02);
    float body=smoothstep(1.,.15,rr)*pow(lens,.6);
    float disk=smoothstep(.62,.95,f)*smoothstep(1.,.9,f)*smoothstep(1.4,.1,abs(sp)/(sigC*.9));
    dia=uDia.x*(body*(.35+.65*f)+disk*1.2)*exp(-yl*uDia.z)*smoothstep(.2,1.1,yl)*(.75+.5*n);
  }
  float T=clamp(dC+.45*dO+dia*1.1,0.,1.5);
  vec3 col=ramp(T)*uGain;
  float a=clamp(dO+dC+dia,0.,1.)*uA*smoothstep(1.,.6,abs(vUv.x))*smoothstep(1.,.82,vUv.y);
  gl_FragColor=uDirect>.5?vec4(col*a,1.):vec4(col,a);${OUT}
}`;
const V = (a, b, c) => new THREE.Vector3(a, b, c), V4 = (a, b, c, d) => new THREE.Vector4(a, b, c, d);
const FLAME_KINDS = {
  default: { rmax: 4.2, sigO: [.9, 1.6, .6], sigC: [.5, .3, .8], amp: [.8, 1, .9, .35], turb: [.7, .42, 8, 1.1], dia: [0, 1, 0, 0], cols: [[.7, .18, .04], [2, .8, .2], [3, 2.1, .9], [4, 3.4, 2.4]], gain: 1, glow: [[2.6, 1.3, .5, 7, -.6], [2.5, 2.2, 2, 3.2, -.2]] },
  rs25: { len: 22, rmax: 5, sigO: [.8, 1.7, .7], sigC: [.62, .85, .8], amp: [.5, .55, .9, .3], turb: [.4, .45, 10, .8], dia: [2.1, 2.3, .15, 0], cols: [[.35, .4, 1], [.6, .8, 1.5], [1.4, 1.5, 2.2], [4.6, 4.5, 5]], gain: 1, glow: [[2.2, 2.3, 2.8, 5, -.3], [1.5, .8, .4, 10, -1.6]], alt: [1.6, .9, 1.4] },
  srb: { len: 24, rmax: 6.2, sigO: [1, 2.3, .55], sigC: [.7, 1.2, .7], amp: [.95, 1.2, .75, .3], turb: [.95, .32, 9, 1.3], dia: [.5, 3.4, .1, 0], cols: [[.9, .18, .04], [2.4, .85, .18], [3.8, 2.4, .9], [5, 4.2, 3.2]], gain: 1, glow: [[3, 1.6, .6, 9, -.8], [3, 2.6, 2.2, 4, -.2]], alt: [.35, .7, .8] },
  oms: { len: 26, rmax: 6, sigO: [.35, 2.6, .95], sigC: [.25, .95, .9], amp: [.2, .62, 1.2, .15], turb: [.28, .5, 6, .6], dia: [.3, 1.9, .16, 0], cols: [[.2, .35, 1], [.45, .65, 1.4], [1, 1.1, 1.9], [2.6, 2.6, 3.1]], gain: 1, glow: [[2, 2.2, 3, 4, -.1], [3, 3, 3.2, 1.8, 0]] },
  descent: { len: 15, rmax: 9.5, sigO: [.5, 3.9, .7], sigC: [.3, 1.1, .8], amp: [.3, .9, 1.7, .12], turb: [.3, .55, 8, .7], dia: [.45, 2.2, .35, 0], cols: [[.28, .42, .9], [.7, .85, 1.2], [1.5, 1.4, 1.3], [2.8, 2.4, 1.8]], gain: 1, glow: [[2.2, 2, 1.7, 4.5, -.1], [3, 3, 3, 1.9, 0]] },
  plasma: { rmax: 5.6, sigO: [.9, 2.8, .8], sigC: [.6, 1.3, .8], amp: [.8, .9, .8, .25], turb: [1, .35, 10, 1.4], dia: [0, 1, 0, 0], cols: [[.7, .15, .5], [1.8, .5, .28], [2.8, 1.5, .7], [3.4, 2.6, 1.8]], gain: 1, glow: [[2.6, 1.2, .5, 7, -.4], [3, 2.6, 2, 3, 0]] }
};


// Engine exhaust pointing down local -Y from the parent's origin, about 16*scale long. Each flame is one camera-facing
// ribbon (no cone edges) shaded with 3D-noise turbulence, plus HDR nozzle glows.
// opts: { scale=1, alpha=.8, color (legacy, tints the default kind), kind: 'rs25'|'srb'|'oms'|'descent'|'plasma', t0 (film time of ignition: flash) }
//   (default is 16*scale long; rs25 is 22*scale and srb 24*scale long, oms 26, descent 15)
//   rs25 hydrolox core stage (pale blue-white, Mach diamonds; lengthens x2.5 and widens with altitude) · srb booster (very bright orange-white,
//   turbulent, thick; widens with altitude) · oms vacuum engine (faint wide bluish bell + hot nozzle, ignition flash at t0 / EVENTS.omsBurn) ·
//   descent lunar landing engine (vacuum: a wide expanding translucent cone with a bright core near the nozzle) · plasma legacy wake.
// Animate with fx.userData.update(t, alpha?, altitude?). Altitude (for rs25/srb) defaults to the sum of the ancestors' local y positions.
// The app may rescale the group every frame (any non-uniform scale is fine). Shader cost follows ctx.quality through userData.tick.
export function flame(parent, opts = {}) {
  const { scale = 1, alpha = .8, kind = 'default' } = opts, P = FLAME_KINDS[kind] || FLAME_KINDS.default;
  const g = group(parent); g.scale.setScalar(scale);
  const col = P.cols.map(c => new THREE.Vector3(...c));
  if (opts.color !== undefined && !opts.kind) { const c = new THREE.Color(opts.color); col[1].set(c.r * 2.4, c.g * 2.4, c.b * 2.4); }
  const L0 = P.len || 16, t0 = opts.t0 ?? (kind === 'oms' ? EVENTS.omsBurn : undefined);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uT: { value: 0 }, uDirect: { value: 0 }, uA: { value: alpha / .8 }, uLen: { value: L0 }, uRmax: { value: P.rmax }, uRise: { value: .6 }, uGain: { value: P.gain }, uWide: { value: 1 }, uOct: { value: 4 },
      uSigO: { value: V(...P.sigO) }, uSigC: { value: V(...P.sigC) }, uAmp: { value: V4(...P.amp) }, uTurb: { value: V4(...P.turb) }, uDia: { value: V4(...P.dia) },
      uC0: { value: col[0] }, uC1: { value: col[1] }, uC2: { value: col[2] }, uC3: { value: col[3] }
    },
    vertexShader: FLAME_VS, fragmentShader: FLAME_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  mat.onBeforeRender = directSwitch;
  const geo = new THREE.PlaneGeometry(2, 1); geo.translate(0, .5, 0);
  const ribbon = new THREE.Mesh(geo, mat); ribbon.frustumCulled = false; ribbon.renderOrder = 5; ribbon.castShadow = false; ribbon.receiveShadow = false; g.add(ribbon);
  const glows = P.glow.map(([r, gg, b, s, y]) => hdrGlow(g, r, gg, b, s, 0, y, 0));
  const base = glows.map(o => o.scale.x), U = mat.uniforms;
  g.userData.update = (t, a, alt) => {
    U.uT.value = t; if (a !== undefined) U.uA.value = a / .8;
    const k = U.uA.value, fl = 1 + .07 * Math.sin(t * 61) + .05 * Math.sin(t * 37 + 1.3);
    let ak = 0;
    if (P.alt) {          // thinning air: the plume lengthens and spreads with altitude
      if (alt === undefined) { alt = 0; for (let p = g.parent; p; p = p.parent) alt += p.position.y; }
      ak = sstep(25, 150, alt); U.uLen.value = L0 * (1 + P.alt[0] * ak); U.uRmax.value = P.rmax * (1 + P.alt[1] * ak); U.uWide.value = 1 + P.alt[1] * 1.3 * ak;
    }
    const flash = t0 !== undefined && t >= t0 ? Math.exp(-(t - t0) * 5) : 0;
    glows.forEach((o, i) => { o.scale.setScalar(base[i] * fl * (.35 + .65 * Math.min(k, 1.3)) * (1 + (P.alt ? .9 * ak : 0) + 1.2 * flash)); o.material.opacity = clamp(k * 1.2 * (1 + .6 * flash)); });
  };
  g.userData.tick = (t, ctx) => { U.uOct.value = ctx.quality === 'low' ? 2 : ctx.quality === 'medium' ? 3 : 4; };
  g.userData.kind = kind;
  return g;
}




// ---------- procedural noise (CPU, integer hashed so every machine builds the identical atlas) ----------
function hash2(x, y, s) { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1274126177); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vn2(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm2(x, y, s, oct = 4) { let v = 0, a = .5, n = 0; for (let i = 0; i < oct; i++) { v += a * vn2(x, y, s + i * 31); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 9.7; a *= .5; } return v / n; }
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// 4x4 atlas of billowy smoke puffs. RG = view-facing normal, B = thickness, A = coverage.
let atlasTex = null;
function puffAtlas() {
  if (atlasTex) return atlasTex;
  const T = 4, S = 144, W = T * S, data = new Uint8Array(W * W * 4), h = new Float32Array(S * S);
  for (let k = 0; k < T * T; k++) {
    const ox = (k % T) * S, oy = Math.floor(k / T) * S, seed = k * 7 + 3, lr = makeRng(900 + k * 13), lobes = [];
    for (let i = 0; i < 17; i++) { const a = lr() * TAU, d = Math.sqrt(lr()) * .58, rad = .17 + lr() * .22 + (i === 0 ? .2 : 0); lobes.push([i === 0 ? 0 : Math.cos(a) * d, i === 0 ? 0 : Math.sin(a) * d, rad]); }
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const px = (x + .5) / S * 2 - 1, py = (y + .5) / S * 2 - 1;
      const wx = vn2(px * 2.2 + 3.1, py * 2.2, seed) - .5, wy = vn2(px * 2.2, py * 2.2 + 5.2, seed + 1) - .5;
      const qx = px + wx * .22, qy = py + wy * .22;
      let s = 0; for (const [cx, cy, r] of lobes) { const w = Math.max(0, 1 - Math.hypot(qx - cx, qy - cy) / r); s += w * w * w; }
      let v = Math.cbrt(s) * .95; v *= .82 + .36 * fbm2(qx * 3.2 + k, qy * 3.2, seed + 2, 3);
      h[y * S + x] = Math.max(0, v) * sstep(1, .78, Math.hypot(px, py));
    }
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i0 = y * S + x, hv = h[i0], xm = h[y * S + Math.max(x - 1, 0)], xp = h[y * S + Math.min(x + 1, S - 1)], ym = h[Math.max(y - 1, 0) * S + x], yp = h[Math.min(y + 1, S - 1) * S + x];
      let nx = -(xp - xm) * S * .38, ny = -(yp - ym) * S * .38; const nz = 1, l = Math.hypot(nx, ny, nz); nx /= l; ny /= l;
      const j = ((oy + y) * W + ox + x) * 4;
      data[j] = (nx * .5 + .5) * 255; data[j + 1] = (ny * .5 + .5) * 255; data[j + 2] = clamp(hv * 1.3) * 255; data[j + 3] = sstep(.0, .36, hv) * 255;
    }
  }
  atlasTex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat, THREE.UnsignedByteType);
  atlasTex.minFilter = THREE.LinearMipmapLinearFilter; atlasTex.magFilter = THREE.LinearFilter; atlasTex.generateMipmaps = true; atlasTex.anisotropy = 4; atlasTex.needsUpdate = true;
  return atlasTex;
}

const PUFF_VS = `
attribute vec3 iPos;attribute vec4 iA,iB;
uniform vec3 uSun;
varying vec2 vUv,vRot;varying vec4 vA,vB;varying vec3 vSunV,vUpV;
void main(){
  vec4 mv=modelViewMatrix*vec4(iPos,1.);
  float c=cos(iA.y),s=sin(iA.y);vec2 q=position.xy;
  mv.xy+=vec2(c*q.x-s*q.y,s*q.x+c*q.y)*iA.x;
  gl_Position=projectionMatrix*mv;
  vUv=position.xy+.5;vRot=vec2(c,s);vA=iA;vB=iB;
  vSunV=(viewMatrix*vec4(uSun,0.)).xyz;vUpV=(viewMatrix*vec4(0.,1.,0.,0.)).xyz;
}`;
const PUFF_FS = `
uniform sampler2D uAtlas;uniform float uSunI,uEr,uOct,uCore;uniform vec3 uSunLo,uSunHi,uSkyLo,uSkyHi,uAlb,uAlbW;
varying vec2 vUv,vRot;varying vec4 vA,vB;varying vec3 vSunV,vUpV;
${NOISE}
float fbm2(vec3 p){return vnoise(p)*.62+vnoise(p*2.1+vec3(3.7,1.3,8.1))*.38;}
void main(){
  float sd=vA.w*5.3+3.1;
  vec3 L=normalize(vSunV),upV=normalize(vUpV),col;float a;
  if(uEr>0.){
    // soft volumetric ball: smooth round profile eaten by 3D noise (more with age), lit as a sphere with a noise bump and self shadow
    vec2 c=(vUv-.5)*2.;float rr2=dot(c,c);if(rr2>=1.)discard;
    float rr=sqrt(rr2),th=sqrt(1.-rr2);
    vec2 cr=vec2(vRot.x*c.x-vRot.y*c.y,vRot.y*c.x+vRot.x*c.y);
    vec3 pc=vec3(c*2.1+sd,sd*.31+vB.z*1.6);
    float n1=uOct>1.5?fbm(pc):fbm2(pc);
    float prof=1.-smoothstep(.22,1.,rr);
    a=clamp((prof*1.6*(.45+1.1*n1)-vB.z*1.15)*1.8,0.,1.);
    a*=vA.z;if(a<.004)discard;
    vec2 Ln=vec2(vRot.x*L.x+vRot.y*L.y,-vRot.y*L.x+vRot.x*L.y);Ln=Ln/(length(Ln)+1e-3);
    float n2=fbm2(pc+vec3(Ln*.33,0.));
    float bump=clamp((n1-n2)*4.6,-.8,.8);
    vec3 n=normalize(vec3(cr*.95,max(th,.05)));
    float hemi=dot(n,upV)*.5+.5;
    vec3 Ls=normalize(L*.8+upV*.62);float dl=clamp(dot(n,Ls)*.62+.4,0.,1.);
    float lit=clamp(dl*1.05+bump*.8-.12,0.,1.);
    float thin=pow(1.-th,1.5)*(1.-.6*vB.z);
    float fwd=pow(clamp(-L.z,0.,1.),3.)*(thin*.5+.2*pow(th,3.)*(1.-vB.w))*(.35+.65*vB.y);
    vec3 sunC=mix(uSunLo,uSunHi,vB.y)*uSunI;
    vec3 skyC=mix(uSkyLo,uSkyHi,hemi);
    vec3 alb=mix(uAlb,uAlbW,vB.w);
    float core=1.-uCore*.6*pow(th,1.15)*(1.-vB.w*.5)*(.7+.3*(1.-hemi));
    vec3 li=skyC*(1.-.4*th)*1.05+sunC*(lit*.95+fwd)*(.3+.7*vB.y);
    li+=vB.x*vec3(2.5,1.05,.34)*(.2+.8*(1.-hemi))*(1.-th*.3)*(.6+.4*n1);
    col=alb*li*core*(.82+.36*n1);
  }else{
    vec2 org=vec2(mod(vA.w,4.),floor(vA.w/4.))*.25;
    vec4 tx=texture2D(uAtlas,org+(vUv*.96+.02)*.25);
    a=tx.a*vA.z;if(a<.004)discard;
    vec3 n=vec3(tx.rg*2.-1.,0.);n.xy=vec2(vRot.x*n.x-vRot.y*n.y,vRot.y*n.x+vRot.x*n.y);
    n.z=sqrt(max(1.-dot(n.xy,n.xy),0.));
    float th=tx.b;
    float wrap=clamp(dot(n,L)*.55+.45,0.,1.);
    float fwd=pow(clamp(-L.z*.5+.5,0.,1.),2.)*pow(max(1.-th,0.),1.6);
    float hemi=dot(n,upV)*.5+.5;
    vec3 sunC=mix(uSunLo,uSunHi,vB.y)*uSunI;
    vec3 skyC=mix(uSkyLo,uSkyHi,hemi);
    vec3 alb=mix(uAlb,uAlbW,vB.w);
    float shade=1.-uCore*.4*smoothstep(.25,1.,th);
    vec3 lit=skyC*(1.-.3*th)+sunC*(wrap*.45+fwd*.9)*(.3+.7*vB.y);
    lit+=vB.x*vec3(2.4,1.05,.36)*(.4+.6*(1.-hemi))*(1.-th*.45);
    col=alb*lit*shade;
  }
  gl_FragColor=vec4(col,1.);${OUT}
  gl_FragColor=vec4(gl_FragColor.rgb*a,a);
}`;

// Shared sorted-billboard particle renderer: instance data is rewritten (back to front) each frame from CPU state.
const DAWN_LOOK = { sunLo: [1, .5, .24], sunHi: [1, .8, .58], skyLo: [.25, .25, .29], skyHi: [.5, .52, .6], alb: [.84, .82, .8], albW: [.97, .97, .97] };
function makePuffMesh(parent, max, sunDir, sunI, look = DAWN_LOOK) {
  const g = new THREE.InstancedBufferGeometry(); g.index = new THREE.PlaneGeometry(1, 1).index;
  const base = new THREE.PlaneGeometry(1, 1); g.setAttribute('position', base.attributes.position);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3), iA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4), iB = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  [iPos, iA, iB].forEach(a => a.setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('iPos', iPos); g.setAttribute('iA', iA); g.setAttribute('iB', iB); g.instanceCount = 0;
  const m = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: puffAtlas() }, uSun: { value: sunDir.clone().normalize() }, uSunI: { value: sunI },
      uSunLo: { value: new THREE.Vector3(...look.sunLo) }, uSunHi: { value: new THREE.Vector3(...look.sunHi) }, uSkyLo: { value: new THREE.Vector3(...look.skyLo) }, uSkyHi: { value: new THREE.Vector3(...look.skyHi) }, uAlb: { value: new THREE.Vector3(...look.alb) }, uAlbW: { value: new THREE.Vector3(...look.albW) }, uEr: { value: look.erode || 0 }, uOct: { value: 2 }, uCore: { value: look.core || 0 } },
    vertexShader: PUFF_VS, fragmentShader: PUFF_FS, transparent: true, depthWrite: false, premultipliedAlpha: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor
  });
  const o = new THREE.Mesh(g, m); o.frustumCulled = false; o.castShadow = o.receiveShadow = false; o.renderOrder = look.order ?? 4; parent.add(o);
  return { object: o, geometry: g, iPos, iA, iB, material: m };
}

// Fills the instance buffers of `pm` from per-particle state (pos xyz, size, rot, alpha, tile, heat, lit, white), sorted far to near.
// The permutation persists between frames, so the insertion sort is ~O(n) and allocation free.
function flushPuffs(pm, S, n, camera) {
  const cp = camera.position, d = S.depth, ord = S.order, max = ord.length;
  let live = 0;
  for (let i = 0; i < max; i++) {
    if (i >= n || S.a[i] <= .002 || S.sz[i] <= 0) { d[i] = -1; continue; }
    const dx = S.p[i * 3] - cp.x, dy = S.p[i * 3 + 1] - cp.y, dz = S.p[i * 3 + 2] - cp.z;
    d[i] = dx * dx + dy * dy + dz * dz; live++;
  }
  for (let k = 1; k < max; k++) { const v = ord[k], dv = d[v]; let j = k - 1; while (j >= 0 && d[ord[j]] < dv) { ord[j + 1] = ord[j]; j--; } ord[j + 1] = v; }
  const A = pm.iPos.array, B = pm.iA.array, C = pm.iB.array;
  for (let k = 0; k < live; k++) {
    const i = ord[k];
    A[k * 3] = S.p[i * 3]; A[k * 3 + 1] = S.p[i * 3 + 1]; A[k * 3 + 2] = S.p[i * 3 + 2];
    B[k * 4] = S.sz[i]; B[k * 4 + 1] = S.rot[i]; B[k * 4 + 2] = S.a[i]; B[k * 4 + 3] = S.tile[i];
    C[k * 4] = S.heat[i]; C[k * 4 + 1] = S.lit[i]; C[k * 4 + 2] = S.er[i]; C[k * 4 + 3] = S.white[i];
  }
  pm.geometry.instanceCount = live; pm.iPos.needsUpdate = pm.iA.needsUpdate = pm.iB.needsUpdate = true;
}
const makeState = n => ({ p: new Float32Array(n * 3), sz: new Float32Array(n), rot: new Float32Array(n), a: new Float32Array(n), tile: new Float32Array(n), heat: new Float32Array(n), lit: new Float32Array(n), white: new Float32Array(n), er: new Float32Array(n), depth: new Float32Array(n), order: Uint16Array.from({ length: n }, (_, i) => i) });


const premulBlend = { transparent: true, depthWrite: false, premultipliedAlpha: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };


const DAWN = new THREE.Vector3(-.35, .08, -1).normalize();
const LAUNCH_LOOK = { sunLo: [1, .52, .26], sunHi: [1, .8, .6], skyLo: [.1, .09, .11], skyHi: [.4, .41, .5], alb: [.5, .47, .44], albW: [.72, .72, .75], erode: 1, core: .8, order: 4 };

// Launch smoke: billowing sun-lit puffs eroded by 3D noise. A ground cloud rolls out along +-X (flame trench) and up, white steam boils near
// the pad and a thick column is left along the flown ascent path (boosters burn out at u=.585, ~t=11.7 s). The cloud grows over ~3 s and keeps a
// clear corridor around the flame so the engines stay visible. Drawn at renderOrder 4 (after the transparent sea 1 and mist 2, before the flames).
// path(u, out) -> out (THREE.Vector3) gives the vehicle position (parent space) at stage progress u (stage length 20 s).
// Returns { object (the mesh), positions (Float32Array xyz per particle, creation order), update(t, u), setQuality(q) }.
export function createLaunchPlume(parent, path) {
  const NG = 190, NS = 80, NC = 300, N = NG + NS + NC, STAGE = 20;
  const r = makeRng(7723), pv = new THREE.Vector3();
  const list = [];
  // k0: ground wall rolling out along the flame trench (+-X) and low over the pad: few, big, overlapping, dense puffs
  for (let i = 0; i < NG; i++) {
    const trench = r() < .8, side = r() < .5 ? -1 : 1, ang = trench ? (side < 0 ? Math.PI : 0) + (r() - .5) * .7 : r() * TAU, tb = 6.2 * Math.pow(r(), 1.9), cls = r();
    const big = cls < .3;
    list.push({ k: 0, tb, life: 13 + r() * 6, dx: Math.cos(ang), dz: Math.sin(ang) * (trench ? .6 : 1), v: (trench ? 12 + r() * 12 : 6 + r() * 7) * (1 - .4 * tb / 6.2) * (tb < 1.2 ? 1.6 : 1), tau: tb < 1.2 ? 1.9 + r() * .6 : 3.2 + r() * 1.3, s0: tb < 1.4 ? 1 : .5, x0: (r() - .5) * 14, z0: (r() - .5) * 9, y0: .5 + r() * 2, h: 2 + r() * r() * 12, w: .06 + r() * .26,
      s: big ? 20 + r() * 9 : 13 + r() * 8, al: .66 + r() * .26, hot: r() < .5 ? .9 : .5, tile: Math.floor(r() * 16), rot: r() * TAU, rs: (r() - .5) * .18, ph: r() * 6 });
  }
  // k1: white steam boiling up around the pad
  for (let i = 0; i < NS; i++) {
    const ang = r() * TAU, tb = 7 * Math.pow(r(), 1.2);
    list.push({ k: 1, tb, life: 8 + r() * 5, dx: Math.cos(ang), dz: Math.sin(ang), v: 3 + r() * 11, tau: 2.6, x0: (r() - .5) * 18, z0: (r() - .5) * 12, y0: 1 + r() * 3, h: 14 + r() * 26, w: 1.6 + r() * 2.8, s: 10 + r() * 8, al: .66 + r() * .24, hot: .55, tile: Math.floor(r() * 16), rot: r() * TAU, rs: (r() - .5) * .3, ph: r() * 6 });
  }
  // k2: continuous exhaust column laid down along the flown ascent path
  for (let i = 0; i < NC; i++) {
    const early = i < NC * .64, tb = early ? .3 + r() * 11.4 : 11.7 + r() * 8.3, ang = r() * TAU, lane = [-4.55, 0, 4.55][Math.floor(r() * 3)];
    path(clamp(tb / STAGE), pv);
    list.push({ k: 2, tb, life: 15 + r() * 8, dx: Math.cos(ang), dz: Math.sin(ang), v: (early ? 5 + r() * 7 : 2.5 + r() * 3.5), tau: 4, x0: pv.x + lane * (early ? 1 : 0) + (r() - .5) * 2.5, z0: pv.z + (r() - .5) * 2.5, y0: pv.y + 1, h: 4 + r() * 6, w: .6, s: early ? 8 + r() * 5 : 5.5 + r() * 4, al: early ? .66 + r() * .22 : .4 + r() * .2, hot: early ? 1 : .3, tile: Math.floor(r() * 16), rot: r() * TAU, rs: (r() - .5) * .22, ph: r() * 6, thin: early ? 0 : 1 });
  }
  // deterministic shuffle so any prefix is an even mix of the three kinds
  const keys = list.map(() => r()), idx = list.map((_, i) => i).sort((a, b) => keys[a] - keys[b]), P = idx.map(i => list[i]);
  const S = makeState(N), pm = makePuffMesh(parent, N, DAWN, 2.0, LAUNCH_LOOK), positions = new Float32Array(N * 3);
  let active = N;
  const padGlow = hdrGlow(parent, 2.4, 1.05, .4, 60, 0, 9, 0); padGlow.visible = false;
  pm.object.visible = false;
  pm.object.userData.tick = (t, ctx) => { pm.material.uniforms.uOct.value = ctx.quality === 'low' ? 1 : 2; flushPuffs(pm, S, active, ctx.camera); };
  return {
    object: pm.object, positions,
    update(t) {
      pm.object.visible = t > 0;
      padGlow.visible = t > 0 && t < 8; padGlow.material.opacity = clamp(1.05 - t / 6.5) * .45; padGlow.scale.setScalar(44 + 24 * clamp(1 - t / 4) + 5 * Math.sin(t * 29));
      const glowK = Math.max(0, 1 - t / 7.5);
      path(clamp(t / STAGE), pv); const vx = pv.x, vy = pv.y, vz = pv.z;
      for (let i = 0; i < active; i++) {
        const p = P[i], age = t - p.tb; let x, y, z, size = 0, a = 0, heat = 0, lit = .4, white = 0, er = 0;
        if (age >= 0 && age < p.life) {
          const e = 1 - Math.exp(-age / p.tau), e2 = 1 - Math.exp(-age / 4.2), fa = age / p.life;
          if (p.k === 0) {
            const rr = p.v * p.tau * e; x = p.x0 + p.dx * rr + age * .3; z = p.z0 + p.dz * rr;
            size = p.s * (p.s0 + (1.9 - p.s0) * e2 * .74); y = p.y0 + p.h * (1 - Math.exp(-age / 2.4)) + age * p.w + Math.sin(age * .7 + p.ph) * .8; y = Math.max(y, size * .36);
            a = p.al * sstep(0, .3, age) * (1 - sstep(p.life * .5, p.life, age)) * (1 - .3 * e);
            heat = clamp(p.hot * Math.exp(-age / 1.9) + glowK * Math.exp(-Math.sqrt(x * x + z * z) / 45) * .5); lit = .35 + .3 * sstep(0, 40, y); er = .06 + .46 * sstep(.2, .95, fa);
          } else if (p.k === 1) {
            x = p.x0 + p.dx * p.v * e; z = p.z0 + p.dz * p.v * e; size = p.s * (.45 + 1.3 * e2); y = p.y0 + p.h * e + age * p.w;
            a = p.al * sstep(0, .4, age) * (1 - sstep(p.life * .4, p.life, age)); heat = clamp(p.hot * Math.exp(-age / 2) + glowK * .5); lit = .4 + .3 * sstep(0, 30, y); white = .4; er = .16 + .4 * sstep(.1, .9, fa);
          } else {
            const rad = 1.2 + p.v * (1 - Math.exp(-age / 3.6)) * (.7 + .3 * Math.min(age / 6, 1));
            x = p.x0 + p.dx * rad + age * .4; z = p.z0 + p.dz * rad; y = p.y0 + p.h * e + Math.sin(age * .5 + p.ph) * .8;
            size = p.s * (.6 + 2 * (1 - Math.exp(-age / 4.6)));
            a = p.al * sstep(0, .5, age) * (1 - sstep(p.life * .42, p.life, age)) * (1 - .5 * sstep(60, 210, p.y0));
            heat = p.hot * Math.exp(-age / .95); lit = .45 + .55 * sstep(8, 120, y); er = .06 + .5 * sstep(.1, .95, fa);
          }
          // flame corridor: keep the nozzles and the first stretch of flame clear of smoke between them and the camera
          const dx = Math.abs(x - vx) - size * .22, dz = z - vz;
          if (y < vy + 4 && dz > -8 && dz < 40) a *= p.k === 2 ? .55 + .45 * sstep(4, 11, dx) : .1 + .9 * sstep(6, 16, dx);
        } else { x = y = z = 0; }
        positions[i * 3] = S.p[i * 3] = x; positions[i * 3 + 1] = S.p[i * 3 + 1] = y; positions[i * 3 + 2] = S.p[i * 3 + 2] = z;
        S.sz[i] = size; S.a[i] = a; S.heat[i] = heat; S.lit[i] = lit; S.white[i] = white; S.tile[i] = p.tile; S.rot[i] = p.rot + p.rs * age; S.er[i] = er;
      }
    },
    setQuality(q) { active = q === 'low' ? Math.floor(N * .5) : N; }
  };
}



// ---------- lunar landing dust ----------
const LUNAR_SUN = new THREE.Vector3(-180, 32, 100).normalize();
const LUNAR_LOOK = { sunLo: [1, .86, .7], sunHi: [1, .9, .75], skyLo: [.1, .1, .11], skyHi: [.18, .18, .2], alb: [.62, .58, .52], albW: [.62, .58, .52] };

const DUST_SHEET_VS = `
uniform vec2 uC;uniform float uI,uH;
varying vec2 vR;
void main(){
  vec3 p=position;vec2 d=p.xz-uC;float r=length(d);
  p.y+=.5+uH+r*.02*uI;
  vR=d;
  gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(p,1.);
}`;
// Thin fast sheet of regolith racing out of the engine. Streak directions are warped by a coherent fbm field (curved, irregular), built from
// three non-harmonic angular frequencies with an angle-dependent radial stretch; the streak contrast fades into a smooth haze disc near the
// engine (no pinch), brightness tapers with range and the sun-facing side (-X) is lit brighter than the lander-shadow side.
const DUST_SHEET_FS = `
uniform float uT,uI,uR0,uOct,uLay,uAmp,uRch;uniform vec2 uSun;
varying vec2 vR;
${NOISE}
void main(){
  float r=length(vR);
  vec2 dir=vR/max(r,1e-3);
  int oc=uOct>1.5?3:2;
  vec3 wp=vec3(vR*.034+uLay*13.,uT*.12);
  float w1=fbmN(wp,oc)-.5,w2=vnoise(wp*2.9+vec3(5.,2.,1.))-.5;
  float an=atan(vR.y,vR.x)+w1*1.15+w2*.42*smoothstep(4.,34.,r);
  vec2 cs=vec2(cos(an),sin(an));
  float st=.04+.06*vnoise(vec3(cs*1.6+uLay*3.1,3.7));
  float s1=vnoise(vec3(cs*8.3+uLay*5.,(r-uT*23.)*st));
  float s2=vnoise(vec3(cs*17.9+4.1,(r-uT*31.)*st*1.8+3.));
  float s3=vnoise(vec3(cs*29.3+8.3,(r-uT*41.)*st*3.1+7.));
  float s4=vnoise(vec3(cs*53.7+2.9,(r-uT*52.)*st*4.7+11.));
  float streak=smoothstep(.22,.8,s1*.4+s2*.28+s3*.2+s4*.12);
  float haze=fbmN(vec3(vR*.055+uLay*7.+vec3(7.,3.,1.).xy,uT*.2),oc);
  float sc=smoothstep(uR0*.6,uR0*2.6,r);
  float dens=mix(.35+.65*haze,.1+.62*streak*(.5+.9*haze)+.3*haze*haze,sc);
  float L0=uR0*1.3;
  float rs=r/uRch;
  float env=(.26*exp(-rs*rs/(2.*L0*L0))+.85*exp(-rs/(21.+uR0*1.2)))*(1.-smoothstep(22.,66.,rs));
  float a=uI*uAmp*env*dens*.86;
  if(a<.002)discard;
  float sd=dot(dir,uSun);
  float shadow=1.-.5*smoothstep(.8,.97,-sd)*(1.-exp(-r/10.));
  float lit=(.66+.4*smoothstep(-.8,.9,sd))*shadow;
  vec3 col=mix(vec3(.5,.47,.43),vec3(.98,.88,.74),.5+.3*streak)*lit;
  gl_FragColor=vec4(col,1.);${OUT}
  gl_FragColor=vec4(gl_FragColor.rgb*a,a);
}`;
const STREAK_VS = `
attribute vec3 iPos;attribute vec4 iDir,iA;
varying vec2 vUv;varying float vAl;
void main(){
  vec3 c=(modelMatrix*vec4(iPos,1.)).xyz;vec3 d=normalize((modelMatrix*vec4(iDir.xyz,0.)).xyz);
  vec3 tc=normalize(cameraPosition-c);vec3 side=cross(d,tc);float sl=length(side);side=sl>1e-3?side/sl:vec3(0.,1.,0.);
  vec3 p=c+d*(position.y+.5)*iDir.w+side*position.x*iA.x;
  vUv=position.xy+.5;vAl=iA.y;
  gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);
}`;
const STREAK_FS = `
varying vec2 vUv;varying float vAl;
void main(){
  float q=(vUv.x-.5)*3.4,across=exp(-q*q),along=pow(max(vUv.y,0.),1.5)*smoothstep(1.,.86,vUv.y);
  float a=across*along*vAl;if(a<.003)discard;
  vec3 col=vec3(1.,.86,.66)*1.1;
  gl_FragColor=vec4(col,1.);${OUT}
  gl_FragColor=vec4(gl_FragColor.rgb*a,a);
}`;

// Regolith kicked up by the descent/ascent engine. No air: a thin radial sheet of streaks races out low over the ground on ballistic arcs
// (1/6 g, straight in plan) with a faint ground-hugging haze, no billowing. Intensity grows as the engine nears the ground (visible below ~55
// units). The effect does not stop when the engine cuts: after EVENTS.touchdown the grains already in flight keep falling and the sheet decays
// over ~6 s. update(t, x, height, active) with the engine at (x, height, 0); the ground is read from terrain.js heights().
// Returns { object (group), positions (streak centres, xyz each), update, setQuality }.
export function createLandingDust(parent) {
  const NS = 460, rr = makeRng(4417), G_MOON = 1.62;
  const root = group(parent), HALF = 96, SEG = 96;
  // ground-hugging blast sheet (static terrain-following grid, shaded procedurally around the engine)
  const sg = new THREE.PlaneGeometry(HALF * 2, HALF * 2, SEG, SEG); sg.rotateX(-Math.PI / 2);
  const sp = sg.attributes.position, hg = new Float32Array(sp.count), G1 = SEG + 1;
  for (let i = 0; i < sp.count; i++) hg[i] = heights(sp.getX(i), sp.getZ(i));
  // dilate: the sheet sits on the highest neighbouring sample so it never sinks into crater walls between grid points
  for (let j = 0; j < G1; j++) for (let k = 0; k < G1; k++) { let m = -1e9; for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) { const a = j + dj, b = k + dk; if (a >= 0 && b >= 0 && a < G1 && b < G1) m = Math.max(m, hg[a * G1 + b]); } sp.setY(j * G1 + k, m); }
  const U = { uT: { value: 0 }, uI: { value: 0 }, uR0: { value: 6 }, uOct: { value: 2 }, uC: { value: new THREE.Vector2() }, uSun: { value: new THREE.Vector2(LUNAR_SUN.x, LUNAR_SUN.z).normalize() } };
  // three thin layers (ground, ~1.4 and ~3 units up) give the sheet some thickness when seen at a grazing angle
  const sheets = [[0, 1, 0, 1], [1.7, .66, 1, .72], [3.6, .46, 2, .5]].map(([h, amp, lay, rch]) => {
    const m = new THREE.ShaderMaterial({ uniforms: { ...U, uH: { value: h }, uAmp: { value: amp }, uLay: { value: lay }, uRch: { value: rch } }, vertexShader: DUST_SHEET_VS, fragmentShader: DUST_SHEET_FS, ...premulBlend, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const o = new THREE.Mesh(sg, m); o.frustumCulled = false; o.castShadow = o.receiveShadow = false; o.renderOrder = -4 + lay * .1; root.add(o); return o;
  });
  // racing streaks (long) and grains (short dashes)
  const quad = new THREE.PlaneGeometry(1, 1), geo = new THREE.InstancedBufferGeometry(); geo.index = quad.index; geo.setAttribute('position', quad.attributes.position);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(NS * 3), 3), iDir = new THREE.InstancedBufferAttribute(new Float32Array(NS * 4), 4), iA = new THREE.InstancedBufferAttribute(new Float32Array(NS * 4), 4);
  [iPos, iDir, iA].forEach(a => a.setUsage(THREE.DynamicDrawUsage)); geo.setAttribute('iPos', iPos); geo.setAttribute('iDir', iDir); geo.setAttribute('iA', iA); geo.instanceCount = 0;
  const streakMat = new THREE.ShaderMaterial({ vertexShader: STREAK_VS, fragmentShader: STREAK_FS, ...premulBlend, side: THREE.DoubleSide });
  const streaks = new THREE.Mesh(geo, streakMat); streaks.frustumCulled = false; streaks.castShadow = streaks.receiveShadow = false; streaks.renderOrder = -3; root.add(streaks);
  const sd = Array.from({ length: NS }, (_, i) => { const grain = i % 3 !== 0; return { life: grain ? .9 + rr() * 1.3 : 1.2 + rr() * 1.6, off: rr() * 10, v: grain ? 14 + rr() * 48 : 24 + rr() * 56, tan: .02 + rr() * rr() * .26, len: grain ? .5 + rr() * 1.3 : 2.4 + rr() * 6, w: grain ? .06 + rr() * .09 : .12 + rr() * .22, al: grain ? .4 + rr() * .4 : .22 + rr() * .34 }; });
  const positions = new Float32Array(NS * 3); let nS = NS;
  root.visible = false;
  const TAU_CUT = 1.7;   // decay time constant of the plume of regolith after the engine stops (s)
  return {
    object: root, positions,
    update(t, x, height, active) {
      const since = t - EVENTS.touchdown, post = !active && since > 0 && since < 9 && height < 3;
      const engine = active ? sstep(58, 4, height) : 0, I = post ? Math.exp(-since / TAU_CUT) : engine;
      root.visible = I > .003; if (!root.visible) return;
      U.uT.value = t; U.uI.value = post ? Math.exp(-since / 2.2) : I; U.uC.value.set(x, 0); U.uR0.value = 3.5 + height * .3 + (post ? since * 1.6 : 0);
      const r0 = 3 + height * .22, A = iPos.array, D = iDir.array, B = iA.array;
      for (let i = 0; i < nS; i++) {
        const s = sd[i], ph = (t + s.off) / s.life, k = Math.floor(ph), age = (ph - k) * s.life, ts = t - age;
        // intensity when this grain was kicked up: the live engine value while it burns, then the decaying post-cutoff value
        const Is = active ? engine : ts <= EVENTS.touchdown ? 1 : Math.exp(-(ts - EVENTS.touchdown) / TAU_CUT);
        const ang = hash2(k, i, 11) * TAU, c = Math.cos(ang), sn = Math.sin(ang), rad = r0 + s.v * age, px = x + c * rad, pz = sn * rad;
        const vy = s.v * s.tan, up = Math.max(vy * age - .5 * G_MOON * age * age, 0);
        const fade = sstep(0, .1, age) * (1 - sstep(.4, 1, age / s.life)) * (.55 + .45 * hash2(k, i, 12)), keep = hash2(k, i, 13) < .3 + .7 * Is;
        const y = heights(px, pz) + .2 + up, dl = 1 / Math.sqrt(s.v * s.v + (vy - G_MOON * age) ** 2);
        A[i * 3] = px; A[i * 3 + 1] = y; A[i * 3 + 2] = pz; positions[i * 3] = px; positions[i * 3 + 1] = y; positions[i * 3 + 2] = pz;
        D[i * 4] = c * s.v * dl; D[i * 4 + 1] = (vy - G_MOON * age) * dl; D[i * 4 + 2] = sn * s.v * dl; D[i * 4 + 3] = s.len * (.6 + age * .5);
        B[i * 4] = s.w * (1 + age * .8); B[i * 4 + 1] = keep ? s.al * fade * Is * .8 : 0;
      }
      geo.instanceCount = nS; iPos.needsUpdate = iDir.needsUpdate = iA.needsUpdate = true;
    },
    setQuality(q) { nS = q === 'low' ? 150 : q === 'medium' ? 330 : NS; U.uOct.value = q === 'low' ? 1 : 2; sheets[1].visible = sheets[2].visible = q !== 'low'; }
  };
}



// ---------- re-entry plasma ----------
// 32^3 tileable value-noise volume (R channel, 3 octaves) used by the volumetric plasma. Integer hashed -> identical everywhere.
let nzTex = null;
function noiseVolume() {
  if (nzTex) return nzTex;
  const N = 32, d = new Uint8Array(N * N * N);
  const lat = (f, s) => { const a = new Float32Array(f * f * f); for (let z = 0; z < f; z++) for (let y = 0; y < f; y++) for (let x = 0; x < f; x++) a[(z * f + y) * f + x] = hash2(x + z * 57, y + z * 13, s); return a; };
  const L = [[4, lat(4, 11), .55], [8, lat(8, 23), .3], [16, lat(16, 37), .15]];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0;
    for (const [f, a, w] of L) {
      const gx = x / N * f, gy = y / N * f, gz = z / N * f, ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz), fx = gx - ix, fy = gy - iy, fz = gz - iz;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
      const x0 = ix % f, y0 = iy % f, z0 = iz % f, x1 = (ix + 1) % f, y1 = (iy + 1) % f, z1 = (iz + 1) % f, G = (i, j, k) => a[(k * f + j) * f + i];
      const c00 = G(x0, y0, z0) + (G(x1, y0, z0) - G(x0, y0, z0)) * ux, c10 = G(x0, y1, z0) + (G(x1, y1, z0) - G(x0, y1, z0)) * ux, c01 = G(x0, y0, z1) + (G(x1, y0, z1) - G(x0, y0, z1)) * ux, c11 = G(x0, y1, z1) + (G(x1, y1, z1) - G(x0, y1, z1)) * ux;
      const c0 = c00 + (c10 - c00) * uy, c1 = c01 + (c11 - c01) * uy; v += w * (c0 + (c1 - c0) * uz);
    }
    d[(z * N + y) * N + x] = Math.round(clamp(v) * 255);
  }
  nzTex = new THREE.Data3DTexture(d, N, N, N); nzTex.format = THREE.RedFormat; nzTex.type = THREE.UnsignedByteType;
  nzTex.minFilter = nzTex.magFilter = THREE.LinearFilter; nzTex.wrapS = nzTex.wrapT = nzTex.wrapR = THREE.RepeatWrapping; nzTex.unpackAlignment = 1; nzTex.needsUpdate = true;
  return nzTex;
}

// Volumetric shock layer + wake, ray-marched in the capsule's own space (R units; heat shield faces -Y, flow comes from -Y).
const PLASMA_VS = `
varying vec3 vPos,vRo;
void main(){
  vPos=position;vRo=(inverse(modelMatrix)*vec4(cameraPosition,1.)).xyz;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
}`;
const PLASMA_FS = `
precision highp sampler3D;
uniform sampler3D uNz;uniform float uT,uH,uR,uY0,uYtop,uGain,uWake;uniform int uSteps;uniform vec3 uBlo,uBhi;uniform float uOct;
varying vec3 vPos,vRo;
float nz(vec3 p){return texture(uNz,p).r;}
float sq(float x){return x*x;}
float body(vec3 q){ // 1 inside the capsule solid (shield dish, backshell cone)
  float r=length(q.xz),ys=r<1.?.09*r*r:.09;
  float rb=max(1.-.62*(q.y-.08)/.74,.38);
  return (q.y>ys&&q.y<uYtop&&r<rb)?1.:0.;
}
void main(){
  vec3 O=vec3(0.,uY0,0.),ro=(vRo-O)/uR,rd=normalize(vPos-vRo);
  vec3 inv=1./rd,b0=(uBlo-O)/uR,b1=(uBhi-O)/uR,ta=(b0-ro)*inv,tb=(b1-ro)*inv,tmn=min(ta,tb),tmx=max(ta,tb);
  float tn=max(max(tmn.x,tmn.y),max(tmn.z,0.)),tf=min(min(tmx.x,tmx.y),tmx.z);
  if(tf<=tn)discard;
  float jit=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  float h=uH,th=.5+.5*h,hh=pow(h,1.25);
  vec3 acc=vec3(0.);float t=tn+jit*.1;
  for(int i=0;i<72;i++){
    if(t>tf||i>=uSteps)break;
    vec3 q=ro+rd*t;
    float r=length(q.xz),y=q.y;
    if(body(q)>.5)break;
    // shock front: offset surface of the shield, then a swept flank
    float ys=r<1.?.09*r*r:.09,ysh=r<1.?ys-(.1+.1*r*r)*th:(.09-.2*th)+1.1*(r-1.)+.1*sq(r-1.);
    float u=y-ysh;
    float dl=max(abs(u-.1*th)-.14*th,0.);
    float dt=clamp(dl*.6+.028,.028,.26);
    vec3 e=vec3(0.);
    if(u>-.02&&u<.5&&r<1.95&&y<1.1){
      float nv=nz(vec3(q.x*.8+uT*.05,q.y*.8-uT*.3,q.z*.8))*.6+(uOct>1.5?nz(vec3(q.xz*2.3,q.y*2.3-uT*.9).xzy)*.4:.2);
      float cor=.5+1.1*nv;
      float front=exp(-max(u,0.)/(.03*th))*smoothstep(0.,.01,u+.01);
      float sf=r<1.?ys-y:0.;
      float rc=1.-.6*clamp((y-.08)/.74,0.,1.),dflank=r-rc;
      float bl=r<1.?exp(-max(sf,0.)/(.05*th))*step(0.,sf+.01):exp(-max(dflank,0.)/(.07*th))*exp(-max(y-.08,0.)/.5);
      float fill=.14*smoothstep(0.,.02,u)*(1.-smoothstep(.1,.32*th,u));
      float mask=smoothstep(.0,.015,u)*(1.-smoothstep(.1,.28*th+.06*(r-1.),u));
      float flank=r>1.?exp(-(r-1.)*6.)*(1.-smoothstep(.3,.9,y)):1.;
      float stag=mix(1.,.5,smoothstep(.45,1.,r));
      float Tl=((front*.8*(1.-smoothstep(1.,1.3,r))+fill*.5*(1.-smoothstep(.9,1.15,r)))+bl*1.1*flank)*stag*mask*cor;
      vec3 c=Tl<.35?mix(vec3(1.2,.28,.06),vec3(3.,1.35,.42),Tl/.35):Tl<.8?mix(vec3(3.,1.35,.42),vec3(4.4,3.4,2.2),(Tl-.35)/.45):mix(vec3(4.4,3.4,2.2),vec3(5.2,4.5,3.5),clamp((Tl-.8)/.6,0.,1.));
      float edge=exp(-max(u,0.)/(.012*th))*smoothstep(0.,.006,u)*.35*(1.-smoothstep(.4,.9,y));
      e+=(c*Tl+vec3(.7,.25,1.1)*edge*cor)*16.*hh;
    }
    float yw=y-.3;
    if(yw>0.&&yw<14.&&r<3.2){
      float rw=.72+.065*yw;
      float core=exp(-sq(r/rw)*1.5),ring=exp(-sq((r-(1.-.45*smoothstep(0.,1.8,yw)))/.3))*exp(-yw/1.2);
      float fil=nz(vec3(q.x*1.5+.3,yw*.42-uT*.9,q.z*1.5))*.62+nz(vec3(q.x*3.4,yw*.9-uT*1.7,q.z*3.4+.7))*.38;
      float tc=clamp((fil-.5)*3.4+.5+.12*exp(-yw*.5),0.,1.3);
      float dn=(core*.55+ring*.95)*mix(.15,1.25,tc)*(1.-smoothstep(.9,1.35,tc)*.0);
      float amp=exp(-yw/(2.2+2.8*h))+.2*exp(-yw/7.5)*sqrt(h);
      vec3 c=mix(vec3(3.2,1.4,.4),vec3(.8,.14,.04),smoothstep(0.,5.,yw));
      e+=c*dn*amp*uWake*1.1*(1.-smoothstep(.55,1.,r/2.35))*(1.-smoothstep(9.,13.5,yw));
    }
    acc+=e*dt;
    t+=dt;
  }
  acc*=uGain;
  if(max(acc.r,max(acc.g,acc.b))<.002)discard;
  gl_FragColor=vec4(acc,1.);${OUT}
}`;
const SPARK_VS = `
attribute vec4 iA,iB;uniform float uT,uHeat,uR,uY0;
varying vec2 vUv;varying float vAl,vAge;
float hs(float x){return fract(sin(x)*43758.5453);}
void main(){
  float ph=uT*iB.x+iA.z,age=fract(ph),cyc=floor(ph),sec=age/iB.x;
  float h1=hs(cyc*12.9898+iA.w*78.233),h2=hs(cyc*7.13+iA.w*31.7),h3=hs(cyc*3.31+iA.w*17.3);
  float ang=iA.x+(h1-.5)*1.3;vec2 dir=vec2(cos(ang),sin(ang));
  float rs=uR*(1.+.08*h2),y0=uY0+uR*(.06+.55*h3*h3);                   // on the shield rim / leeward backshell, never ahead of the shield
  float back=iA.y*sec*(1.+.3*sec)*uR,lat=iB.y*sec*(1.-.35*sec)*uR*(.5+h2);
  vec3 c=vec3(dir.x*(rs+lat),y0+back,dir.y*(rs+lat));
  vec3 d=normalize(vec3(dir.x*iB.y*.5,iA.y*(1.+.6*sec),dir.y*iB.y*.5));
  vec3 cw=(modelMatrix*vec4(c,1.)).xyz,dw=normalize((modelMatrix*vec4(d,0.)).xyz);
  vec3 tc=normalize(cameraPosition-cw);vec3 side=cross(dw,tc);float sl=length(side);side=sl>1e-3?side/sl:vec3(1.,0.,0.);
  float sc=length(modelMatrix[0].xyz);
  float len=(.1+.012*iA.y)*uR*sc*(1.-.45*age),w=(.012+.014*iB.z)*uR*sc;
  vec3 p=cw+dw*(position.y-.5)*len+side*position.x*w;
  vUv=position.xy+.5;vAge=age;
  vAl=(1.-age)*(.3+.7/(1.+age*9.))*smoothstep(0.,.03,age)*smoothstep(.12,.5,uHeat);
  gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);
}`;
const SPARK_FS = `
varying vec2 vUv;varying float vAl,vAge;
void main(){
  float x=(vUv.x-.5)*2.,across=exp(-x*x*3.),along=smoothstep(0.,.35,vUv.y);
  float a=across*along*vAl;if(a<.004)discard;
  vec3 col=mix(vec3(4.8,3.4,1.7),vec3(1.5,.32,.07),smoothstep(0.,.75,vAge));
  gl_FragColor=vec4(col*a,1.);${OUT}
}`;

// Dimensions of a crew-module group in its own space (heat shield faces local -Y). The named 'shield' / 'cm' meshes are measured when they
// exist (the union of every mesh was far too large: the old sheath floated ~1R ahead of the shield), then userData.shieldRadius/shieldY.
function capsuleDims(capsule) {
  capsule.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(capsule.matrixWorld).invert(), M = new THREE.Matrix4(), box = new THREE.Box3(), b = new THREE.Box3();
  const meas = (o, into) => { if (o && o.isMesh && o.geometry) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); M.multiplyMatrices(inv, o.matrixWorld); b.copy(o.geometry.boundingBox).applyMatrix4(M); into.union(b); return true; } return false; };
  const sh = new THREE.Box3(), cm = new THREE.Box3(), ok = meas(capsule.getObjectByName('shield'), sh), ok2 = meas(capsule.getObjectByName('cm'), cm);
  if (ok && ok2) return { R: Math.max(sh.max.x - sh.min.x, sh.max.z - sh.min.z) / 2, minY: sh.min.y, maxY: cm.max.y };
  const ud = capsule.userData;
  if (ud.shieldRadius) return { R: ud.shieldRadius, minY: ud.shieldY ?? -.15, maxY: (ud.shieldY ?? -.15) + ud.shieldRadius * .95 };
  capsule.traverse(o => { if (!o.userData.fx) meas(o, box); });
  if (box.isEmpty()) return { R: 2.8, minY: -.15, maxY: 2.45 };
  return { R: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2, minY: box.min.y, maxY: box.max.y };
}

// Re-entry plasma around a capsule whose heat shield faces local -Y: a thin white-yellow shock layer hugging the shield (violet only in the
// outermost skin) that sweeps back into a turbulent, tapering orange wake with a long dim cooling tail, plus sparse ablation embers streaming
// back from the rim. Volumetric (ray-marched proxy box), so no hard sleeve edges. update(t, heat 0..1, trailVisible): the wake fades with heat
// (trailVisible is only a soft hint now). Intensity is HDR and scales with heat. Extras: returned object.group, radius.
export function createEntryPlasma(capsule) {
  const { R, minY, maxY } = capsuleDims(capsule), root = group(capsule);
  const bx = 2.5 * R, lo = new THREE.Vector3(-bx, minY - .7 * R, -bx), hi = new THREE.Vector3(bx, minY + 15 * R, bx);
  const bg = new THREE.BoxGeometry(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z); bg.translate((hi.x + lo.x) / 2, (hi.y + lo.y) / 2, (hi.z + lo.z) / 2);
  const pm = new THREE.ShaderMaterial({
    uniforms: { uNz: { value: noiseVolume() }, uT: { value: 0 }, uH: { value: 0 }, uR: { value: R }, uY0: { value: minY }, uYtop: { value: Math.min((maxY - minY) / R, 1.25) }, uGain: { value: .19 }, uWake: { value: 1 }, uSteps: { value: 64 }, uOct: { value: 2 }, uBlo: { value: lo }, uBhi: { value: hi } },
    vertexShader: PLASMA_VS, fragmentShader: PLASMA_FS, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.BackSide
  });
  const vol = new THREE.Mesh(bg, pm); vol.frustumCulled = false; vol.castShadow = vol.receiveShadow = false; vol.renderOrder = 7; vol.userData.fx = true; root.add(vol);
  // sparks
  const NSP = 64, sr = makeRng(8801), quad = new THREE.PlaneGeometry(1, 1), sg = new THREE.InstancedBufferGeometry(); sg.index = quad.index; sg.setAttribute('position', quad.attributes.position);
  const A = new Float32Array(NSP * 4), B = new Float32Array(NSP * 4);
  for (let i = 0; i < NSP; i++) {
    const ember = i >= NSP - 8;
    A.set([sr() * TAU, ember ? 2.5 + sr() * 3 : 5 + sr() * 7, sr(), sr()], i * 4);
    B.set([ember ? .55 + sr() * .35 : 1.1 + sr() * 1.1, (sr() - .3) * .5, ember ? 1.6 + sr() : sr() * .9, 0], i * 4);
  }
  sg.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 4)); sg.setAttribute('iB', new THREE.InstancedBufferAttribute(B, 4)); sg.instanceCount = NSP;
  const sparkM = new THREE.ShaderMaterial({ uniforms: { uT: { value: 0 }, uHeat: { value: 0 }, uR: { value: R }, uY0: { value: minY } }, vertexShader: SPARK_VS, fragmentShader: SPARK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const sparks = new THREE.Mesh(sg, sparkM); sparks.frustumCulled = false; sparks.castShadow = false; sparks.renderOrder = 8; sparks.userData.fx = true; root.add(sparks);
  // soft warm glows at the stagnation point (kept small: the volume carries the shape)
  const g1 = hdrGlow(root, 2.2, 1.2, .55, R * 2.6, 0, minY - .12 * R, 0), g2 = hdrGlow(root, 1.1, .32, .1, R * 5.2, 0, minY + .5 * R, 0);
  root.visible = false;
  root.userData.tick = (t, ctx) => { const q = ctx.quality; pm.uniforms.uSteps.value = q === 'low' ? 30 : q === 'high' ? 72 : 52; pm.uniforms.uOct.value = q === 'low' ? 1 : 2; sg.instanceCount = q === 'low' ? 30 : NSP; };
  return {
    group: root, radius: R,
    update(t, heat, trailVisible) {
      const h = clamp(heat); root.visible = h > .004;
      if (!root.visible) return;
      const U = pm.uniforms; U.uT.value = sparkM.uniforms.uT.value = t; U.uH.value = sparkM.uniforms.uHeat.value = h;
      U.uWake.value = Math.pow(sstep(0, .75, h), 1.2);   // trailVisible is ignored: the wake fades with heat, never pops
      const fl = 1 + .05 * Math.sin(t * 23) + .03 * Math.sin(t * 41 + 1);
      g1.material.opacity = clamp(h * .8); g1.scale.setScalar(R * (1.4 + 1.2 * h) * fl);
      g2.material.opacity = clamp(h * .22); g2.scale.setScalar(R * (3 + 2 * h) * fl);
    }
  };
}


// ---------- splashdown: water crown, rebound spikes, droplets, mist, foam ----------
const T_SPLASH = EVENTS.splash;                       // capsule hits the water
const SPLASH_SUN = new THREE.Vector3(-.35, .03, -1).normalize();
const SPLASH_LOOK = { sunLo: [1, .72, .5], sunHi: [1, .85, .65], skyLo: [.2, .22, .27], skyHi: [.46, .5, .58], alb: [.9, .94, .96], albW: [.95, .97, 1] };
const SWELL = [Math.cos(78 * Math.PI / 180), Math.sin(78 * Math.PI / 180)];   // dominant swell direction of ocean.js (+X toward +Z)
const GERST = `
uniform vec4 uWA[8],uWB[8];uniform float uTW;
vec3 gerst(vec2 p){
  float r=length(p);vec3 o=vec3(0.);
  for(int i=0;i<8;i++){vec4 a=uWA[i],b=uWB[i];float att=1.-smoothstep(b.w,b.w*2.,r);
    float th=a.z*dot(a.xy,p)-b.x*uTW+b.y,A=a.w*att,c=cos(th);
    o.y+=A*sin(th);o.xz+=b.z*A*a.xy*c;}
  return o;
}`;

// Foam disc: a rest-position polar grid displaced on the GPU with the very same Gerstner waves as ocean.js (no CPU work).
const FOAM_VS = `
uniform vec2 uC;uniform vec3 uPl;uniform float uLift;
varying vec3 vW;
${GERST}
void main(){
  vec2 rest=position.xz+uC;vec3 o=gerst(rest);
  vec2 xz=rest+o.xz;float y=o.y+uLift+uPl.x+dot(uPl.yz,rest);
  vec4 w=modelMatrix*vec4(xz.x,y,xz.y,1.);
  vW=w.xyz;
  gl_Position=projectionMatrix*viewMatrix*w;
}`;
const FOAM_FS = `
uniform float uT,uTau,uRD,uAer;varying vec3 vW;
${NOISE}
vec2 h22(vec2 p){vec3 q=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));q+=dot(q,q.yzx+33.33);return fract((q.xx+q.yz)*q.zy);}
float cells(vec2 p,float tm){vec2 i=floor(p),f=fract(p);float d=1.;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 g=vec2(float(x),float(y)),o=h22(i+g);o=.5+.5*sin(tm+6.2831*o);d=min(d,length(g+o-f));}
  return d;}
float sq(float x){return x*x;}
void main(){
  vec2 p=vW.xz;float r=length(p),an=atan(p.y,p.x);
  float edge=1.-smoothstep(uRD*.72,uRD,r);if(edge<=0.)discard;
  vec2 cs=vec2(cos(an),sin(an));
  float w1=vnoise(vec3(cs*1.6,uT*.05))-.5,w2=vnoise(vec3(cs*4.3+3.,uT*.09))-.5;
  float warp=1.+.3*w1+.16*w2;
  vec2 sw=vec2(${SWELL[0].toFixed(4)},${SWELL[1].toFixed(4)}),dr=sw*uTau*.45;
  vec2 wp=(p-dr)+(vec2(vnoise(vec3(p*.33,uT*.08)),vnoise(vec3(p*.33+9.,uT*.08)))-.5)*1.5;
  float cA=cells(wp*1.25,uT*.35),cB=cells(wp*3.1+7.,uT*.5);
  float bub=mix(.3,1.,smoothstep(.66,.2,cA))*(.55+.45*smoothstep(.55,.12,cB));
  float a=0.;
  for(int k=0;k<3;k++){
    float tk=uTau-float(k)*.5;
    if(tk>0.){
      float R=(4.4+13.*(1.-exp(-tk/2.2))+tk*.5)*warp,w=.7+.8*pow(tk,.7);
      float gap=smoothstep(.2,.7,vnoise(vec3(cs*2.1+float(k)*3.7,tk*.25+float(k))));
      a+=exp(-sq((r-R)/w))*exp(-tk/3.6)*(k==0?1.:.55)*(.25+.75*bub)*mix(.12,1.2,gap);
    }
  }
  float rp=0.;
  for(int k=0;k<3;k++){float ph=fract(uT*.06+float(k)/3.),R=6.+ph*28.;rp+=exp(-sq((r-R)/(.8+ph*1.4)))*sq(1.-ph);}
  a+=rp*.1*smoothstep(3.,5.,uTau)*(.4+.6*bub);
  float rP=(8.2-2.*smoothstep(0.,6.5,uTau))*(1.+.18*w1);
  float fade=1.-smoothstep(3.2,6.6,uTau);
  vec2 pc=p-dr;
  float pr=smoothstep(rP,rP*.3,length(pc)*(1.+.12*w2));
  a+=pr*(.12+.88*bub)*fade*smoothstep(0.,.5,uTau)*(.55+.45*smoothstep(1.2,3.,uTau));
  a+=exp(-sq((r-4.0)/1.0))*.8*(.5+.5*bub)*fade*smoothstep(0.,.4,uTau);
  float s=dot(pc,sw),tt=dot(pc,vec2(-sw.y,sw.x));
  float sn=cells(vec2(s*.16,tt*1.1)+3.,uT*.15);
  a+=smoothstep(.5,.12,sn)*smoothstep(13.,3.,s)*smoothstep(-5.,1.,s)*exp(-tt*tt/10.)*.5*fade*smoothstep(.4,1.2,uTau);
  float aer=smoothstep(7.5,2.,r*(1.+.14*w1))*(1.-smoothstep(2.5,7.,uTau))*smoothstep(0.,.35,uTau)*uAer;
  a=clamp(a,0.,1.)*edge*smoothstep(0.,.2,uTau+.05);
  float ae=aer*edge*.55;
  if(a+ae<.004)discard;
  vec3 v=normalize(cameraPosition-vW);
  float glint=pow(max(dot(-v,vec3(-.33,.03,-.94)),0.),4.);
  vec3 fc=vec3(.66,.7,.74)*(.5+.55*bub)+glint*vec3(.8,.7,.6)*.3;
  vec3 ac=vec3(.012,.07,.082);
  float oa=a+ae*(1.-a);
  gl_FragColor=vec4((fc*a+ac*ae*(1.-a))/max(oa,1e-3),1.);${OUT}
  gl_FragColor=vec4(gl_FragColor.rgb*oa,oa);
}`;

// Water crown / rebound spikes: a thin broken sheet (cylindrical grid shaped in the vertex shader from uTau).
const CROWN_VS = `
uniform float uTau,uJet,uSc;
varying vec2 vCs;varying vec3 vN,vW;varying float vH,vF;
${NOISE}
void main(){
  float a=uv.x*6.2831853,v=uv.y;vec2 cs=vec2(cos(a),sin(a));
  float t=uTau-uJet*.24;
  float n1=vnoise(vec3(cs*2.3,1.7+uJet*5.)),n2=vnoise(vec3(cs*6.4,4.4+uJet)),n3=vnoise(vec3(cs*15.,8.2));
  float h,r0,lean;
  if(uJet<.5){
    h=3.3*uSc*(1.-exp(-t/.15))*exp(-pow(max(t,0.)/1.1,1.7));
    h*=.35+.8*n1*n1+.55*n2*(.5+.5*smoothstep(.1,.6,t));
    r0=(3.7+5.6*(1.-exp(-t/.5)))*(.9+.1*uSc);lean=.5+.6*smoothstep(.1,1.,t);
  }else{
    float sp=pow(n1*.6+n2*.6,2.4);
    h=(2.2+9.5*sp)*uSc*smoothstep(0.,.5,t)*exp(-pow(max(t,0.)/1.15,1.8));
    r0=(3.9+1.4*(1.-exp(-t/.6)))*(.9+.1*uSc);lean=.12+.25*n2;
  }
  h=max(h,0.);
  float y=v*h,rad=r0+lean*y+.3*v*v*h+(n3-.5)*.25*v;
  vec3 p=vec3(cs.x*rad,y+.15,cs.y*rad);
  vCs=cs;vH=v;vF=clamp(h/(3.3*uSc),0.,1.);
  vN=normalize((modelMatrix*vec4(cs.x,.35+lean*.2,cs.y,0.)).xyz);
  vec4 w=modelMatrix*vec4(p,1.);vW=w.xyz;
  gl_Position=(t>0.&&h>.02)?projectionMatrix*viewMatrix*w:vec4(2.,2.,2.,1.);
}`;
const CROWN_FS = `
uniform float uTau,uJet;varying vec2 vCs;varying vec3 vN,vW;varying float vH,vF;
${NOISE}
void main(){
  float t=uTau-uJet*.24;
  vec3 V=normalize(cameraPosition-vW);float ndv=abs(dot(normalize(vN),V));
  float ray=vnoise(vec3(vCs*12.,.5+t*.25+uJet*3.)),fr=vnoise(vec3(vCs*24.,vH*7.-t*2.2));
  float dens=(1.-vH)*.8+ray*.55+(fr-.5)*(.2+.7*vH)-vH*.12;
  float env=smoothstep(0.,.07,t)*(1.-smoothstep(.8,1.8,t+vH*.4));
  float a=smoothstep(.4,.82,dens)*env*mix(.55,1.1,1.-ndv)*(.5+.7*(1.-vH*.5));
  a=clamp(a,0.,.8);if(a<.004)discard;
  float bl=pow(max(dot(-V,vec3(-.33,.03,-.94)),0.),3.);
  vec3 deep=vec3(.12,.3,.34),pale=vec3(.82,.89,.94);
  vec3 col=mix(deep,pale,smoothstep(.0,.75,vH*.9+fr*.4))*(.7+.4*ndv)+vec3(.5,.46,.4)*bl*.5;
  gl_FragColor=vec4(col,1.);${OUT}
  gl_FragColor=vec4(gl_FragColor.rgb*a,a);
}`;

// Droplets: soft stretched ellipses on ballistic paths, power-law sizes, many tiny. Backlit by the dawn sun (pale, never orange).
const DROP_VS = `
attribute vec4 iP,iV;attribute vec2 iR;uniform float uTau,uG;
varying vec2 vUv;varying float vAl,vGl;
void main(){
  float tt=uTau-iP.w;vec4 outp=vec4(2.,2.,2.,1.);vAl=0.;vUv=position.xy+.5;vGl=0.;
  if(tt>0.&&tt<iR.y){
    vec3 vel0=iV.xyz;
    vec3 pos=iP.xyz+vel0*tt+vec3(0.,-.5*uG*tt*tt,0.),vel=vel0+vec3(0.,-uG*tt,0.);
    if(pos.y>.1){
      vec3 cw=(modelMatrix*vec4(pos,1.)).xyz,dw=normalize((modelMatrix*vec4(vel,0.)).xyz);
      vec3 tc=normalize(cameraPosition-cw);vec3 side=cross(dw,tc);float sl=length(side);side=sl>1e-3?side/sl:vec3(1.,0.,0.);
      float sz=iV.w,len=sz*(1.4+length(vel)*.16),w=sz;
      vec3 p=cw+dw*(position.y+.5)*len+side*position.x*w*2.;
      outp=projectionMatrix*viewMatrix*vec4(p,1.);
      vAl=smoothstep(0.,.05,tt)*(1.-smoothstep(.6,1.,tt/iR.y))*(.5+.5*iR.x);
      vGl=pow(max(dot(normalize(cw-cameraPosition),vec3(-.33,.03,-.94)),0.),3.);
    }
  }
  gl_Position=outp;
}`;
const DROP_FS = `
varying vec2 vUv;varying float vAl,vGl;
void main(){
  float x=(vUv.x-.5)*2.,y=(vUv.y-.5)*2.;
  float e=x*x+y*y,tail=mix(.55,1.,smoothstep(0.,1.,vUv.y));
  float a=smoothstep(1.,.05,e)*tail*vAl*.75;if(a<.004)discard;
  vec3 col=vec3(.78,.86,.93)*(.8+.5*vGl)+vec3(.5,.46,.4)*vGl*.35;
  gl_FragColor=vec4(col,1.);${OUT}
  gl_FragColor=vec4(gl_FragColor.rgb*a,a);
}`;

// Water crown + rebound spikes + droplets + mist + foam rings/patch at splashdown (EVENTS.splash), all pure in t. The foam rides the ocean
// surface exactly (it reuses the Gerstner uniform arrays of the ocean mesh found in the same world; falls back to a plane fitted to opts.heightAt).
// update(t, u, active): u is ignored (timing comes from timeline.js). Returns { object (group), update, setQuality }.
export function createWaveRings(parent, opts = {}) {
  const root = group(parent), RD = 64, NR = 40, NA = 96, rr = makeRng(6120), heightAt = opts.heightAt, SC = 1.85;
  const zero8 = () => Array.from({ length: 8 }, () => new THREE.Vector4());
  // foam disc (polar rest grid, denser near the capsule)
  const cnt = (NR + 1) * (NA + 1), pos = new Float32Array(cnt * 3), idx = [];
  for (let i = 0; i <= NR; i++) for (let j = 0; j <= NA; j++) { const r = RD * Math.pow(i / NR, 1.7), a = j / NA * TAU; pos.set([Math.cos(a) * r, 0, Math.sin(a) * r], (i * (NA + 1) + j) * 3); }
  for (let i = 0; i < NR; i++) for (let j = 0; j < NA; j++) { const a = i * (NA + 1) + j, b = a + NA + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); fg.setIndex(idx);
  const foamMat = new THREE.ShaderMaterial({ uniforms: { uT: { value: 0 }, uTW: { value: 0 }, uTau: { value: -1 }, uRD: { value: RD }, uAer: { value: 1 }, uC: { value: new THREE.Vector2() }, uPl: { value: new THREE.Vector3() }, uLift: { value: .3 }, uWA: { value: zero8() }, uWB: { value: zero8() } }, vertexShader: FOAM_VS, fragmentShader: FOAM_FS, ...premulBlend, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
  const foam = new THREE.Mesh(fg, foamMat); foam.frustumCulled = false; foam.castShadow = foam.receiveShadow = false; foam.renderOrder = -2; root.add(foam);
  const fx = group(root);     // crown, droplets and mist ride the swell at the capsule (fx.position.y)
  // crown + spikes
  const cg = new THREE.PlaneGeometry(1, 1, 128, 10);
  const mkCrown = jet => { const m = new THREE.ShaderMaterial({ uniforms: { uTau: { value: -1 }, uJet: { value: jet }, uSc: { value: SC } }, vertexShader: CROWN_VS, fragmentShader: CROWN_FS, ...premulBlend, side: THREE.DoubleSide }); const o = new THREE.Mesh(cg, m); o.frustumCulled = false; o.castShadow = o.receiveShadow = false; o.renderOrder = 3; fx.add(o); return m; };
  const crownM = mkCrown(0), spikeM = mkCrown(1);
  // droplets
  const ND = 720, dq = new THREE.PlaneGeometry(1, 1), dg = new THREE.InstancedBufferGeometry(); dg.index = dq.index; dg.setAttribute('position', dq.attributes.position);
  const P = new Float32Array(ND * 4), Vv = new Float32Array(ND * 4), Rr = new Float32Array(ND * 2);
  for (let i = 0; i < ND; i++) {
    const az = rr() * TAU, c = Math.cos(az), s = Math.sin(az), kind = i < ND * .55 ? 0 : i < ND * .88 ? 1 : 2;   // crown rim / spikes / fine mist
    const size = Math.min(.7, .07 * Math.pow(1 - rr() * .985, -.62));
    let r0, y0, sp, el, delay;
    if (kind === 0) { r0 = 4 + rr() * 2.8; y0 = .3 + rr() * 2.6; sp = (4 + rr() * 8) * SC * .8; el = .5 + rr() * .7; delay = rr() * .5; }
    else if (kind === 1) { r0 = 4 + rr() * 1.8; y0 = 2 + rr() * 5; sp = (3 + rr() * 6) * SC * .8; el = .9 + rr() * .6; delay = .3 + rr() * .9; }
    else { r0 = 3.5 + rr() * 4; y0 = .2 + rr() * 1.5; sp = (7 + rr() * 11) * SC * .7; el = .15 + rr() * .5; delay = rr() * .35; }
    const ce = Math.cos(el);
    P.set([c * r0, y0, s * r0, delay], i * 4); Vv.set([c * ce * sp, Math.sin(el) * sp * (kind === 1 ? 1.15 : 1), s * ce * sp, size * (kind === 2 ? .55 : 1)], i * 4); Rr.set([rr(), 1.1 + rr() * 1.8], i * 2);
  }
  dg.setAttribute('iP', new THREE.InstancedBufferAttribute(P, 4)); dg.setAttribute('iV', new THREE.InstancedBufferAttribute(Vv, 4)); dg.setAttribute('iR', new THREE.InstancedBufferAttribute(Rr, 2)); dg.instanceCount = ND;
  const dropMat = new THREE.ShaderMaterial({ uniforms: { uTau: { value: -1 }, uG: { value: 9.2 } }, vertexShader: DROP_VS, fragmentShader: DROP_FS, ...premulBlend, side: THREE.DoubleSide });
  const drops = new THREE.Mesh(dg, dropMat); drops.frustumCulled = false; drops.castShadow = drops.receiveShadow = false; drops.renderOrder = 3; fx.add(drops);
  // mist puffs (large, soft)
  const NM = 56, M = makeState(NM), mm = makePuffMesh(fx, NM, SPLASH_SUN, 1.5, SPLASH_LOOK);
  const md = Array.from({ length: NM }, () => ({ d: rr() * 1.2, life: 2.4 + rr() * 2, a: rr() * TAU, r0: 3.4 + rr() * 3, v: 2 + rr() * 5, up: 1.5 + rr() * 4.5, s: 4 + rr() * 5, al: .06 + rr() * .07, tile: Math.floor(rr() * 16), rot: rr() * TAU, rs: (rr() - .5) * .4 }));
  mm.object.renderOrder = 2; let nM = NM;
  mm.object.userData.tick = (t, ctx) => flushPuffs(mm, M, nM, ctx.camera);
  root.visible = false;
  // ocean wave arrays (shared with ocean.js so foam and sea can never disagree)
  let ou = null, searched = false, WA = null, WB = null;
  const findOcean = () => {
    searched = true;
    const src = opts.ocean && opts.ocean.object ? opts.ocean.object : root.parent;
    src?.traverse(o => { if (!ou && o.material && o.material.uniforms && o.material.uniforms.uWA && o.material.uniforms.uWB) ou = o.material.uniforms; });
    if (ou) { WA = ou.uWA.value; WB = ou.uWB.value; foamMat.uniforms.uWA.value = WA; foamMat.uniforms.uWB.value = WB; }
  };
  const ss = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  let cx = 0, cz = 0, cy = 0;
  function restCenter(t) {      // rest point whose displaced position is the world origin (where the capsule floats)
    let x0 = 0, z0 = 0;
    for (let it = 0; it < 5; it++) {
      const r = Math.sqrt(x0 * x0 + z0 * z0); let ox = 0, oz = 0;
      for (let i = 0; i < 8; i++) { const a = WA[i], b = WB[i], att = 1 - ss(b.w, b.w * 2, r), c = Math.cos(a.z * (a.x * x0 + a.y * z0) - b.x * t + b.y); ox += b.z * a.w * att * a.x * c; oz += b.z * a.w * att * a.y * c; }
      x0 = -ox; z0 = -oz;
    }
    let y = 0; const r = Math.sqrt(x0 * x0 + z0 * z0);
    for (let i = 0; i < 8; i++) { const a = WA[i], b = WB[i]; y += a.w * (1 - ss(b.w, b.w * 2, r)) * Math.sin(a.z * (a.x * x0 + a.y * z0) - b.x * t + b.y); }
    cx = x0; cz = z0; cy = y;
  }
  return {
    object: root,
    update(t, u, active) {
      if (typeof u === 'boolean') active = u;
      const tau = t - T_SPLASH;
      root.visible = (active === undefined || !!active) && tau > -.05; if (!root.visible) return;
      if (!searched) findOcean();
      const U = foamMat.uniforms;
      U.uT.value = U.uTW.value = t; U.uTau.value = tau;
      if (ou) { restCenter(t); U.uC.value.set(cx, cz); U.uPl.value.set(0, 0, 0); fx.position.y = cy; }
      else if (heightAt) { const y0 = heightAt(0, 0, t); U.uPl.value.set(y0, (heightAt(4, 0, t) - heightAt(-4, 0, t)) / 8, (heightAt(0, 4, t) - heightAt(0, -4, t)) / 8); U.uC.value.set(0, 0); fx.position.y = y0; }
      crownM.uniforms.uTau.value = spikeM.uniforms.uTau.value = dropMat.uniforms.uTau.value = tau;
      for (let i = 0; i < nM; i++) {
        const p = md[i], age = tau - p.d; let a = 0, size = 0, x = 0, y = 0, z = 0;
        if (age > 0 && age < p.life) {
          const e = 1 - Math.exp(-age / 1.4), rad = p.r0 + p.v * e * 1.8;
          x = Math.cos(p.a) * rad; z = Math.sin(p.a) * rad; y = .5 + p.up * e + age * .35; size = p.s * (1 + 1.2 * (1 - Math.exp(-age / 2)));
          a = p.al * sstep(0, .4, age) * (1 - sstep(p.life * .3, p.life, age));
        }
        M.p[i * 3] = x; M.p[i * 3 + 1] = y; M.p[i * 3 + 2] = z; M.sz[i] = size; M.a[i] = a; M.rot[i] = p.rot + p.rs * age; M.tile[i] = p.tile; M.heat[i] = 0; M.lit[i] = .75; M.white[i] = .8;
      }
    },
    setQuality(q) { nM = q === 'low' ? 24 : NM; dg.instanceCount = q === 'low' ? 260 : q === 'medium' ? 560 : ND; }
  };
}


// ---------- gas / separation / deployment puffs (new exports) ----------
const GAS_VS = `
attribute vec4 iO,iD,iT,iR;
uniform float uT,uLevel,uDrag,uFD;uniform vec3 uAcc;
varying vec2 vUv;varying vec4 vS;
float hh(float x){return fract(sin(x*127.1+1.7)*43758.5453);}
void main(){
  float age,gate=1.,cyc=0.;
  if(iR.x>0.){float s=uT+iR.w*iR.x;cyc=floor(s/iR.x);age=s-cyc*iR.x-iT.x;gate=step(hh(cyc*7.31+iR.w*91.7),uLevel*iR.y);}
  else{age=uT-iT.x;gate=step(.0001,uLevel);}
  vUv=position.xy+.5;vS=vec4(0.);
  vec4 outp=vec4(2.,2.,2.,1.);
  if(age>0.&&age<iT.y&&gate>.5){
    float k=1.-exp(-age*uDrag),dist=iD.w*k/uDrag,f=age/iT.y;
    vec3 p=iO.xyz+iD.xyz*dist+.5*uAcc*age*age;
    float size=(iT.z+(iT.w-iT.z)*(1.-exp(-4.*f)))*length(modelMatrix[0].xyz);
    vec4 mv=modelViewMatrix*vec4(p,1.);
    float c=cos(iO.w+f*.8),s2=sin(iO.w+f*.8);vec2 q=position.xy;
    mv.xy+=vec2(c*q.x-s2*q.y,s2*q.x+c*q.y)*size;
    outp=projectionMatrix*mv;
    vS=vec4(pow(1.-f,1.7)*smoothstep(0.,.05*iT.y,age),iR.z*exp(-age*uFD),iO.w,hh(iR.w*3.3+cyc));
  }
  gl_Position=outp;
}`;
const GAS_FS = `
uniform vec3 uCol,uFlash;uniform float uDirect;
varying vec2 vUv;varying vec4 vS;
${NOISE}
void main(){
  vec2 p=vUv*2.-1.;float r=length(p);if(r>1.||vS.x<=0.)discard;
  float n=fbm(vec3(p*1.7+vS.z*3.1,vS.w*5.+vS.z));
  float d=r+(n-.5)*.75,a=smoothstep(1.,.2,d)*vS.x;
  if(a<.004)discard;
  vec3 col=uCol*(.55+.7*n)*(1.-.25*r)+uFlash*vS.y*(1.-r)*(1.-r)*2.;
  gl_FragColor=vec4(col,1.);${OUT}
  gl_FragColor=vec4(gl_FragColor.rgb*a,a);
}`;

// Generic deterministic gas-puff emitter (GPU evaluated: costs no CPU per frame).
// opts: { count=40, origin:[x,y,z]|Vector3 (parent space), dir:[x,y,z] mean direction, spread=.6 (cone, 0..1+), speed:[min,max],
//   size:[start,end], life:[min,max], delay:[min,max] stagger inside a burst, drag=2, acc:[x,y,z], color:[r,g,b] lit gas colour,
//   flash:[r,g,b] HDR emissive flash colour, flashAmount=0..2 (0 = pure vapour), flashDecay=13 (1/s), period=0 (0 = one burst at t0, >0 repeats every
//   `period` s per particle group), prob=1, jets: optional [{p:[x,y,z], d:[x,y,z]}] -> `count` particles per jet (repeating pulses) }
// Returns { object (Mesh), update(t, t0=0, level=1) }: one-shot bursts play at film time t0 (invisible before); repeating emitters ignore t0
// and fire pseudo-randomly with probability level*prob per cycle (level 0 = silent).
export function createBurstPuffs(parent, opts = {}) {
  const { count = 40, spread = .6, speed = [6, 14], size = [.5, 4], life = [1, 2.2], delay = [0, .1], drag = 2, acc = [0, 0, 0], color = [.9, .88, .86], flash = [4, 2.2, .9], flashAmount = 0, flashDecay = 13, period = 0, prob = 1 } = opts;
  const jets = opts.jets || [{ p: opts.origin ? (Array.isArray(opts.origin) ? opts.origin : opts.origin.toArray()) : [0, 0, 0], d: opts.dir || [0, 1, 0] }];
  const rr = makeRng(opts.seed || 3141), N = count * jets.length, O = new Float32Array(N * 4), D = new Float32Array(N * 4), T = new Float32Array(N * 4), R = new Float32Array(N * 4), v = new THREE.Vector3(), a1 = new THREE.Vector3(), a2 = new THREE.Vector3();
  jets.forEach((j, ji) => {
    const dir = new THREE.Vector3(...j.d).normalize(); a1.set(Math.abs(dir.y) < .9 ? 0 : 1, Math.abs(dir.y) < .9 ? 1 : 0, 0).cross(dir).normalize(); a2.crossVectors(dir, a1);
    const per = period ? period * (.8 + rr() * .5) : 0, seed = rr();
    for (let i = 0; i < count; i++) {
      const k = ji * count + i, az = rr() * TAU, sp = Math.sqrt(rr()) * spread;
      v.copy(dir).addScaledVector(a1, Math.cos(az) * sp).addScaledVector(a2, Math.sin(az) * sp).normalize();
      O.set([j.p[0], j.p[1], j.p[2], rr() * TAU], k * 4); D.set([v.x, v.y, v.z, speed[0] + rr() * (speed[1] - speed[0])], k * 4);
      T.set([delay[0] + rr() * (delay[1] - delay[0]), life[0] + rr() * (life[1] - life[0]), size[0] * (.7 + rr() * .6), size[1] * (.7 + rr() * .6)], k * 4);
      R.set([per, prob, rr() < .6 ? flashAmount * (.5 + rr() * .5) : 0, period ? seed : rr()], k * 4);
    }
  });
  const quad = new THREE.PlaneGeometry(1, 1), g = new THREE.InstancedBufferGeometry(); g.index = quad.index; g.setAttribute('position', quad.attributes.position);
  g.setAttribute('iO', new THREE.InstancedBufferAttribute(O, 4)); g.setAttribute('iD', new THREE.InstancedBufferAttribute(D, 4)); g.setAttribute('iT', new THREE.InstancedBufferAttribute(T, 4)); g.setAttribute('iR', new THREE.InstancedBufferAttribute(R, 4)); g.instanceCount = N;
  const m = new THREE.ShaderMaterial({
    uniforms: { uT: { value: -1 }, uLevel: { value: 1 }, uDrag: { value: drag }, uFD: { value: flashDecay }, uAcc: { value: new THREE.Vector3(...acc) }, uCol: { value: new THREE.Vector3(...color) }, uFlash: { value: new THREE.Vector3(...flash) }, uDirect: { value: 0 } },
    vertexShader: GAS_VS, fragmentShader: GAS_FS, ...premulBlend, side: THREE.DoubleSide
  });
  const o = new THREE.Mesh(g, m); o.frustumCulled = false; o.castShadow = o.receiveShadow = false; o.renderOrder = 4; o.visible = false; parent.add(o);
  return {
    object: o,
    update(t, t0 = 0, level = 1) {
      const lt = period ? t : t - t0;
      o.visible = level > 0 && (period ? true : lt > 0 && lt < 6);
      m.uniforms.uT.value = lt; m.uniforms.uLevel.value = level;
    }
  };
}

// ---------- RCS: vacuum cold-gas / hypergolic jets ----------
// Brief, narrow (12 deg), fast and faint: each nozzle fires 0.1-0.3 s pulses; the gas flashes hot-white at the throat, fans out and is gone in
// ~0.3 s (no lingering vapour). GPU evaluated and deterministic. Instances: nozzle x 9 particles.
const RCS_VS = `
attribute vec4 iO,iD,iT,iR;attribute vec2 iE;
uniform float uT,uLevel,uSc,uDrag;
varying vec2 vUv;varying float vAl,vHot;
float hh(float x){return fract(sin(x*127.1+1.7)*43758.5453);}
void main(){
  float per=iR.x,s=uT+iR.w*per,cyc=floor(s/per),tc=s-cyc*per;
  float gp=hh(cyc*7.31+iR.w*91.7),mode=floor(hh(cyc*3.17+iR.w*51.3)*4.);
  float gate=step(gp,uLevel*iR.y)*step(abs(mode-iR.z),.5)*step(iE.x,0.);
  float start=hh(cyc*5.7+iR.w*13.1)*(per-.55),dur=.1+.2*hh(cyc*2.3+iR.w*7.7);
  float age=tc-(start+iT.x*dur);
  if(iE.x>0.){age=uT-(iE.x+iT.x*iE.y);gate=1.;}   // explicit scheduled burst
  vUv=position.xy+.5;vAl=0.;vHot=0.;
  vec4 outp=vec4(2.,2.,2.,1.);
  if(gate>.5&&age>0.&&age<iT.y){
    float f=age/iT.y,k=(1.-exp(-age*uDrag))/uDrag;
    vec3 cl=iO.xyz+iD.xyz*(iD.w*k);
    vec3 cw=(modelMatrix*vec4(cl,1.)).xyz,dw=normalize((modelMatrix*vec4(iD.xyz,0.)).xyz);
    vec3 tc2=normalize(cameraPosition-cw);vec3 side=cross(dw,tc2);float sl=length(side);side=sl>1e-3?side/sl:vec3(1.,0.,0.);
    float sz=mix(iT.z,iT.w,f)*uSc,len=(iD.w*.085*(1.-.4*f)+iT.z*3.)*uSc;
    vec3 p=cw+dw*position.y*len-dw*.5*len+side*position.x*sz;
    outp=projectionMatrix*viewMatrix*vec4(p,1.);
    vAl=(1.-f)*(1.-f)*smoothstep(0.,.04*iT.y,age);vHot=exp(-age*14.)*(.4+.6*iO.w);
  }
  gl_Position=outp;
}`;
const RCS_FS = `
varying vec2 vUv;varying float vAl,vHot;
void main(){
  float x=(vUv.x-.5)*2.,y=vUv.y;
  float across=exp(-x*x*3.2),along=smoothstep(0.,.4,y)*(1.-smoothstep(.85,1.,y));
  float a=across*along*vAl;if(a<.003)discard;
  vec3 col=mix(vec3(.55,.62,.8),vec3(2.4,2.6,3.6),vHot);
  gl_FragColor=vec4(col*a*(.7+2.*vHot),1.);${OUT}
}`;

// Attitude-control jets for docking / attitude changes. Attach to the vehicle group (jets inherit its scale/rotation).
// Default layouts (parent local space, +Y is the nose): Orion (radius <= 2.6) = 6 ESM pods x 4 nozzles (axial +-Y and tangential) + 12 CM ports;
// lander (radius > 2.6) = 4 cabin-base quads x 4 nozzles. opts: { radius, y (legacy), size=1 (speed/size multiplier), prob=.45 (chance a pod fires per
// 1.6 s cycle), thrusters: [{p:[x,y,z], d:[x,y,z], g?: slot 0..3, pod?: id}] to override }. Returns { object, update(t, level=1) }:
// level 0..1 scales how busy the jets are (0 = silent). Deterministic in t.
export function createRcsPuffs(parent, opts = {}) {
  const { radius = 1.9, size = 1, prob = .45, y: legacyY = 0 } = opts, lander = radius > 2.6;
  const th = [];
  const addPod = (pod, a, py, pr, nozzles, pp) => {
    const sa = Math.sin(a), ca = Math.cos(a), X = [ca, 0, -sa], Z = [sa, 0, ca];
    nozzles.forEach(([dx, dy, tx, ty], slot) => {
      const d = [X[0] * tx + Z[0] * .3, ty, X[2] * tx + Z[2] * .3];
      th.push({ p: [X[0] * dx + Z[0] * pr, py + dy, X[2] * dx + Z[2] * pr], d, g: slot, pod, prob: pp });
    });
  };
  if (opts.thrusters) opts.thrusters.forEach((t, i) => th.push({ p: t.p, d: t.d, g: t.g ?? 0, pod: t.pod ?? i, prob: 1 }));
  else if (lander) for (let k = 0; k < 4; k++) addPod(k, k * Math.PI / 2 + Math.PI / 4, 5.95, 2.5, [[-.3, 0, -1, 0], [.3, 0, 1, 0], [0, .34, 0, 1], [0, -.34, 0, -1]], prob * .5);
  else {
    for (let k = 0; k < 6; k++) addPod(k, k * Math.PI / 3 + .52, k & 1 ? -1.6 : .2, 2.27, [[-.13, 0, -1, 0], [.13, 0, 1, 0], [0, .2, 0, 1], [0, -.2, 0, -1]], prob);
    for (let i = 0; i < 12; i++) {   // CM ring ports
      const th0 = i * TAU / 12 + .26, yy = 1.3 + 1.65 * (i & 1 ? .84 : .2), r = 2.3 - .697 * (yy - 1.3), n = [Math.sin(th0), .697, Math.cos(th0)], l = Math.hypot(...n);
      th.push({ p: [Math.sin(th0) * r, yy, Math.cos(th0) * r], d: n.map(v => v / l), g: 0, pod: 10 + i, prob: prob * .35, cm: true });
    }
  }
  const NP = 9, rr = makeRng(opts.seed || 271), Oa = [], Da = [], Ta = [], Ra = [], Ea = [];
  const a1 = new THREE.Vector3(), a2 = new THREE.Vector3(), v = new THREE.Vector3(), dir = new THREE.Vector3(), cone = Math.tan(12 * Math.PI / 180);
  const podSeed = new Map(), tagOf = d => Math.abs(d[1]) > .75 ? (d[1] > 0 ? 'fwd' : 'aft') : 'lat';
  th.forEach(j => { j.tag = j.cm ? 'cm' : tagOf(j.d); });
  const events = (opts.events || []).map(e => ({ t: e.t, dur: e.dur ?? .25, sel: e.sel ?? 'all', gain: e.gain ?? 1 }));
  const emit = (j, ev) => {
    dir.set(...j.d).normalize(); a1.set(Math.abs(dir.y) < .9 ? 0 : 1, Math.abs(dir.y) < .9 ? 1 : 0, 0).cross(dir).normalize(); a2.crossVectors(dir, a1);
    if (!podSeed.has(j.pod)) podSeed.set(j.pod, rr());
    for (let i = 0; i < NP; i++) {
      const az = rr() * TAU, sp = Math.sqrt(rr()) * cone;
      v.copy(dir).addScaledVector(a1, Math.cos(az) * sp).addScaledVector(a2, Math.sin(az) * sp).normalize();
      const flash = i < 2, g = ev ? ev.gain : 1;
      Oa.push(j.p[0], j.p[1], j.p[2], flash ? 1 : .2);
      Da.push(v.x, v.y, v.z, (9 + rr() * 8) * size * (flash ? .7 : 1) * (ev ? .6 + .4 * g : 1));
      Ta.push(i / NP * .999, flash ? .1 + rr() * .06 : .16 + rr() * .17, (.12 + rr() * .06) * size * (flash ? 1.5 : 1), (.45 + rr() * .3) * size);
      Ra.push(1.6 + podSeed.get(j.pod) * .4, ev ? 1 : j.prob, j.g, podSeed.get(j.pod));
      Ea.push(ev ? ev.t : 0, ev ? ev.dur : 0);
    }
  };
  th.forEach(j => emit(j, null));
  events.forEach(e => th.forEach(j => { if (e.sel === 'all' || e.sel === j.tag || (typeof e.sel === 'function' && e.sel(j))) emit(j, e); }));
  const N = Oa.length / 4, O = new Float32Array(Oa), D = new Float32Array(Da), T = new Float32Array(Ta), R = new Float32Array(Ra), E = new Float32Array(Ea);
  const quad = new THREE.PlaneGeometry(1, 1), g = new THREE.InstancedBufferGeometry(); g.index = quad.index; g.setAttribute('position', quad.attributes.position);
  g.setAttribute('iO', new THREE.InstancedBufferAttribute(O, 4)); g.setAttribute('iD', new THREE.InstancedBufferAttribute(D, 4)); g.setAttribute('iT', new THREE.InstancedBufferAttribute(T, 4)); g.setAttribute('iR', new THREE.InstancedBufferAttribute(R, 4)); g.setAttribute('iE', new THREE.InstancedBufferAttribute(E, 2)); g.instanceCount = N;
  const m = new THREE.ShaderMaterial({ uniforms: { uT: { value: 0 }, uLevel: { value: 1 }, uSc: { value: 1 }, uDrag: { value: .8 } }, vertexShader: RCS_VS, fragmentShader: RCS_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const o = new THREE.Mesh(g, m); o.frustumCulled = false; o.castShadow = o.receiveShadow = false; o.renderOrder = 4; o.visible = false; parent.add(o);
  void legacyY;
  return {
    object: o,
    update(t, level = 1) {
      o.visible = level > 0 || events.some(e => t > e.t - .05 && t < e.t + e.dur + .7); m.uniforms.uT.value = t; m.uniforms.uLevel.value = level;
      m.uniforms.uSc.value = parent.scale.x;
    }
  };
}

// SRB separation motors: a burst of bright motor exhaust and smoke puffs from the forward and aft separation motors of both boosters.
// opts: { origin: THREE.Vector3 (launch-world position of the stack base at the separation instant = ascent path point at u=.585),
//   t0: EVENTS.srbSep (film time of separation), side: 4.55 (booster x offset), aftY: 2, fwdY: 34, scale: 1 }.
// The puffs stay fixed in world space while the stack climbs away. Attach to the launch world. update(t) is a pure function of t.
export function createSeparationPuffs(parent, opts = {}) {
  const { origin = new THREE.Vector3(), t0 = EVENTS.srbSep, side = 4.55, aftY = 2, fwdY = 34, scale = 1 } = opts;
  const jets = [];
  for (const s of [-1, 1]) for (const [y, dy] of [[aftY, .15], [fwdY, -.1]]) jets.push({ p: [s * (side + 1.3), y, 0], d: [s, dy, 0] });
  const b = createBurstPuffs(parent, { jets, count: 16, spread: .55, speed: [10 * scale, 26 * scale], size: [1.4 * scale, 8 * scale], life: [1.2, 2.8], delay: [0, .22], drag: .9, acc: [0, -2, 0], color: [.94, .9, .86], flash: [5, 2.6, 1], flashAmount: 2, flashDecay: 4.5, seed: 881 });
  b.object.position.set(origin.x, origin.y, origin.z);
  return { object: b.object, update(t) { b.update(t, t0, 1); } };
}

// Parachute deployment: a white vapour/debris burst (pilot-chute mortar and cover jettison) thrown upward and out of the capsule top.
// opts: { position: THREE.Vector3 (parent space, where the chutes pop out), t0: film time, dir: [0,1,0], scale: 1 }.
// Attach to the splash world for the film (e.g. position (0,38,0), t0 default EVENTS.chuteDeploy). update(t) is a pure function of t.
export function createChuteDeployPuff(parent, opts = {}) {
  const { position = new THREE.Vector3(), t0 = EVENTS.chuteDeploy, dir = [0, 1, 0], scale = 1 } = opts;
  const b = createBurstPuffs(parent, { count: 42, origin: position, dir, spread: 1.1, speed: [5 * scale, 15 * scale], size: [.7 * scale, 4.2 * scale], life: [1.4, 3], delay: [0, .1], drag: 2.2, acc: [0, -1.5, 0], color: [.96, .94, .92], flash: [3, 2.2, 1.4], flashAmount: .5, seed: 1717 });
  return { object: b.object, update(t) { b.update(t, t0, 1); } };
}
