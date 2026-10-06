// Filmic HDR frame pipeline.
//   scene -> HalfFloat MSAA target (scene-linear HDR, no tone mapping inside the scene pass)
//         -> soft-knee bright pass + 13-tap dual-filter downsample chain -> tent upsample (energy-preserving lerp)
//         -> composite to the canvas: heat haze, bloom, lens flare, sun glare + god rays, anamorphic streak, CA, vignette,
//            exposure + white balance, tone mapping (three's chunks, exactly once), ASC-style grade, grain, TPDF dither,
//            fade-to-black, sRGB (exactly once).
// Contract used by app.js:
//   const post = createPost(renderer, scene, camera)
//   post.render(t, dt)           draw one frame to the canvas (t = mission film time, drives the grain seed + haze flow)
//   post.setSize(w, h, pixelRatio)
//   post.setQuality('low'|'medium'|'high')
//   post.setLook(look)           per-world grading object from looks.js (see LOOK_DEFAULTS); partial objects are fine, cheap, allocation-free
//   post.setFade(a)              0..1 dip-to-black amount for stage cuts (done in the composite; #transition stays at opacity 0)
// Extras: post.sceneInfo {calls, triangles} (scene pass only), post.rtInfo {w,h,samples,hdr,mb} (what was really allocated), post.dispose().
// Resource safety: the HDR scene target is capped at ~4.1 MP (the composite upsamples), MSAA is clamped to renderer.capabilities.maxSamples
// and dropped (FXAA takes over) above ~2.9 MP, the allocation is verified with checkFramebufferStatus and steps down
// (MSAA -> none -> 0.7x -> RGBA8) if the driver refuses it, and a lost/restored WebGL context rebuilds every target.
// NOTE for shader authors: every material now renders SCENE-LINEAR HDR. Custom ShaderMaterials (sky, flames, plasma, ocean...) are
// tone mapped + sRGB encoded by the composite, so author colours with THREE.Color (hex -> linear) and values > 1 glow.
import * as THREE from 'three';

export const LOOK_DEFAULTS = {
  exposure: 1,            // linear multiplier before tone mapping
  tone: 'aces',           // 'aces' | 'agx' | 'neutral'
  bloom: .1, bloomThreshold: 1, bloomKnee: .6, bloomRadius: .7,   // strength (final mix), soft-knee threshold, radius = glow spread
  flare: 0, flareThreshold: 2.5,                                  // ghosts + halo (medium/high)
  streak: 0, streakThreshold: 3, streakTint: [.55, .75, 1],      // anamorphic horizontal streak
  glare: 0, glareDir: [0, 0, -1], glareTint: [1, .86, .62],       // soft radial sun glare; glareDir = world direction toward the sun (medium/high)
  rays: 0, raysThreshold: 1.2,                                    // crepuscular rays (radial blur toward the sun, medium/high)
  haze: 0, hazeAxis: [-1, .3],                                    // heat-haze refraction amplitude (uv) behind hazeAxis (screen dir from the centre)
  saturation: 1, contrast: 1, pivot: .46,                         // grade in sRGB-encoded space, S-curve contrast around pivot
  temperature: 0, tint: 0,                                        // white balance (-1..1)
  lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
  shadowTint: [1, 1, 1], highlightTint: [1, 1, 1],                // split toning (multiplicative)
  vignette: .28, grain: .03, ca: .0022                            // ca fades to 0 inside ~45% of the radius
};
const TONES = { aces: 0, agx: 1, neutral: 2 };
const QUALITY = {
  low: { samples: 0, levels: 4, shift: 2, flare: false, fxaa: true, ca: false, sunfx: false, streak: 3 },
  medium: { samples: 4, levels: 6, shift: 1, flare: true, fxaa: false, ca: true, sunfx: true, streak: 6 },
  high: { samples: 4, levels: 7, shift: 1, flare: true, fxaa: false, ca: true, sunfx: true, streak: 9 }
};
const MAX_PIXELS = 4.1e6, MSAA_PIXELS = 2.9e6;      // scene-target budget (see header)

