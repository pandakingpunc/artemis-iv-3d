// Language layer: English (default) and Turkish. Switching is live — no reload.
//   t(key, ...args)      UI string for the current language ({0}, {1}… are replaced by args)
//   L(en, tr) / tx(v)    an inline pair for data that lives next to scene code (stages, labels); tx resolves it
//   setLang(l)           switches, stores the choice, re-applies the static DOM and notifies onLang listeners (in order)
//   applyDom(root)       [data-i18n] text · [data-i18n-html] markup (trusted, static) · [data-i18n-title] / [data-i18n-aria] attributes
//   num(x, digits) / int(x)   locale number formatting (TR: 1.234,5 · EN: 1,234.5)
// Initial language: ?lang=en|tr, then the stored choice, otherwise English.
export const LANGS = ['en', 'tr'];
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const fromUrl = (/[?&]lang=(en|tr)\b/.exec(location.search) || [])[1];
let lang = fromUrl || (LANGS.includes(store.get('a4.lang')) ? store.get('a4.lang') : 'en');
const listeners = [];

const STR = {
  en: {
    docTitle: 'ARTEMIS IV · T+0',
    sceneAria: 'Artemis IV 3D mission animation',
    exitCinema: 'Exit cinema mode', exitKey: 'Exit',
    loadText: 'Preparing the mission…', loadAria: 'Loading progress', loadInit: 'Starting',
    loadModules: 'Loading modules', loadTextures: 'Earth and Moon textures', loadSurface: 'Surface and sky', loadShaders: 'Preparing shaders', loadReady: 'Ready',
    missionReady: 'Mission ready',
    start: 'Start mission', soundOn: 'Sound on', muted: 'Muted', fullscreen: 'Fullscreen',
    gateNote: '3 min 4 s · soundtrack generated in the browser · headphones recommended',
    gateSkip: 'Skip · explore the scene',
    gateCav: 'Representative visualization · not real footage or telemetry',
    brandSub: 'RETURN TO THE MOON / MISSION EXPERIENCE',
    status: 'T+0 → RETURN TO EARTH',
    report: 'Report ↗', reportTitle: 'Report and sources',
    help: 'Shortcuts and controls (?)', helpAria: 'Shortcuts and controls',
    cinema: 'Cinema', cinemaTitle: 'Cinema mode (C)', cinemaAria: 'Cinema mode',
    hide: 'Hide interface (H)', hideAria: 'Hide interface',
    lang: 'Language: English · Türkçe', langAria: 'Switch language (English / Turkish)',
    detail: 'Details',
    telemetryAria: 'Mission telemetry, representative values',
    clock: 'MISSION CLOCK', fpsTitle: 'Frame rate',
    uDay: 'DAY', uHr: 'HR', uMin: 'MIN', uSec: 'SEC',
    tLaunch: 'Launch · representative mission clock', tAscent: 'Ascent timing is representative', tClock: 'Representative mission clock',
    distEarth: 'Distance from Earth', seaLevel: 'Sea level', altitude: 'Altitude', speed: 'Speed', kms: 'km/s',
    approx: 'Representative / approximate · not real telemetry',
    location: 'Location', operation: 'Operation', crew: 'Crew',
    mapAria: 'Schematic Earth–Moon mission map', mapNote: 'Schematic route · scales adapted for storytelling',
    mapEarth: 'EARTH', mapMoon: 'MOON', mapOut: 'OUTBOUND', mapRet: 'RETURN',
    tMore: 'Details', tLess: 'Less',
    flow: 'MISSION TIMELINE', scenes: '/ 10 SCENES',
    discFull: '3 October 2026 report · T+ days are a representative scenario; exact flight schedule, lander and trajectory are not yet set.',
    discShort: 'Representative scenario · 3 October 2026 report',
    timelineAria: 'Mission timeline', chaptersAria: 'Mission phases',
    reset: 'Back to T+0', resetAria: 'Restart',
    play: 'Play', pause: 'Pause',
    speedLbl: 'Speed', speedAria: 'Playback speed',
    more: 'More controls',
    camera: 'Camera', cameraAria: 'Camera mode', cinematic: 'Cinematic', free: 'Free',
    views: ['Standard', 'Wide', 'Close'], viewTitle: 'Change camera angle (Standard · Wide · Close)', viewAria: 'Camera angle: {0}',
    viewFreeTitle: 'Angle is fixed in free camera · switch to Cinematic', viewFreeToast: 'Angle does not change in free camera · choose Cinematic in the Camera menu',
    quality: 'Quality', qualityAria: 'Image quality', qLow: 'Low', qMedium: 'Medium', qHigh: 'High',
    labels: 'Labels', labelsTitle: 'Scene labels (L)', labelsOn: 'Labels on', labelsOff: 'Labels off',
    sound: 'Sound', soundTitle: 'Sound (M)', soundOff: 'Sound off',
    capture: 'Save image as PNG', captured: '3D scene saved as PNG.',
    fsTitle: 'Fullscreen (F)', fsUnsupported: 'This browser does not support fullscreen.',
    show: 'Show interface · H',
    caveat: 'REPRESENTATIVE VISUALIZATION · not real footage',
    endKicker: 'MISSION COMPLETE · T+20 DAYS (REPRESENTATIVE)',
    endLine: 'One journey. A new beginning.',
    replay: 'Watch again', endReport: 'Report',
    endCav: 'Representative visualization · based on the 3 October 2026 report; vehicles, routes and T+ days are representative.',
    dossier: 'MISSION FILE / ARTEMIS IV', closeReport: 'Close report',
    rTitle: 'From report to screen.',
    rLead: 'This experience visualizes the T+ mission sequence of the <b>3 October 2026 Artemis IV research report</b>. T+0 is the SLS/Orion launch. A representative mission of about 21 days is compressed into a 3 minute 4 second narrative; the time scale varies by scene.',
    rMissionH: 'The announced mission',
    rMission: '4 astronauts launch on Orion, 2 land in the south polar region, the crew reunites in orbit and Orion returns to the Pacific.',
    rChoicesH: 'Visualization choices',
    rChoices: 'Vehicle geometry, flight paths, stage separation times, landing site, surface walks and the placement of T+ days are representative. HLS is shown as a generic lander; neither SpaceX nor Blue Origin is chosen. DUSTER and SPSS are candidate science payloads selected for development, not a final flight manifest. No Gateway stop is included.',
    rRaw: 'Raw report text ↗', rDraft: 'Pre-mission draft ↗', rPayloads: 'Science payloads ↗',
    rFull: 'Read the full research report here', rLoading: 'Loading report…',
    rFail: 'Could not load the report. Use the “Raw report text” link.',
    rKeys: 'Press <kbd>?</kbd> or use the help button at the top for controls and shortcuts.',
    reportFile: 'report.md',
    controls: 'CONTROLS', closeHelp: 'Close controls', shortcuts: 'Shortcuts',
    kPlay: 'Play / pause', kSeek: '2 seconds back / forward', kScene: 'Go to scene (0 = scene 10)', kCinema: 'Cinema mode (Esc to exit)',
    kHide: 'Hide / show interface', kFs: 'Fullscreen', kSound: 'Sound on / off', kLabels: 'Scene labels', kPerf: 'Performance readout',
    kHelp: 'This window', kEsc: 'Close window / exit cinema mode', kLang: 'Switch language (EN / TR)',
    helpFoot: 'Free camera: left-drag to orbit · wheel to zoom · right-drag to pan<br>Touch: drag to orbit · pinch to zoom and pan. Tap the timeline to move between scenes.',
    sceneTitle: '{0} · scene {1} ({2})', sceneAria: 'Scene {0}: {1}', announce: 'Scene {0} / {1}: {2}. {3}',
    cert0: 'BASED ON THE REPORT · REPRESENTATIVE', certN: 'T+ DAYS AND DETAILS REPRESENTATIVE',
    cinemaToastTouch: 'Cinema mode · tap to exit', cinemaToast: 'Cinema mode · C or Esc to exit',
    adapted: 'adapted',
    langSwitched: 'Language: English',
    crewLoc: ['Orion (atop SLS)', 'Orion', 'Orion', 'Orion + HLS', 'HLS (2) · Orion (2)', 'Surface (2) · Orion (2)', 'HLS → Orion', 'Orion', 'Orion capsule', 'Capsule → recovery ship'],
    bootFail: 'Could not start', bootFailMsg: 'Reload the page; if the problem persists, try an up-to-date browser with hardware acceleration enabled.',
    webglFail: 'WebGL could not start', webglFailMsg: 'Open it again in a browser with hardware acceleration enabled.',
    lLight: 'Lighting and image pipeline', lPad: 'Launch complex', lEarth: 'Earth', lMoon: 'Moon and transfer', lDock: 'Docking', lSurface: 'Lunar surface',
    lProps: 'Surface objects', lReturn: 'Return', lEntry: 'Atmospheric entry', lPacific: 'Pacific', lTex: 'Textures loaded',
    lCompile: 'Compiling shaders · may take ~15 s on first launch', lScene: 'Preparing scene · {0}/{1}',
    qApplying: 'Applying quality setting…', qDropped: 'Quality lowered for smoothness: {0}', qRes: 'Render resolution adapted for smoothness.',
    qNames: { low: 'low', medium: 'medium' }
  },
  tr: {
    docTitle: 'ARTEMIS IV · T+0',
    sceneAria: 'Artemis IV üç boyutlu görev canlandırması',
    exitCinema: 'Sinema modundan çık', exitKey: 'Çık',
    loadText: 'Görev sahnesi hazırlanıyor…', loadAria: 'Yükleme durumu', loadInit: 'Başlatılıyor',
    loadModules: 'Modüller yükleniyor', loadTextures: 'Dünya ve Ay dokuları', loadSurface: 'Yüzey ve gökyüzü', loadShaders: 'Gölgelendiriciler hazırlanıyor', loadReady: 'Hazır',
    missionReady: 'Görev hazır',
    start: 'Görevi başlat', soundOn: 'Ses açık', muted: 'Sessiz', fullscreen: 'Tam ekran',
    gateNote: '3 dk 4 sn · film müziği tarayıcıda üretilir · kulaklık önerilir',
    gateSkip: 'Atla · sahneyi keşfet',
    gateCav: 'Temsili görselleştirme · gerçek görüntü ve telemetri değildir',
    brandSub: 'AY’A DÖNÜŞ / GÖREV DENEYİMİ',
    status: 'T+0 → DÜNYA’YA DÖNÜŞ',
    report: 'Rapor ↗', reportTitle: 'Rapor ve kaynaklar',
    help: 'Kısayollar ve kontroller (?)', helpAria: 'Kısayollar ve kontroller',
    cinema: 'Sinema', cinemaTitle: 'Sinema modu (C)', cinemaAria: 'Sinema modu',
    hide: 'Arayüzü gizle (H)', hideAria: 'Arayüzü gizle',
    lang: 'Dil: English · Türkçe', langAria: 'Dili değiştir (İngilizce / Türkçe)',
    detail: 'Detay',
    telemetryAria: 'Görev telemetrisi, temsili değerler',
    clock: 'GÖREV SAATİ', fpsTitle: 'Görüntü hızı',
    uDay: 'GÜN', uHr: 'SA', uMin: 'DK', uSec: 'SN',
    tLaunch: 'Fırlatma anı · temsili görev saati', tAscent: 'Yükseliş zamanı temsili', tClock: 'Temsili görev saati',
    distEarth: 'Dünya’dan uzaklık', seaLevel: 'Deniz seviyesi', altitude: 'Yükseklik', speed: 'Hız', kms: 'km/sn',
    approx: 'Temsili / yaklaşık · gerçek telemetri değil',
    location: 'Konum', operation: 'Operasyon', crew: 'Mürettebat',
    mapAria: 'Şematik Dünya Ay görev haritası', mapNote: 'Şematik rota · ölçekler görsel anlatım için uyarlanmıştır',
    mapEarth: 'DÜNYA', mapMoon: 'AY', mapOut: 'GİDİŞ', mapRet: 'DÖNÜŞ',
    tMore: 'Ayrıntı', tLess: 'Daha az',
    flow: 'GÖREV AKIŞI', scenes: '/ 10 SAHNE',
    discFull: '3 Ekim 2026 raporu · T+ günleri temsili senaryo; kesin uçuş takvimi, iniş aracı ve yörünge henüz belirlenmiş değil.',
    discShort: 'Temsili senaryo · 3 Ekim 2026 raporu',
    timelineAria: 'Görev zaman çizelgesi', chaptersAria: 'Görev aşamaları',
    reset: 'T+0’a dön', resetAria: 'Başa al',
    play: 'Oynat', pause: 'Duraklat',
    speedLbl: 'Hız', speedAria: 'Oynatma hızı',
    more: 'Diğer kontroller',
    camera: 'Kamera', cameraAria: 'Kamera modu', cinematic: 'Sinematik', free: 'Serbest',
    views: ['Standart', 'Uzak', 'Yakın'], viewTitle: 'Kamera açısını değiştir (Standart · Uzak · Yakın)', viewAria: 'Kamera açısı: {0}',
    viewFreeTitle: 'Serbest kamerada açı değiştirilemez · Sinematik moda geç', viewFreeToast: 'Serbest kamerada açı değişmez · Kamera menüsünden Sinematik’i seç',
    quality: 'Kalite', qualityAria: 'Görüntü kalitesi', qLow: 'Düşük', qMedium: 'Orta', qHigh: 'Yüksek',
    labels: 'Etiketler', labelsTitle: 'Sahne etiketleri (L)', labelsOn: 'Etiketler açık', labelsOff: 'Etiketler kapalı',
    sound: 'Ses', soundTitle: 'Ses (M)', soundOff: 'Ses kapalı',
    capture: 'Görüntüyü PNG olarak kaydet', captured: '3D sahne PNG olarak kaydedildi.',
    fsTitle: 'Tam ekran (F)', fsUnsupported: 'Bu tarayıcı tam ekranı desteklemiyor.',
    show: 'Arayüzü göster · H',
    caveat: 'TEMSİLİ GÖRSELLEŞTİRME · gerçek görüntü değildir',
    endKicker: 'GÖREV TAMAMLANDI · T+20 GÜN (TEMSİLİ)',
    endLine: 'Bir yolculuk. Yeni bir başlangıç.',
    replay: 'Yeniden izle', endReport: 'Rapor',
    endCav: 'Temsili görselleştirme · 3 Ekim 2026 raporuna dayalıdır; araçlar, rotalar ve T+ günleri temsilidir.',
    dossier: 'GÖREV DOSYASI / ARTEMIS IV', closeReport: 'Raporu kapat',
    rTitle: 'Rapordan sahneye.',
    rLead: 'Bu deneyim, <b>3 Ekim 2026 Artemis IV araştırma raporunun</b> T+ görev sırasını görselleştirir. T+0, SLS/Orion fırlatma anıdır. Yaklaşık 21 günlük temsili görev, 3 dakika 4 saniyelik bir anlatıma sıkıştırılmıştır; zaman ölçeği sahneye göre değişir.',
    rMissionH: 'Açıklanan görev',
    rMission: '4 astronot Orion ile yola çıkar, 2 kişi güney kutup bölgesine iner, ekip yörüngede birleşir ve Orion Pasifik’e döner.',
    rChoicesH: 'Görselleştirme tercihleri',
    rChoices: 'Araç geometrileri, uçuş rotaları, kademe ayrılma anları, iniş alanı, yüzey yürüyüşleri ve T+ günlerinin yerleşimi temsilidir. HLS genel bir iniş aracı olarak gösterilir; SpaceX veya Blue Origin seçimi yapılmaz. DUSTER ve SPSS geliştirilmek için seçilen aday bilim yükleridir; kesin uçuş manifestosu değildir. Gateway durağı eklenmemiştir.',
    rRaw: 'Ham rapor metni ↗', rDraft: 'Ön görev taslağı ↗', rPayloads: 'Bilim yükleri ↗',
    rFull: 'Tam araştırma raporunu burada oku', rLoading: 'Rapor yükleniyor…',
    rFail: 'Rapor yüklenemedi. “Ham rapor metni” bağlantısını kullan.',
    rKeys: 'Kontroller ve kısayollar için <kbd>?</kbd> tuşuna bas veya üstteki yardım düğmesini kullan.',
    reportFile: 'rapor.md',
    controls: 'KONTROLLER', closeHelp: 'Kontroller penceresini kapat', shortcuts: 'Kısayollar',
    kPlay: 'Oynat / duraklat', kSeek: '2 saniye geri / ileri', kScene: 'Sahneye git (0 = 10. sahne)', kCinema: 'Sinema modu (Esc ile çık)',
    kHide: 'Arayüzü gizle / göster', kFs: 'Tam ekran', kSound: 'Sesi aç / kapat', kLabels: 'Sahne etiketleri', kPerf: 'Performans göstergesi',
    kHelp: 'Bu pencere', kEsc: 'Pencereyi kapat / sinema modundan çık', kLang: 'Dili değiştir (EN / TR)',
    helpFoot: 'Serbest kamera: sol sürükle döndür · tekerlek yaklaş · sağ sürükle kaydır<br>Dokunmatik: sürükle döndür · iki parmakla yakınlaştır ve kaydır. Zaman çizelgesine dokunarak sahneler arasında gezin.',
    sceneTitle: '{0} · sahne {1} ({2})', sceneAria: 'Sahne {0}: {1}', announce: 'Sahne {0} / {1}: {2}. {3}',
    cert0: 'GÖREV AKIŞI RAPORA DAYALI · TEMSİLİ', certN: 'T+ GÜNLERİ VE AYRINTILAR TEMSİLİ',
    cinemaToastTouch: 'Sinema modu · çıkmak için dokun', cinemaToast: 'Sinema modu · çıkmak için C veya Esc',
    adapted: 'uyarlanan',
    langSwitched: 'Dil: Türkçe',
    crewLoc: ['Orion (SLS üzerinde)', 'Orion', 'Orion', 'Orion + HLS', 'HLS (2) · Orion (2)', 'Yüzey (2) · Orion (2)', 'HLS → Orion', 'Orion', 'Orion kapsülü', 'Kapsül → kurtarma gemisi'],
    bootFail: 'Başlatılamadı', bootFailMsg: 'Sayfayı yenile; sorun sürerse donanım hızlandırması açık güncel bir tarayıcıda dene.',
    webglFail: 'WebGL açılamadı', webglFailMsg: 'Donanım hızlandırması açık bir tarayıcıda yeniden aç.',
    lLight: 'Işık ve görüntü zinciri', lPad: 'Fırlatma kompleksi', lEarth: 'Dünya', lMoon: 'Ay ve transfer', lDock: 'Kenetlenme', lSurface: 'Ay yüzeyi',
    lProps: 'Yüzey nesneleri', lReturn: 'Dönüş', lEntry: 'Atmosfer girişi', lPacific: 'Pasifik', lTex: 'Dokular yüklendi',
    lCompile: 'Gölgelendiriciler derleniyor · ilk açılışta ~15 sn sürebilir', lScene: 'Sahne hazırlanıyor · {0}/{1}',
    qApplying: 'Kalite ayarı uygulanıyor…', qDropped: 'Akıcılık için kalite düşürüldü: {0}', qRes: 'Akıcılık için görüntü çözünürlüğü uyarlandı.',
    qNames: { low: 'düşük', medium: 'orta' }
  }
};

