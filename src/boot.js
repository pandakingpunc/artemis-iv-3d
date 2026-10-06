// ARTEMIS IV · boot — paints the loading screen first, then pulls in the heavy app.js module graph.
// index.html contains the loader markup statically, so the first paint already shows it; this module only
// makes sure the browser actually gets to paint (two animation frames, with a timeout for background tabs)
// before app.js starts compiling worlds on the main thread.
import { t, applyDom } from './i18n.js';
applyDom();   // static strings in the chosen language before the first paint
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const wait = ms => new Promise(r => setTimeout(r, ms));
window.__boot = { t0: performance.now() };

(async () => {
  const text = document.getElementById('loadText'), step = document.getElementById('loadStep');
  await Promise.race([frame().then(frame), wait(250)]);   // loader is on screen before any heavy work
  await wait(16);
  if (text) text.textContent = t('loadText');
  if (step) step.textContent = t('loadModules');
  try {
    await import('../app.js');
    window.__boot.appMs = Math.round(performance.now() - window.__boot.t0);
  } catch (e) {
    console.error(e);
    const box = document.querySelector('#loading .ld-inner');
    if (box && document.getElementById('loadText')) {   // app.js already shows its own WebGL message
      box.textContent = '';
      const h = document.createElement('h2'); h.textContent = t('bootFail');
      const p = document.createElement('p'); p.textContent = t('bootFailMsg');
      box.append(h, p);
    }
  }
})();