const VERT = 'varying vec2 vUv;void main(){vUv=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}';

const COMMON = /* glsl */`
float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 clean(vec3 c){ uvec3 b=floatBitsToUint(c)&0x7f800000u; if(b.x==0x7f800000u||b.y==0x7f800000u||b.z==0x7f800000u) return vec3(0.); return min(c,vec3(2000.)); }
`;

const DOWN_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform vec2 uThr;
varying vec2 vUv;
${COMMON}
vec3 T(vec2 o){
  vec3 c=clean(texture2D(tSrc,vUv+o*uTexel).rgb);
#ifdef PREFILTER
  float br=max(c.r,max(c.g,c.b));
  float rq=clamp(br-uThr.x+uThr.y,0.,2.*uThr.y); rq=rq*rq/(4.*uThr.y+1e-5);
  c*=max(rq,br-uThr.x)/max(br,1e-5);
#endif
  return c;
}
void main(){
  vec3 a=T(vec2(-2,2)),b=T(vec2(0,2)),c=T(vec2(2,2)),d=T(vec2(-2,0)),e=T(vec2(0,0)),f=T(vec2(2,0)),g=T(vec2(-2,-2)),h=T(vec2(0,-2)),i=T(vec2(2,-2)),j=T(vec2(-1,1)),k=T(vec2(1,1)),l=T(vec2(-1,-1)),m=T(vec2(1,-1));
#ifdef PREFILTER
  vec3 g0=(a+b+d+e)*.25,g1=(b+c+e+f)*.25,g2=(d+e+g+h)*.25,g3=(e+f+h+i)*.25,g4=(j+k+l+m)*.25;
  float w0=1./(1.+luma(g0)),w1=1./(1.+luma(g1)),w2=1./(1.+luma(g2)),w3=1./(1.+luma(g3)),w4=1./(1.+luma(g4));
  vec3 r=(g0*w0+g1*w1+g2*w2+g3*w3)*.125+g4*w4*.5;
  gl_FragColor=vec4(r/((w0+w1+w2+w3)*.125+w4*.5),1.);
#else
  gl_FragColor=vec4(e*.125+(a+c+g+i)*.03125+(b+d+f+h)*.0625+(j+k+l+m)*.125,1.);
#endif
}`;

const UP_FRAG = /* glsl */`
uniform sampler2D tLow, tHigh; uniform vec2 uTexel; uniform float uMix;
varying vec2 vUv;
void main(){
  vec4 d=vec4(1.,1.,-1.,0.)*uTexel.xyxy;
  vec3 s=texture2D(tLow,vUv-d.xy).rgb+2.*texture2D(tLow,vUv-d.wy).rgb+texture2D(tLow,vUv-d.zy).rgb
        +2.*texture2D(tLow,vUv+d.zw).rgb+4.*texture2D(tLow,vUv).rgb+2.*texture2D(tLow,vUv+d.xw).rgb
        +texture2D(tLow,vUv+d.zy).rgb+2.*texture2D(tLow,vUv+d.wy).rgb+texture2D(tLow,vUv+d.xy).rgb;
  gl_FragColor=vec4(mix(texture2D(tHigh,vUv).rgb,s*(1./16.),uMix),1.);
}`;

const COMP_FRAG = /* glsl */`
uniform sampler2D tScene, tBloom, tFlare, tStreak;
uniform vec2 uTexel; uniform vec2 uStreakTexel; uniform float uAspect;
uniform float uBloom, uFlare, uFlareThr, uStreak, uStreakThr; uniform vec3 uStreakTint;
uniform vec3 uWB; uniform float uTone;
uniform float uVig, uGrain, uCA, uSeed, uFade, uSat, uContrast, uPivot, uTime;
uniform vec3 uLift, uGamma, uGain, uShadowTint, uHighTint;
uniform float uGlare, uRays, uRayThr, uSunVis; uniform vec2 uSunUV; uniform vec3 uGlareTint;
uniform float uHaze; uniform vec2 uHazeAxis;
varying vec2 vUv;
#include <tonemapping_pars_fragment>
${COMMON}
vec3 S(vec2 uv){ return clean(texture2D(tScene,uv).rgb); }

