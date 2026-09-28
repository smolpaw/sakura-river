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
  var wi = WEATHERS.findIndex(function (w) { return w.id === 'fubuki'; }); // opens in a petal storm
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

  // ---------- time of day ----------
  var tBtns = TIMES.map(function (t) {
    var b = document.createElement('button');
    b.type = 'button'; b.setAttribute('aria-label', t.name);
    b.innerHTML = '<b lang="ja"></b><span></span>'; b.firstChild.textContent = t.kanji; b.lastChild.textContent = t.name;
    b.addEventListener('click', function () { if (engine) engine.setTimeOfDay(t.hour); });
    $('times').appendChild(b);
    return b;
  });
  // the period the clock is in: dawn 04:30-09:00, afternoon to 17:00, dusk to 19:30, then night
  function period(h) { return h >= 4.5 && h < 9 ? 'dawn' : h >= 9 && h < 17 ? 'afternoon' : h >= 17 && h < 19.5 ? 'dusk' : 'night'; }
  function showTime() {
    var h = engine.timeOfDay(), p = period(h);
    var waiting = engine.soundWaiting();
    if (waiting !== $('btn-sound').classList.contains('waiting')) {
      $('btn-sound').classList.toggle('waiting', waiting);
      $('btn-sound').title = waiting ? 'Click anywhere to start the sound' : 'Music and ambience';
    }
    $('clock').textContent = clock(h);
    tBtns.forEach(function (b, i) { setPressed(b, TIMES[i].id === p); });
  }
  function clock(h) {
    var m = Math.floor(h * 60) % 1440, hh = Math.floor(m / 60), mm = m % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  $('t-run').addEventListener('click', function () {
    var on = this.getAttribute('aria-pressed') !== 'true';
    setPressed(this, on);
    this.setAttribute('aria-label', on ? 'Pause the clock' : 'Run the clock');
    if (engine) engine.setClockRunning(on);
  });

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
  if (['high', 'medium', 'low'].indexOf(quality) < 0) quality = 'auto';
  $('quality').value = quality;
  $('quality').addEventListener('change', function () { save('sr.quality', this.value); location.reload(); });

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
  $('btn-ui').addEventListener('click', function () {
    var hide = !document.body.classList.contains('ui-hidden');
    document.body.classList.toggle('ui-hidden', hide);
    setPressed(this, hide);
    this.setAttribute('aria-label', hide ? 'Show controls' : 'Hide controls');
  });
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

  function start() {
    var fixed = quality !== 'auto';
    create($('scene'), {
      quality: fixed ? quality : undefined,
      fixedQuality: fixed,
      hour: TIMES.find(function (t) { return t.id === 'night'; }).hour, // open at night
      onStats: function (s) { // shown only when the capped 60 fps drops (58+ is jitter)
        var el = $('stats');
        el.hidden = s.fps >= 58;
        if (!el.hidden) el.textContent = s.fps + ' fps';
      },
      onCinematicChange: function (on) { setPressed($('btn-cine'), on); },
      onReady: function (r) { if (!fixed) $('quality').options[0].textContent = 'Auto · ' + r.quality; },
    }).then(function (e) {
      engine = e;
      engine.setWeather(WEATHERS[wi].id, 0);
      engine.setClockRunning($('t-run').getAttribute('aria-pressed') === 'true');
      engine.setVolume('music', vols.music);
      engine.setVolume('nature', vols.nature);
      engine.setSound(soundOn);
      showTime();
      setInterval(showTime, 250);
      $('veil').classList.add('done');
    }).catch(function () {
      $('veil-text').textContent = 'This device could not start WebGL. Try a desktop browser with hardware acceleration on.';
    });
  }
  // let the veil paint before the procedural build
  requestAnimationFrame(function () { setTimeout(start, 30); });
})();
