// Shared helpers. Every module imports from here; keep this file stable (add helpers inside your own module).
import * as THREE from 'three';

export const $ = s => document.querySelector(s);
export const TAU = Math.PI * 2;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };

// Deterministic LCG. Each module creates its own stream so layouts never depend on build order.
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
}

export const mat = (color, metalness = 0, roughness = .7) => new THREE.MeshStandardMaterial({ color, metalness, roughness });

export const boxG = new THREE.BoxGeometry(1, 1, 1);
export const sphereG = new THREE.SphereGeometry(1, 32, 20);
export const cylinderG = new THREE.CylinderGeometry(1, 1, 1, 32);
export const coneG = new THREE.ConeGeometry(1, 1, 32);

export function mesh(g, m, parent, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z); o.scale.set(sx, sy, sz);
  o.castShadow = true; o.receiveShadow = true;
  parent?.add(o);
  return o;
}
export const group = parent => { const g = new THREE.Group(); parent?.add(g); return g; };

// Planets neither cast nor receive the vehicle shadow map: avoids acne bands on huge spheres.
export const planet = o => { o.traverse(c => { c.castShadow = c.receiveShadow = false; }); return o; };

export function softTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const q = c.getContext('2d'), grad = q.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,.95)'); grad.addColorStop(.25, 'rgba(255,255,255,.65)');
  grad.addColorStop(.6, 'rgba(255,255,255,.18)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  q.fillStyle = grad; q.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
export const soft = softTexture();

export function glow(parent, color, size, x = 0, y = 0, z = 0) {
  const o = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  o.position.set(x, y, z); o.scale.setScalar(size); parent.add(o);
  return o;
}

export function curve(points, parent, color = 0x54758c, opacity = .32) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  parent.add(line);
  return line;
}

// Shared texture loader so the loading screen can track every image through DefaultLoadingManager.
export const loader = new THREE.TextureLoader();
export const loadTex = (name, srgb = true) => { const t = loader.load('assets/' + name); if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