#ifdef FXAA
float lc(vec3 c){ float l=luma(c); return l/(1.+l); }
vec3 sceneAA(vec2 uv){
  vec3 cM=S(uv),cNW=S(uv+vec2(-1,1)*uTexel),cNE=S(uv+vec2(1,1)*uTexel),cSW=S(uv+vec2(-1,-1)*uTexel),cSE=S(uv+vec2(1,-1)*uTexel);
  float lM=lc(cM),lNW=lc(cNW),lNE=lc(cNE),lSW=lc(cSW),lSE=lc(cSE);
  float lMin=min(lM,min(min(lNW,lNE),min(lSW,lSE))),lMax=max(lM,max(max(lNW,lNE),max(lSW,lSE)));
  vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),(lNW+lSW)-(lNE+lSE));
  float dirReduce=max((lNW+lNE+lSW+lSE)*.25*.125,1./128.);
  float rcp=1./(min(abs(dir.x),abs(dir.y))+dirReduce);
  dir=clamp(dir*rcp,-8.,8.)*uTexel;
  vec3 A=.5*(S(uv+dir*(1./3.-.5))+S(uv+dir*(2./3.-.5)));
  vec3 B=A*.5+.25*(S(uv+dir*-.5)+S(uv+dir*.5));
  float lB=lc(B);
  return (lB<lMin||lB>lMax)?A:B;
}
#endif

#ifdef FLARE
vec3 fS(vec2 o,vec2 ca){
  return vec3(max(texture2D(tFlare,o-ca).r-uFlareThr,0.),max(texture2D(tFlare,o).g-uFlareThr,0.),max(texture2D(tFlare,o+ca).b-uFlareThr,0.));
}
vec3 lensFlare(vec2 uv){
  vec2 st=1.-uv, gv=(.5-st)*.3; vec3 res=vec3(0.);
  vec2 ca=normalize(gv+1e-5)*.0016;
  for(int i=1;i<5;i++){
    float fi=float(i);
    vec2 o=fract(st+gv*fi);
    float w=pow(max(1.-length(.5-o)/.7071,0.),3.2)/fi;
    vec3 tint=mix(vec3(1.),.5+.5*cos(6.2832*(fi*.23+vec3(0.,.33,.67))),.35);
    res+=fS(o,ca)*w*tint;
  }
  vec2 ho=st+normalize(gv+1e-5)*.42;
  float hw=pow(max(1.-length(.5-fract(ho))/.7071,0.),5.);
  res+=fS(fract(ho),ca*1.5)*hw*vec3(1.,.82,.64)*.5;
  return res;
}
#endif

