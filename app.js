// ARTEMIS IV · T+0 — stage choreography, cameras, warm-up and the frame loop. Assets/visuals live in src/*.
// Cameras are authored as spline tracks (orbit angle, elevation, distance, target offset) around a moving anchor, composed so the hero
// lands in the SAFE FRAME (x 28-75 %, y 8-74 % of the screen: the centre of that box is NDC (+.03, +.18)) via camera.setViewOffset.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { $, clamp, mix, smooth, mat, mesh, group, cylinderG, soft } from './src/util.js';
import { earth, moon, createStars } from './src/space.js';
import { createSky } from './src/sky.js';
import { createLaunchSite, createSLS } from './src/launchpad.js';
import * as SC from './src/spacecraft.js';
import { flame, createLaunchPlume, createLandingDust, createEntryPlasma, createWaveRings, createBurstPuffs, createRcsPuffs, createSeparationPuffs, createChuteDeployPuff } from './src/effects.js';
import { heights, createLunarSurface } from './src/terrain.js';
import { createOcean } from './src/ocean.js';
import { createPost } from './src/post.js';
import { createLooks } from './src/looks.js';
import { createUI } from './src/ui.js';
import { t as msg, L, getLang, onLang } from './src/i18n.js';
import { createAudio } from './src/audio.js';
import { DURATION as duration, STAGE_STARTS, EVENTS as EV, PROPS, FLAG_POS, SPSS_POS, DUSTER_POS, LADDER, LANDER_YAW, astronautAt } from './src/timeline.js';

const { orion, lander, astronaut, flag, duster, spss, entryCapsule, seaCapsule, recoveryShip } = SC;
const DEG = Math.PI / 180, V3 = THREE.Vector3;
const stageDefs = [
  { day: 0, to: 12 / 1440,
    en: { title: 'Farewell to<br>gravity.', name: 'Launch', tag: 'KENNEDY / EARTH', desc: 'Four astronauts. One journey. At T+0, SLS begins its mission to carry Orion from Earth to the Moon.', crew: '4 ASTRONAUTS · ORION', loc: 'Kennedy Space Center' },
    tr: { title: 'Yerçekimine<br>veda.', name: 'Fırlatma', tag: 'KENNEDY / DÜNYA', desc: 'Dört astronot. Bir yolculuk. SLS, Orion’u Dünya’dan Ay’a taşıyacak görevini T+0’da başlatıyor.', crew: '4 ASTRONOT · ORION', loc: 'Kennedy Uzay Merkezi' } },
  { day: 12 / 1440, to: .5,
    en: { title: 'Beyond the<br>blue planet.', name: 'Earth orbit', short: 'Orbit', tag: 'EARTH / ORION', desc: 'After ascent: stage separations and vehicle checkouts. Orion prepares for the transfer to the Moon.', crew: '4 ASTRONAUTS · ORION', loc: 'Earth orbit' },
    tr: { title: 'Mavi gezegenin<br>ötesinde.', name: 'Dünya yörüngesi', short: 'Yörünge', tag: 'DÜNYA / ORION', desc: 'Yükselişin ardından kademe ayrılmaları ve araç kontrolleri. Orion, Ay’a transfer için hazırlanıyor.', crew: '4 ASTRONOT · ORION', loc: 'Dünya çevresi' } },
  { day: .5, to: 5,
    en: { title: 'Between two<br>worlds.', name: 'Lunar transfer', short: 'Transfer', tag: 'EARTH → MOON', desc: 'Life support, communications and navigation checks continue. Ahead lie the Moon and a new surface journey.', crew: '4 ASTRONAUTS · ORION', loc: 'Translunar coast' },
    tr: { title: 'İki dünya<br>arasında.', name: 'Ay’a transfer', short: 'Transfer', tag: 'DÜNYA → AY', desc: 'Yaşam destek, haberleşme ve navigasyon kontrolleri sürüyor. Önümüzde Ay ve yeni bir yüzey yolculuğu var.', crew: '4 ASTRONOT · ORION', loc: 'Ay transferi' } },
  { day: 5, to: 6,
    en: { title: 'Rendezvous<br>in orbit.', name: 'Docking', tag: 'MOON / RENDEZVOUS', desc: 'Orion docks with the commercial lander. Two astronauts will head to the surface; two will stay in orbit.', crew: '2 SURFACE + 2 ORBIT', loc: 'Lunar orbit' },
    tr: { title: 'Yörüngede<br>buluşma.', name: 'Kenetlenme', tag: 'AY / BULUŞMA', desc: 'Orion, ticari iniş aracıyla kenetleniyor. İki astronot yüzeye gidecek, iki astronot yörüngede kalacak.', crew: '2 YÜZEY + 2 YÖRÜNGE', loc: 'Ay çevresi' } },
  { day: 6, to: 6.25,
    en: { title: 'A new<br>footprint.', name: 'Lunar landing', short: 'Landing', tag: 'MOON / SOUTH POLAR REGION', desc: 'The lander descends under control. Low sunlight casts long shadows across the crater walls.', crew: '2 ASTRONAUTS · HLS', loc: 'South polar region' },
    tr: { title: 'Yeni bir<br>ayak izi.', name: 'Ay’a iniş', short: 'İniş', tag: 'AY / GÜNEY KUTUP BÖLGESİ', desc: 'İniş aracı kontrollü biçimde alçalıyor. Alçak Güneş ışığı, krater duvarlarında uzun gölgeler bırakıyor.', crew: '2 ASTRONOT · HLS', loc: 'Güney kutup bölgesi' } },
  { day: 6.25, to: 11.9,
    en: { title: 'Science in<br>the silence.', name: 'Surface science', short: 'Surface', tag: 'MOON / SURFACE OPERATIONS', desc: 'Geological observations, rock and soil samples. The candidate DUSTER and SPSS science payloads are being developed to study the lunar environment.', crew: '2 SURFACE + 2 ORBIT', loc: 'Lunar surface' },
    tr: { title: 'Sessizliğin<br>içindeki bilim.', name: 'Yüzey bilimi', short: 'Yüzey', tag: 'AY / YÜZEY OPERASYONLARI', desc: 'Jeolojik gözlemler, kaya ve toprak örnekleri. Aday DUSTER ve SPSS bilim yükleri Ay ortamını araştırmak için geliştiriliyor.', crew: '2 YÜZEY + 2 YÖRÜNGE', loc: 'Ay yüzeyi' } },
  { day: 11.9, to: 13,
    en: { title: 'Together<br>again.', name: 'Ascent / rendezvous', short: 'Ascent', tag: 'MOON → ORION', desc: 'The surface crew returns to orbit with their samples. All four astronauts reunite aboard Orion.', crew: '4 ASTRONAUTS · REUNITED', loc: 'Lunar surface → orbit' },
    tr: { title: 'Yeniden<br>bir arada.', name: 'Kalkış / buluşma', short: 'Kalkış', tag: 'AY → ORION', desc: 'Yüzey ekibi örnekleriyle yörüngeye dönüyor. Dört astronot Orion’da yeniden birleşiyor.', crew: '4 ASTRONOT · YENİDEN BİRLEŞME', loc: 'Ay yüzeyi → yörünge' } },
  { day: 13, to: 18,
    en: { title: 'The long road<br>home.', name: 'Return to Earth', short: 'Return', tag: 'MOON → EARTH', desc: 'Orion leaves lunar orbit. On the way home the crew makes course corrections and prepares for atmospheric entry.', crew: '4 ASTRONAUTS · ORION', loc: 'Earth transfer' },
    tr: { title: 'Eve giden<br>uzun yol.', name: 'Dünya’ya dönüş', short: 'Dönüş', tag: 'AY → DÜNYA', desc: 'Orion Ay çevresinden ayrılıyor. Dönüş uçuşunda rota kontrolleri ve atmosfer girişine hazırlık yapılıyor.', crew: '4 ASTRONOT · ORION', loc: 'Dünya transferi' } },
  { day: 18, to: 20,
    en: { title: 'The last ring<br>of fire.', name: 'Atmospheric entry', short: 'Entry', tag: 'EARTH / ORION CAPSULE', desc: 'Separated from its service module, Orion meets atmospheric entry behind its heat shield. Parachutes will slow the descent to the sea.', crew: '4 ASTRONAUTS · CAPSULE', loc: 'Earth’s atmosphere' },
    tr: { title: 'Son ateş<br>çemberi.', name: 'Atmosfer girişi', short: 'Giriş', tag: 'DÜNYA / ORION KAPSÜLÜ', desc: 'Servis modülünden ayrılan Orion, ısı kalkanıyla atmosfer girişini karşılıyor. Paraşütler denize inişi yavaşlatacak.', crew: '4 ASTRONOT · KAPSÜL', loc: 'Dünya atmosferi' } },
  { day: 20, to: 20.05,
    en: { title: 'One journey.<br>A new beginning.', name: 'Pacific / recovery', short: 'Pacific', tag: 'PACIFIC / MISSION END', desc: 'The capsule splashes down in the Pacific and the recovery team picks up the astronauts. Samples and flight data will light the way for future lunar missions.', crew: '4 ASTRONAUTS · BACK ON EARTH', loc: 'Pacific Ocean' },
    tr: { title: 'Bir yolculuk.<br>Yeni bir başlangıç.', name: 'Pasifik / kurtarma', short: 'Pasifik', tag: 'PASİFİK / GÖREV SONU', desc: 'Kapsül Pasifik’e iniyor, kurtarma ekibi astronotları alıyor. Örnekler ve uçuş verileri, sonraki Ay görevlerine ışık tutacak.', crew: '4 ASTRONOT · DÜNYA’YA DÖNÜŞ', loc: 'Pasifik Okyanusu' } }
];
const stages = stageDefs.map((s, i) => ({ start: STAGE_STARTS[i], end: STAGE_STARTS[i + 1] ?? duration, day: s.day, to: s.to, i18n: { en: s.en, tr: s.tr } }));
// the active language's fields (title, name, short, tag, desc, crew, loc) are copied onto each stage; registered before the UI's own listener
const localizeStages = () => { const l = getLang(); for (const s of stages) { delete s.short; Object.assign(s, s.i18n[l]); } };
localizeStages(); onLang(localizeStages);
const WORLD_OF_STAGE = ['launch', 'orbit', 'transfer', 'dock', 'surface', 'surface', 'surface', 'return', 'entry', 'splash'];
const state = { time: 0, playing: false, speed: 1, mode: 'cinematic', quality: 'medium', labels: true, sound: false, view: 0 };

// ------------------------------------------------------------------------------------------------ small math helpers
const ramp = (t, a, b) => clamp((t - a) / (b - a));
const sm = (t, a, b) => smooth((t - a) / (b - a));
const lerpA = (a, b, k) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return a + d * k; };
// Piecewise cubic through rows [t, v0, v1, ...] with finite-difference tangents (C1, no stop-start at the keys). out[i] = v_i.
function track(t, K, out) {
  const n = K.length, w = K[0].length - 1;
  if (t <= K[0][0]) { for (let i = 0; i < w; i++) out[i] = K[0][i + 1]; return out; }
  if (t >= K[n - 1][0]) { for (let i = 0; i < w; i++) out[i] = K[n - 1][i + 1]; return out; }
  let k = 1; while (k < n - 1 && t > K[k][0]) k++;
  const a = K[k - 1], b = K[k], h = b[0] - a[0], s = (t - a[0]) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const p = k > 1 ? K[k - 2] : null, q = k < n - 1 ? K[k + 1] : null;
  for (let i = 1; i <= w; i++) {
    const ma = p ? (b[i] - p[i]) / (b[0] - p[0]) : (b[i] - a[i]) / h, mb = q ? (q[i] - a[i]) / (q[0] - a[0]) : (b[i] - a[i]) / h;
    out[i - 1] = h00 * a[i] + h10 * h * ma + h01 * b[i] + h11 * h * mb;
  }
  return out;
}
// Hermite through rows [t, value, velocity].
function hermite(t, K) {
  const n = K.length;
  if (t <= K[0][0]) return K[0][1]; if (t >= K[n - 1][0]) return K[n - 1][1];
  let k = 1; while (k < n - 1 && t > K[k][0]) k++;
  const a = K[k - 1], b = K[k], h = b[0] - a[0], s = (t - a[0]) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * a[1] + (s3 - 2 * s2 + s) * h * a[2] + (-2 * s3 + 3 * s2) * b[1] + (s3 - s2) * h * b[2];
}
const n1 = x => Math.sin(x * 1.7) * .5 + Math.sin(x * 2.9 + 1.3) * .3 + Math.sin(x * 5.3 + .4) * .2;
const KV = new Array(8).fill(0);

