// Dawn sky dome shared by the Florida launch and the Pacific splashdown worlds, plus the GLSL the ocean reuses.
// All colours are scene-referred LINEAR HDR; the dome includes three's tonemapping/colorspace chunks, so it looks right
// both when rendering straight to the canvas and into an HDR post-processing target.
import * as THREE from 'three';

// Direction toward the low dawn sun glow (world space). The ocean glint uses the same vector.
export const DAWN_SUN_DIR = new THREE.Vector3(-.35, .03, -1).normalize();

// Horizon colour away from the sun / toward the sun (linear), exported so other modules (fog, ground haze) can match.
export const DAWN_HORIZON = { anti: new THREE.Color(.2, .135, .175), sun: new THREE.Color(.9, .36, .12) };

// Shared procedural-noise GLSL (hash/value noise with analytic derivatives, fbm). Also used by terrain.js.
export const NOISE_GLSL = /* glsl */`
float hash12(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float hash13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
vec2 hash22(vec2 p){vec3 q=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));q+=dot(q,q.yzx+33.33);return fract((q.xx+q.yz)*q.zy);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x),u.y);}
vec3 vnoised(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f),du=6.*f*(1.-f);float a=hash12(i),b=hash12(i+vec2(1,0)),c=hash12(i+vec2(0,1)),d=hash12(i+vec2(1,1)),k=a-b-c+d;return vec3(a+(b-a)*u.x+(c-a)*u.y+k*u.x*u.y,du.x*((b-a)+k*u.y),du.y*((c-a)+k*u.x));}
float vnoise3(vec3 p){vec3 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),u.x),mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),u.x),u.y),mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),u.x),mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),u.x),u.y),u.z);}
float fbm(vec2 p,int o){float a=.5,s=0.;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<6;i++){if(i>=o)break;s+=a*vnoise(p);p=m*p;a*=.5;}return s*1.04;}
`;

