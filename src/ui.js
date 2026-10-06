// HUD, controls, keyboard, report dialog, schematic map, 3D annotations, loading screen + start gate, end card. All DOM work lives here.
// Contract used by app.js:
//   const ui = createUI(api)  api = { state, stages, duration, audio, seek(t, keepPlaying), togglePlay(), setQuality(q),
//                                     setCameraMode(mode), cycleView() -> viewIndex, capture() -> dataURL }
//   ui.frame({ t, idx, u, stage, day })   every frame (cheap: DOM writes only when values change)
//   ui.syncPlay()                          after state.playing changes
//   ui.setFps(fps, adapted)                shown only in the debug readout (Shift+D or ?debug)
//   ui.toast(msg)
//   ui.addAnnotations(defs)                defs: [{ text, world, object, offset?, radius?, priority? }]
//                                          radius (world units, optional) = hero size the label must clear; measured from meshes when omitted
//   ui.updateAnnotations(camera, activeWorld, isVisible(def) -> bool)   collision-aware layout, reads state.time/playing
//   ui.setLoadProgress(f, label)           warm-up phase (shader compile) progress f = 0..1, maps onto the last 30 % of the bar
//   ui.hideLoading()                       warm-up done: shows the start gate (or opens straight away under automation / ?nogate)
// Extras: ui.setCinema(on) / ui.isCinema() · ui.setQualityValue(q) · ui.isGateOpen()
import * as THREE from 'three';
import { $, TAU, clamp, mix, smooth } from './util.js';
import { t, tx, num, int, getLang, onLang, toggleLang } from './i18n.js';

const STAGE_COLORS = ['#ffb569', '#86bdff', '#62d6c6', '#a6e3a9', '#d4dde4', '#f1e7cf', '#d4dde4', '#62d6c6', '#ff7b4f', '#5eb3e8'];
const PLAY_ICON = () => '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg><span>' + t('play') + '</span>';
const PAUSE_ICON = () => '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg><span>' + t('pause') + '</span>';
const GLYPH_PLAY = 'M8 5v14l11-7z', GLYPH_PAUSE = 'M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z';
const pad2 = n => String(n).padStart(2, '0');
const D = Math.PI / 180;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

// Representative (not real) telemetry: [km from Earth, km/s] as a smooth function of stage progress.
function profile(idx, u) {
  const e = smooth(u);
  switch (idx) {
    case 0: return [185 * Math.pow(u, 1.4), 7.8 * Math.pow(u, 1.25)];
    case 1: return [mix(185, 410, u), u < .58 ? 7.7 : mix(7.7, 10.8, smooth((u - .58) / .42))];
    case 2: return [410 + 383990 * (1 - Math.pow(1 - u, 2)), 1 + 9.8 * Math.pow(1 - u, 2.2)];
    case 3: return [384400, 1.6];
    case 4: return [384400, mix(1.6, 0, e)];
    case 5: return [384400, 0];
    case 6: return [384400, 1.6 * e];
    case 7: return [12000 + 372400 * Math.pow(1 - u, 1.8), mix(1, 6.6, u * u)];
    // entry: SM separation far out, entry interface (~122 km) at u≈.3, plasma braking, ends near drogue altitude (~6 km)
    case 8: return u < .3 ? [122 + 11878 * Math.pow(1 - u / .3, 2.5), mix(6.6, 11, u / .3)] : [mix(122, 6, smooth((u - .3) / .7)), mix(11, .15, smooth((u - .3) / .7))];
    // splash: under the mains from ~3 km to the sea at u = .42 (≈ 8 m/s at splashdown)
    default: { const f = smooth(u / .42); return [u < .42 ? Math.max(.06, 3 * Math.pow(1 - f, 1.4)) : 0, u < .42 ? mix(.06, .008, f) : 0]; }
  }
}

// Small Markdown -> DOM pass (headings, paragraphs, lists, tables, **bold**, *em*, [links](https://…)). Never uses innerHTML.
function renderMarkdown(src, host) {
  host.textContent = '';
  const el = (tag, parent) => { const n = document.createElement(tag); parent?.append(n); return n; };
  const inline = (parent, text) => {
    const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|\*([^*\s][^*]*)\*/g; let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1] !== undefined) el('b', parent).textContent = m[1];
      else if (m[2] !== undefined) { const a = el('a', parent); a.textContent = m[2]; a.href = m[3]; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      else el('em', parent).textContent = m[4];
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  };
  const lines = src.replace(/\r/g, '').split('\n'); let i = 0;
  const special = l => /^(#{1,3}\s|\||\s*[-*]\s+|\s*\d+\.\s+)/.test(l);
  while (i < lines.length) {
    const ln = lines[i]; let m;
    if (!ln.trim()) { i++; continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(ln))) { inline(el('h' + m[1].length, host), m[2]); i++; continue; }
    if (ln.startsWith('|')) {
      const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++].replace(/^\||\|\s*$/g, '').split('|').map(s => s.trim()));
      const table = el('table', host), head = rows[0], body = rows.slice(/^[\s:|-]+$/.test(rows[1]?.join('') || '') ? 2 : 1);
      const tr0 = el('tr', el('thead', table)); head.forEach(c => inline(el('th', tr0), c));
      const tb = el('tbody', table); body.forEach(r => { const tr = el('tr', tb); r.forEach(c => inline(el('td', tr), c)); });
      continue;
    }
    const list = /^\s*[-*]\s+/.test(ln) ? 'ul' : /^\s*\d+\.\s+/.test(ln) ? 'ol' : null;
    if (list) {
      const root = el(list, host), rx = list === 'ul' ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
      while (i < lines.length && rx.test(lines[i])) inline(el('li', root), lines[i++].replace(rx, ''));
      continue;
    }
    const buf = []; while (i < lines.length && lines[i].trim() && !special(lines[i])) buf.push(lines[i++].trim());
    if (!buf.length) { buf.push(ln.trim()); i++; }
    inline(el('p', host), buf.join(' '));
  }
}