// ------------------------------------------------------------------------------------------------ renderer, scene, lights
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas: $('#scene'), antialias: false, powerPreference: 'high-performance' }); }
catch (e) { $('#loading').innerHTML = '<h2>' + msg('webglFail') + '</h2><p>' + msg('webglFailMsg') + '</p>'; throw e; }
renderer.setClearColor(0x03070d); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // never toggled: every quality tier shares the same programs
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(43, innerWidth / innerHeight, .1, 6000);
const cine = new THREE.PerspectiveCamera(43, innerWidth / innerHeight, .1, 6000);   // the authored (cinematic) camera; bodies are placed from it even in free mode
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true; orbit.dampingFactor = .07; orbit.enabled = false; orbit.minDistance = 5; orbit.maxDistance = 1400; orbit.maxPolarAngle = Math.PI * .96;

const ambient = new THREE.HemisphereLight(0xaec6e6, 0x24202a, .7); scene.add(ambient);
const fillLight = new THREE.DirectionalLight(0xa8c7ef, .85); fillLight.position.set(90, 45, 140); scene.add(fillLight);
const sun = new THREE.DirectionalLight(0xffe3bb, 3.1); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.far = 650; sun.shadow.bias = -.0005; sun.shadow.normalBias = .04; scene.add(sun, sun.target);
let shadowExtent = 0;
function setShadowExtent(e) { if (e === shadowExtent) return; shadowExtent = e; const c = sun.shadow.camera; c.left = c.bottom = -e; c.right = c.top = e; c.updateProjectionMatrix(); }

// Early public handle: ready=false until the shader warm-up has finished (tools wait for it).
window.artemis = { ready: false, state, stages, camera, scene, renderer, orbit };

// ------------------------------------------------------------------------------------------------ loading screen + yielding
let texIdle = true; const texWaiters = [];
{ const m = THREE.DefaultLoadingManager, onStart = m.onStart, onLoad = m.onLoad; m.onStart = (...a) => { texIdle = false; onStart?.(...a); }; m.onLoad = (...a) => { texIdle = true; onLoad?.(...a); for (const f of texWaiters.splice(0)) f(); }; }
const marks = window.__marks = [], mark = l => marks.push(l + ":" + Math.round(performance.now()));
const nextFrame = () => new Promise(r => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 50); });
let uiRef = null, loadFrac = 0;
const progress = (f, label) => { loadFrac = Math.max(loadFrac, f); uiRef?.setLoadProgress?.(loadFrac, label); };
const audio = createAudio();
const ui = uiRef = createUI({
  state, stages, duration, audio,
  seek, togglePlay,
  setQuality: q => setQualityUser(q),
  setCameraMode(mode) { state.mode = mode; orbit.enabled = mode === 'free'; if (mode === 'free') camera.updateProjectionMatrix(); orbit.target.copy(camTarget); orbit.update(); },
  cycleView() { state.view = (state.view + 1) % 3; if (state.mode === 'free') { state.mode = 'cinematic'; orbit.enabled = false; } update(state.time); return state.view; },
  capture() { update(state.time); post.setFade(0); post.render(state.time, 0); return renderer.domElement.toDataURL('image/png'); }
});
progress(.01, msg('loadInit'));
await nextFrame();

const worlds = {}; const world = key => { const g = group(scene); worlds[key] = g; return g; };
const stars = createStars(scene);
const post = createPost(renderer, scene, camera);
post.warm?.();
const looks = createLooks({ renderer, scene, ambient, sun, fill: fillLight, stars, post, setShadowExtent });
const white = mat(0xd8d9d8, .35, .38);
progress(.04, msg('lLight')); await nextFrame();

// 1 · Launch: coastal complex at dawn, SLS with deterministic exhaust and smoke.
const launch = world('launch'); launch.add(createSky()); createLaunchSite(launch);
const SLS = createSLS(launch), sls = SLS.group, boosters = SLS.boosters;
for (const b of boosters) b.userData.flame = flame(b.userData.engineAnchor, { scale: .95, kind: 'srb' });
const exhaust = flame(SLS.coreEngineAnchor, { scale: 1.2, kind: 'rs25' });
const engineLight = new THREE.PointLight(0xffa260, 0, 220, 2); SLS.coreEngineAnchor.add(engineLight);
const ascentPath = (u, out) => out.set(u * u * 12, Math.pow(u, 1.7) * 210, 0);
const plume = createLaunchPlume(launch, ascentPath);
const sepPuffs = createSeparationPuffs(launch, { origin: ascentPath(EV.srbSep / 20, new THREE.Vector3()), t0: EV.srbSep, boosters, core: sls });
progress(.08, msg('lPad')); await nextFrame();

// 2 · Earth orbit: spent stage drifts away while Orion configures for the transfer burn.
const earthWorld = world('orbit'), earthOrb = earth(earthWorld, 120); earthOrb.rotation.set(.25, 1.1, -.2);
const orbitShip = orion(earthWorld, 2.1), detachedStage = mesh(cylinderG, white, earthWorld, 0, 0, 0, 4, 32, 4), orbFlame = flame(orbitShip.userData.engineAnchor, { scale: .4, kind: 'oms' });
const rcsOrbit = createRcsPuffs(orbitShip, { radius: 1.9, y: -.3, size: .9 });
orbitShip.rotation.order = 'ZXY';
progress(.12, msg('lEarth')); await nextFrame();

// 3 · Translunar coast.
const transfer = world('transfer'), earthTrans = earth(transfer, 105); earthTrans.rotation.y = 1;
const moonTrans = moon(transfer, 45);
const transferShip = orion(transfer, 2.4); transferShip.rotation.order = 'ZXY';
const rcsTransfer = createRcsPuffs(transferShip, { radius: 1.9, y: -.3, size: .8, prob: .35 });
progress(.16, msg('lMoon')); await nextFrame();

// 4 · Lunar-orbit rendezvous. Moon rotated so the texture's pole pinch faces away from the docking camera. Orion:lander scale 1.4:1 as in the ascent.
const rendezvous = world('dock'), moonDock = moon(rendezvous, 150); moonDock.rotation.set(1.25, .4, 0);
const DOCK_SCALE = 1.4, DOCK_Y = 5, LANDER_X = 10, HATCH_X = LANDER_X - 10.3, X_CONTACT = HATCH_X - 3.3 * DOCK_SCALE - .03;
const dockShip = orion(rendezvous, DOCK_SCALE); dockShip.rotation.order = 'ZXY';
const dockLander = lander(rendezvous); dockLander.rotation.order = 'ZXY'; dockLander.rotation.z = Math.PI / 2; dockLander.position.set(LANDER_X, DOCK_Y, 0);
dockLander.userData.setLegs?.(0);
const rcsShip = createRcsPuffs(dockShip, { radius: 1.9, y: -.3 }), rcsLander = createRcsPuffs(dockLander, { radius: 3.1, y: 7.5, size: 1.4 });
const earthDock = earth(rendezvous, 9);
const landerTick0 = dockLander.userData.tick;
// capture-latch flash: HDR ring + glow on the interface and a few docking-light blinks (all pure functions of t)
const latch = group(rendezvous); latch.position.set(HATCH_X, DOCK_Y, 0);
const latchRing = new THREE.Mesh(new THREE.TorusGeometry(1.25, .085, 10, 56), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(7, 5, 2.6, THREE.LinearSRGBColorSpace), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false }));
latchRing.rotation.y = Math.PI / 2; latchRing.renderOrder = 7; latchRing.frustumCulled = false; latch.add(latchRing);
const spriteMat = c => new THREE.SpriteMaterial({ map: soft, color: new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false });
const latchGlow = new THREE.Sprite(spriteMat([5, 3.6, 2])); latchGlow.renderOrder = 7; latch.add(latchGlow);
const dockLamps = [0, 1, 2].map(i => { const s = new THREE.Sprite(spriteMat(i === 1 ? [.5, 5, 1.2] : [6, .8, .5])); s.scale.setScalar(.42); s.renderOrder = 7; const a = i * Math.PI * 2 / 3 + .6; s.position.set(0, Math.cos(a) * 1.25, Math.sin(a) * 1.25); latch.add(s); return s; });
const dockTag = new THREE.Object3D(); dockTag.position.set(HATCH_X + .5, DOCK_Y + 3.2, 0); rendezvous.add(dockTag);
progress(.2, msg('lDock')); await nextFrame();

// 5–7 · South-polar surface: landing, science and ascent share one set.
const surface = world('surface'); createLunarSurface(surface, renderer);
progress(.24, msg('lSurface')); await nextFrame();
const surfaceLander = lander(surface), landFlame = flame(surfaceLander.userData.engineAnchor, { scale: .72, kind: 'descent' });
const groundLight = new THREE.PointLight(0xffc091, 0, 80); surfaceLander.add(groundLight);
const surfaceEarth = earth(surface, 19); surfaceEarth.rotation.set(.4, -1.5, -.3);
const astronauts = [astronaut(surface, 0, 0), astronaut(surface, 0, 0)];
const flagSet = flag(surface); flagSet.position.set(FLAG_POS[0], heights(FLAG_POS[0], FLAG_POS[1]), FLAG_POS[1]);
const dusterSet = duster(surface); dusterSet.position.set(DUSTER_POS[0], heights(DUSTER_POS[0], DUSTER_POS[1]) + .2, DUSTER_POS[1]);
const spssSet = spss(surface); spssSet.position.set(SPSS_POS[0], heights(SPSS_POS[0], SPSS_POS[1]), SPSS_POS[1]);
const dust = createLandingDust(surface);
const rcsAscent = createRcsPuffs(surfaceLander, { radius: 3.1, y: 7.5, size: 1.4 });
// Orion waits nose-down so the ascending lander's top hatch (10.3) meets its docking port (nose 3.3×1.4); it arrives from the camera side.
const ascentDock = orion(surface, 1.4); ascentDock.rotation.order = 'ZXY';
const rcsAscentOrion = createRcsPuffs(ascentDock, { radius: 1.9, y: -.3 });
surfaceLander.userData.setLegs?.(0);
progress(.3, msg('lProps')); await nextFrame();

// 8 · Trans-Earth coast.
const returnWorld = world('return'), returnEarth = earth(returnWorld, 100); returnEarth.rotation.y = 1.8;
const returnMoon = moon(returnWorld, 40);
const returnShip = orion(returnWorld, 2.5); returnShip.rotation.order = 'ZXY';
const returnFlame = flame(returnShip.userData.engineAnchor, { scale: .4, kind: 'oms' });
const rcsReturn = createRcsPuffs(returnShip, { radius: 1.9, y: -.3, size: .8, prob: .4 });
progress(.34, msg('lReturn')); await nextFrame();