#ifdef SUNFX
// Soft radial glare tied to the sun's screen position, gated by how bright the sun really is in the frame (so the rocket / a planet / a cloud
// that covers it also covers the glare), plus radial-blur god rays that the same occluders cut into shafts.
float sunSeen(){
  vec2 e=uStreakTexel*1.5; vec3 a=texture2D(tFlare,uSunUV).rgb+texture2D(tFlare,uSunUV+vec2(e.x,0.)).rgb+texture2D(tFlare,uSunUV-vec2(e.x,0.)).rgb+texture2D(tFlare,uSunUV+vec2(0.,e.y)).rgb+texture2D(tFlare,uSunUV-vec2(0.,e.y)).rgb;
  float l=max(a.r,max(a.g,a.b))*.2; return smoothstep(1.5,9.,l)*uSunVis;
}
vec3 sunGlare(vec2 uv,float vis){
  vec2 d=(uv-uSunUV)*vec2(uAspect,1.); float r=length(d);
  float g=.55*exp(-r*11.)+.2*exp(-r*3.4)+.045*exp(-r*1.15);
  return uGlareTint*g*uGlare*vis;
}
vec3 godRays(vec2 uv,float vis){
  vec2 st=(uSunUV-uv)*(1./14.); vec3 s=vec3(0.); float w=1.,wt=0.; vec2 p=uv;
  float jit=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  p+=st*jit;
  for(int i=0;i<14;i++){
    p+=st; vec3 c=texture2D(tFlare,p).rgb; float l=max(max(c.r,c.g),c.b);
    s+=c*smoothstep(uRayThr,uRayThr+1.6,l)*w; wt+=w; w*=.93;
  }
  float fall=exp(-length((uv-uSunUV)*vec2(uAspect,1.))*1.7);
  return s/wt*fall*uRays*vis*uGlareTint;
}
#endif

vec3 streakBlur(vec2 uv){
  vec3 s=vec3(0.); float ws=0.;
  for(int i=-STREAK_N;i<=STREAK_N;i++){
    float k=float(i); float w=exp(-abs(k)*(1.8/float(STREAK_N)));
    s+=max(texture2D(tStreak,uv+vec2(k*(18./float(STREAK_N))*uStreakTexel.x,0.)).rgb-uStreakThr,0.)*w; ws+=w;
  }
  return s/ws;
}

vec3 toS(vec3 x){ return mix(x*12.92,1.055*pow(max(x,vec3(0.)),vec3(1./2.4))-.055,step(.0031308,x)); }
vec3 fromS(vec3 x){ return mix(x/12.92,pow((max(x,vec3(0.))+.055)/1.055,vec3(2.4)),step(.04045,x)); }
vec3 sCurve(vec3 c,float k,float p){
  vec3 lo=p*pow(max(c/p,vec3(0.)),vec3(k));
  vec3 hi=1.-(1.-p)*pow(max((1.-c)/(1.-p),vec3(0.)),vec3(k));
  return mix(lo,hi,step(vec3(p),c));
}
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y); }