// Sky radiance. Needs uniforms: vec3 uSunDir, float uTime, uCloud, uSeed, uStars. oct = cloud fbm octaves (cost knob).
export const SKY_GLSL = /* glsl */`
uniform vec3 uSunDir; uniform float uTime, uCloud, uSeed, uStars;
vec3 horizonCol(float wA){return mix(vec3(.12,.085,.125),vec3(.78,.27,.075),pow(wA,3.4));}
vec3 skyGrad(vec3 d,float wA){
  float e=max(d.y,0.);
  vec3 hor=horizonCol(wA);
  vec3 belt=mix(vec3(.075,.045,.115),vec3(.42,.12,.15),pow(wA,2.2));
  vec3 mid=vec3(.018,.04,.125), zen=vec3(.004,.011,.05);
  vec3 c=mix(hor,belt,smoothstep(0.,.1,e));
  c=mix(c,mid,smoothstep(.04,.26,e));
  c=mix(c,zen,smoothstep(.28,.9,e));
  // earth-shadow band: slightly darker blue-violet low on the anti-sun side
  c*=1.-.28*(1.-wA)*smoothstep(.02,.16,e)*(1.-smoothstep(.16,.5,e));
  return c;
}
vec4 cloudLow(vec3 d,float wA,vec3 hor,int oct){
  float e=d.y; if(e<=0.) return vec4(0.);
  float mask=smoothstep(0.,.02,e)*(1.-smoothstep(.17,.44,e));
  if(mask<=0.) return vec4(0.);
  vec2 p=d.xz/(e+.09)*.55+uSeed*3.17+vec2(uTime*.012,uTime*.004);
  float n=fbm(p,oct);
  float cov=uCloud*(.62+.5*(1.-smoothstep(0.,.3,e)));
  float thr=.62-.22*cov;
  float dens=smoothstep(thr,thr+.16,n)*(.75+.5*vnoise(p*5.1));dens=clamp(dens,0.,1.);
  vec2 ls=normalize(uSunDir.xz);
  float ns=fbm(p+ls*.1,oct);
  float lit=clamp((n-ns)*5.5+.5,0.,1.);
  vec3 litC=mix(vec3(.34,.15,.17),vec3(1.,.46,.15)*1.25,wA);
  vec3 shdC=mix(vec3(.045,.04,.085),vec3(.2,.085,.09),wA);
  vec3 c=mix(shdC,litC,lit*lit*(.25+.75*(1.-dens*.6)));
  c+=pow(wA,3.)*(1.-dens)*vec3(1.,.55,.25)*.9*dens*lit;
  c=mix(c,hor*1.15,exp(-e*15.)*.8);
  return vec4(c,dens*mask*.95);
}
vec4 cirrus(vec3 d,float wA,int oct){
  float e=d.y; if(e<=.02) return vec4(0.);
  vec2 q=d.xz/(e+.3);
  q=vec2(dot(q,vec2(.82,.57)),dot(q,vec2(-.57,.82)))+vec2(uTime*.01,0.)+uSeed*5.3;
  vec2 w=vec2(fbm(q*1.3+11.,2),fbm(q*1.3+31.,2))-.5;
  float n=fbm(vec2(q.x*.42,q.y*2.7)+w*1.3,oct);
  float thr=.56-.15*uCloud;
  float dens=smoothstep(thr,thr+.2,n);
  float mask=smoothstep(.03,.14,e)*(1.-.75*smoothstep(.55,1.,e));
  vec3 lit=mix(vec3(.3,.15,.28),vec3(.95,.42,.24),wA)*(1.1-.75*smoothstep(.1,.9,e))*(.5+.8*wA*exp(-e*2.2));
  return vec4(lit,dens*mask*.55*min(uCloud*1.4,1.));
}
vec3 starField(vec3 d,float wA,float e){
  float vis=smoothstep(.12,.5,e)*smoothstep(.35,-.7,(wA*2.-1.))*uStars;
  if(vis<=0.) return vec3(0.);
  vec3 q=d*160.,id=floor(q),f=fract(q)-.5;
  float h=hash13(id); if(h<.972) return vec3(0.);
  vec3 off=(vec3(hash13(id+7.1),hash13(id+13.3),hash13(id+3.7))-.5)*.6;
  float m=(h-.972)/.028;
  float s=smoothstep(.16,0.,length(f-off));
  return vec3(.8,.88,1.)*s*(.12+.5*m*m)*vis;
}
// Sky radiance exactly on the horizon line (d.y = 0): gradient + sun glare, no cloud layers. The ocean fades into this, so its
// distant haze is one cheap evaluation instead of a second full skyColor() call. Equals skyColor(d,false,*) for d.y = 0.
vec3 skyHaze(vec3 d){
  vec2 h=normalize(d.xz+1e-5); float wA=smoothstep(-.55,1.,dot(h,normalize(uSunDir.xz)));
  vec3 hor=horizonCol(wA); float ang=length(d-uSunDir);
  vec3 c=hor+vec3(1.,.4,.12)*(.3*exp(-ang*3.)+1.7*exp(-ang*13.)+9.*exp(-ang*65.));
  return mix(c,hor*1.05,.4);
}
// Full sky colour for view direction d (skyColorEx can skip the cirrus layer: the ocean does that on the low quality tier). full = include stars + sun disc (not wanted in water reflections).
vec3 skyColorEx(vec3 d,bool full,int oct,bool useCirrus){
  vec2 hd=normalize(d.xz+1e-5);
  float wA=smoothstep(-.55,1.,dot(hd,normalize(uSunDir.xz)));
  float e=d.y;
  vec3 c=skyGrad(d,wA);
  if(e<0.) c*=mix(1.,.3,smoothstep(0.,-.2,e));
  float ang=length(d-uSunDir);
  float vgl=.35+.65*exp(-max(e,0.)*5.);
  c+=vec3(1.,.4,.12)*(.3*exp(-ang*3.)+1.7*exp(-ang*13.)+9.*exp(-ang*65.))*vgl*smoothstep(-.06,.04,e+.04);
  c=mix(c,horizonCol(wA)*1.05,exp(-max(e,0.)*30.)*.4);
  if(full) c+=starField(d,wA,e);
  vec4 ci=useCirrus?cirrus(d,wA,oct):vec4(0.);
  c=mix(c,ci.rgb,ci.a);
  vec4 lo=cloudLow(d,wA,horizonCol(wA),oct);
  float sunVis=1.;
  if(full){
    float disc=1.-smoothstep(.0095,.0125,ang);
    float below=smoothstep(-.002,.004,e);
    sunVis=(1.-lo.a*.92)*(1.-ci.a*.5);
    c+=vec3(1.,.62,.32)*70.*disc*below*sunVis;
  }
  c=mix(c,lo.rgb,lo.a);
  return c;
}
vec3 skyColor(vec3 d,bool full,int oct){return skyColorEx(d,full,oct,true);}
`;

// createSky(opts?) -> THREE.Mesh (2200-radius BackSide dome, depthWrite false, fog false).
// opts: { clouds = 1 (0 clear … 1.4 overcast), seed = 7 (cloud/star layout), stars = 1, sunDir = DAWN_SUN_DIR }
// The mesh animates itself through userData.tick(t, ctx): cloud drift is a pure function of film time.
export function createSky(opts = {}) {
  const { clouds = 1, seed = 7, stars = 1, sunDir = DAWN_SUN_DIR } = opts;
  const uniforms = {
    uSunDir: { value: sunDir }, uTime: { value: 0 }, uCloud: { value: clouds }, uSeed: { value: seed }, uStars: { value: stars }, uOct: { value: 4 }
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vW;void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}',
    fragmentShader: NOISE_GLSL + SKY_GLSL + /* glsl */`
uniform float uOct; varying vec3 vW;
void main(){
  vec3 d=normalize(vW-cameraPosition);
  gl_FragColor=vec4(skyColor(d,true,int(uOct)),1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2200, 48, 28), mat);
  sky.frustumCulled = false; sky.renderOrder = 100; sky.castShadow = sky.receiveShadow = false;
  sky.userData.tick = (t, ctx) => { uniforms.uTime.value = t; uniforms.uOct.value = ctx?.quality === 'low' ? 2 : ctx?.quality === 'high' ? 5 : 4; };
  return sky;
}