// 9 · Entry: the Orion stack (crew module + service module) flips after separation, heat shield first.
const entry = world('entry'), entryEarth = earth(entry, 160);
const capsule = entryCapsule(entry); capsule.scale.setScalar(3);
const plasma = createEntryPlasma(capsule);
const entryDir = new THREE.Vector3(44, -12, 0).normalize(), downAxis = new THREE.Vector3(0, -1, 0);
const qFinal = new THREE.Quaternion().setFromUnitVectors(downAxis, entryDir), qFlip = new THREE.Quaternion(), qRoll = new THREE.Quaternion(), qWob = new THREE.Quaternion(), zAxis = new V3(0, 0, 1), yAxis = new V3(0, 1, 0), xAxis = new V3(1, 0, 0);
// Service module: use spacecraft's if it exports one, otherwise a compact stand-in (white MLI drum, radiator strips, bronze bell).
function buildServiceModule(parent) {
  if (SC.serviceModule) { const g = SC.serviceModule(parent); g.userData.stand = false; return g; }
  const g = group(parent); g.userData.stand = true;
  const body = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: .55, roughness: .38 }), dark = new THREE.MeshStandardMaterial({ color: 0x2a3036, metalness: .4, roughness: .55 }), bronze = new THREE.MeshStandardMaterial({ color: 0x8a5a34, metalness: .8, roughness: .35 });
  const R = 2.7, H = 3.2;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 48, 1, true), body); drum.position.y = -H / 2 - .1; g.add(drum);
  for (const y of [-.1, -H * .33, -H * .66, -H - .1]) { const r = new THREE.Mesh(new THREE.TorusGeometry(R + .02, .05, 6, 56), dark); r.rotation.x = Math.PI / 2; r.position.y = y; g.add(r); }
  const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R, .12, 48), dark); top.position.y = -.16; g.add(top);
  const bot = new THREE.Mesh(new THREE.CylinderGeometry(R, R * .55, .5, 48), dark); bot.position.y = -H - .35; g.add(bot);
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(.5, 1.45, 2.0, 32, 1, true), bronze); bell.position.y = -H - 1.35; bell.material.side = THREE.DoubleSide; g.add(bell);
  for (let k = 0; k < 4; k++) { const rad = new THREE.Mesh(new THREE.CylinderGeometry(R + .04, R + .04, H * .8, 14, 1, true, k * Math.PI / 2 - .5, 1.0), dark); rad.position.y = -H / 2 - .1; g.add(rad); }
  g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}
const sm3 = buildServiceModule(entry); sm3.scale.setScalar(3);
const smSepPuffs = [];     // jets are built once from the (deterministic) pose of the stack at separation
const qSM = new THREE.Quaternion(), tmpV = new V3(), tmpV2 = new V3(), tmpV3 = new V3(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler();
const capsulePos = (t, out) => { const u = ramp(t, 156, 171); return out.set(mix(-22, 22, u), mix(6, -6, u), 0); };
{
  const P0 = capsulePos(EV.smSep, new V3()), a1 = new V3(0, 0, 1), a2 = new V3(0, 1, 0).cross(entryDir).normalize(), jets = [];
  for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2, o = new V3().copy(a2).multiplyScalar(Math.cos(a)).addScaledVector(a1, Math.sin(a)); jets.push({ p: [P0.x + o.x * 7.6 - entryDir.x * 1.2, P0.y + o.y * 7.6 - entryDir.y * 1.2, P0.z + o.z * 7.6 - entryDir.z * 1.2], d: [o.x * .9 - entryDir.x * .5, o.y * .9 - entryDir.y * .5, o.z * .9 - entryDir.z * .5] }); }
  smSepPuffs.push(createBurstPuffs(entry, { jets, count: 6, spread: .5, speed: [5, 14], size: [.5, 3.2], life: [.9, 2.0], delay: [0, .18], drag: 1.6, flashAmount: 1.6, flashDecay: 6, seed: 1561 }));
}
// cloud-immersion veil used for the entry -> splash bridge (a pale cloud-white haze that wraps the camera)
const veil = new THREE.Mesh(new THREE.SphereGeometry(30, 16, 10), new THREE.MeshBasicMaterial({ color: 0xaec4e0, transparent: true, depthTest: false, depthWrite: false, side: THREE.BackSide, opacity: 0, fog: false, toneMapped: false }));
veil.renderOrder = 998; veil.frustumCulled = false; veil.visible = false; scene.add(veil);
progress(.38, msg('lEntry')); await nextFrame();