export const getLang = () => lang;
export const L = (en, tr) => ({ en, tr });
export const tx = v => (v && typeof v === 'object' && 'en' in v ? v[lang] ?? v.en : v);
export function t(key, ...args) {
  const s = STR[lang][key] ?? STR.en[key] ?? key;
  return args.length ? s.replace(/\{(\d)\}/g, (_, i) => args[i]) : s;
}
export function num(x, digits = 1) {
  const s = x.toFixed(digits);
  return lang === 'tr' ? s.replace('.', ',') : s;
}
export const int = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'tr' ? '.' : ',');

export function applyDom(root = document) {
  document.documentElement.lang = lang;
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-html]')) n.innerHTML = t(n.dataset.i18nHtml);   // static strings from STR only
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  for (const n of root.querySelectorAll('.langBtn')) n.querySelectorAll('[data-l]').forEach(s => s.classList.toggle('on', s.dataset.l === lang));
}
export function onLang(fn) { listeners.push(fn); }
export function setLang(l) {
  if (!LANGS.includes(l) || l === lang) return;
  lang = l; store.set('a4.lang', l);
  if (fromUrl) { const u = new URL(location.href); u.searchParams.set('lang', l); history.replaceState(null, '', u); }
  applyDom();
  for (const fn of listeners) fn(l);
}
export const toggleLang = () => setLang(lang === 'en' ? 'tr' : 'en');
