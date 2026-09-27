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
  var wi = 0; // clear
  function showWeather() { $('w-kanji').textContent = WEATHERS[wi].kanji; $('w-name').textContent = WEATHERS[wi].name; }
  function pickWeather(i) {
    wi = (i + WEATHERS.length) % WEATHERS.length;
    showWeather();
    if (engine) engine.setWeather(WEATHERS[wi].id, 6);
  }
  showWeather();
  $('w-prev').addEventListener('click', function () { pickWeather(wi - 1); });
  $('w-next').addEventListener('click', function () { pickWeather(wi + 1); });
  $('w-random').addEventListener('click', function () { pickWeather(wi + 1 + Math.floor(Math.random() * (WEATHERS.length - 1))); });

  // ---------- time of day ----------
  TIMES.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = t.name;
    b.addEventListener('click', function () { if (engine) engine.setTimeOfDay(t.hour); });
    $('times').appendChild(b);
  });
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
      hour: TIMES.find(function (t) { return t.id === 'night'; }).hour, // open on a clear night
      onStats: function (s) { $('stats').textContent = s.fps + ' fps'; },
      onCinematicChange: function (on) { setPressed($('btn-cine'), on); },
      onReady: function (r) { if (!fixed) $('quality').options[0].textContent = 'Auto · ' + r.quality; },
    }).then(function (e) {
      engine = e;
      engine.setWeather(WEATHERS[wi].id, 0);
      engine.setClockRunning($('t-run').getAttribute('aria-pressed') === 'true');
      $('clock').textContent = clock(engine.timeOfDay());
      setInterval(function () { $('clock').textContent = clock(engine.timeOfDay()); }, 250);
      $('veil').classList.add('done');
    }).catch(function () {
      $('veil-text').textContent = 'This device could not start WebGL. Try a desktop browser with hardware acceleration on.';
    });
  }
  // let the veil paint before the procedural build
  requestAnimationFrame(function () { setTimeout(start, 30); });
})();