// 10 · Pacific splashdown and recovery.
const splash = world('splash'), ocean = createOcean(splash); splash.add(createSky());
const sea = seaCapsule(splash), seaCap = sea.group;
const rescue = recoveryShip(splash);
// three RHIBs converge from different sides (right-far, left-far, near-right) and park ~15-20 units off the capsule; the chutes lie to its left
const boatCount = 3, boats = [], boatStart = [[105, -55], [-190, -62], [78, 82]], boatStop = [[18, -3], [-9, -24], [14, 8]], boatT = [[177.3, 182.4], [176.4, 182.9], [178.6, 183.2]], boatYaw = [.9, -.8, 1.3];
if (SC.rescueBoat) for (let i = 0; i < boatCount; i++) { const b = SC.rescueBoat(splash); boats.push(b); }
const waves = createWaveRings(splash, { heightAt: ocean.heightAt });
const CAP_TOP = 2.7, fallY = dt => 44.3 - 6.8 * dt - 7.2 * (1 - Math.exp(-dt)), T_IMPACT = EV.splash, FALL_DT = T_IMPACT - STAGE_STARTS[9], Y0 = fallY(0);
const chutePuff = createChuteDeployPuff(splash, { position: new THREE.Vector3(0, fallY(EV.chuteDeploy - STAGE_STARTS[9]) + CAP_TOP, 0), t0: EV.chuteDeploy });
// inflated flotation collar (appears when the boats arrive)
const collar = new THREE.Mesh(new THREE.TorusGeometry(3.7, .62, 14, 56), new THREE.MeshStandardMaterial({ color: 0xff7a22, roughness: .6, metalness: 0, emissive: 0x3a1204 }));
collar.rotation.x = Math.PI / 2; collar.castShadow = true; collar.visible = false; seaCap.add(collar);
// V-wake behind each boat: a flat triangular foam fan (screen-space-free shader, pure in t)
const wakeMat = new THREE.ShaderMaterial({
  uniforms: { uT: { value: 0 } }, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  vertexShader: 'varying vec2 vP; attribute float aA; varying float vA; void main(){ vP=position.xz; vA=aA; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
  fragmentShader: `varying vec2 vP; varying float vA; uniform float uT;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
void main(){ float L=max(-vP.y,0.); float w=1.1+L*.26; float x=abs(vP.x);
  float edge=exp(-pow((x-w)/(.55+L*.05),2.)); float core=exp(-pow(x/(.9+L*.08),2.))*.8;
  float fl=n(vec2(vP.x*1.4,vP.y*.7+uT*-3.))*.6+n(vec2(vP.x*3.2,vP.y*1.6-uT*5.))*.4;
  float a=(edge*1.1+core)*fl*vA*smoothstep(0.,1.5,L)*(1.-smoothstep(10.,70.,L));
  gl_FragColor=vec4(vec3(.92,.96,1.)*a,a); }`
});
function makeWake() {
  const N = 12, pos = new Float32Array((N + 1) * 2 * 3), al = new Float32Array((N + 1) * 2), idx = [];
  for (let i = 0; i <= N; i++) { const z = -2 - i * 5.6, w = 3 + i * 3.2; pos.set([-w, 0, z, w, 0, z], i * 6); al[i * 2] = al[i * 2 + 1] = 1; if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aA', new THREE.BufferAttribute(al, 1)); g.setIndex(idx);
  const m = new THREE.Mesh(g, wakeMat); m.frustumCulled = false; m.renderOrder = 3; m.position.y = .3; return m;
}
const wakes = boats.map(b => { const w = makeWake(); b.add(w); return w; });
// the boats' own bow-spray / stern-wake sheets are scaled with speed so parked boats do not trail streaks (uAmt is read per frame by the foam shaders)
const boatFoam = boats.map(b => { const a = []; b.traverse(o => { if (o.isMesh && /^foam(Bow|Wake)$/.test(o.name) && o.material.uniforms?.uAmt) a.push([o.material.uniforms.uAmt, o.material.uniforms.uAmt.value]); }); return a; });
progress(.42, msg('lPacific')); await nextFrame();

// ------------------------------------------------------------------------------------------------ annotations
const noObj = (parent, x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };
const dusterLabelObj = noObj(surface, 0, 2.5, 0), spssLabelObj = noObj(surface, 0, 2.5, 0);
const esmTag = noObj(orbitShip, 0, -1.5, 0), shipTag = noObj(rescue, 0, 62, 0);   // anchors on the ESM (orbit) and above the recovery ship's superstructure
const ANN = {
  dockOrion: { text: L('ORION · 2 ASTRONAUTS IN ORBIT', 'ORION · 2 ASTRONOT YÖRÜNGEDE'), world: 'dock', object: dockShip, offset: new V3(-5, 8, 0), side: 'left' },
  dockHls: { text: L('HLS · REPRESENTATIVE LANDER', 'HLS · TEMSİLİ İNİŞ ARACI'), world: 'dock', object: dockLander, offset: new V3(-3, 7.5, 0), side: 'right' },
  dockLatched: { text: L('DOCKED · ORION + HLS', 'KENETLENDİ · ORION + HLS'), world: 'dock', object: dockTag, side: 'right' },
  entrySm: { text: L('ORION · SERVICE MODULE (ESM)', 'ORION · HİZMET MODÜLÜ (ESM)'), world: 'entry', object: sm3, offset: new V3(0, 7, 0) },
  ship: { text: L('RECOVERY SHIP', 'KURTARMA GEMİSİ'), world: 'splash', object: shipTag, radius: 22 },
  duster: { text: L('DUSTER · CANDIDATE PAYLOAD', 'DUSTER · ADAY YÜK'), world: 'surface', object: dusterLabelObj, scienceOnly: true, occlude: true },
  spss: { text: L('SPSS · CANDIDATE PAYLOAD', 'SPSS · ADAY YÜK'), world: 'surface', object: spssLabelObj, scienceOnly: true, occlude: true }
};
ui.addAnnotations([
  { text: 'SLS · ORION', world: 'launch', object: sls, offset: new V3(3, 54, 0) },
  { text: L('ORION · SERVICE MODULE (ESM)', 'ORION · HİZMET MODÜLÜ (ESM)'), world: 'orbit', object: esmTag, offset: new V3(5, 6, 0), radius: 5 },
  { text: L('ORION · 4 ASTRONAUTS', 'ORION · 4 ASTRONOT'), world: 'transfer', object: transferShip, offset: new V3(3, -8, 0) },
  ANN.dockOrion, ANN.dockHls, ANN.dockLatched,
  { text: L('HLS · REPRESENTATIVE MODEL', 'HLS · TEMSİLİ MODEL'), world: 'surface', object: surfaceLander, offset: new V3(3, 8, 0), lander: true },
  ANN.duster, ANN.spss,
  { text: L('ORION · RETURN TO EARTH', 'ORION · DÜNYA’YA DÖNÜŞ'), world: 'return', object: returnShip, offset: new V3(7, 9, 0) },
  ANN.entrySm,
  { text: L('ORION CAPSULE', 'ORION KAPSÜLÜ'), world: 'entry', object: capsule, offset: new V3(0, 6, 0) },
  { text: L('ORION CAPSULE', 'ORION KAPSÜLÜ'), world: 'splash', object: seaCap, offset: new V3(0, 5, 0) },
  ANN.ship
]);

// ------------------------------------------------------------------------------------------------ trajectory ribbons (camera-facing, additive, fade ahead/behind the ship)
const ribbonMat = () => new THREE.ShaderMaterial({
  uniforms: { uRes: { value: new THREE.Vector2(1440, 900) }, uWidth: { value: 2.4 }, uShip: { value: .5 }, uFade: { value: 1 }, uCol: { value: new THREE.Color().setRGB(.34, .62, .95, THREE.LinearSRGBColorSpace) } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
  vertexShader: `attribute vec3 aPrev,aNext;attribute float aSide,aS;uniform vec2 uRes;uniform float uWidth;varying float vS,vSide;
void main(){mat4 m=projectionMatrix*modelViewMatrix;vec4 c=m*vec4(position,1.),cp=m*vec4(aPrev,1.),cn=m*vec4(aNext,1.);
vec2 s0=cp.xy/cp.w*uRes,s1=cn.xy/cn.w*uRes;vec2 d=s1-s0;float l=length(d);d=l>1e-4?d/l:vec2(1.,0.);vec2 n=vec2(-d.y,d.x);
c.xy+=n*aSide*uWidth/uRes*c.w*2.;gl_Position=c;vS=aS;vSide=aSide;}`,
  fragmentShader: `uniform float uShip,uFade;uniform vec3 uCol;varying float vS,vSide;
void main(){float d=vS-uShip;float behind=d<0.?exp(d*2.4):1.;float ahead=d>0.?exp(-d*1.8)*(.55+.45*step(.5,fract(d*46.))):1.;
float edge=1.-vSide*vSide;float a=edge*behind*ahead*uFade*.75;gl_FragColor=vec4(uCol*a*1.6,a);}`
});
function makeRibbon(parent, N) {
  const pos = new Float32Array(N * 6), pv = new Float32Array(N * 6), nx = new Float32Array(N * 6), sd = new Float32Array(N * 2), ss = new Float32Array(N * 2), idx = [];
  for (let i = 0; i < N; i++) { sd[i * 2] = -1; sd[i * 2 + 1] = 1; ss[i * 2] = ss[i * 2 + 1] = i / (N - 1); if (i < N - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
  const g = new THREE.BufferGeometry(), A = (n, a, s) => { const at = new THREE.BufferAttribute(a, s); at.setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, at); return at; };
  const aP = A('position', pos, 3), aV = A('aPrev', pv, 3), aN = A('aNext', nx, 3); g.setAttribute('aSide', new THREE.BufferAttribute(sd, 1)); g.setAttribute('aS', new THREE.BufferAttribute(ss, 1)); g.setIndex(idx);
  const m = new THREE.Mesh(g, ribbonMat()); m.frustumCulled = false; m.renderOrder = 2; parent.add(m);
  const pts = new Float32Array(N * 3);
  m.userData.set = (ship, fade) => {   // pts must have been filled by the caller
    for (let i = 0; i < N; i++) {
      const p = i * 3, a = Math.max(i - 1, 0) * 3, b = Math.min(i + 1, N - 1) * 3;
      for (let k = 0; k < 3; k++) { const v = pts[p + k]; pos[i * 6 + k] = pos[i * 6 + 3 + k] = v; pv[i * 6 + k] = pv[i * 6 + 3 + k] = pts[a + k]; nx[i * 6 + k] = nx[i * 6 + 3 + k] = pts[b + k]; }
    }
    aP.needsUpdate = aV.needsUpdate = aN.needsUpdate = true; m.material.uniforms.uShip.value = ship; m.material.uniforms.uFade.value = fade;
  };
  m.userData.pts = pts; m.userData.N = N; return m;
}
const orbitPath = makeRibbon(earthWorld, 160), transferPath = makeRibbon(transfer, 100);
const ribbons = [orbitPath, transferPath];
const setRibbonRes = () => { renderer.getDrawingBufferSize(tmpV2v); for (const r of ribbons) { r.material.uniforms.uRes.value.set(tmpV2v.x, tmpV2v.y); r.material.uniforms.uWidth.value = Math.max(1.8, 2.2 * renderer.getPixelRatio()); } };
const tmpV2v = new THREE.Vector2();

// ------------------------------------------------------------------------------------------------ frame state
let currentStage = -1, activeWorld = 'launch', fps = 0, lastStage = -1, frameCount = 0, frameSeconds = 0;
const focus = new V3(), camPos = new V3(), camTarget = new V3(), lastTarget = new V3(), shakeV = new V3();
let camRoll = 0, camCx = .03, camCy = .18, camShake = 0, camShakeSeed = 0;
const tickCtx = { t: 0, idx: 0, u: 0, camera, sunDir: new V3(), quality: 'medium', world: 'launch' };
const uiInfo = { t: 0, idx: 0, u: 0, stage: stages[0], day: 0 }, audioInfo = { t: 0, idx: 0, u: 0, playing: false, speed: 1, hidden: false };
const getStage = t => { const i = stages.findIndex(s => t < s.end); return i < 0 ? stages.length - 1 : i; };
const worldList = Object.entries(worlds);
const tickFn = o => { if (o.userData.tick) o.userData.tick(t_, tickCtx); };
let t_ = 0, idxNow = 0, cutAt = -1e9;

// orbit camera: target = anchor + offset; camera = target + spherical(azimuth phi from +Z toward +X, elevation e, distance d)
function orbitCam(ax, ay, az, phi, e, d, ox = 0, oy = 0, oz = 0) {
  camTarget.set(ax + ox, ay + oy, az + oz);
  const ce = Math.cos(e * DEG); camPos.set(camTarget.x + d * ce * Math.sin(phi * DEG), camTarget.y + d * Math.sin(e * DEG), camTarget.z + d * ce * Math.cos(phi * DEG));
}
function groundClamp(minH) { const h = heights(camPos.x, camPos.z) + minH; if (camPos.y < h) camPos.y = h; }
// place a far body on the cinematic camera's ray through NDC (nx, ny); keeps a minimum elevation above the horizon for surface worlds
function lockBody(obj, nx, ny, dist, minElev = -1) {
  tmpV.set(nx, ny, .5).unproject(cine).sub(cine.position).normalize();
  if (minElev > -1 && tmpV.y < minElev) { const k = Math.sqrt(1 - minElev * minElev) / Math.max(1e-4, Math.hypot(tmpV.x, tmpV.z)); tmpV.set(tmpV.x * k, minElev, tmpV.z * k); }
  obj.position.copy(cine.position).addScaledVector(tmpV, dist);
}
const placers = [];   // body placements that need the final cinematic camera

// ------------------------------------------------------------------------------------------------ stage choreography
const astroPose = {};

// Stage 0 · launch ---------------------------------------------------------------------------------------------------
const CAM0 = [[0, 6, -7, 158, 30], [2.4, 9, -5, 160, 31], [5.5, 24, 0, 164, 32], [8.5, 38, 4, 168, 31], [11.7, 46, 5, 186, 22], [14.5, 52, 2, 196, 23], [20, 62, -3, 212, 27]];
function stage0(t, u) {
  ascentPath(u, sls.position); sls.rotation.z = -u * .065;
  const ss = EV.srbSep, dt = Math.max(0, t - ss);
  const thr = t < ss - 1 ? 1 : t < ss ? mix(1, .16, smooth((t - (ss - 1)))) : t < ss + .22 ? .09 * (1 - (t - ss) / .22) : 0;
  boosters.forEach((b, i) => {
    const s = i ? 1 : -1, asym = 1 + s * .08;
    b.position.set(s * (4.55 + 5 * dt + 1.5 * dt * dt * asym), -(2.6 * dt + 2.0 * dt * dt), 0);
    b.rotation.set(s * .05 * dt, 0, -s * (.9 * dt * asym + .05 * dt * dt));
    const bf = b.userData.flame; bf.visible = t > 0 && thr > .004; bf.scale.set(.95 * (.55 + .45 * thr), .95 * thr * (.9 + .1 * Math.sin(t * 15 + i)), .95 * (.55 + .45 * thr)); bf.userData.update(t + i, Math.min(1, thr * 1.5));
  });
  exhaust.visible = t > 0; exhaust.scale.set(1.3, 1.25 + .12 * Math.sin(t * 13), 1.3); exhaust.userData.update(t);
  engineLight.intensity = t > 0 ? (t < ss ? 800 * (.6 + .4 * thr) : 450) : 0;
  plume.update(t, u); sepPuffs.update(t);
  focus.set(sls.position.x, sls.position.y + 32, 0);
  track(t, CAM0, KV); orbitCam(sls.position.x, sls.position.y, 0, KV[0], KV[1], KV[2], 0, KV[3], 0);
  camShake = .55 * Math.exp(-t / 2.6) * ramp(t, 0, .3) + .35 * Math.exp(-Math.abs(t - ss) / .5);
  camCx = .03; camCy = .18;
}

// Stage 1 · orbit -----------------------------------------------------------------------------------------------------
const CAM1 = [[20, 18, 7, 104, 0], [26, 44, 5, 76, 0], [28.6, 58, 0, 58, -1], [30, 76, -7, 44, -3], [33, 100, -9, 38, -3], [35, 118, -8, 40, -3]];
const ringBase = new V3(), ringT = new V3(), ringC = new V3(), ringR = new V3();
function ribbonOrbit(pathMesh, center, shipPos, tangent, fade, arc) {
  ringR.copy(shipPos).sub(center); const R = ringR.length(); ringR.divideScalar(R);
  ringT.copy(tangent).addScaledVector(ringR, -tangent.dot(ringR)).normalize();
  const P = pathMesh.userData.pts, N = pathMesh.userData.N;
  for (let i = 0; i < N; i++) { const a = (i / (N - 1) - .5) * arc; const c = Math.cos(a), s = Math.sin(a); P[i * 3] = center.x + R * (c * ringR.x + s * ringT.x); P[i * 3 + 1] = center.y + R * (c * ringR.y + s * ringT.y); P[i * 3 + 2] = center.z + R * (c * ringR.z + s * ringT.z); }
  pathMesh.userData.set(.5, fade);
}
function stage1(t, u) {
  const ease = smooth(u);
  orbitShip.position.set(0, 6, 0); orbitShip.rotation.set(.12 * Math.sin(t * .31), .85 + u * .6, -.6 + u * .3);
  detachedStage.position.set(-20 - ease * 45, -28 - ease * 50, -8); detachedStage.rotation.z = -.5 - u;
  orbFlame.visible = t >= EV.omsBurn; orbFlame.userData.update(t); rcsOrbit.update(t, u < .55 ? .7 : 0);
  focus.set(0, 5, 0);
  track(t, CAM1, KV); orbitCam(0, 6, 0, KV[0], KV[1], KV[2], 0, KV[3], 0);
  camShake = .35 * Math.exp(-Math.abs(t - EV.omsBurn - .25) / .7);
  earthOrb.rotation.y = 1.1 + (t - 20) * .028;
  camCx = .03; camCy = .18;
}

// Stage 2 · transfer ------------------------------------------------------------------------------------------------------
const CAM2 = [[35, 8, 7, 80, 0], [42, 26, 5, 70, 0], [49, 44, 3, 62, 0], [55, 58, 2, 56, 0]];
const bzA = new V3(), bzB = new V3(), bzC = new V3(), bzP = new V3();
function ribbonBezier(pathMesh, A, B, S, tau, fade) {
  const k = 2 * (1 - tau) * tau; bzC.copy(S).addScaledVector(A, -(1 - tau) * (1 - tau)).addScaledVector(B, -tau * tau).divideScalar(k);
  const P = pathMesh.userData.pts, N = pathMesh.userData.N;
  for (let i = 0; i < N; i++) { const s = i / (N - 1), a = (1 - s) * (1 - s), b = 2 * (1 - s) * s, c = s * s; P[i * 3] = a * A.x + b * bzC.x + c * B.x; P[i * 3 + 1] = a * A.y + b * bzC.y + c * B.y; P[i * 3 + 2] = a * A.z + b * bzC.z + c * B.z; }
  pathMesh.userData.set(tau, fade);
}
function stage2(t, u) {
  const ease = smooth(u);
  transferShip.position.set(mix(-30, 30, ease), Math.sin(u * Math.PI) * 8, 15); transferShip.rotation.set(.1 * Math.sin(t * .27), 1.05 + u * .5, -.9 + .25 * Math.sin(u * 2)); rcsTransfer.update(t, .5);
  earthTrans.rotation.y = 1 + (t - 35) * .01;
  focus.copy(transferShip.position);
  track(t, CAM2, KV); orbitCam(focus.x, focus.y, focus.z, KV[0], KV[1], KV[2], 0, KV[3], 0);
  camShake = 0; camCx = -.1; camCy = .18; camRoll = .012 * Math.sin(t * .21);
}

// Stage 3 · docking ---------------------------------------------------------------------------------------------------------
// Orion's closing gap g (nose to hatch): fast, then range-proportional braking, a station-keeping beat and a slow 0.4 u/s soft capture.
const DOCK_G = [[55, 35.1, -4.2], [66, 6.0, -1.5], [70.3, 1.2, -.4], [EV.dockContact, 0, -.4]];
const CAM3 = [[55, -60, 12, 100, 0], [62, -52, 11, 94, 0], [66, -44, 11, 84, 0], [70, -32, 10, 58, 0], [72, -18, 9, 38, 0], [EV.dockContact, -6, 7, 27, 0], [EV.dockContact + .7, -9, 8, 30, 0], [75, -22, 10, 54, 0]];
const kickT = (() => { const a = []; let s = 7; for (let i = 0; i < 12; i++) { s = (s * 16807) % 2147483647; a.push(56.2 + i * 1.18 + (s % 1000) / 1000 * .5); } return a; })();
function stage3(t, u) {
  const tc = EV.dockContact, tau = t - tc;
  const g = t < tc ? hermite(t, DOCK_G) : 0;
  const rec = tau > 0 ? .2 * Math.exp(-5 * tau) * Math.sin(Math.PI * 2 * 1.6 * tau) : 0;       // contact recoil + damped settle
  dockShip.position.set(X_CONTACT - g - rec, DOCK_Y, 0);
  // slow attitude drift + RCS kicks, converging to a locked pose before contact (so the docking petals line up)
  const lockK = 1 - sm(t, tc - 3.2, tc - .3);
  let kyaw = 0, kpitch = 0; for (let i = 0; i < kickT.length; i++) { const d = t - kickT[i]; if (d > 0 && d < 2.4) { const e = Math.exp(-d / .6); kyaw += ((i & 1) ? 1 : -1) * e; kpitch += ((i % 3) - 1) * e * .8; } }
  const drift = lockK * (Math.sin(t * .62) * .011 + kyaw * .0085), driftP = lockK * (Math.sin(t * .47 + 1) * .010 + kpitch * .0085);
  dockShip.rotation.set(drift, (1 - sm(t, 56, tc - 3.5)) * .78, -Math.PI / 2 + driftP);
  dockLander.rotation.set(0, 0, Math.PI / 2); if (tau > 0) { dockLander.rotation.x = .007 * Math.exp(-3 * tau) * Math.sin(tau * 11); dockLander.rotation.z = Math.PI / 2 + .004 * Math.exp(-3 * tau) * Math.sin(tau * 9 + 1); }
  rcsShip.update(t, t < tc - 3 ? 1 : t < tc ? .4 : tau < .6 ? .8 : 0); rcsLander.update(t, t < tc - 3 ? .6 : 0);
  moonDock.rotation.y = .4 + (t - 55) * .004; moonDock.position.set(-(t - 55) * .15, -185, -190);
  // capture latch
  const f = tau < 0 ? 0 : Math.exp(-tau / .16);
  latchRing.material.opacity = f * (.7 + .3 * Math.sin(tau * 60)); latchRing.visible = f > .01; latchRing.scale.setScalar(1 + (1 - f) * .06);
  latchGlow.material.opacity = f * .8; latchGlow.visible = f > .01; latchGlow.scale.setScalar(2.4 + 2.5 * (1 - f));
  for (let i = 0; i < 3; i++) { const b = tau > .12 + i * .3 && tau < .12 + i * .3 + .14 ? 1 : 0; dockLamps[i].material.opacity = b; dockLamps[i].visible = b > 0; }
  // camera: anchor glides from the pair's midpoint to the interface
  const mid = (dockShip.position.x + LANDER_X) * .5, ax = mix(mid, HATCH_X + .6, sm(t, 64, 72.2));
  focus.set(ax, DOCK_Y, 0);
  track(t, CAM3, KV); orbitCam(ax, DOCK_Y, 0, KV[0], KV[1], KV[2], 0, KV[3], 0);
  camShake = .18 * Math.exp(-Math.max(tau, 0) / .35) * (tau > 0 ? 1 : 0);
  camCx = .03; camCy = .18; camRoll = .02 * Math.sin(t * .17) * (1 - sm(t, 70, 73));
}

// Stage 4-6 · surface -----------------------------------------------------------------------------------------------------------
const LAND_Y0 = 95, LAND_V = 2.5, LAND_T0 = STAGE_STARTS[4], LAND_T = EV.touchdown - LAND_T0;
// descent: starts at 105 u, brakes to a 2.5 u/s residual speed at touchdown (a real contact, not a hover)
const landY = t => { const k = ramp(t, LAND_T0, EV.touchdown); return (LAND_Y0 - LAND_V * LAND_T) * (1 - k) * (1 - k) + LAND_V * LAND_T * (1 - k); };
const landX = t => 28 * Math.pow(1 - ramp(t, LAND_T0, EV.touchdown), 2.2);
const ASC_YK = [[EV.liftoff, 0, 0], [122.0, 2.2, 2.6], [126.0, 36, 11], [131.0, 94, 12], [134.0, 120.5, 5], [EV.ascentDock, 124.97, .4]];
const ASC_XK = [[EV.liftoff, 0, 0], [128, 2.5, .6], [133, 8.5, 1.2], [EV.ascentDock, 10, .1]];
const ASC_X0 = 10, ASC_Y0 = 139.92, BURN_END = 131.8;
const CAM4 = [[75, 52, 26, 60, 4.5], [79, 46, 18, 54, 4], [83, 40, 12, 46, 4], [86.5, 32, 6.5, 37, 4.2], [88.5, 28, 4.2, 33, 4.5], [EV.touchdown, 24, 3.2, 29, 4.8], [92, 22, 3.0, 27, 5.2]];
const easeBack = k => { k = clamp(k); const c1 = 1.7, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
function placeAstronaut(i, t) {
  const a = astronauts[i], P = astroPose; astronautAt(i, t, P);
  a.visible = P.mode > 0 && P.scale > .01;
  if (!a.visible) return;
  if (P.mode === 1) { const gh = heights(LADDER.baseX, LADDER.baseZ); a.position.set(P.x, P.y + (P.ladderK >= .999 ? gh : P.ladderK > 0 ? gh * P.ladderK : 0), P.z); }
  else a.position.set(P.x, heights(P.x, P.z) + Math.abs(Math.sin(P.phase)) * .22, P.z);
  a.rotation.y = P.h; a.userData.walk(P.phase); a.scale.setScalar(P.scale);
}
// science shots (hard cuts, each with its own gentle move): [t0, t1, fn(t, k)]
const sciCam = [
  [92, 98.4, (t, k) => { camPos.set(mix(-11, -7.5, k), mix(2.6, 2.2, k), mix(20, 15, k)); camTarget.set(mix(1.8, 1.8, k), mix(4.3, 3.2, k), mix(4.4, 5.2, k)); }],                                   // low 3/4 egress
  [98.4, 101.2, (t, k) => { const a = astronauts[0].position; camPos.set(mix(26, 20.5, k), 2.6, mix(26.5, 25.5, k)); camTarget.set(a.x * .55 + FLAG_POS[0] * .45, 2.8, a.z * .55 + FLAG_POS[1] * .45); }],  // track a1 to the flag
  [101.2, 104.6, (t, k) => { camPos.set(mix(9.5, 11.5, k), mix(1.5, 2.1, k), mix(23.5, 24.5, k)); camTarget.set(mix(14.2, 14.6, k), 3.2, mix(15.8, 16.2, k)); }],                                       // flag, astronaut, Earth behind
  [104.6, 107.6, (t, k) => { camPos.set(mix(-31, -26, k), mix(2.8, 3.4, k), mix(-25, -22, k)); camTarget.set(dusterSet.position.x - 1, 2.4, dusterSet.position.z + 1); }],                              // DUSTER unfolds, a2 beside it
  [107.6, 111.2, (t, k) => { camPos.set(mix(32, 27.5, k), mix(2.4, 2.9, k), mix(7, 3.5, k)); camTarget.set(SPSS_POS[0] - .6, 1.8, SPSS_POS[1] + .5); }],                                                       // SPSS deployed by a1
  [111.2, 120.05, (t, k) => { const e = smooth(k); camPos.set(mix(38, 31, e), mix(4, 10, e), mix(33, 29, e)); camTarget.set(mix(6, 2.5, k), mix(3, 5.5, k), mix(7, 5, k)); }]                              // crane up to the wide
];
const CAM6A = [[120, 40, -1.5, 45, 4.5], [123, 38, -6, 52, 6], [126, 40, -10, 58, 8], [130, 48, -10, 58, 8]];
const orionApproach = new V3(.5, .32, .8).normalize(), vA = new V3(), tA = new V3();
function surfaceStage(t, u, idx) {
  const tTD = EV.touchdown;
  surfaceLander.visible = true;
  let y = 0, x = 0, flameOn = false, flameScale = 1;
  if (idx === 4) {
    y = landY(t); x = landX(t);
    const tauT = t - tTD, comp = tauT > 0 ? .1 * (1 - Math.exp(-28 * tauT)) * Math.exp(-3.6 * tauT) + .035 * Math.sin(tauT * 17) * Math.exp(-6 * tauT) : 0;
    y = Math.max(y - comp, -.12);
    flameOn = t < tTD + .45; flameScale = t < tTD ? mix(1, .35, smooth((t - 76) / (tTD - 76))) : .35 * Math.max(0, 1 - (t - tTD) / .45);
    const wob = t < tTD ? Math.min(1, (tTD - t) * .5) : Math.exp(-tauT * 5);
    surfaceLander.rotation.set(.018 * Math.sin(t * .9) * wob, LANDER_YAW, (landX(t + .2) - landX(t)) * .35 + (tauT > 0 ? .012 * Math.sin(tauT * 7) * Math.exp(-3 * tauT) : 0));
    surfaceLander.userData.setLegs?.(sm(t, 76, 79.2));
  } else if (idx === 5) { surfaceLander.rotation.set(0, LANDER_YAW, 0); surfaceLander.userData.setLegs?.(1); }
  else {
    y = hermite(t, ASC_YK); x = hermite(t, ASC_XK);
    flameOn = t >= EV.liftoff && t < BURN_END + .35; flameScale = t < BURN_END ? clamp((t - EV.liftoff) / .5) * .55 + .45 : Math.max(0, 1 - (t - BURN_END) / .35);
    surfaceLander.rotation.set(0, LANDER_YAW, -.012 * Math.sin(t * .8) * ramp(t, 121, 124));
    surfaceLander.userData.setLegs?.(1 - sm(t, 122.8, 126.4));
  }
  surfaceLander.position.set(x, y, 0);
  landFlame.visible = flameOn; landFlame.scale.set(1, Math.max(.02, flameScale), 1); groundLight.intensity = flameOn ? 80 * flameScale : 0; if (flameOn) landFlame.userData.update(t);
  // dust: after touchdown the "engine height" is eased upward so the blast sheet fades out slowly instead of vanishing
  let dh = y, dAct = flameOn;
  if (idx === 4 && t >= tTD) { dh = mix(y, 60, smooth((t - tTD) / 3.4)); dAct = t < tTD + 3.4; }
  dust.update(t, x, Math.max(0, dh), dAct);
  // crew and props: unpacked/planted by the astronauts, never present from the cut
  placeAstronaut(0, t); placeAstronaut(1, t);
  const tp = t >= STAGE_STARTS[6] ? 1e3 : t;
  const fk = easeBack(ramp(tp, PROPS.flag, PROPS.flag + .9)); flagSet.visible = fk > .01; flagSet.scale.set(1, Math.max(.01, fk), 1);
  const dk = easeBack(ramp(tp, PROPS.duster, PROPS.duster + 1.1)); dusterSet.visible = dk > .01; dusterSet.scale.setScalar(Math.max(.01, dk));
  const sk = easeBack(ramp(tp, PROPS.spss, PROPS.spss + 1.1)); spssSet.visible = sk > .01; spssSet.scale.setScalar(Math.max(.01, sk));
  dusterSet.position.x = DUSTER_POS[0] - ramp(t, PROPS.duster + .5, 119.5) * 6; dusterSet.position.y = heights(dusterSet.position.x, DUSTER_POS[1]) + .2;
  dusterLabelObj.position.copy(dusterSet.position); spssLabelObj.position.copy(spssSet.position);
  // ascent: Orion arrives from the camera side, rolling, and meets the lander at EV.ascentDock
  ascentDock.visible = idx === 6;
  if (idx === 6) {
    const ad = Math.max(0, hermite(t, [[120, 70, -6], [127, 30, -3.4], [133, 5.5, -1.0], [EV.ascentDock, 0, -.35]])), tauC = t - EV.ascentDock;
    ascentDock.position.set(ASC_X0 + orionApproach.x * ad, ASC_Y0 + orionApproach.y * ad, orionApproach.z * ad);
    const calm = 1 - sm(t, 128, 134);
    ascentDock.rotation.set(.15 * Math.sin(t * .4) * calm, (1 - sm(t, 120, EV.ascentDock - 2.5)) * 2.4, Math.PI + .12 * Math.sin(t * .33) * calm);
    const rcs = t > 132.4 && t < EV.ascentDock; rcsAscentOrion.update(t, rcs ? 1 : 0); rcsAscent.update(t, rcs ? .9 : 0);
    if (tauC > 0) ascentDock.position.y += .12 * Math.exp(-5 * tauC) * Math.sin(tauC * 10);
  }
  // cameras
  focus.set(x, y + 5, 0);
  if (idx === 4) {
    track(t, CAM4, KV); camPos.set(KV[0], KV[1], KV[2]); camTarget.set(x, y + KV[3], 0); groundClamp(1.4);
    camShake = .2 * Math.exp(-Math.abs(t - tTD) / .45) + (flameOn ? .04 : 0);
  } else if (idx === 5) {
    let shot = sciCam[0]; for (const s of sciCam) if (t >= s[0]) shot = s;
    shot[2](t, ramp(t, shot[0], shot[1])); groundClamp(1.1); camShake = .012;
  } else {
    track(t, CAM6A, KV); orbitCam(x, y, 0, KV[0], KV[1], KV[2], 0, KV[3], 0);
    const bl = sm(t, 129.2, 132.8);
    if (bl > 0) {   // dolly in on the pair, gentle low-angle upward tilt
      vA.copy(camPos); tA.copy(camTarget);
      const mx = (x + ascentDock.position.x) * .5, my = (y + 10.3 + ascentDock.position.y - 4.62) * .5; orbitCam(mx, my, 0, mix(50, 60, bl), mix(-6, -13, bl), mix(56, 36, bl));
      camPos.lerp(vA, 1 - bl); camTarget.lerp(tA, 1 - bl);
    }
    if (t < 124) groundClamp(1.4);
    camShake = (t > EV.liftoff ? .25 * Math.exp(-(t - EV.liftoff) / 1.6) : 0) + (t > EV.ascentDock ? .1 * Math.exp(-(t - EV.ascentDock) / .4) : 0);
  }
  surfaceEarth.scale.setScalar(14 / 19); placers.push(placeSurfaceEarth);
}
const ndcTmp = new V3();
function placeSurfaceEarth() {   // Earth rides the camera ray at a fixed screen spot: never behind the lander or the HUD, low over the horizon
  const t = t_, idx = idxNow; let nx = .3, ny = .46;
  if (idx === 4) { nx = mix(.34, .3, ramp(t, 75, 92)); ny = mix(.5, .46, ramp(t, 75, 92)); }
  else if (idx === 5 && t >= 101.2 && t < 104.6) { ndcTmp.set(FLAG_POS[0], heights(FLAG_POS[0], FLAG_POS[1]) + 4.2, FLAG_POS[1]).project(cine); nx = ndcTmp.x + .035; ny = ndcTmp.y + .17; }   // behind the planted flag
  lockBody(surfaceEarth, nx, ny, 380, .075);
}


// Stage 7 · return -------------------------------------------------------------------------------------------------------------------
const CAM7 = [[136, 150, 8, 82, 0], [142, 168, 6, 70, 0], [148, 190, 4, 62, 0], [156, 212, 2, 56, 0]];
function stage7(t, u) {
  const ease = smooth(u);
  returnShip.position.set(mix(-20, 35, ease), Math.sin(u * 3) * 5, 12); returnShip.rotation.set(.08 * Math.sin(t * .3), .9 + u * .55, -1.1 + .3 * Math.sin(u * 2.4));
  { const fa = 1 - sm(u, .15, .2); returnFlame.visible = fa > .01; returnFlame.userData.update(t, .8 * fa); } returnEarth.rotation.y = 1.8 + (t - 136) * .008; rcsReturn.update(t, u > .25 ? .5 : 0);
  focus.copy(returnShip.position);
  track(t, CAM7, KV); orbitCam(focus.x, focus.y, focus.z, KV[0], KV[1], KV[2], 0, KV[3], 0);
  camShake = 0; camCx = .03; camCy = .18; camRoll = -.012 * Math.sin(t * .19);
}

// Stage 8 · entry ------------------------------------------------------------------------------------------------------------------------
// opens ahead of the stack (CM visible), swings to a rear three-quarter view (camera ~65° off the flight axis, behind-side): cone silhouette, shock layer wrapping the shield rim, wake streaming back
const CAM8 = [[156, 42, 14, 72, 1], [157.5, 14, 12, 62, .5], [159.5, -16, 10, 54, 0], [161, -26, 10, 50, 0], [163.5, -24, 9, 47, 0], [166, -27, 11, 48, 0], [168.5, -10, 22, 52, -.5], [171, 14, 36, 62, -3]];
function stage8(t, u) {
  const sep = EV.smSep, heatRaw = Math.sin(u * Math.PI), flip = sm(t, sep + .5, sep + 3.4);
  const heat = heatRaw * sm(t, sep + 1.8, sep + 4.2) * (1 - sm(t, 168.4, 170.9));
  capsulePos(t, capsule.position);
  // orientation: nose-first stack, flips 180° about Z once separated, then shield-forward with a slow roll/wobble
  qFlip.setFromAxisAngle(zAxis, Math.PI * (1 - flip)); capsule.quaternion.copy(qFlip).multiply(qFinal);
  qRoll.setFromAxisAngle(yAxis, .3 + u * .5); capsule.quaternion.multiply(qRoll); qWob.setFromAxisAngle(xAxis, Math.sin(t * 2.3) * .035 * flip); capsule.quaternion.multiply(qWob);
  // service module: attached under the shield at first, then drifts away aft, tumbling
  const ts = t - sep;
  if (ts < 0) { sm3.position.copy(capsule.position); sm3.quaternion.copy(capsule.quaternion); }
  else {
    capsulePos(sep, tmpV); const q0 = qFlip.setFromAxisAngle(zAxis, Math.PI).multiply(qFinal); qRoll.setFromAxisAngle(yAxis, .3 + ramp(sep, 156, 171) * .5); q0.multiply(qRoll);
    sm3.position.copy(tmpV).addScaledVector(entryDir, ts * 3.6 - 4.2 * ts * ts * .2 * 0).addScaledVector(entryDir, 0);
    // slides aft relative to the stack: capsule keeps going, the SM is left behind
    const rel = 1.2 * ts + .55 * ts * ts; capsulePos(t, tmpV2); tmpV3.copy(tmpV2).sub(tmpV);   // stack displacement since separation
    sm3.position.copy(tmpV).add(tmpV3).addScaledVector(entryDir, -rel * 2.2).addScaledVector(yAxis, ts * .35);
    qSM.copy(q0); tmpQ.setFromEuler(tmpE.set(ts * .09, ts * .05, ts * .21)); sm3.quaternion.copy(qSM).premultiply(tmpQ);
  }
  sm3.visible = ts < 7.5;
  smSepPuffs[0].update(t, sep, 1);
  plasma.update(t, heat, true); capsule.userData.setHeat?.(heat);
  entryEarth.quaternion.setFromAxisAngle(zAxis, (t - 156) * .058).multiply(tmpQ.setFromAxisAngle(yAxis, (t - 156) * .04));   // surface slides back under the capsule (about the screen-normal axis): speed over the cloud deck
  entryEarth.position.set(-(t - 156) * 1.5, mix(-192, -178, sm(t, 167, 171)), -160 + (t - 156) * 1.2);
  focus.copy(capsule.position);
  track(t, CAM8, KV); orbitCam(capsule.position.x, capsule.position.y, capsule.position.z, KV[0], KV[1], KV[2], 0, KV[3], 0);
  camShake = .13 * heat * heat + .05 * heat; camShakeSeed = 3; camCx = .03; camCy = .18; camRoll = .02 * Math.sin(t * .5) * heat;
  const ve = sm(t, 169.7, 170.95); veil.visible = ve > .005; veil.material.opacity = ve * .78; veil.material.color.setRGB(.4, .47, .58);
}

// Stage 9 · splash ------------------------------------------------------------------------------------------------------------------------------
const CAM9 = [[171, 26, 2, 96, 21], [173.5, 34, 0, 82, 17], [175.2, 40, -3, 52, 9], [T_IMPACT - .25, 34, 1, 27, 3.4], [T_IMPACT + 1.4, 22, 6, 30, 3.2], [180, 8, 8, 40, 4], [182.2, 6, 9, 52, 5], [184, 4, 10, 60, 5.5]];
const shipP = new V3(), SHIP_S = .4, SHIP_YAW = 1.0;   // the 270-unit hull is shown at 40 % so it reads as a small whole silhouette on the horizon
function stage9(t, u) {
  const dt = t - STAGE_STARTS[9], tau = t - T_IMPACT, sea0 = ocean.heightAt(0, 0, t);
  let y;
  if (tau < 0) y = Math.max(sea0, fallY(dt));
  else {
    const dip = -1.3 * Math.sin(5.6 * tau) * Math.exp(-2.5 * tau);
    y = sea0 + dip;
  }
  seaCap.position.set(0, y, 0);
  if (tau >= 0) {
    const kick = .105 * Math.exp(-2.5 * tau) * Math.cos(7 * tau);
    seaCap.rotation.set((ocean.heightAt(0, 2, t) - ocean.heightAt(0, -2, t)) * .18 + kick, 0, (ocean.heightAt(-2, 0, t) - ocean.heightAt(2, 0, t)) * .18 + Math.sin(t * .6) * .02);
  } else if (!sea.update) { seaCap.rotation.set(0, 0, Math.sin(t * 1.8) * .05 * (1 - sm(t, 171.5, 176))); }
  sea.update?.(t);
  if (!sea.update) { // fallback chute animation when the sea capsule has no built-in update: inflate, swing, then drift off after release
    const rel = sm(t, EV.chuteRelease, EV.chuteRelease + 2.2), inf = sm(t, EV.chuteDeploy + .1, EV.chuteDeploy + 1.7);
    sea.chutes.visible = rel < 1; sea.chutes.position.set(rel * 16, -rel * 26, rel * 5); sea.chutes.rotation.set(0, 0, t < EV.chuteRelease ? Math.sin(t * .7) * .04 : -rel * .5);
    sea.chutes.scale.set(mix(.12, 1, inf), mix(.12, 1, inf) * mix(1, .35, rel), mix(.12, 1, inf)); sea.chuteMaterial.opacity = 1 - rel; sea.chuteLines.forEach(l => l.material.opacity = .32 * clamp(1 - rel * 2.5));
  }
  chutePuff.update(t);
  // recovery ship: far away toward the dawn sun (silhouette in the glitter), steaming slowly closer; boats race in from its side
  const ship = ramp(t, 171, 184);
  shipP.set(mix(-165, -137, ship), 0, mix(-535, -507, ship));
  rescue.position.set(shipP.x, ocean.heightAt(shipP.x, shipP.z, t) * .6, shipP.z); rescue.scale.setScalar(SHIP_S);
  rescue.rotation.set((ocean.heightAt(shipP.x, shipP.z + 80, t) - ocean.heightAt(shipP.x, shipP.z - 80, t)) * .004, SHIP_YAW, (ocean.heightAt(shipP.x - 80, shipP.z, t) - ocean.heightAt(shipP.x + 80, shipP.z, t)) * .003, 'YXZ');
  for (let i = 0; i < boats.length; i++) {
    const b = boats[i], k = ramp(t, boatT[i][0], boatT[i][1]), s = 1 - Math.pow(1 - k, 1.7), bx = mix(boatStart[i][0], boatStop[i][0], s), bz = mix(boatStart[i][1], boatStop[i][1], s);
    const vx = (boatStop[i][0] - boatStart[i][0]), vz = (boatStop[i][1] - boatStart[i][1]), speed = k <= 0 || k >= 1 ? 0 : 1.7 * Math.pow(1 - k, .7) * Math.hypot(vx, vz) / (boatT[i][1] - boatT[i][0]);
    b.visible = t >= boatT[i][0] - .6;
    const sway = k >= 1 ? .5 : 0, hx = bx + Math.sin(t * .7 + i) * sway, hz = bz + Math.cos(t * .6 + i * 2) * sway;
    b.position.set(hx, ocean.heightAt(hx, hz, t), hz);
    const hdg = lerpA(Math.atan2(vx, vz), Math.atan2(-bx, -bz) + boatYaw[i], sm(k, .78, 1));
    b.rotation.set((ocean.heightAt(hx, hz + 5, t) - ocean.heightAt(hx, hz - 5, t)) * .08 - Math.min(speed / 40, .5) * .1, hdg, (ocean.heightAt(hx - 2, hz, t) - ocean.heightAt(hx + 2, hz, t)) * .12, 'YXZ');
    { const sp = clamp(speed / 14), f = boatFoam[i]; for (let j = 0; j < f.length; j++) f[j][0].value = f[j][1] * sp; }
    { const wk = clamp(speed / 18) * sm(k, 0, .05); wakes[i].visible = wk > .01; wakes[i].scale.setScalar(wk * (.6 + .4 * wk)); }   // grows from nothing: no pop when a boat starts or parks
  }
  wakeMat.uniforms.uT.value = t;
  collar.visible = t > 181; collar.scale.setScalar(Math.max(.05, easeBack(ramp(t, 181.0, 182.2)))); collar.position.y = .35;
  ocean.update(t); waves.update(t, u, u > .4);
  focus.set(0, Math.max(y, 0) + 4, 0);
  track(t, CAM9, KV); orbitCam(0, Math.max(seaCap.position.y, sea0), 0, KV[0], KV[1], KV[2], 0, KV[3], 0);
  camShake = (t < 173 ? .3 * Math.exp(-(t - 171) / .35) * (t > 171 ? 1 : 0) : 0) + (t > EV.chuteDeploy + 1.2 ? .55 * Math.exp(-(t - EV.chuteDeploy - 1.2) / .5) * (t < EV.chuteDeploy + 3 ? 1 : 0) : 0) + (tau > 0 ? .5 * Math.exp(-tau / .5) : 0);
  camCx = .03; camCy = .18; camRoll = .015 * Math.sin(t * .4);
  // the cloud veil clears quickly so the drogue/main deployment at EVENTS.chuteDeploy is visible through it
  const ve = 1 - sm(t, 171, 171.75); veil.visible = ve > .005; veil.material.opacity = ve * .78; { const k = ramp(t, 171, 171.7); veil.material.color.setRGB(mix(.4, .8, k), mix(.47, .6, k), mix(.58, .5, k)); }
}

// ------------------------------------------------------------------------------------------------ master update
function update(t) {
  t_ = t;
  const idx = getStage(t), s = stages[idx], u = clamp((t - s.start) / (s.end - s.start));
  idxNow = idx; activeWorld = WORLD_OF_STAGE[idx];
  for (let i = 0; i < worldList.length; i++) worldList[i][1].visible = worldList[i][0] === activeWorld;
  looks.apply(activeWorld);
  camShake = 0; camRoll = 0; camCx = .03; camCy = .18; veil.visible = false; placers.length = 0;

  if (idx === 0) stage0(t, u);
  else if (idx === 1) stage1(t, u);
  else if (idx === 2) stage2(t, u);
  else if (idx === 3) stage3(t, u);
  else if (idx <= 6) surfaceStage(t, u, idx);
  else if (idx === 7) stage7(t, u);
  else if (idx === 8) stage8(t, u);
  else stage9(t, u);
  sun.target.position.copy(focus); sun.position.copy(focus).add(looks.sunOffset); sun.target.updateMatrixWorld();

  // ---- camera finishing: view button, narrow screens, shake, roll, composition (safe frame) --------------------------------------------------
  // "Uzak" widens the lens instead of dollying back: a farther camera would end up behind bodies that are locked to its ray
  // (the Earth in orbit) or crop the hero; a wider field keeps the authored composition and the hero in frame.
  cine.fov = state.view === 1 ? 62 : 43;
  if (state.view === 2) { tmpV.copy(camPos).sub(camTarget).multiplyScalar(.65); camPos.copy(camTarget).add(tmpV); }
  if (innerWidth < 750) { tmpV.copy(camPos).sub(camTarget).multiplyScalar(1.35); camPos.copy(camTarget).add(tmpV); }
  if (innerHeight < 750 && innerWidth >= 750) { tmpV.copy(camPos).sub(camTarget).multiplyScalar(idx === 0 ? 1.28 : idx >= 4 && idx <= 6 ? 1.2 : 1.08); camPos.copy(camTarget).add(tmpV); camTarget.y -= idx === 0 ? 6 : idx >= 4 && idx <= 6 ? 4 : 3; }
  if (camShake > .002) {
    const k = camShake, x = t * 9;
    camPos.x += n1(x + camShakeSeed) * k; camPos.y += n1(x * .93 + 11 + camShakeSeed) * k; camPos.z += n1(x * 1.07 + 23 + camShakeSeed) * k;
    camTarget.x += n1(x * .8 + 5) * k * .5; camTarget.y += n1(x * .9 + 17) * k * .5;
  }
  const wide = innerWidth >= 1000;
  cine.aspect = innerWidth / innerHeight;
  cine.position.copy(camPos); cine.up.set(Math.sin(camRoll), Math.cos(camRoll), 0); cine.lookAt(camTarget); cine.up.set(0, 1, 0);
  cine.setViewOffset(innerWidth, innerHeight, -(wide ? camCx : 0) * innerWidth * .5, (wide ? camCy : .08) * innerHeight * .5, innerWidth, innerHeight);
  cine.updateMatrixWorld(true);
  for (let i = 0; i < placers.length; i++) placers[i]();
  if (idx === 2 || idx === 7) placeCruiseBodies(t, u, idx);
  else if (idx === 1) placeOrbitBodies(t, u);
  else if (idx === 3) lockBody(earthDock, -.26, .62, 420);
  veil.position.copy(cine.position);

  if (state.mode === 'cinematic') { camera.position.copy(cine.position); camera.quaternion.copy(cine.quaternion); camera.projectionMatrix.copy(cine.projectionMatrix); camera.projectionMatrixInverse.copy(cine.projectionMatrixInverse); camera.aspect = cine.aspect; orbit.target.copy(camTarget); }
  else if (idx !== lastStage) { camera.position.copy(camPos); orbit.target.copy(camTarget); orbit.update(); }
  else { tmpV.subVectors(camTarget, lastTarget); camera.position.add(tmpV); orbit.target.add(tmpV); }
  lastTarget.copy(camTarget); lastStage = idx; currentStage = idx;

  // trajectory ribbons follow the ship of their stage
  const rv = state.labels;
  orbitPath.visible = rv && idx === 1; transferPath.visible = rv && (idx === 2);
  if (idx === 1) ribbonOrbit(orbitPath, earthOrb.position, orbitShip.position, tmpV.set(1, .12, .1), ramp(t, 20, 21.5) * (1 - sm(t, 27.2, 28.8)), 1.5);
  if (idx === 2) { ribbonBezier(transferPath, bzA, bzB, transferShip.position, mix(.3, .66, smooth(u)), ramp(t, 35, 36.5) * (1 - sm(t, 54, 55))); }

  // Generic per-object animation hook: any visible object may define userData.tick(t, ctx).
  tickCtx.t = t; tickCtx.idx = idx; tickCtx.u = u; tickCtx.quality = effTier; tickCtx.world = activeWorld; tickCtx.sunDir.copy(looks.sunOffset).normalize();
  if (idx === 3 && t >= EV.dockContact) dockLander.userData.tick = landerTickLatched; else dockLander.userData.tick = landerTick0;
  scene.updateMatrixWorld(); camera.updateMatrixWorld();
  worlds[activeWorld].traverseVisible(tickFn); if (stars.visible) stars.traverseVisible(tickFn);
  looks.frame(tickCtx);

  uiInfo.t = t; uiInfo.idx = idx; uiInfo.u = u; uiInfo.stage = s; uiInfo.day = mix(s.day, s.to, u); ui.frame(uiInfo);
  post.setFade(fadeFor(t, idx));
  ui.updateAnnotations(camera, activeWorld, annVisible);
}
const landerTickLatched = (t, ctx) => { landerTick0?.(t, ctx); const nr = dockLander.getObjectByName('navR'), ng = dockLander.getObjectByName('navG'), st = dockLander.getObjectByName('strobe'); if (nr) nr.material.opacity = .55; if (ng) ng.material.opacity = .55; if (st) st.material.opacity = .5; };

// Dip-to-black at stage cuts: only while playing and only for stages entered by playback. Pre-cut ramp (film time) + post-cut ease (real time).
function fadeFor(t, idx) {
  if (!state.playing) return 0;
  const end = stages[idx].end, pre = idx < stages.length - 1 ? clamp(1 - (end - t) / .3) : 0;
  const post_ = clamp(1 - (performance.now() - cutAt) / 520);
  return Math.max(pre, post_ * post_) * .6;
}
const annVisible = d => {
  if (d.scienceOnly && idxNow !== 5) return false;
  if (d === ANN.duster) { if (!dusterSet.visible) return false; } else if (d === ANN.spss && !spssSet.visible) return false;
  const t = t_;
  if (d === ANN.dockOrion || d === ANN.dockHls) return t < 71.2;
  if (d === ANN.dockLatched) return t >= EV.dockContact + .35;
  if (d === ANN.entrySm) return t > EV.smSep + .3 && t < EV.smSep + 3.4 && sm3.visible;
  if (d === ANN.ship) { if (t < 180.2) return false; const v = shipTag.getWorldPosition(tmpV).project(camera); return v.z < 1 && v.x > -.5 && v.x < .6 && v.y > .3 && v.y < .8; }
  if (d.occlude) {   // hide when the lander (a cylinder r≈6.4, h≈11 at the origin) is between the camera and the label anchor
    const o = d.object.position, c = camera.position, dx = o.x - c.x, dz = o.z - c.z, L2 = dx * dx + dz * dz; if (L2 < 1e-3) return true;
    const k = clamp(-(c.x * dx + c.z * dz) / L2), px = c.x + dx * k, pz = c.z + dz * k, py = c.y + (o.y - c.y) * k;
    if (px * px + pz * pz < 41 && py < 11.5 && py > -1 && k > .02 && k < .98) return false;
  }
  return true;
};

// Far bodies for the cruise stages (camera-locked with slow drifts so they stay inside the safe frame)
function placeOrbitBodies(t, u) {
  earthOrb.scale.setScalar(1);
  lockBody(earthOrb, mix(-.12, -.18, u), mix(-1.88, -1.78, smooth(u)), 188);
}
function placeCruiseBodies(t, u, idx) {
  if (idx === 2) {
    earthTrans.scale.setScalar(mix(1, .8, smooth(u))); moonTrans.scale.setScalar(mix(.72, 1.15, smooth(u)));
    lockBody(earthTrans, mix(-.28, -.34, u), mix(-.9, -.98, u), 275); lockBody(moonTrans, mix(.32, .3, u), mix(.58, .5, u), 360);
    bzA.copy(earthTrans.position).lerp(moonTrans.position, .55 * 0 + .31); bzB.copy(moonTrans.position).lerp(earthTrans.position, .2);
    bzA.copy(earthTrans.position); bzB.copy(moonTrans.position);
    tmpV.copy(moonTrans.position).sub(earthTrans.position).normalize(); bzA.addScaledVector(tmpV, 105 * earthTrans.scale.x); bzB.addScaledVector(tmpV, -45 * moonTrans.scale.x);
  } else {
    returnEarth.scale.setScalar(mix(.9, 1.3, smooth(u))); returnMoon.scale.setScalar(mix(1.2, .8, smooth(u)));
    lockBody(returnEarth, mix(.1, 0, u), mix(-1.05, -1.1, u), 230); lockBody(returnMoon, mix(-.32, -.34, u), mix(.52, .56, u), 470);
  }
}

// ------------------------------------------------------------------------------------------------ transport
function seek(t, keepPlaying = false) {
  state.time = clamp(t, 0, duration); cutAt = -1e9;
  if (!keepPlaying || state.time >= duration) state.playing = false;
  ui.syncPlay(); update(state.time); post.render(state.time, 0);
  holdAdaptive(3000);   // a seek renders synchronously between frames: never read that gap as GPU load
}
function togglePlay() {
  if (state.time >= duration) state.time = 0;
  state.playing = !state.playing; cutAt = -1e9; ui.syncPlay();
}

// ------------------------------------------------------------------------------------------------ quality tiers, adaptive controller, resize
const TIERS = ['low', 'medium', 'high'];
const tierRatio = { low: d => Math.min(d, .8), medium: d => Math.min(d, 1.15), high: d => Math.min(d > 1 ? d : 1.25, 1.65) }, tierShadow = { low: 512, medium: 1024, high: 2048 };
let effTier = 'medium', userTier = 'medium', adapt = 1, appliedRatio = 0, appliedW = 0, appliedH = 0, compiling = false;
const warmedTiers = new Set(['medium']);
function applyQuality() {
  const q = effTier;
  let ratio = tierRatio[q](devicePixelRatio) * adapt; ratio = Math.max(.5, Math.min(ratio, Math.sqrt(4.1e6 / (innerWidth * innerHeight))));
  if (ratio !== appliedRatio || innerWidth !== appliedW || innerHeight !== appliedH) { renderer.setPixelRatio(ratio); renderer.setSize(innerWidth, innerHeight); appliedRatio = ratio; appliedW = innerWidth; appliedH = innerHeight; post.setSize(innerWidth, innerHeight, ratio); }
  const ms = tierShadow[q]; if (ms !== sun.shadow.mapSize.x) { sun.shadow.mapSize.set(ms, ms); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  plume.setQuality(q); dust.setQuality(q); waves.setQuality?.(q);
  ocean.object.material.uniforms.uPix.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (innerHeight * ratio);
  post.setQuality(q); setRibbonRes();
  ui.setQualityValue(userTier);
}
const dummyRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
// Compile every material of a world group for the current tier without blocking (parallel shader compile); keys match the real frame path.
async function compileWorld(key) {
  looks.apply(key); const prev = renderer.getRenderTarget(); renderer.setRenderTarget(dummyRT);
  const jobs = [renderer.compileAsync(worlds[key], camera, scene)]; if (stars.visible) jobs.push(renderer.compileAsync(stars, camera, scene));
  renderer.setRenderTarget(prev); await Promise.all(jobs);
}
async function setQualityUser(q) {
  userTier = q; state.quality = q; adapt = 1; effTier = q; lowSeconds = 0;
  if (warmedTiers.has(q) || !worlds[activeWorld]) { applyQuality(); return; }
  compiling = true; ui.toast(msg('qApplying')); applyQuality();
  try { await compileWorld(activeWorld); } catch {}
  compiling = false; warmedTiers.add(q); update(state.time); post.render(state.time, 0);
  for (const key of Object.keys(worlds)) { if (key === activeWorld) continue; await nextFrame(); try { await compileWorld(key); } catch {} }
  looks.apply(activeWorld);
}
let resizeTimer = 0;
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; cine.aspect = camera.aspect; camera.updateProjectionMatrix();
  clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { applyQuality(); update(state.time); }, 120);
});

// ------------------------------------------------------------------------------------------------ frame loop (even cadence, adaptive quality that can recover)
const RING = 120, rafIv = new Float32Array(RING), drawIv = new Float32Array(RING), scratch = new Float32Array(RING);
let rafN = 0, rafI = 0, rafCount = 0, drawN = 0, drawI = 0, drawEvery = 1, divVotes = 0, pendingDiv = 1, lastRaf = 0, last = performance.now(), lastDraw = last;
let lowSeconds = 0, evalAt = 0, upCalm = 0, backoff = 12, lastUp = -1e9, calmSince = 0, warming = true, hiddenNow = false;
const pct = (arr, n, p) => { scratch.set(arr.subarray(0, n)); const s = scratch.subarray(0, n); s.sort(); return s[Math.min(n - 1, Math.floor(p * n))]; };
document.addEventListener('visibilitychange', () => { last = lastDraw = performance.now(); lastRaf = 0; rafN = drawN = 0; evalAt = performance.now() + 3000; });
function refreshCadence() {
  if (rafN < 40) return;
  const ivl = pct(rafIv, rafN, .2) || 16.7, hz = 1000 / ivl;
  let want = 1; while (hz / want > 100 && want < 5) want++;
  if (want === pendingDiv) divVotes++; else { pendingDiv = want; divVotes = 0; }
  if (divVotes >= 3 && want !== drawEvery) { drawEvery = want; drawN = 0; }
}
// Samples are discarded after seeks, stage cuts (first-visit uploads) and pauses; only sustained slowness during playback
// (two evaluations in a row, judged on the median as well as the tail) lowers quality, so compile/seek hitches never do.
let slowStreak = 0;
function holdAdaptive(ms) { drawN = 0; slowStreak = 0; evalAt = Math.max(evalAt, performance.now() + ms); }
function adaptive(now) {
  if (!state.playing) { if (drawN) holdAdaptive(1500); return; }
  if (now < evalAt || drawN < 60 || rafN < 20) return; evalAt = now + 2500;
  const p90 = pct(drawIv, drawN, .9), p50 = pct(drawIv, drawN, .5), expect = pct(rafIv, rafN, .2) * drawEvery;
  const slow = (p50 > Math.max(18, expect * 1.25)) || p90 > Math.max(34, expect * 2);
  slowStreak = slow ? slowStreak + 1 : 0;
  if (slow && slowStreak < 2) { drawN = 0; return; }
  if (slow) {
    calmSince = 0; slowStreak = 0;
    if (effTier !== 'low') { effTier = TIERS[TIERS.indexOf(effTier) - 1]; ui.toast(msg('qDropped', msg('qNames')[effTier])); applyQuality(); }
    else if (adapt > .7) { adapt = Math.max(.7, adapt * .85); applyQuality(); ui.toast(msg('qRes')); }
    if (now - lastUp < 30000) backoff = Math.min(backoff * 2, 120);
    drawN = 0; ui.setFps(fps, true);
  } else if (p90 < expect * 1.12 + 2 && (effTier !== userTier || adapt < 1)) {
    if (!calmSince) calmSince = now;
    if (now - calmSince > backoff * 1000) {
      if (adapt < 1) adapt = Math.min(1, adapt / .85 > 1 ? 1 : adapt / .85); else effTier = TIERS[TIERS.indexOf(effTier) + 1];
      lastUp = now; calmSince = 0; applyQuality(); drawN = 0; ui.setFps(fps, effTier !== userTier || adapt < 1);
    }
  } else calmSince = 0;
}
function frame(now) {
  requestAnimationFrame(frame);
  if (lastRaf) { const d = now - lastRaf; if (d > 0 && d < 250) { rafIv[rafI] = d; rafI = (rafI + 1) % RING; rafN = Math.min(rafN + 1, RING); } }
  lastRaf = now;
  if (warming || compiling) { last = lastDraw = now; return; }
  if (document.hidden) { audioInfo.t = state.time; audioInfo.idx = currentStage; audioInfo.u = 0; audioInfo.playing = false; audioInfo.speed = state.speed; audioInfo.hidden = true; audio.update(audioInfo); return; }
  if (++rafCount % 30 === 0) refreshCadence();
  if (rafCount % drawEvery !== 0) return;
  const dt = Math.min((now - lastDraw) / 1000, .1);
  if (dt > 0 && dt < .25) { drawIv[drawI] = dt * 1000; drawI = (drawI + 1) % RING; drawN = Math.min(drawN + 1, RING); }
  lastDraw = now;
  if (state.playing) {
    const t0 = state.time, nt = Math.min(duration, t0 + dt * state.speed);
    if (getStage(nt) !== getStage(t0)) { cutAt = performance.now(); holdAdaptive(2500); }
    state.time = nt; if (state.time >= duration) { state.playing = false; ui.syncPlay(); }
  }
  update(state.time);
  if (orbit.enabled) orbit.update();
  post.render(state.time, dt);
  const s = stages[currentStage];
  audioInfo.t = state.time; audioInfo.idx = currentStage; audioInfo.u = clamp((state.time - s.start) / (s.end - s.start)); audioInfo.playing = state.playing; audioInfo.speed = state.speed; audioInfo.hidden = false; audio.update(audioInfo);
  frameCount++; frameSeconds += dt;
  if (frameSeconds >= 2) { fps = Math.round(frameCount / frameSeconds); ui.setFps(fps, effTier !== userTier || adapt < 1); frameCount = 0; frameSeconds = 0; }
  adaptive(now);
}

// ------------------------------------------------------------------------------------------------ startup: tiers, warm-up, ready
effTier = userTier = 'medium'; applyQuality();
const hashT = Number((location.hash.match(/t=([\d.]+)/) || [])[1]);
if (Number.isFinite(hashT)) state.time = clamp(hashT, 0, duration);
await nextFrame();
async function loadsDone() {   // textures requested at construction time (Earth, Moon...) finish through DefaultLoadingManager
  await new Promise(r => { let done = false; const f = () => { if (!done) { done = true; r(); } }; if (texIdle) return f(); texWaiters.push(f); setTimeout(f, 6000); });
}
await loadsDone(); progress(.46, msg('lTex'));
// Representative moments per world, including every first appearance of an effect (RCS bursts near 72/132/136/141, chutes, boats)
// so no geometry upload or program link happens during the film.
const WARM = { launch: [1, 6, 12, 18], orbit: [22, 30], transfer: [40], dock: [60, 72.1, 74], surface: [76, 88, 93, 96, 100, 104, 109, 114, 119, 122.2, 124, 132.4, 135.3], return: [136.2, 140, 141.2], entry: [158, 165], splash: [172, 177, 180, 181.3, 183] };
const worldKeys = Object.keys(worlds);
const WARM_N = worldKeys.length;
for (let wi = 0; wi < WARM_N; wi++) {
  const key = worldKeys[wi], f0 = .46 + wi / WARM_N * .5, f1 = .46 + (wi + 1) / WARM_N * .5;
  progress(f0, msg('lCompile')); await nextFrame();
  mark(key + " compile>"); try { await compileWorld(key); } catch {}
  mark(key + " compiled"); let n = 0; const times = WARM[key] || [0];
  for (const t of times) { update(t); post.render(t, 0); progress(mix(f0, f1, .5 + .5 * (++n) / times.length), msg('lScene', wi + 1, WARM_N)); await nextFrame(); }
}
mark("warm done"); update(state.time); post.render(state.time, 0);

Object.assign(window.artemis, {
  seek, worlds, post, orbit,
  // Debug: park a free camera at pos looking at target (world space) at the current time, e.g. for close-up inspection.
  view(pos, target) {
    state.mode = 'free'; orbit.enabled = true; update(state.time);
    camera.updateProjectionMatrix();
    camera.position.set(...pos); orbit.target.set(...target); orbit.update(); lastTarget.copy(camTarget); post.render(state.time, 0);
  },
  // Debug: screen position (px) of a world object's origin under the live camera.
  screenOf(o) { const v = tmpV.setFromMatrixPosition(o.matrixWorld).project(camera); return [Math.round((v.x * .5 + .5) * innerWidth), Math.round((.5 - v.y * .5) * innerHeight)]; },
  objs: { capsule, sm3, seaCap, rescue, boats, entryEarth },
  metrics: () => ({ fps, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, drawCalls: post.sceneInfo?.calls ?? renderer.info.render.calls, triangles: post.sceneInfo?.triangles ?? renderer.info.render.triangles, pixelRatio: renderer.getPixelRatio(), tier: effTier, adapt, cadence: drawEvery, programs: renderer.info.programs?.length }),
  sample: () => ({ stage: currentStage, world: activeWorld, sls: sls.position.toArray(), ship: transferShip.position.toArray(), lander: surfaceLander.position.toArray(), capsule: seaCap.position.toArray(), dust: Array.from(dust.positions.slice(0, 24)), smoke: Array.from(plume.positions.slice(0, 24)) })
});
warming = false; last = lastDraw = performance.now(); holdAdaptive(8000);
requestAnimationFrame(frame);
window.artemis.ready = true; ui.hideLoading();
