import { create } from './main.js';
import { WEATHERS, TIMES } from './weather.js';

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var engine = null;
  // the chosen quality survives the reload; storage can be unavailable (private mode, blocked site data)
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function setPressed(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  // reduced motion: no opening flight, the time cut to rather than run as a time-lapse, weather blended in quickly
  var still = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // ---------- the link: the time, the weather and the view in the URL's hash ----------
  // #t=<hour>&w=<weather>&v=<x,y,z,tx,ty,tz> (the camera and what it looks at, m), or &walk=<x,z,yaw,pitch> (m, degrees)
  // in walk mode. A page opened from one starts there; anything not understood is left out.
  var NIGHT = TIMES.find(function (t) { return t.id === 'night'; }).hour;
  function nums(v, n, max) {
    var a = (v || '').split(',').map(Number);
    return a.length === n && a.every(function (x) { return isFinite(x) && Math.abs(x) <= max; }) && String(v).trim() !== '' ? a : null;
  }
  var link = (function () {
    var q = {};
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) { try { q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* malformed */ } }
    });
    var out = {}, t = q.t === undefined || q.t === '' ? NaN : +q.t, v = nums(q.v, 6, 5000), wk = nums(q.walk, 4, 5000);
    if (isFinite(t) && t >= 0 && t <= 24) out.hour = t % 24;
    if (WEATHERS.some(function (x) { return x.id === q.w; })) out.weather = q.w;
    if (v) out.view = { pos: v.slice(0, 3), target: v.slice(3) };
    else if (wk) out.view = { walk: [wk[0], wk[1], wk[2] * Math.PI / 180, wk[3] * Math.PI / 180] };
    return out;
  })();
  var r1 = function (x) { return Math.round(x * 10) / 10; };
  // the scene's state as a hash; '' at the default (night, clear, the opening view)
  function hashNow() {
    var h = Math.round(engine.timeOfDay() * 100) / 100 % 24, v = engine.view(), w = WEATHERS[wi].id;
    if (h === NIGHT && w === 'clear' && v.home) return '';
    var out = '#t=' + h + '&w=' + w;
    if (v.walk) out += '&walk=' + [r1(v.walk[0]), r1(v.walk[1]), Math.round(v.walk[2] * 180 / Math.PI), Math.round(v.walk[3] * 180 / Math.PI)].join(',');
    else out += '&v=' + v.pos.concat(v.target).map(r1).join(',');
    return out;
  }
  function urlWith(hash) { return location.href.replace(/#.*$/, '') + hash; }
  // written as the scene changes, replacing the address (no history entries): once things have been still for 0.6 s,
  // and at least every 2 s while they keep moving (a time-lapse, the cinematic flight, auto-orbit); not during a
  // flight between views, which ends at one
  var written = location.hash, linkDue = 0, linkFirst = 0;
  function writeLink(hash) {
    written = hash;
    try { history.replaceState(history.state, '', urlWith(hash)); } catch (e) { /* e.g. a sandboxed frame */ }
  }
  function watchLink() {
    if (!engine || engine.view().flying) return;
    var hash = hashNow(), now = performance.now();
    if (hash === written) { linkDue = linkFirst = 0; return; }
    if (!linkFirst) linkFirst = now;
    if (linkDue && now < linkDue && now - linkFirst < 2000) return;
    if (!linkDue) { linkDue = now + 600; return; }
    linkDue = linkFirst = 0;
    writeLink(hash);
  }

  // ---------- weather ----------
  var wi = WEATHERS.findIndex(function (w) { return w.id === (link.weather || 'clear'); }); // opens in clear weather, or the link's
  var wBtns = WEATHERS.map(function (w, i) {
    var b = document.createElement('button');
    b.type = 'button'; b.title = w.name; b.setAttribute('aria-label', w.name);
    b.innerHTML = '<b lang="ja"></b>'; b.firstChild.textContent = w.kanji;
    b.addEventListener('click', function () { pickWeather(i); });
    $('weathers').appendChild(b);
    return b;
  });
  function showWeather() {
    $('w-name').textContent = WEATHERS[wi].name;
    wBtns.forEach(function (b, i) { setPressed(b, i === wi); });
  }
  function pickWeather(i) {
    wi = i;
    showWeather();
    if (engine) engine.setWeather(WEATHERS[wi].id, still.matches ? 1 : 6);
  }
  showWeather();
  $('w-random').addEventListener('click', function () { pickWeather((wi + 1 + Math.floor(Math.random() * (WEATHERS.length - 1))) % WEATHERS.length); });

  // ---------- time of day: fixed (no ticking clock); a preset moves there as a time-lapse, the slider follows ----------
  var day = $('t-day'), dragged = null; // the slider's hour while it is being moved, shown instead of the scene's
  function lapseTo(h) { engine.setTimeOfDay(h, !still.matches); day.value = h; showTime(); }
  var tBtns = TIMES.map(function (t) {
    var b = document.createElement('button');
    b.type = 'button'; b.setAttribute('aria-label', t.name);
    b.innerHTML = '<b lang="ja"></b><span></span>'; b.firstChild.textContent = t.kanji; b.lastChild.textContent = t.name;
    b.addEventListener('click', function () { if (engine) lapseTo(t.hour); });
    $('times').appendChild(b);
    return b;
  });
  // a random half hour at least two hours from now, reached like a preset (forward, through the night if need be)
  $('t-random').addEventListener('click', function () {
    if (!engine) return;
    var now = engine.timeOfDay(), h;
    do { h = Math.floor(Math.random() * 48) / 2; } while (Math.abs(((h - now + 36) % 24) - 12) < 2);
    lapseTo(h);
  });
  // the scene follows the slider as it moves (straight there, back if it is earlier; presets go forward through the
  // night): a time change costs about what a time-lapse's frames do
  day.addEventListener('input', function () { dragged = +this.value; if (engine) engine.followTime(dragged); showTime(); });
  day.addEventListener('change', function () { dragged = null; showTime(); });
  // the keys step it by half hours (Page Up and Down by two hours), onto the half hour (its step is any, so the presets'
  // times sit on it as they are)
  day.addEventListener('keydown', function (e) {
    var d = { ArrowRight: 0.5, ArrowUp: 0.5, ArrowLeft: -0.5, ArrowDown: -0.5, PageUp: 2, PageDown: -2 }[e.key];
    if (!d || !engine) return;
    e.preventDefault();
    var v = +day.value, n = d > 0 ? Math.floor(v / 0.5 + 1e-6) * 0.5 + d : Math.ceil(v / 0.5 - 1e-6) * 0.5 + d;
    day.value = Math.min(+day.max, Math.max(+day.min, n));
    engine.followTime(+day.value);
    showTime();
  });
  // the period the clock is in (the preset whose button shows pressed): dawn 04:30-09:00, day to 17:00, dusk to 19:30,
  // then night
  function period(h) { return h >= 4.5 && h < 9 ? 'dawn' : h >= 9 && h < 17 ? 'afternoon' : h >= 17 && h < 19.5 ? 'dusk' : 'night'; }
  function showTime() {
    if (!engine) return;
    var h = engine.timeOfDay(), p = period(h);
    var waiting = engine.soundWaiting();
    if (waiting !== $('btn-sound').classList.contains('waiting')) {
      $('btn-sound').classList.toggle('waiting', waiting);
      $('btn-sound').title = waiting ? 'Click or tap anywhere to start the sound' : 'Music and ambience';
    }
    $('clock').textContent = clock(dragged !== null ? dragged : h);
    var vt = clock(+day.value);
    if (day.getAttribute('aria-valuetext') !== vt) day.setAttribute('aria-valuetext', vt);
    tBtns.forEach(function (b, i) { setPressed(b, TIMES[i].id === p); });
  }
  function clock(h) {
    var m = Math.floor(h * 60) % 1440, hh = Math.floor(m / 60), mm = m % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  // ---------- sound: on unless muted before; it starts with the first click or key press ----------
  var soundOn = load('sr.sound') !== 'off';
  var vols = { music: +(load('sr.vol.music') || 0.75), nature: +(load('sr.vol.nature') || 0.4) };
  function showSound() {
    setPressed($('btn-sound'), soundOn);
    $('btn-sound').setAttribute('aria-label', soundOn ? 'Mute sound' : 'Turn sound on');
    document.body.classList.toggle('muted', !soundOn);
  }
  showSound();
  $('btn-sound').addEventListener('click', function () {
    // while the browser holds sound back, this click is the one that starts it
    if (this.classList.contains('waiting')) { this.classList.remove('waiting'); return; }
    soundOn = !soundOn;
    save('sr.sound', soundOn ? 'on' : 'off');
    showSound();
    if (engine) engine.setSound(soundOn);
  });
  ['music', 'nature'].forEach(function (k) {
    var input = $('v-' + k);
    function fill() { input.style.setProperty('--v', (input.value * 100) + '%'); }
    input.value = vols[k]; fill();
    input.addEventListener('input', function () {
      vols[k] = +this.value; fill();
      save('sr.vol.' + k, this.value);
      if (engine) engine.setVolume(k, vols[k]);
      // moving a slider while muted turns sound on
      if (!soundOn) $('btn-sound').click();
    });
  });

  // ---------- quality: a fixed tier, or auto (detected tier + adaptive resolution); changing it reloads ----------
  var quality = load('sr.quality');
  if (['ultra', 'high', 'medium', 'low'].indexOf(quality) < 0) quality = 'auto';
  // Auto's starting tier when the page found the detected one too slow here (the notice's Switch to Low); a choice in
  // the menu clears it
  var autoTier = quality === 'auto' && load('sr.autoTier') === 'low' ? 'low' : null;
  $('quality').value = quality;
  $('quality').addEventListener('change', function () { save('sr.quality', this.value); save('sr.autoTier', ''); location.reload(); });

  // ---------- frame rate: Auto (60, or 30 before the device would lose detail), 60 or 30; no reload ----------
  var rate = load('sr.rate');
  if (['60', '30'].indexOf(rate) < 0) rate = 'auto';
  $('rate').value = rate;
  $('rate').addEventListener('change', function () {
    rate = this.value; save('sr.rate', rate);
    if (rate !== 'auto') $('rate').options[0].textContent = 'Auto'; // (the rate Auto runs at shows while it is chosen)
    if (engine) engine.setFrameRate(rate);
  });

  // ---------- camera ----------
  $('btn-cine').addEventListener('click', function () {
    var on = this.getAttribute('aria-pressed') !== 'true';
    setPressed(this, on); if (engine) engine.setCinematic(on);
  });
  $('btn-orbit').addEventListener('click', function () {
    var on = this.getAttribute('aria-pressed') !== 'true';
    setPressed(this, on); if (engine) engine.setAutoOrbit(on);
  });
  $('btn-reset').addEventListener('click', function () {
    setPressed($('btn-cine'), false); if (engine) engine.resetCamera();
  });
  // walk mode: first person along the lanes (the Walk button, Reset view or a second Esc leave it); a hint on the
  // controls fades a few seconds after it starts
  var walking = false, hintTimer = 0, hint = $('walk-hint');
  if (window.matchMedia && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) {
    hint.textContent = 'Left thumb walk · right thumb look';
  }
  $('btn-walk').addEventListener('click', function () {
    var on = this.getAttribute('aria-pressed') !== 'true';
    if (engine) engine.setWalk(on);
    if (on) this.blur(); // the keys walk rather than press the button again
  });
  function showWalk(on) {
    walking = on;
    setPressed($('btn-walk'), on);
    if (on) { setPressed($('btn-cine'), false); setPressed($('btn-orbit'), false); }
    clearTimeout(hintTimer);
    hint.classList.toggle('show', on);
    if (on) hintTimer = setTimeout(function () { hint.classList.remove('show'); }, 5000);
  }
  var fullBtn = $('btn-full');
  var canFull = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  if (!canFull) fullBtn.hidden = true;
  fullBtn.addEventListener('click', function () {
    var d = document, el = d.documentElement;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); }
      else {
        var p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        if (p && p.catch) p.catch(function () { fullBtn.hidden = true; });
      }
    } catch (e) { fullBtn.hidden = true; }
  });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (t) {
    document.addEventListener(t, function () {
      var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      fullBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Enter full screen');
      fullBtn.title = on ? 'Exit full screen' : 'Full screen';
    });
  });

  // ---------- the controls fade out after a few seconds without activity ----------
  var idleTimer = 0, mouse = false;
  function idle() {
    // stay while the mouse rests on a control or keyboard focus is in one
    if ((mouse && document.querySelector('.side:hover, .top-right:hover, .credits:hover')) ||
        document.querySelector('.side :focus-visible, .top-right :focus-visible, .credits:focus-visible')) return wake();
    document.body.classList.add('ui-idle');
  }
  function wake(e) {
    // walking (keys held, the mouse looking round under pointer lock) is not activity on the controls
    if (walking && e && (e.type === 'keydown' || (e.type === 'pointermove' && document.pointerLockElement))) return;
    if (e && e.pointerType) mouse = e.pointerType === 'mouse'; // a tapped control keeps :hover on touch screens
    document.body.classList.remove('ui-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(idle, 3500);
  }
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(function (t) {
    window.addEventListener(t, wake, { capture: true, passive: true });
  });

  // a link pasted over this page's own address changes only the hash: open it
  window.addEventListener('hashchange', function () { if (location.hash !== written) location.reload(); });

  // ---------- copy link ----------
  var toastTimer = 0;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  $('btn-link').addEventListener('click', function () {
    if (!engine) return;
    var hash = hashNow();
    linkDue = linkFirst = 0;
    if (hash !== written) writeLink(hash);
    var url = urlWith(hash);
    function fallback() {
      // (no clipboard API: an insecure context, or permission refused)
      var ta = document.createElement('textarea'), ok = false;
      ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { /* unsupported */ }
      ta.remove();
      toast(ok ? 'Link copied' : 'Copy the address bar to share this view');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { toast('Link copied'); }, fallback);
    else fallback();
  });

  // ---------- photo mode: every control hidden (H or the button; H again, Esc or the corner's button bring them back) ----------
  var photoTimer = 0;
  function photoAwake() {
    // the way back shows for a while after any touch or movement, then fades
    document.body.classList.remove('photo-quiet');
    clearTimeout(photoTimer);
    photoTimer = setTimeout(function () { document.body.classList.add('photo-quiet'); }, 2500);
  }
  function setPhoto(on) {
    if (on === document.body.classList.contains('photo')) return;
    document.body.classList.toggle('photo', on);
    setPressed($('btn-photo'), on);
    if (on) { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); photoAwake(); }
    else { clearTimeout(photoTimer); document.body.classList.remove('photo-quiet'); wake(); }
  }
  $('btn-photo').addEventListener('click', function () { setPhoto(true); });
  $('photo-exit').addEventListener('click', function () { setPhoto(false); $('btn-photo').focus({ preventScroll: true }); });
  ['pointermove', 'pointerdown'].forEach(function (t) {
    window.addEventListener(t, function () { if (document.body.classList.contains('photo')) photoAwake(); }, { capture: true, passive: true });
  });
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    var el = e.target, tag = el && el.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && el.type !== 'range') || (el && el.isContentEditable)) return;
    var photo = document.body.classList.contains('photo');
    if (e.code === 'KeyH') setPhoto(!photo);
    // (walking, Esc frees the mouse and then leaves the walk: walk.js)
    else if (e.key === 'Escape' && photo && !walking) setPhoto(false);
  });

  // ---------- loading, failure and how it runs ----------
  // the WebGL2 renderer when the page offers it after WebGPU failed here; for this tab's session only
  var backend = null;
  try { backend = sessionStorage.getItem('sr.backend'); } catch (e) { /* ignore */ }
  var tier = quality === 'auto' ? null : quality, using = null; // the tier and the backend in use, once known
  var failed = false;
  var STAGES = { generate: 'Shaping the valley', build: 'Growing the blossoms', shaders: 'Preparing the shaders', warm: 'Almost there' };
  var stage = null, stageAt = 0, stageF = null;
  // (written only when they change: the veil is a live region, which announces the stage's name but not its percentage
  // or the seconds, both aria-hidden)
  function put(el, text) { if (el.textContent !== text) el.textContent = text; }
  function showStage() {
    if (failed || !stage) return;
    put($('veil-stage'), STAGES[stage] + '…');
    put($('veil-pct'), stageF !== null ? ' ' + Math.round(stageF * 100) + '%' : '');
    // a slow device spends long on a stage: say it is still working
    var s = (performance.now() - stageAt) / 1000, sub = $('veil-sub');
    if (s <= 12) put(sub, '');
    else {
      if (!sub.firstElementChild) sub.innerHTML = '<span aria-hidden="true"></span>this takes longer on slower devices';
      put(sub.firstElementChild, Math.round(s) + ' s · ');
    }
  }
  var stageTimer = setInterval(showStage, 1000);
  function act(label, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = label;
    b.addEventListener('click', fn);
    $('veil-actions').appendChild(b);
  }
  function reloadWith(q, be) {
    if (q) save('sr.quality', q);
    try { if (be) sessionStorage.setItem('sr.backend', be); else sessionStorage.removeItem('sr.backend'); } catch (e) { /* ignore */ }
    location.reload();
  }
  // the scene can't start or has stopped: say why, and what may still work here (`opts.detail`: the error's own
  // words, smaller, under the plain sentence)
  function fail(title, text, opts) {
    if (failed) return;
    failed = true;
    clearInterval(stageTimer);
    var veil = $('veil');
    veil.classList.remove('done'); veil.classList.add('failed');
    veil.setAttribute('role', 'alert');
    $('veil-text').textContent = title;
    $('veil-sub').textContent = text;
    $('veil-detail').textContent = opts.detail || '';
    $('veil-detail').hidden = !opts.detail;
    $('veil-actions').textContent = '';
    if (opts.low && tier !== 'low') act('Try Low quality', function () { reloadWith('low', backend); });
    if (opts.webgl && using === 'webgpu') act('Try the WebGL renderer', function () { reloadWith(null, 'webgl'); });
    act('Reload', function () { location.reload(); });
  }
  function lost(info) {
    var low = tier === 'low';
    console.error('Sakura River stopped: ' + (info && info.message));
    fail(engine ? 'The graphics device stopped' : 'The graphics device gave up while preparing the scene',
      'The browser reset the graphics chip, which usually means it ran out of graphics memory or a frame took too long. ' +
      (low ? 'Low quality is the lightest the scene gets, so this device may not be able to show it.' : 'Low quality needs much less.'),
      { low: true, webgl: true });
  }
  // after the scene shows: if it stays very slow with nothing left to lower, say so (a hand-picked tier above Low is
  // the visitor's choice, however slow it runs)
  var slowSince = 0, noticed = false;
  function watchSpeed(s) {
    if (!engine || failed || noticed) return;
    var lowest = s.quality === 'low';
    if (!lowest && quality !== 'auto') return;
    // (under half of it, lowering the resolution can't close the gap: no need to wait for the controller's floor, which
    // takes minutes at a few frames a second)
    var limit = lowest ? 15 : 20, slow = s.fps < limit && (s.floor || s.fps < limit / 2);
    if (!slow) { slowSince = 0; return; }
    if (!slowSince) { slowSince = performance.now(); return; }
    if (performance.now() - slowSince < 8000) return;
    noticed = true;
    $('notice-text').textContent = lowest
      ? 'This device is below what the scene needs, even on Low quality (' + s.fps + ' fps). It keeps running, slowly.'
      : 'Running slowly here (' + s.fps + ' fps). Low quality may run smoother.';
    $('notice-low').hidden = lowest;
    $('notice').hidden = false;
  }
  // (Auto starting on Low, not Low fixed: Auto at its floor already draws fewer pixels than fixed Low would)
  $('notice-low').addEventListener('click', function () { save('sr.autoTier', 'low'); location.reload(); });
  $('notice-close').addEventListener('click', function () { $('notice').hidden = true; });

  // The service worker (src/sw.js, put into the build by vite.plugins.mjs) keeps the files from public/, so a repeat
  // visit fetches only the page. Registered once the scene shows: its first fill comes from the browser's cache.
  function keepFiles() {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('sw.js').catch(function (err) { console.warn('service worker not registered:', err && err.message); });
  }

  function start() {
    var fixed = quality !== 'auto';
    create($('scene'), {
      quality: fixed ? quality : autoTier || undefined,
      fixedQuality: fixed,
      backend: backend === 'webgl' ? 'webgl' : undefined,
      frameRate: rate,
      hour: link.hour !== undefined ? link.hour : NIGHT, // open at night, or at the link's time
      view: link.view, // the link's view, flown into briefly
      introDuration: still.matches ? 0 : undefined,
      onProgress: function (p) {
        tier = p.quality; using = p.backend;
        if (p.stage !== stage) { stage = p.stage; stageAt = performance.now(); }
        stageF = p.f;
        showStage();
      },
      onStats: function (s) { // shown only when the frame rate drops below its cap, 60 or 30 (within 2 is jitter)
        var el = $('stats');
        el.hidden = s.fps >= s.rate - 2;
        if (!el.hidden) el.textContent = s.fps + ' fps';
        var auto = $('rate').options[0], label = 'Auto · ' + s.rate + ' fps';
        if (rate === 'auto' && auto.textContent !== label) auto.textContent = label;
        watchSpeed(s);
      },
      onLost: lost,
      onCinematicChange: function (on) { setPressed($('btn-cine'), on); },
      onWalkChange: showWalk,
      onReady: function (r) {
        tier = r.quality;
        if (!fixed) $('quality').options[0].textContent = 'Auto · ' + r.quality.charAt(0).toUpperCase() + r.quality.slice(1);
      },
    }).then(function (e) {
      if (failed) { try { e.dispose(); } catch (err) { /* the device is gone */ } return; }
      engine = e;
      e.setFrameRate(rate); // (a choice made while it loaded)
      clearInterval(stageTimer);
      engine.setWeather(WEATHERS[wi].id, 0);
      day.value = engine.timeOfDay();
      engine.setVolume('music', vols.music);
      engine.setVolume('nature', vols.nature);
      engine.setSound(soundOn);
      showTime();
      setInterval(function () { showTime(); watchLink(); }, 250);
      $('veil').classList.add('done');
      wake();
      keepFiles();
    }).catch(function (err) {
      console.error(err);
      if (err && err.code === 'unsupported') {
        fail('This browser can’t show the scene',
          'It needs WebGPU or WebGL2. Try a current Chrome, Edge or Safari, and check that hardware acceleration is on in its settings.',
          {});
      } else if (err && err.code === 'stalled') {
        fail('The scene couldn’t start', 'The graphics driver stopped while preparing the scene’s shaders' +
          (using === 'webgpu' ? '. The WebGL renderer may work on this device.' : '.'), { low: true, webgl: true });
      } else {
        fail('The scene couldn’t start', 'Something went wrong while starting the scene.',
          { low: true, webgl: true, detail: String((err && err.message) || err).slice(0, 200) });
      }
    });
  }
  // let the veil paint before the procedural build
  requestAnimationFrame(function () { setTimeout(start, 30); });
})();
