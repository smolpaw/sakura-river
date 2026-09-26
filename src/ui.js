import { create } from './main.js';

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var keys = ['wind', 'petals', 'river', 'time', 'fog', 'bloom'];
  var engine = null;
  function clock(v) {
    var m = Math.round((5 + 14 * v / 100) * 60), hh = Math.floor(m / 60), mm = m % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function show(k) { var v = +$('s-' + k).value; $('v-' + k).textContent = k === 'time' ? clock(v) : String(v); }
  keys.forEach(function (k) {
    show(k);
    $('s-' + k).addEventListener('input', function () { show(k); if (engine) engine.set(k, +this.value / 100); });
  });
  function setPressed(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }

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
    try {
      engine = create($('scene'), {
        onStats: function (s) { $('stats').textContent = s.fps + ' fps · ' + s.quality; },
        onCinematicChange: function (on) { setPressed($('btn-cine'), on); },
      });
      keys.forEach(function (k) { engine.setImmediate(k, +$('s-' + k).value / 100); });
      $('veil').classList.add('done');
    } catch (e) {
      $('veil-text').textContent = 'This device could not start WebGL. Try a desktop browser with hardware acceleration on.';
    }
  }
  // let the veil paint before the procedural build
  requestAnimationFrame(function () { setTimeout(start, 30); });
})();
