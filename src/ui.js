import { create } from './main.js';
import { WEATHERS, TIMES } from './weather.js';

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var engine = null;
  // the chosen quality survives the reload; storage can be unavailable (private mode, blocked site data)
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function setPressed(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }

  // ---------- weather ----------
  var wi = WEATHERS.findIndex(function (w) { return w.id === 'clear'; }); // opens in clear weather
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
    if (engine) engine.setWeather(WEATHERS[wi].id, 6);
  }
  showWeather();
  $('w-random').addEventListener('click', function () { pickWeather((wi + 1 + Math.floor(Math.random() * (WEATHERS.length - 1))) % WEATHERS.length); });

  // ---------- time of day: fixed (no ticking clock); a preset or the half-hour slider moves there as a time-lapse ----------
  var day = $('t-day'), dragged = null; // the slider's hour while it is being moved, shown instead of the scene's
  var tBtns = TIMES.map(function (t) {
    var b = document.createElement('button');
    b.type = 'button'; b.setAttribute('aria-label', t.name);
    b.innerHTML = '<b lang="ja"></b><span></span>'; b.firstChild.textContent = t.kanji; b.lastChild.textContent = t.name;
    b.addEventListener('click', function () { if (engine) { engine.setTimeOfDay(t.hour); day.value = t.hour; } });
    $('times').appendChild(b);
    return b;
  });
  // a random half hour at least two hours from now, reached like a preset (forward, through the night if need be)
  $('t-random').addEventListener('click', function () {
    if (!engine) return;
    var now = engine.timeOfDay(), h;
    do { h = Math.floor(Math.random() * 48) / 2; } while (Math.abs(((h - now + 36) % 24) - 12) < 2);
    engine.setTimeOfDay(h); day.value = h;
  });
  day.addEventListener('input', function () { dragged = +this.value; showTime(); });
  // straight to the chosen half hour, back if it is earlier (presets go forward through the night)
  day.addEventListener('change', function () { dragged = null; if (engine) { engine.setTimeOfDay(+this.value, true, false); showTime(); } });
  // the period the clock is in: dawn 04:30-09:00, afternoon to 17:00, dusk to 19:30, then night
  function period(h) { return h >= 4.5 && h < 9 ? 'dawn' : h >= 9 && h < 17 ? 'afternoon' : h >= 17 && h < 19.5 ? 'dusk' : 'night'; }
  function showTime() {
    if (!engine) return;
    var h = engine.timeOfDay(), p = period(h);
    var waiting = engine.soundWaiting();
    if (waiting !== $('btn-sound').classList.contains('waiting')) {
      $('btn-sound').classList.toggle('waiting', waiting);
      $('btn-sound').title = waiting ? 'Click anywhere to start the sound' : 'Music and ambience';
    }
    $('clock').textContent = clock(dragged !== null ? dragged : h);
    day.setAttribute('aria-valuetext', clock(+day.value));
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

  // ---------- frame rate: Auto (60, or 30 when the device needs it to keep its detail), 60 or 30; no reload ----------
  var rate = load('sr.rate');
  if (['60', '30'].indexOf(rate) < 0) rate = 'auto';
  $('rate').value = rate;
  $('rate').addEventListener('change', function () {
    rate = this.value; save('sr.rate', rate);
    if (rate !== 'auto') $('rate').options[0].textContent = 'Auto · fps';
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
  document.addEventListener('fullscreenchange', function () {
    fullBtn.setAttribute('aria-label', document.fullscreenElement ? 'Exit full screen' : 'Enter full screen');
  });

  // ---------- the controls fade out after a few seconds without activity ----------
  var idleTimer = 0, mouse = false;
  function idle() {
    // stay while the mouse rests on a control or keyboard focus is in one
    if ((mouse && document.querySelector('.side:hover, .top-right:hover')) ||
        document.querySelector('.side :focus-visible, .top-right :focus-visible')) return wake();
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

  // ---------- loading, failure and how it runs ----------
  // the WebGL2 renderer when the page offers it after WebGPU failed here; for this tab's session only
  var backend = null;
  try { backend = sessionStorage.getItem('sr.backend'); } catch (e) { /* ignore */ }
  var tier = quality === 'auto' ? null : quality, using = null; // the tier and the backend in use, once known
  var failed = false;
  var STAGES = { generate: 'Shaping the valley', build: 'Growing the blossoms', shaders: 'Preparing the shaders', warm: 'Almost there' };
  var stage = null, stageAt = 0, stageF = null;
  function showStage() {
    if (failed || !stage) return;
    $('veil-text').textContent = STAGES[stage] + '…' + (stageF !== null ? ' ' + Math.round(stageF * 100) + '%' : '');
    // a slow device spends long on a stage: say it is still working
    var s = (performance.now() - stageAt) / 1000;
    $('veil-sub').textContent = s > 12 ? Math.round(s) + ' s · this takes longer on slower devices' : '';
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
  // the scene can't start or has stopped: say why, and what may still work here
  function fail(title, text, opts) {
    if (failed) return;
    failed = true;
    clearInterval(stageTimer);
    var veil = $('veil');
    veil.classList.remove('done'); veil.classList.add('failed');
    veil.setAttribute('role', 'alert');
    $('veil-text').textContent = title;
    $('veil-sub').textContent = text;
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

  function start() {
    var fixed = quality !== 'auto';
    create($('scene'), {
      quality: fixed ? quality : autoTier || undefined,
      fixedQuality: fixed,
      backend: backend === 'webgl' ? 'webgl' : undefined,
      frameRate: rate,
      hour: TIMES.find(function (t) { return t.id === 'night'; }).hour, // open at night
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
      onReady: function (r) { tier = r.quality; if (!fixed) $('quality').options[0].textContent = 'Auto · ' + r.quality; },
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
      setInterval(showTime, 250);
      $('veil').classList.add('done');
      wake();
    }).catch(function (err) {
      console.error(err);
      if (err && err.code === 'unsupported') {
        fail('This browser can’t show the scene',
          'It needs WebGPU or WebGL2 with hardware acceleration. Try a current Chrome, Edge or Safari, with hardware acceleration on in its settings.',
          {});
      } else if (err && err.code === 'stalled') {
        fail('The scene couldn’t start', 'The graphics driver stopped while preparing the scene’s shaders' +
          (using === 'webgpu' ? '. The WebGL renderer may work on this device.' : '.'), { low: true, webgl: true });
      } else {
        fail('The scene couldn’t start', String((err && err.message) || err).slice(0, 200), { low: true, webgl: true });
      }
    });
  }
  // let the veil paint before the procedural build
  requestAnimationFrame(function () { setTimeout(start, 30); });
})();