void main(){
  vec2 uv=vUv, dc=(uv-.5)*vec2(uAspect,1.);
  float r2=dot(dc,dc);
  // heat haze: noise-driven refraction in a wedge behind the hot body (hazeAxis = screen direction of the wake from the centre)
  if(uHaze>0.){
    vec2 ax=normalize(uHazeAxis), pp=vec2(dot(dc,ax),dot(dc,vec2(-ax.y,ax.x)));
    float along=pp.x, mask=smoothstep(.03,.16,along)*exp(-along*2.1)*exp(-pow(pp.y/(.05+.34*along),2.));
    vec2 q=vec2(along*9.-uTime*3.1,pp.y*15.), q2=vec2(along*21.-uTime*5.3,pp.y*34.+3.7);
    vec2 n=vec2(vnoise(q)+.5*vnoise(q2),vnoise(q+17.3)+.5*vnoise(q2+9.1))-.75;
    uv+=n*uHaze*mask*vec2(1./uAspect,1.);
  }
  float rad=sqrt(r2);
#ifdef CA
  // lateral CA only toward the frame edge (zero inside ~45% of the radius); offset capped at ~1 px so sub-pixel pebbles never split into RGB ticks
  float caK=smoothstep(.4,.95,rad);
  vec2 off=(uv-.5)*r2*uCA*caK; off=clamp(off,-1.1*uTexel,1.1*uTexel);
  #ifdef FXAA
  vec3 col=sceneAA(uv);
  if(caK>0.){ col.r=S(uv+off).r; col.b=S(uv-off).b; }
  #else
  vec3 col=caK>0.?vec3(S(uv+off).r,S(uv).g,S(uv-off).b):S(uv);
  #endif
#elif defined(FXAA)
  vec3 col=sceneAA(uv);
#else
  vec3 col=S(uv);
#endif
  col+=texture2D(tBloom,uv).rgb*uBloom;
#ifdef FLARE
  if(uFlare>.0005) col+=lensFlare(uv)*uFlare;
#endif
#ifdef SUNFX
  if(uSunVis>.001){ float sv=sunSeen(); if(sv>.001){ if(uGlare>.0005) col+=sunGlare(uv,sv); if(uRays>.0005) col+=godRays(uv,sv); } }
#endif
  if(uStreak>.0005) col+=streakBlur(uv)*uStreakTint*uStreak;
  col*=1.-uVig*pow(smoothstep(.28,1.02,rad),1.7);
  col*=uWB;
  vec3 c=toS(uTone<.5?ACESFilmicToneMapping(col):(uTone<1.5?AgXToneMapping(col):NeutralToneMapping(col)));
  // grade (sRGB-encoded working space; round trip is exact, the output transform below runs once)
  c=c*uGain+uLift*(1.-c);
  c=pow(max(c,vec3(0.)),1./uGamma);
  c=sCurve(clamp(c,0.,1.),uContrast,uPivot);
  float l=luma(c);
  c=mix(vec3(l),c,uSat);
  c*=mix(uShadowTint,uHighTint,smoothstep(.1,.9,l));
  // film grain: luminance weighted, animated at 24 fps from the film clock
  vec2 gp=gl_FragCoord.xy+vec2(uSeed*37.17,uSeed*91.31);
  float n=hash12(gp)+hash12(gp+17.7)-1.;
  c+=n*uGrain*(.3+2.4*l*(1.-l));
  c=mix(c,vec3(3.,7.,13.)/255.,uFade);
  gl_FragColor=vec4(fromS(clamp(c,0.,1.)),1.);
  #include <colorspace_fragment>
  // TPDF dither at the output quantisation, a little stronger in smooth dark gradients (sky, glow haloes) where 8-bit contours show
  float dl=luma(gl_FragColor.rgb);
  gl_FragColor.rgb+=(hash12(gl_FragCoord.xy+3.1)+hash12(gl_FragCoord.xy+9.7)-1.)*(1.35+1.1*(1.-smoothstep(.0,.45,dl)))/255.;
}`;

const num = (look, k) => look[k] ?? LOOK_DEFAULTS[k];
const vec3 = (u, look, k) => { const a = look[k] || LOOK_DEFAULTS[k]; u.value.set(a[0], a[1], a[2]); };

export function createPost(renderer, scene, camera) {
  const fadeEl = document.getElementById('transition'); if (fadeEl) fadeEl.style.opacity = '0';
  const fsGeo = new THREE.BufferGeometry();
  fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const fsMesh = new THREE.Mesh(fsGeo, null); fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene(); fsScene.add(fsMesh);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const shader = (frag, uniforms, defines = {}) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, toneMapped: false });
  const v2 = () => ({ value: new THREE.Vector2() }), v3 = (x = 0, y = x, z = x) => ({ value: new THREE.Vector3(x, y, z) });
  const prefilterM = shader(DOWN_FRAG, { tSrc: { value: null }, uTexel: v2(), uThr: v2() }, { PREFILTER: 1 });
  const downM = shader(DOWN_FRAG, { tSrc: { value: null }, uTexel: v2(), uThr: v2() });
  const upM = shader(UP_FRAG, { tLow: { value: null }, tHigh: { value: null }, uTexel: v2(), uMix: { value: .7 } });
  const compU = {
    tScene: { value: null }, tBloom: { value: null }, tFlare: { value: null }, tStreak: { value: null },
    uTexel: v2(), uStreakTexel: v2(), uAspect: { value: 1 },
    uBloom: { value: .1 }, uFlare: { value: 0 }, uFlareThr: { value: 2.5 }, uStreak: { value: 0 }, uStreakThr: { value: 3 }, uStreakTint: v3(.55, .75, 1),
    uWB: v3(1), uTone: { value: 0 }, uVig: { value: .28 }, uGrain: { value: .03 }, uCA: { value: .002 }, uSeed: { value: 0 }, uFade: { value: 0 }, uTime: { value: 0 },
    uSat: { value: 1 }, uContrast: { value: 1 }, uPivot: { value: .46 },
    uLift: v3(0), uGamma: v3(1), uGain: v3(1), uShadowTint: v3(1), uHighTint: v3(1),
    uGlare: { value: 0 }, uRays: { value: 0 }, uRayThr: { value: 1.2 }, uSunVis: { value: 0 }, uSunUV: v2(), uGlareTint: v3(1, .86, .62),
    uHaze: { value: 0 }, uHazeAxis: { value: new THREE.Vector2(-1, .3) }
  };
  const compM = shader(COMP_FRAG, compU);

  let W = 1, H = 1, SW = 1, SH = 1, q = 'medium', Q = QUALITY.medium, sceneRT = null, down = [], up = [], builtKey = '';
  const L = {}, thr = prefilterM.uniforms.uThr.value, size = new THREE.Vector2();
  let bloomRadius = .7, lost = false, hdrSupported = true;
  const glareDir = new THREE.Vector3(0, 0, -1), tmpV = new THREE.Vector3(), glareOn = { v: false };
  const rtInfo = { w: 1, h: 1, samples: 0, hdr: true, mb: 0, fallback: '' };
  try { hdrSupported = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'); } catch { hdrSupported = true; }

  const rt = (w, h, opts) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, ...opts });
  const freeAll = () => { try { sceneRT?.dispose(); for (const r of down) r.dispose(); for (const r of up) r.dispose(); } catch { /* context may be gone */ } sceneRT = null; down = []; up = []; };

  // Is the allocated scene target actually usable? (incomplete framebuffer / GL_OUT_OF_MEMORY on weak or busy GPUs)
  function healthy() {
    try {
      const gl = renderer.getContext(); while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
      renderer.initRenderTarget?.(sceneRT); renderer.setRenderTarget(sceneRT);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
      renderer.setRenderTarget(null); return ok;
    } catch { renderer.setRenderTarget(null); return false; }
  }

  function build(force) {
    const key = W + 'x' + H + q; if (!force && key === builtKey) return; builtKey = key;
    freeAll();
    // resource plan: pixel cap, MSAA clamp, float-target availability
    const maxS = renderer.capabilities.maxSamples | 0;
    let scale = W * H > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / (W * H)) : 1, samples = Math.min(Q.samples, maxS), hdr = hdrSupported, fallback = '';
    const alloc = () => {
      SW = Math.max(2, Math.round(W * scale)); SH = Math.max(2, Math.round(H * scale));
      if (SW * SH > MSAA_PIXELS) samples = 0;
      sceneRT = rt(SW, SH, { depthBuffer: true, samples, type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType });
      sceneRT.resolveDepthBuffer = false; sceneRT.resolveStencilBuffer = false;
    };
    alloc();
    for (let attempt = 0; attempt < 4 && !healthy(); attempt++) {
      sceneRT.dispose();
      if (samples > 0) { samples = 0; fallback = 'no-msaa'; } else if (scale > .75) { scale = .7; fallback = 'scaled'; } else { hdr = false; fallback = 'rgba8'; }
      alloc();
    }
    let w = Math.max(2, SW >> Q.shift), h = Math.max(2, SH >> Q.shift);
    const bt = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    for (let i = 0; i < Q.levels && Math.min(w, h) >= 2; i++) { down.push(rt(w, h, { type: bt })); if (i < Q.levels - 1) up.push(rt(w, h, { type: bt })); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
    while (up.length > down.length - 1) up.pop().dispose();
    const aa = Q.fxaa || samples === 0;
    compM.defines = { STREAK_N: Q.streak, ...(Q.flare ? { FLARE: 1 } : {}), ...(Q.sunfx ? { SUNFX: 1 } : {}), ...(aa ? { FXAA: 1 } : {}), ...(Q.ca ? { CA: 1 } : {}) };
    compM.needsUpdate = true;
    // bytes: colour (+ MSAA samples + resolve) + depth, plus the bloom chain
    const px = SW * SH, bpp = hdr ? 8 : 4;
    let bytes = px * (bpp * (samples > 0 ? samples + 1 : 1) + 4 * (samples > 0 ? samples : 1));
    for (const r of down) bytes += r.width * r.height * bpp; for (const r of up) bytes += r.width * r.height * bpp;
    Object.assign(rtInfo, { w: SW, h: SH, samples, hdr, mb: Math.round(bytes / 1048576), fallback });
  }

  const pass = (m, target) => { fsMesh.material = m; renderer.setRenderTarget(target); renderer.render(fsScene, fsCam); };

  function bloomChain() {
    const n = down.length, first = prefilterM.uniforms;
    first.tSrc.value = sceneRT.texture; first.uTexel.value.set(1 / SW, 1 / SH).multiplyScalar(Q.shift === 2 ? 2 : 1);
    pass(prefilterM, down[0]);
    for (let i = 1; i < n; i++) {
      const u = downM.uniforms; u.tSrc.value = down[i - 1].texture; u.uTexel.value.set(1 / down[i - 1].width, 1 / down[i - 1].height);
      pass(downM, down[i]);
    }
    // accumulate from the narrowest mip up: up[i] = mix(down[i], tent(up[i+1]), radius)
    let low = down[n - 1].texture;
    for (let i = n - 2; i >= 0; i--) {
      const u = upM.uniforms; u.tLow.value = low; u.tHigh.value = down[i].texture;
      u.uTexel.value.set(1 / down[i + 1].width, 1 / down[i + 1].height); u.uMix.value = bloomRadius;
      pass(upM, up[i]); low = up[i].texture;
    }
    return low;
  }

  // Screen position of the sun glare (after the scene pass so the camera matrices are fresh); fades out when the sun is behind the camera.
  function sunScreen() {
    const U = compU;
    if (!glareOn.v || !Q.sunfx) { U.uSunVis.value = 0; return; }
    tmpV.copy(glareDir).transformDirection(camera.matrixWorldInverse);          // view space, z < 0 is in front
    if (tmpV.z > -.02) { U.uSunVis.value = 0; return; }
    const P = camera.projectionMatrix.elements, nx = tmpV.x / -tmpV.z * P[0], ny = tmpV.y / -tmpV.z * P[5];
    U.uSunUV.value.set(nx * .5 + .5, ny * .5 + .5);
    // gated by the frame edge so it never pops (the shader additionally gates by the sun's real brightness in the frame)
    const edge = Math.max(Math.abs(nx), Math.abs(ny)); U.uSunVis.value = THREE.MathUtils.clamp((1.6 - edge) / .6, 0, 1);
  }

  const info = { calls: 0, triangles: 0 };
  const post = {
    sceneInfo: info, rtInfo,
    render(t = 0) {
      if (lost) return;
      build();
      const ac = renderer.autoClear; renderer.info.autoReset = false; renderer.info.reset();
      renderer.setRenderTarget(sceneRT); renderer.render(scene, camera);
      info.calls = renderer.info.render.calls; info.triangles = renderer.info.render.triangles;
      renderer.autoClear = false;
      const bloom = bloomChain(), nd = down.length;
      renderer.toneMappingExposure = 1;
      const sr = down[Math.min(2, nd - 1)];
      compU.tScene.value = sceneRT.texture; compU.tBloom.value = bloom;
      compU.tFlare.value = sr.texture; compU.tStreak.value = sr.texture;
      compU.uStreakTexel.value.set(1 / sr.width, 1 / sr.height); compU.uTexel.value.set(1 / SW, 1 / SH); compU.uAspect.value = W / H;
      compU.uSeed.value = Math.floor(t * 24) % 997; compU.uTime.value = t % 1000;
      sunScreen();
      pass(compM, null);
      renderer.autoClear = ac;
    },
    setSize(w, h, pr = 1) {
      renderer.getDrawingBufferSize(size);
      W = Math.max(2, Math.floor(size.x || w * pr)); H = Math.max(2, Math.floor(size.y || h * pr)); build();
    },
    setQuality(quality) { if (!QUALITY[quality]) return; q = quality; Q = QUALITY[quality]; build(); },
    setLook(look = {}) {
      const tone = look.tone ?? LOOK_DEFAULTS.tone; compU.uTone.value = typeof tone === 'number' ? tone : TONES[tone] ?? 0;
      const e = num(look, 'exposure'), tp = num(look, 'temperature'), ti = num(look, 'tint');
      compU.uWB.value.set(e * (1 + .2 * tp), e * (1 - .1 * ti), e * (1 - .2 * tp));
      compU.uBloom.value = num(look, 'bloom'); thr.set(num(look, 'bloomThreshold'), Math.max(num(look, 'bloomKnee'), .01)); bloomRadius = num(look, 'bloomRadius');
      compU.uFlare.value = num(look, 'flare'); compU.uFlareThr.value = num(look, 'flareThreshold');
      compU.uStreak.value = num(look, 'streak'); compU.uStreakThr.value = num(look, 'streakThreshold'); vec3(compU.uStreakTint, look, 'streakTint');
      compU.uGlare.value = num(look, 'glare'); compU.uRays.value = num(look, 'rays'); compU.uRayThr.value = num(look, 'raysThreshold'); vec3(compU.uGlareTint, look, 'glareTint');
      const gd = look.glareDir || LOOK_DEFAULTS.glareDir; glareDir.set(gd[0], gd[1], gd[2]).normalize(); glareOn.v = compU.uGlare.value > 0 || compU.uRays.value > 0;
      compU.uHaze.value = num(look, 'haze'); const ha = look.hazeAxis || LOOK_DEFAULTS.hazeAxis; compU.uHazeAxis.value.set(ha[0], ha[1]);
      compU.uSat.value = num(look, 'saturation'); compU.uContrast.value = num(look, 'contrast'); compU.uPivot.value = num(look, 'pivot');
      vec3(compU.uLift, look, 'lift'); vec3(compU.uGamma, look, 'gamma'); vec3(compU.uGain, look, 'gain'); vec3(compU.uShadowTint, look, 'shadowTint'); vec3(compU.uHighTint, look, 'highlightTint');
      compU.uVig.value = num(look, 'vignette'); compU.uGrain.value = num(look, 'grain'); compU.uCA.value = num(look, 'ca');
    },
    setFade(a) { compU.uFade.value = a; },
    dispose() {
      freeAll(); prefilterM.dispose(); downM.dispose(); upM.dispose(); compM.dispose(); fsGeo.dispose();
      cv?.removeEventListener('webglcontextlost', onLost); cv?.removeEventListener('webglcontextrestored', onRestored);
    }
  };
  // GPU reset: stop drawing while the context is gone, rebuild every target (three re-creates its own GL state on restore).
  const cv = renderer.domElement;
  const onLost = () => { lost = true; };
  const onRestored = () => { lost = false; sceneRT = null; down = []; up = []; builtKey = ''; build(true); };   // old GL handles are dead: drop them, don't delete
  cv?.addEventListener('webglcontextlost', onLost); cv?.addEventListener('webglcontextrestored', onRestored);
  renderer.getDrawingBufferSize(size); W = Math.max(2, size.x | 0); H = Math.max(2, size.y | 0);
  post.setLook(LOOK_DEFAULTS); build();
  return post;
}