export function createUI(api) {
  const { state, stages, duration } = api;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const fmt = t => pad2(Math.floor(t / 60)) + ':' + pad2(Math.floor(t % 60));
  const totalLabel = fmt(duration);
  const stageAt = t => { const i = stages.findIndex(s => t < s.end); return i < 0 ? stages.length - 1 : i; };
  const setText = (e, v) => { if (e.textContent !== v) e.textContent = v; };
  const body = document.body;
  const el = { filmTime: $('#filmTime'), timeline: $('#timeline'), tl: $('#tl'), timeNote: $('#timeNote'), distance: $('#distance'), velocity: $('#velocity'), mtD: $('#mtD'), mtH: $('#mtH'), mtM: $('#mtM'), mtS: $('#mtS') };
  const color = i => STAGE_COLORS[i] || STAGE_COLORS[0];
  if (/[?&]debug\b/.test(location.search)) body.classList.add('debug');

  let loading = true, gateOpen = false, isCinema = false, idle = false, quiet = 0, prevPlaying = false;
  const dockEl = $('#dock'), tele = $('#telemetry');

  // ---- activity tracking: playback UI recedes after 3 s without input -----------------------------------------------
  let lastActive = performance.now(), overUI = false, moreOpen = false;
  const poke = () => { lastActive = performance.now(); if (idle) setIdle(false); };
  function setIdle(on) { if (on === idle) return; idle = on; body.classList.toggle('idle', on); }
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, poke, { passive: true });
  document.addEventListener('focusin', poke);
  for (const n of [dockEl, tele]) { n.addEventListener('pointerenter', () => { overUI = true; poke(); }); n.addEventListener('pointerleave', () => { overUI = false; lastActive = performance.now(); }); }

  // ---- timeline: coloured segments, chapter buttons -------------------------------------------------------------
  for (const id of ['#tlBase', '#tlLit']) stages.forEach((s, i) => {
    const seg = document.createElement('i'); seg.style.cssText = `--w:${(s.end - s.start) / duration * 100};--c:${color(i)}`; $(id).append(seg);
  });
  const chapBtns = stages.map((s, i) => {
    const b = document.createElement('button');
    b.style.setProperty('--w', (s.end - s.start) / duration * 100);
    b.innerHTML = `<span class="n">${pad2(i + 1)}</span><span class="nm"></span>`;
    b.onclick = () => api.seek(s.start, true); $('#chapters').append(b); return b;
  });
  const labelChapters = () => chapBtns.forEach((b, i) => {
    const s = stages[i]; b.lastChild.textContent = s.short || s.name;
    b.title = t('sceneTitle', s.name, i + 1, (i + 1) % 10); b.setAttribute('aria-label', t('sceneAria', i + 1, s.name));
  });
  labelChapters();
  // chapter names are dropped whenever their cell is too narrow to show them without truncation
  const fitChapters = () => { for (const b of chapBtns) { b.classList.remove('tiny'); const nm = b.lastChild; if (b.clientWidth && nm.scrollWidth + b.firstChild.offsetWidth + 14 > b.clientWidth) b.classList.add('tiny'); } };
  if (window.ResizeObserver) new ResizeObserver(fitChapters).observe($('#chapters')); else window.addEventListener('resize', fitChapters);

  const tip = $('#tlTip'), tipName = $('#tipName'), tipTime = $('#tipTime'), ghost = el.tl.querySelector('.tl-ghost');
  el.tl.addEventListener('pointermove', e => {
    const r = el.tl.getBoundingClientRect(), k = clamp((e.clientX - r.left) / r.width), tt = k * duration, si = stageAt(tt), w = tip.offsetWidth;
    setText(tipName, pad2(si + 1) + ' · ' + stages[si].name); setText(tipTime, fmt(tt)); tip.style.setProperty('--c', color(si));
    tip.style.transform = `translateX(${clamp(k * r.width - w / 2, 0, r.width - w)}px)`; ghost.style.left = k * 100 + '%'; el.tl.classList.add('hover');
  });
  el.tl.addEventListener('pointerleave', () => el.tl.classList.remove('hover'));
  // Scrubbing keeps the play state (like chapter buttons and arrow keys); playback is held during a drag for glitch-free audio.
  let scrubbing = false, resumeAfter = false;
  el.timeline.addEventListener('pointerdown', () => {
    if (scrubbing) return; scrubbing = true; resumeAfter = state.playing;
    if (resumeAfter) { state.playing = false; quiet++; syncPlay(); quiet--; }
  });
  const endScrub = () => {
    if (!scrubbing) return; scrubbing = false;
    if (resumeAfter && state.time < duration) { state.playing = true; quiet++; syncPlay(); quiet--; }
    resumeAfter = false;
  };
  window.addEventListener('pointerup', endScrub); window.addEventListener('pointercancel', endScrub);
  el.timeline.oninput = e => api.seek(Number(e.target.value), true);

  // ---- helpers for stage-change motion ---------------------------------------------------------------------------
  const anim = (node, frames, o) => { if (!reduced() && node.animate) node.animate(frames, { fill: 'backwards', easing: 'cubic-bezier(.16,.84,.24,1)', ...o }); };
  const slideIn = (node, delay) => anim(node, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 650, delay });
  // Crossfade: the previous text lingers as an absolutely positioned clone that fades away.
  function swap(host, value, animate = true) {
    const v = host.querySelector('.v') || host;
    if (v.textContent === value) return;
    if (animate && !reduced() && v.animate) {
      host.querySelectorAll('.xf-old').forEach(n => n.remove());
      const old = document.createElement('span'); old.className = 'xf-old'; old.textContent = v.textContent; host.append(old);
      old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 320, easing: 'ease-in' }).onfinish = () => old.remove();
      v.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: 80, easing: 'cubic-bezier(.16,.84,.24,1)', fill: 'backwards' });
    }
    v.textContent = value;
  }
  function buildTitle(html) {
    const h = $('#chapterTitle'); h.textContent = ''; let i = 0;
    for (const line of html.split(/<br\s*\/?>/i)) {
      const l = document.createElement('span'); l.className = 'tline';
      line.trim().split(/\s+/).forEach((w, k) => {
        if (k) l.append(' ');
        const m = document.createElement('span'); m.className = 'tw'; const s = document.createElement('span'); s.style.setProperty('--i', i++); s.textContent = w; m.append(s); l.append(m);
      });
      h.append(l);
    }
    h.setAttribute('aria-label', html.replace(/<br\s*\/?>/gi, ' '));
  }

  // ---- stage change --------------------------------------------------------------------------------------------------
  let currentStage = -1, swapToken = 0, annTimer, exitAnim, collapseTimer, pinned = false;
  const chapter = document.querySelector('.chapter'), detailBtn = $('#detailBtn'), phoneMQ = matchMedia('(max-width: 750px)');
  // Phones: description + facts show for the first seconds of a stage, then fold away ('Detay' brings them back).
  function briefChapter() {
    clearTimeout(collapseTimer); pinned = false; chapter.classList.remove('collapsed'); detailBtn.setAttribute('aria-expanded', 'true');
    collapseTimer = setTimeout(() => { if (phoneMQ.matches && !pinned && !loading) { chapter.classList.add('collapsed'); detailBtn.setAttribute('aria-expanded', 'false'); } }, 5000);
  }
  detailBtn.onclick = () => { pinned = true; clearTimeout(collapseTimer); chapter.classList.remove('collapsed'); detailBtn.setAttribute('aria-expanded', 'true'); };
  function renderStage(idx, mode) { // mode: 'first' | 'swap' | 'intro'
    const s = stages[idx], fresh = mode !== 'swap';
    setText($('#chapterIndex'), pad2(idx + 1) + ' / ' + stages.length); setText($('#stageTag'), s.tag);
    buildTitle(s.title); setText($('#chapterDesc'), s.desc); setText($('#crew'), s.crew);
    setText($('#certainty'), idx === 0 ? t('cert0') : t('certN'));
    if (mode !== 'first') {
      slideIn($('.chapter .eyebrow'), 0); slideIn($('#chapterDesc'), 320); slideIn($('.facts'), 440);
    }
    swap($('#location'), s.loc, !fresh); swap($('#operation'), s.name, !fresh); swap($('#crewLoc'), t('crewLoc')[idx] || s.crew, !fresh);
    briefChapter();
  }
  function onStage(idx, s) {
    const first = currentStage < 0, token = ++swapToken; currentStage = idx;
    chapBtns.forEach((b, i) => { b.classList.toggle('active', i === idx); b.classList.toggle('done', i < idx); if (i === idx) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    document.documentElement.style.setProperty('--stage', color(idx));
    document.title = 'ARTEMIS IV · ' + s.name;
    updateSubtitle(idx, s, !first);
    clearTimeout(annTimer); annTimer = setTimeout(() => setText($('#announcer'), t('announce', idx + 1, stages.length, s.name, s.desc)), first ? 0 : 700);
    if (first || reduced() || loading) { renderStage(idx, 'first'); return; }
    // quick fade-out of the old chapter, then staggered reveal of the new one
    exitAnim?.cancel(); exitAnim = chapter.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
    setTimeout(() => { if (token !== swapToken) return; exitAnim?.cancel(); exitAnim = null; renderStage(idx, 'swap'); }, 140);
  }
  function updateSubtitle(idx, s, animate) {
    const host = $('.subtitle'), kick = $('#subKicker'), sub = $('#subtitle'), title = s.title.replace(/<br\s*\/?>/gi, ' '), k = pad2(idx + 1) + ' / ' + stages.length + ' · ' + s.tag;
    if (animate && !reduced() && host.animate && sub.textContent) {
      const old = document.createElement('div'); old.className = 'xf-old'; old.innerHTML = '<small></small><span></span>'; old.firstChild.textContent = kick.textContent; old.lastChild.textContent = sub.textContent; host.append(old);
      old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500 }).onfinish = () => old.remove();
      host.querySelectorAll('small:not(.xf-old *),span:not(.xf-old *)').forEach(n => n.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 700, delay: 200, fill: 'backwards', easing: 'cubic-bezier(.16,.84,.24,1)' }));
    }
    kick.textContent = k; sub.textContent = title;
  }

  // ---- play / buttons --------------------------------------------------------------------------------------------------
  const glyph = $('#glyph'), glyphPath = $('#glyphPath');
  function flashGlyph(playing) {
    glyphPath.setAttribute('d', playing ? GLYPH_PLAY : GLYPH_PAUSE);
    if (!reduced() && glyph.animate) glyph.animate([{ opacity: 0, transform: 'scale(.78)' }, { opacity: 1, transform: 'scale(1)', offset: .22 }, { opacity: 0, transform: 'scale(1.3)' }], { duration: 700, easing: 'ease-out' });
  }
  function syncPlay() {
    $('#play').innerHTML = state.playing ? PAUSE_ICON() : PLAY_ICON();
    $('#play').setAttribute('aria-label', state.playing ? t('pause') : t('play'));
    if (state.playing !== prevPlaying) {
      prevPlaying = state.playing;
      if (!quiet && !gateOpen && !loading && state.time < duration - .05) flashGlyph(state.playing);
    }
  }
  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2400); }
  const quietMode = () => isCinema || body.classList.contains('hidden') || idle;
  const feedback = msg => { if (quietMode()) toast(msg); };
  syncPlay();
  $('#play').onclick = api.togglePlay;
  $('#reset').onclick = () => api.seek(0);
  $('#speed').onchange = e => state.speed = Number(e.target.value);
  const viewBtn = $('#view');
  function syncView(v = 0) {
    const free = state.mode === 'free';
    const name = t('views')[v];
    viewBtn.disabled = free; viewBtn.title = free ? t('viewFreeTitle') : t('viewTitle');
    viewBtn.firstElementChild.nextElementSibling.textContent = name; viewBtn.setAttribute('aria-label', t('viewAria', name)); viewBtn.classList.toggle('alt', v > 0);
    $('#cameraMode').value = state.mode;
  }
  $('#cameraMode').onchange = e => { api.setCameraMode(e.target.value); syncView(state.view || 0); };
  viewBtn.onclick = () => { if (state.mode === 'free') { toast(t('viewFreeToast')); return; } syncView(api.cycleView()); };
  $('#quality').onchange = e => api.setQuality(e.target.value);
  const toggleLabels = () => { state.labels = !state.labels; $('#labels').setAttribute('aria-pressed', state.labels); feedback(state.labels ? t('labelsOn') : t('labelsOff')); };
  $('#labels').onclick = toggleLabels;
  const soundBtn = $('#sound');
  function syncSound() { setText(soundBtn.firstElementChild, state.sound ? t('soundOn') : t('soundOff')); soundBtn.setAttribute('aria-pressed', state.sound); }
  const toggleSound = () => { api.audio.setEnabled(!api.audio.enabled); state.sound = api.audio.enabled; syncSound(); feedback(state.sound ? t('soundOn') : t('soundOff')); };
  soundBtn.onclick = toggleSound;
  async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { toast(t('fsUnsupported')); } }
  $('#fullscreen').onclick = fullscreen;
  function hide() { if (isCinema) return; body.classList.toggle('hidden'); $('#show').hidden = !body.classList.contains('hidden'); poke(); }
  $('#hide').onclick = hide; $('#show').onclick = hide;
  $('#capture').onclick = () => {
    const a = document.createElement('a'); a.download = 'artemis-iv-' + String(Math.floor(state.time)) + 's.png'; a.href = api.capture(); a.click();
    toast(t('captured'));
  };
  // secondary controls live behind the ⋯ button on phones / very short windows
  const moreBtn = $('#more');
  function setMore(on) { moreOpen = on; body.classList.toggle('more', on); moreBtn.setAttribute('aria-expanded', on); moreBtn.setAttribute('aria-pressed', on); }
  moreBtn.onclick = () => setMore(!moreOpen);
  window.addEventListener('pointerdown', e => { if (moreOpen && !e.target.closest('#viewGroup,#more')) setMore(false); });
  // telemetry card: compact by default, details on hover or via the toggle (remembered)
  const tBtn = $('#tDetail');
  let teleOpen = store.get('a4.tele') === '1';
  function setTele(on) { teleOpen = on; tele.classList.toggle('open', on); tBtn.setAttribute('aria-expanded', on); tBtn.firstElementChild.textContent = on ? t('tLess') : t('tMore'); store.set('a4.tele', on ? '1' : '0'); }
  tBtn.onclick = () => setTele(!teleOpen); setTele(teleOpen);

  // ---- dialogs ----------------------------------------------------------------------------------------------------------
  const reportDialog = $('#reportDialog'), helpDialog = $('#helpDialog');
  // Focus returns to the opener only for keyboard users; after a pointer-opened dialog the opener is not focused, so Space keeps
  // toggling playback instead of re-activating the button that opened the dialog.
  let opener = null, lastInputPointer = false;
  window.addEventListener('pointerdown', () => { lastInputPointer = true; }, true);
  window.addEventListener('keydown', () => { lastInputPointer = false; }, true);
  const openDialog = (d, from) => { opener = lastInputPointer ? null : (from || null); setMore(false); d.showModal(); };
  for (const d of [reportDialog, helpDialog]) d.addEventListener('close', () => { if (opener) opener.focus?.({ preventScroll: true }); else document.activeElement?.blur?.(); opener = null; });
  // the report file follows the language (report.md / rapor.md); a switch while it is open reloads it
  let reportLoaded = null;
  async function loadReport() {
    const l = getLang(); if (reportLoaded === l) return; reportLoaded = l;
    try { const r = await fetch(t('reportFile')); if (!r.ok) throw 0; const text = await r.text(); if (reportLoaded === l) renderMarkdown(text, $('#reportBody')); }
    catch { if (reportLoaded !== l) return; reportLoaded = null; $('#reportBody').textContent = ''; const p = document.createElement('p'); p.textContent = t('rFail'); $('#reportBody').append(p); }
  }
  const syncReportLang = () => {
    $('#rawReport').href = t('reportFile');
    if ($('#fullReport').open) loadReport();
    else if (reportLoaded && reportLoaded !== getLang()) { reportLoaded = null; $('#reportBody').innerHTML = '<p class="mdLoading"></p>'; $('#reportBody').firstChild.textContent = t('rLoading'); }
  };
  syncReportLang();
  $('#fullReport').addEventListener('toggle', e => { if (e.target.open) loadReport(); });
  $('#report').onclick = e => openDialog(reportDialog, e.currentTarget);
  $('#help').onclick = e => openDialog(helpDialog, e.currentTarget);
  $('#closeReport').onclick = () => reportDialog.close();
  $('#closeHelp').onclick = () => helpDialog.close();
  for (const d of [reportDialog, helpDialog]) d.onclick = e => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  };

  // ---- cinema mode ------------------------------------------------------------------------------------------------------
  let exitTimer;
  const showExit = ms => { body.classList.add('show-exit'); clearTimeout(exitTimer); exitTimer = setTimeout(() => body.classList.remove('show-exit'), ms); };
  function setCinema(on) {
    if (on === isCinema) return; isCinema = on;
    body.classList.toggle('cinema', on); body.classList.remove('show-exit'); $('#cinema').setAttribute('aria-pressed', on); setMore(false);
    if (on) {
      document.activeElement?.blur?.();
      toast(isTouch ? t('cinemaToastTouch') : t('cinemaToast'));
      if (isTouch) showExit(3200);
    }
  }
  $('#cinema').onclick = () => setCinema(!isCinema);
  $('#exitCinema').onclick = () => setCinema(false);
  document.querySelectorAll('.letterbox').forEach(b => b.addEventListener('click', () => setCinema(false)));
  window.addEventListener('pointermove', () => { if (isCinema) showExit(2500); }, { passive: true });
  window.addEventListener('pointerdown', () => { if (isCinema) showExit(3200); }, { passive: true });

  // ---- start gate (after warm-up), end card ----------------------------------------------------------------------------------
  const loadingEl = $('#loading'), gateEl = $('#gate'), startBtn = $('#startBtn'), gateSound = $('#gateSound'), gateFs = $('#gateFs');
  let wantSound = store.get('a4.sound') !== '0', wantFs = false;
  const syncGate = () => {
    gateSound.setAttribute('aria-pressed', wantSound); gateSound.lastElementChild.textContent = wantSound ? t('soundOn') : t('muted');
    gateFs.setAttribute('aria-pressed', wantFs);
  };
  gateSound.onclick = () => { wantSound = !wantSound; store.set('a4.sound', wantSound ? '1' : '0'); syncGate(); };
  gateFs.onclick = () => { wantFs = !wantFs; syncGate(); }; syncGate();
  function dismissGate() {
    if (!loading) return; loading = false; gateOpen = false; body.classList.remove('gate');
    loadingEl.classList.add('done'); $('#loadText').textContent = t('missionReady');
    setTimeout(() => { loadingEl.style.display = 'none'; }, 1100);
    if (currentStage >= 0) setTimeout(() => renderStage(currentStage, 'intro'), 350); // replay the chapter reveal
    poke();
  }
  function startMission() {
    quiet++;
    if (wantSound) { api.audio.setEnabled(true); state.sound = api.audio.enabled; syncSound(); }   // inside the user gesture: creates the AudioContext
    if (wantFs && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => { });
    dismissGate(); if (!state.playing) api.togglePlay();
    quiet--;
  }
  startBtn.onclick = startMission;
  $('#gateSkip').onclick = () => { dismissGate(); };
  function openGate() {
    gateOpen = true; body.classList.add('gate'); loadingEl.classList.add('ready'); gateEl.hidden = false; $('#loadText').textContent = t('missionReady');
    startBtn.focus({ preventScroll: true });
  }
  // End card: appears once the film has played through; Space / Yeniden izle restarts.
  const endEl = $('#endcard'); let endShown = false, endArmed = false, endTimer;
  function showEnd(on) {
    if (on === endShown) return; endShown = on; clearTimeout(endTimer); body.classList.toggle('ended', on);
    if (on) { endEl.hidden = false; endTimer = setTimeout(() => { endEl.classList.add('on'); $('#replay').focus({ preventScroll: true }); }, 700); }
    else { endEl.classList.remove('on'); endTimer = setTimeout(() => { endEl.hidden = true; }, 1250); }
  }
  $('#replay').onclick = () => { showEnd(false); endArmed = false; api.seek(0); api.togglePlay(); };
  $('#endReport').onclick = e => openDialog(reportDialog, e.currentTarget);
  $('#endCinema').onclick = () => setCinema(true);

  // ---- keyboard ---------------------------------------------------------------------------------------------------------
  document.addEventListener('mousedown', e => { if (e.target.closest('button') && !e.target.closest('dialog')) e.preventDefault(); });
  document.querySelectorAll('.controls select').forEach(s => s.addEventListener('change', () => s.blur()));
  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (gateOpen) return;
    if (reportDialog.open || helpDialog.open) { if (e.key === '?' && helpDialog.open) { e.preventDefault(); helpDialog.close(); } return; }
    if (e.key === 'Escape') { if (isCinema) setCinema(false); else if (moreOpen) setMore(false); return; }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.id !== 'timeline') return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.code === 'Space') { if (e.target.tagName === 'BUTTON') return; e.preventDefault(); if (!e.repeat) api.togglePlay(); }
    else if (k === 'ArrowRight') { e.preventDefault(); api.seek(state.time + 2, true); feedback('+2 ' + t('uSec').toLowerCase()); }
    else if (k === 'ArrowLeft') { e.preventDefault(); api.seek(state.time - 2, true); feedback('−2 ' + t('uSec').toLowerCase()); }
    else if (/^[0-9]$/.test(k) && !e.shiftKey) { const i = k === '0' ? 9 : Number(k) - 1; if (stages[i]) { e.preventDefault(); api.seek(stages[i].start, true); feedback((i + 1) + ' · ' + stages[i].name); } }
    else if (k === 'd' && e.shiftKey) body.classList.toggle('debug');
    else if (k === 'h') hide();
    else if (k === 'f') fullscreen();
    else if (k === 'c') setCinema(!isCinema);
    else if (k === 'm') toggleSound();
    else if (k === 'l') toggleLabels();
    else if (k === 't') { toggleLang(); feedback(t('langSwitched')); }
    else if (k === '?') { e.preventDefault(); openDialog(helpDialog, null); }
  });

  // ---- schematic map (≤30 Hz, crisp on high-DPI, static layer cached) --------------------------------------------
  const canvas = $('#map'), mapCtx = canvas.getContext('2d');
  const stat = document.createElement('canvas'); // cached static layer
  const L = {}; let mapW = 0, mapH = 0, mapDpr = 1, lastMap = 0, lastMapIdx = -1;
  const bez = (p0, p1, p2, p3, n) => Array.from({ length: n }, (_, i) => { const t = i / (n - 1), a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3; return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]; });
  const ring = (c, r, a) => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
  function layoutMap() {
    const r = canvas.getBoundingClientRect(); if (r.width < 4) { mapW = 0; return; }
    mapDpr = Math.min(2.5, Math.max(1, devicePixelRatio || 1)); mapW = r.width; mapH = r.height;
    canvas.width = Math.round(mapW * mapDpr); canvas.height = Math.round(mapH * mapDpr); stat.width = canvas.width; stat.height = canvas.height;
    const w = mapW, h = mapH, s = h / 132;
    L.Re = 22 * s; L.Rm = 10.5 * s; L.ro = L.Re + 9 * s; L.rm = L.Rm + 9 * s; L.E = [w * .17, h * .6]; L.M = [w * .85, h * .42];
    L.thOut = -125 * D; L.thIn = 40 * D; L.mIn = -150 * D; L.mOut = 130 * D;
    const o0 = ring(L.E, L.ro, L.thOut), o1 = ring(L.M, L.rm, L.mIn), r0 = ring(L.M, L.rm, L.mOut), r1 = ring(L.E, L.ro, L.thIn);
    L.out = bez(o0, [o0[0] + w * .14, o0[1] - h * .36], [o1[0] - w * .26, o1[1] - h * .4], o1, 72);
    L.ret = bez(r0, [r0[0] - w * .1, r0[1] + h * .3], [r1[0] + w * .3, r1[1] + h * .3], r1, 72);
    drawStatic(); lastMapIdx = -1;
  }
  function drawStatic() {
    const c = stat.getContext('2d'); c.setTransform(mapDpr, 0, 0, mapDpr, 0, 0); c.clearRect(0, 0, mapW, mapH);
    // faint grid
    c.fillStyle = 'rgba(160,190,215,.10)'; for (let x = 8; x < mapW; x += 16) for (let y = 8; y < mapH; y += 16) c.fillRect(x, y, 1, 1);
    // orbit rings
    c.lineWidth = 1; c.strokeStyle = 'rgba(150,185,215,.22)'; for (const [P, r] of [[L.E, L.ro], [L.M, L.rm]]) { c.beginPath(); c.arc(P[0], P[1], r, 0, TAU); c.stroke(); }
    // Earth
    let [x, y] = L.E, R = L.Re, g = c.createRadialGradient(x, y, R * .9, x, y, R * 1.55); g.addColorStop(0, 'rgba(110,180,255,.38)'); g.addColorStop(1, 'rgba(110,180,255,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, R * 1.55, 0, TAU); c.fill();
    g = c.createRadialGradient(x - R * .4, y - R * .45, R * .1, x, y, R); g.addColorStop(0, '#7cc0ff'); g.addColorStop(.55, '#2a6fb5'); g.addColorStop(1, '#0c2f5a');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, TAU); c.fill();
    c.save(); c.beginPath(); c.arc(x, y, R, 0, TAU); c.clip(); c.fillStyle = 'rgba(120,200,140,.38)';
    for (const [dx, dy, rx, ry, rot] of [[-.3, -.2, .38, .26, .5], [.3, .25, .3, .38, -.4], [-.05, .55, .2, .12, 0], [.55, -.35, .18, .14, .3]]) { c.beginPath(); c.ellipse(x + dx * R, y + dy * R, rx * R, ry * R, rot, 0, TAU); c.fill(); }
    g = c.createLinearGradient(x - R, y, x + R, y); g.addColorStop(.35, 'rgba(0,10,25,0)'); g.addColorStop(1, 'rgba(0,10,25,.55)'); c.fillStyle = g; c.fillRect(x - R, y - R, R * 2, R * 2); c.restore();
    c.strokeStyle = 'rgba(160,210,255,.55)'; c.lineWidth = 1; c.beginPath(); c.arc(x, y, R, 0, TAU); c.stroke();
    // Moon
    [x, y] = L.M; R = L.Rm; g = c.createRadialGradient(x - R * .4, y - R * .4, R * .1, x, y, R); g.addColorStop(0, '#eceff1'); g.addColorStop(1, '#757f87'); c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, TAU); c.fill();
    c.fillStyle = 'rgba(60,70,80,.28)'; for (const [dx, dy, rr] of [[-.3, -.2, .26], [.35, .1, .2], [-.05, .45, .16], [.2, -.5, .13]]) { c.beginPath(); c.arc(x + dx * R, y + dy * R, rr * R, 0, TAU); c.fill(); }
    // labels
    c.font = '500 11px Bahnschrift,"Segoe UI",sans-serif'; c.letterSpacing = '1.4px'; c.fillStyle = '#a9bccb'; c.textBaseline = 'middle';
    c.textAlign = 'center'; c.fillText(t('mapEarth'), L.E[0], Math.min(mapH - 8, L.E[1] + L.Re + 15)); c.fillText(t('mapMoon'), L.M[0], L.M[1] + L.Rm + 14);
    c.fillStyle = '#8fa6b8'; c.textAlign = 'center'; c.fillText(t('mapOut'), L.out[36][0], L.out[36][1] + 15); c.fillText(t('mapRet'), L.ret[36][0], L.ret[36][1] - 13);
  }
  const trace = (c, pts, upTo) => { // draw polyline up to fraction 0..1
    const n = pts.length - 1, f = clamp(upTo) * n, k = Math.floor(f); c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i <= k; i++) c.lineTo(pts[i][0], pts[i][1]);
    if (k < n) c.lineTo(mix(pts[k][0], pts[k + 1][0], f - k), mix(pts[k][1], pts[k + 1][1], f - k));
  };
  function pointAt(pts, p) { const n = pts.length - 1, f = clamp(p) * n, k = Math.min(n - 1, Math.floor(f)); return [mix(pts[k][0], pts[k + 1][0], f - k), mix(pts[k][1], pts[k + 1][1], f - k)]; }
  function drawMap(idx, u, t) {
    const c = mapCtx, e = smooth(u); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height); c.drawImage(stat, 0, 0); c.setTransform(mapDpr, 0, 0, mapDpr, 0, 0);
    // vehicle position + progress per leg
    let pos, ang;
    const pOut = idx < 2 ? 0 : idx === 2 ? e : 1, pRet = idx < 7 ? 0 : idx === 7 ? e : 1;
    const earthArc = idx === 1 ? L.thOut + (u - 1) * TAU : null;
    if (idx === 0) pos = ring(L.E, mix(L.Re, L.ro, e), L.thOut);
    else if (idx === 1) pos = ring(L.E, L.ro, earthArc);
    else if (idx === 2) pos = pointAt(L.out, e);
    else if (idx === 3) { ang = L.mIn + u * (90 * D - L.mIn); pos = ring(L.M, L.rm, ang); }
    else if (idx === 4) pos = ring(L.M, mix(L.rm, L.Rm, e), 90 * D);
    else if (idx === 5) pos = ring(L.M, L.Rm, 90 * D);
    else if (idx === 6) pos = ring(L.M, mix(L.Rm, L.rm, smooth(u / .6)), 90 * D + (L.mOut - 90 * D) * smooth((u - .45) / .55));
    else if (idx === 7) pos = pointAt(L.ret, e);
    else if (idx === 8) pos = ring(L.E, mix(L.ro, L.Re, e), L.thIn);
    else pos = ring(L.E, L.Re, L.thIn);
    c.lineCap = 'round'; c.lineJoin = 'round';
    // dashed future routes, dash phase tied to film time (deterministic)
    c.lineWidth = 1.4; c.strokeStyle = 'rgba(140,175,205,.55)'; c.setLineDash([4, 6]); c.lineDashOffset = -t * 8;
    for (const pts of [L.out, L.ret]) { trace(c, pts, 1); c.stroke(); }
    c.setLineDash([]);
    // completed / active route (solid, glowing head)
    c.strokeStyle = '#ffb569'; c.lineWidth = 2; c.shadowColor = 'rgba(255,181,105,.9)'; c.shadowBlur = 6;
    if (pOut > 0) { trace(c, L.out, pOut); c.stroke(); }
    if (pRet > 0) { trace(c, L.ret, pRet); c.stroke(); }
    const arc = (P, r, a0, a1) => { c.beginPath(); c.arc(P[0], P[1], r, a0, a1); c.stroke(); };
    if (idx === 1) arc(L.E, L.ro, L.thOut, earthArc); else if (idx > 1) { c.globalAlpha = .55; arc(L.E, L.ro, L.thOut, L.thOut + TAU); c.globalAlpha = 1; }
    if (idx === 3) arc(L.M, L.rm, L.mIn, ang); else if (idx > 3) { c.globalAlpha = .55; arc(L.M, L.rm, L.mIn, 90 * D); c.globalAlpha = 1; }
    if (idx > 6) { c.globalAlpha = .55; arc(L.M, L.rm, 90 * D, L.mOut); c.globalAlpha = 1; }
    c.shadowBlur = 0;
    // glowing vehicle
    const [x, y] = pos, g = c.createRadialGradient(x, y, 0, x, y, 13); g.addColorStop(0, 'rgba(255,196,140,.85)'); g.addColorStop(.35, 'rgba(255,181,105,.3)'); g.addColorStop(1, 'rgba(255,181,105,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, 13, 0, TAU); c.fill();
    c.fillStyle = '#fff3e4'; c.beginPath(); c.arc(x, y, 3, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,200,150,.8)'; c.lineWidth = 1; c.beginPath(); c.arc(x, y, 5.5 + Math.sin(t * 3) * .6, 0, TAU); c.stroke();
  }
  if (window.ResizeObserver) new ResizeObserver(layoutMap).observe(canvas); else window.addEventListener('resize', layoutMap);
  const syncDock = () => document.documentElement.style.setProperty('--dock-h', Math.round(dockEl.getBoundingClientRect().height) + 'px');
  if (window.ResizeObserver) new ResizeObserver(syncDock).observe(dockEl); syncDock();
  const hoverCapable = matchMedia('(hover: hover)').matches;

  // ---- per-frame update -----------------------------------------------------------------------------------------------
  let lastPct = -1, lastSec = -1, lastDist = '', lastVel = '';
  const hairline = $('#hairline'), distLabel = $('#distLabel'), distApprox = $('#distApprox'), velApprox = $('#velApprox'), distUnit = $('#distUnit');
  function frame({ t: ft, idx, u, stage: s, day }) {
    if (idx !== currentStage) onStage(idx, s);
    const now = performance.now();
    // playback chrome recedes after 3 s without input while the film plays
    const wantIdle = state.playing && !gateOpen && !isCinema && !overUI && !moreOpen && !reportDialog.open && !helpDialog.open && now - lastActive > 3000;
    if (wantIdle !== idle) setIdle(wantIdle);
    // end card
    if (state.playing && ft > duration - 2) endArmed = true;
    if (endArmed && !state.playing && ft >= duration - .02) showEnd(true);
    else if (endShown && ft < duration - .5) { showEnd(false); endArmed = false; }
    const secs = Math.floor(day * 86400);
    setText(el.mtD, pad2(Math.floor(secs / 86400))); setText(el.mtH, pad2(Math.floor(secs % 86400 / 3600))); setText(el.mtM, pad2(Math.floor(secs % 3600 / 60))); setText(el.mtS, pad2(secs % 60));
    setText(el.timeNote, ft === 0 ? t('tLaunch') : idx === 0 ? t('tAscent') : t('tClock'));
    const sec = Math.floor(ft);
    if (sec !== lastSec) {
      lastSec = sec; setText(el.filmTime, fmt(ft) + ' / ' + totalLabel);
      el.timeline.setAttribute('aria-valuetext', fmt(ft) + ' / ' + totalLabel + ' · ' + s.name);
      if (!scrubbing) el.timeline.value = ft;
    }
    const pct = Math.round(ft / duration * 4000) / 40;
    if (pct !== lastPct) { lastPct = pct; el.tl.style.setProperty('--p', pct + '%'); hairline.style.setProperty('--pr', (pct / 100).toFixed(4)); }
    const [dist, vel] = profile(idx, u), alt = idx >= 8, ds = dist >= 1000 ? int(Math.round(dist / 10) * 10) : dist >= 10 ? int(Math.round(dist)) : dist >= .05 ? num(dist, 1) : '0', vs = num(vel, vel > 0 && vel < 1 ? 2 : 1);   // slow phases (parachutes) keep a readable non-zero speed
    if (ds !== lastDist) { lastDist = ds; el.distance.textContent = ds; distApprox.hidden = ds === '0'; }
    if (vs !== lastVel) { lastVel = vs; el.velocity.textContent = vs; velApprox.hidden = !Number(vs.replace(',', '.')); }
    setText(distLabel, !alt ? t('distEarth') : ds === '0' ? t('seaLevel') : t('altitude'));
    // map: ≤30 Hz, only while the detail section is actually visible
    if (now - lastMap >= 33 && !isCinema && !idle && !body.classList.contains('hidden') && !gateOpen) {
      const shown = teleOpen || (hoverCapable && tele.matches(':hover'));
      if (shown) {
        if (!mapW && canvas.offsetWidth) layoutMap();
        if (mapW) { lastMap = now; lastMapIdx = idx; drawMap(idx, u, ft); }
      }
    }
  }

  // ---- annotations: collision-aware layout ---------------------------------------------------------------------------
  // Each label tries 8 lead directions x 3 lengths and takes the placement that overlaps least with the HUD cards,
  // the other labels and the hero silhouettes (a screen-space circle around each labelled object). Lower-priority labels
  // fade out instead of overlapping. Placement is sticky (hysteresis) so nothing jitters. Labels fade with the stage cuts.
  const DIRS = [[-38, 1], [-142, -1], [38, 1], [142, -1], [-72, 1], [-108, -1], [72, 1], [108, -1]].map(([a, side]) => ({ a, side, c: Math.cos(a * D), s: Math.sin(a * D) }));
  const EXTRA = [0, 44, 100], LH = 26, LEAD0 = 56;
  let annotationDefs = [], lastWorld = '', obsAt = 0, curW = 0, curH = 0;
  const obs = Array.from({ length: 6 }, () => ({ x0: 0, y0: 0, x1: 0, y1: 0 })); let obsN = 0;
  const cands = [], tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3(), box = new THREE.Box3(), box2 = new THREE.Box3(), sph = new THREE.Sphere();
  const annEl = $('#annotations'); let annFactor = 1, hasPriority = false;
  const byPriority = (a, b) => (b.priority || 0) - (a.priority || 0);
  function refreshObstacles(now) {
    if (now - obsAt < 250 && curW === innerWidth && curH === innerHeight) return; obsAt = now; curW = innerWidth; curH = innerHeight; obsN = 0;
    const add = (node, pad) => { if (!node) return; const r = node.getBoundingClientRect(); if (r.width < 8 || r.height < 8) return; const o = obs[obsN++]; o.x0 = r.left - pad; o.y0 = r.top - pad; o.x1 = r.right + pad; o.y1 = r.bottom + pad; };
    add(tele, 8); add(chapter, 4);
    if (!idle) { add(dockEl, 6); add(document.querySelector('header.top .toptools'), 4); add(document.querySelector('header.top .brand'), 4); }
  }
  function measure(d) {
    box.makeEmpty();
    d.object.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || !o.visible || !o.geometry) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!m || m.transparent) return;
      const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
      box2.copy(g.boundingBox).applyMatrix4(o.matrixWorld); box.union(box2);
    });
    d.object.getWorldPosition(tmp);
    if (box.isEmpty()) { d.hero = { r: d.radius || 0, ox: 0, oy: 0, oz: 0 }; return; }
    box.getBoundingSphere(sph);
    d.hero = { r: d.radius || sph.radius * .8, ox: sph.center.x - tmp.x, oy: sph.center.y - tmp.y, oz: sph.center.z - tmp.z };
  }
  function addAnnotations(defs) {
    for (const d of defs) {
      d.src = d.text; d.text = tx(d.src).replace(/\s+\/\s+/g, ' · ');
      d.el = document.createElement('div'); d.el.className = 'annotation';
      d.el.innerHTML = '<i class="dot"></i><i class="lead"></i><span class="txt"></span>'; d.txt = d.el.lastChild; d.lead = d.el.children[1]; d.txt.textContent = d.text;
      d.on = false; d.px = d.py = -1e4; d.rect = { x0: 0, y0: 0, x1: 0, y1: 0 }; d.pl = -1; d.plKey = -1; d.hero = null; d.cx = d.cy = d.cr = 0;
      $('#annotations').append(d.el); d.w = d.txt.offsetWidth;
    }
    annotationDefs = annotationDefs.concat(defs); hasPriority = annotationDefs.some(d => d.priority);
    document.fonts?.ready?.then(() => { for (const d of annotationDefs) d.w = d.txt.offsetWidth; });
  }
  window.addEventListener('resize', () => { obsAt = 0; for (const d of annotationDefs) d.w = d.txt.offsetWidth || d.w; });
  const kill = d => { // hide without a ghost: used when the world changes
    d.on = false; d.pl = -1; d.plKey = -1; d.el.style.transition = 'none'; d.el.classList.remove('on'); void d.el.offsetWidth; d.el.style.transition = '';
  };
  const overlap = (x0, y0, x1, y1, o) => { const w = Math.min(x1, o.x1) - Math.max(x0, o.x0), h = Math.min(y1, o.y1) - Math.max(y0, o.y0); return w > 0 && h > 0 ? w * h : 0; };
  const circleHits = (cx, cy, r, x0, y0, x1, y1) => { const dx = cx - clamp(cx, x0, x1), dy = cy - clamp(cy, y0, y1); return dx * dx + dy * dy < r * r; };
  function updateAnnotations(camera, activeWorld, isVisible) {
    const W = innerWidth, H = innerHeight, now = performance.now();
    if (activeWorld !== lastWorld) { lastWorld = activeWorld; for (const d of annotationDefs) if (d.on) kill(d); }
    // fade with the stage cuts (the scene dips to black there) while the film is playing; hidden instantly on a world change
    let f = 1;
    if (state.playing) { for (let i = 1; i < stages.length; i++) f = Math.min(f, Math.abs(state.time - stages[i].start) / .3); f = smooth(clamp(f)); }
    if (f !== annFactor) { annFactor = f; annEl.style.setProperty('--ann', f.toFixed(3)); }
    const show = state.labels && !isCinema && !gateOpen && !endShown && W > 430;
    refreshObstacles(now);
    const k = H / (2 * Math.tan(camera.fov * D / 2));
    cands.length = 0;
    for (const d of annotationDefs) {
      let ok = show && d.world === activeWorld && d.object.visible && isVisible(d);
      if (ok) {
        d.object.getWorldPosition(tmp); if (!d.hero) measure(d);
        tmp2.copy(tmp).add(tmp3.set(d.hero.ox, d.hero.oy, d.hero.oz)); // hero centre
        const dist = camera.position.distanceTo(tmp2) || 1;
        if (d.offset) tmp.add(d.offset);
        tmp.project(camera);
        ok = tmp.z > -1 && tmp.z < 1 && Math.abs(tmp.x) < .95 && Math.abs(tmp.y) < .8;
        if (ok) {
          d.ax = Math.round((tmp.x * .5 + .5) * W * 2) / 2; d.ay = Math.round((-tmp.y * .5 + .5) * H * 2) / 2;
          tmp2.project(camera); d.cx = (tmp2.x * .5 + .5) * W; d.cy = (-tmp2.y * .5 + .5) * H; d.cr = Math.min(240, d.hero.r * k / dist);
          if (!d.w) d.w = d.txt.offsetWidth;
          cands.push(d);
        }
      }
      if (!ok && d.on) { d.on = false; d.pl = -1; d.el.classList.remove('on'); }
    }
    // priority: explicit d.priority (higher first), else definition order
    if (cands.length > 1 && hasPriority) cands.sort(byPriority);
    let placed = 0;
    for (let ci = 0; ci < cands.length; ci++) {
      const d = cands[ci], w = d.w || 120;
      let best = 1e9, bi = 0, bt = 0, bL = LEAD0;
      for (let di = 0; di < DIRS.length; di++) {
        const dr = DIRS[di];
        // lead must leave the hero silhouette: distance along the ray from the anchor to the circle's edge
        let exit = 0;
        if (d.cr > 4) {
          const ox = d.ax - d.cx, oy = d.ay - d.cy, b = dr.c * ox + dr.s * oy, cc = ox * ox + oy * oy - d.cr * d.cr;
          if (cc < 0) exit = -b + Math.sqrt(b * b - cc);
        }
        const L0 = Math.min(LEAD0 + 120, Math.max(LEAD0, exit + 20));
        for (let ti = 0; ti < EXTRA.length; ti++) {
          const L2 = L0 + EXTRA[ti], ex = d.ax + dr.c * L2, ey = d.ay + dr.s * L2;
          const x0 = dr.side > 0 ? ex : ex - w, x1 = x0 + w, y0 = ey - LH / 2, y1 = y0 + LH, area = w * LH;
          let sc = ti * 6 + di * 1.5, ov = 0;
          if (x0 < 8 || x1 > W - 8 || y0 < 8 || y1 > H - 8) sc += 220;
          for (let o = 0; o < obsN; o++) ov += overlap(x0, y0, x1, y1, obs[o]) / area * 110;
          for (let p = 0; p < ci; p++) { const q = cands[p]; if (q.placed) ov += overlap(x0, y0, x1, y1, q.rect) / area * 160; }
          // stickiness only for a clean placement, so a remembered spot never keeps a chip touching the HUD or another label
          sc += ov + (ov === 0 && di === d.pl && ti === d.plT ? -14 : 0);
          for (let p = 0; p < cands.length; p++) { const q = cands[p]; if (q.cr > 4 && circleHits(q.cx, q.cy, q.cr * (q === d ? .95 : .9), x0, y0, x1, y1)) sc += q === d ? 18 : 45; }
          if (sc < best) { best = sc; bi = di; bt = ti; bL = L2; }
        }
      }
      d.placed = false;
      if (ci > 0 && best >= 90) continue; // would overlap something: stay hidden rather than collide (the first label always shows)
      const dr = DIRS[bi], Lq = Math.round(bL / 4) * 4, key = bi * 4096 + Lq;
      d.pl = bi; d.plT = bt; d.placed = true; placed++;
      const ex = dr.c * Lq, ey = dr.s * Lq, tx = dr.side > 0 ? ex : ex - w, r = d.rect;
      r.x0 = d.ax + tx; r.x1 = r.x0 + w; r.y0 = d.ay + ey - LH / 2; r.y1 = r.y0 + LH;
      if (key !== d.plKey) {
        d.plKey = key; d.el.classList.toggle('flip', dr.side < 0);
        d.lead.style.width = Lq + 'px'; d.lead.style.transform = 'rotate(' + dr.a + 'deg)';
        d.txt.style.transform = 'translate(' + tx + 'px,' + (ey - LH / 2) + 'px)';
      }
      if (d.ax !== d.px || d.ay !== d.py) { d.px = d.ax; d.py = d.ay; d.el.style.transform = 'translate3d(' + d.ax + 'px,' + d.ay + 'px,0)'; }
      if (!d.on) { d.on = true; d.el.classList.add('on'); }
    }
    for (const d of cands) if (!d.placed && d.on) { d.on = false; d.pl = -1; d.el.classList.remove('on'); }
  }

  // ---- loading screen: real asset progress 0–70 %, shader warm-up 70–100 % (ui.setLoadProgress) ------------------------
  const fill = $('#loadFill'), pctEl = $('#loadPct'), stepEl = $('#loadStep'), bar = loadingEl.querySelector('.ld-bar');
  const ASSET_END = 70;
  let shown = 0, ready = false, explicit = false;
  const steps = [[0, 'loadInit'], [15, 'loadTextures'], [45, 'loadSurface'], [ASSET_END, 'loadShaders'], [100, 'loadReady']];
  function setProgress(p, label) {
    p = Math.max(shown, Math.round(clamp(p, 0, 100))); if (p === shown && shown && !label) return; shown = p;
    fill.style.width = Math.max(6, p) + '%'; pctEl.textContent = p + '%'; bar.setAttribute('aria-valuenow', p);
    let step = steps[0][1]; for (const [a, name] of steps) if (p >= a) step = name; stepEl.textContent = label || t(step);
  }
  function setLoadProgress(f, label) { if (!loading || ready) return; explicit = true; setProgress(ASSET_END + (100 - ASSET_END) * clamp(f), label || undefined); }
  const mgr = THREE.DefaultLoadingManager, prevProgress = mgr.onProgress;
  mgr.onProgress = (url, loaded, total) => { prevProgress?.(url, loaded, total); if (loading && !ready && total && !explicit) setProgress(loaded / total * ASSET_END); };
  // fallback while no explicit warm-up progress arrives: ease towards 96 % so the bar never looks hung
  const creep = setInterval(() => {
    if (!loading || ready) return clearInterval(creep);
    if (!explicit && shown >= ASSET_END - 1 && shown < 96) setProgress(shown + Math.max(1, (96 - shown) * .08));
  }, 450);
  const automated = () => !!navigator.webdriver || /[?&]nogate\b/.test(location.search);
  function hideLoading() {
    if (ready) return; ready = true; setProgress(100, t('loadReady'));
    const gate = /[?&]gate\b/.test(location.search) || !automated();
    setTimeout(() => { if (gate) openGate(); else dismissGate(); }, reduced() ? 0 : 450);
  }

  // ---- language switch (static DOM is handled by i18n.applyDom; this refreshes everything rendered from JS) -------------
  const syncSpeedLabels = () => { for (const o of $('#speed').options) o.textContent = String(Number(o.value)).replace('.', getLang() === 'tr' ? ',' : '.') + '×'; };
  syncSpeedLabels();
  document.querySelectorAll('.langBtn').forEach(b => b.addEventListener('click', toggleLang));
  onLang(() => {
    labelChapters(); fitChapters(); syncSpeedLabels();
    syncPlay(); syncView(state.view || 0); syncSound(); syncGate(); setTele(teleOpen); syncReportLang();
    if (gateOpen || !loading) $('#loadText').textContent = t('missionReady');
    if (currentStage >= 0) {
      const s = stages[currentStage]; renderStage(currentStage, 'first'); updateSubtitle(currentStage, s, false);
      document.title = 'ARTEMIS IV · ' + s.name; lastSec = -1;
    }
    lastDist = lastVel = ''; lastMapIdx = -1; if (mapW) drawStatic();
    for (const d of annotationDefs) { d.text = tx(d.src).replace(/\s+\/\s+/g, ' · '); d.txt.textContent = d.text; d.w = d.txt.offsetWidth; d.plKey = -1; }
  });

  return {
    frame, syncPlay, toast, addAnnotations, updateAnnotations, hideLoading, setLoadProgress,
    setCinema, isCinema: () => isCinema, isGateOpen: () => gateOpen,
    setFps(fps, adapted) { if (body.classList.contains('debug')) $('#fps').textContent = fps + ' FPS · ' + (adapted ? t('adapted') : 'WebGL'); },
    setQualityValue(q) { $('#quality').value = q; }
  };
}
