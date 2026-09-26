// nvidia-smi helpers: idle-relative contention detection and a clock/throttle logger.
import { execFileSync, spawn } from 'node:child_process';

const smi = (args) => execFileSync('nvidia-smi', args, { encoding: 'utf8' });

// processes listed by plain `nvidia-smi` (graphics + compute; --query-compute-apps misses graphics-only)
export function gpuProcesses() {
  const txt = smi([]);
  const out = [];
  const i = txt.indexOf('Processes:');
  for (const line of txt.slice(i).split('\n')) {
    const m = line.match(/^\|\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(.+?)\s+(\d+)MiB\s*\|$/);
    if (m) out.push({ pid: +m[1], type: m[2], name: m[3].trim(), mib: +m[4] });
  }
  return out;
}

// per-process SM utilisation (one pmon sample)
export function pmon() {
  const txt = smi(['pmon', '-c', '1', '-s', 'u']);
  const out = [];
  for (const line of txt.split('\n')) {
    if (line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    out.push({ pid: +f[1], type: f[2], sm: f[3] === '-' ? 0 : +f[3], mem: f[4] === '-' ? 0 : +f[4], name: f.slice(9).join(' ') });
  }
  return out;
}

export function idleSnapshot() {
  return { at: new Date().toISOString(), procs: gpuProcesses(), pmon: pmon() };
}

const COMPOSITOR = /Hyprland|Xwayland|gnome-shell|kwin|sway|mutter/i;

// contention = a GPU client not in the idle set (and not ours), or a non-own, non-compositor client with real SM load
export function contention(idle, own, { smLimit = 15 } = {}) {
  const idlePids = new Set(idle.procs.map((p) => p.pid));
  const procs = gpuProcesses();
  const fresh = procs.filter((p) => !idlePids.has(p.pid) && !own.has(p.pid));
  const load = [];
  for (let k = 0; k < 3; k++) for (const p of pmon()) if (!own.has(p.pid) && !COMPOSITOR.test(p.name) && p.sm >= smLimit) load.push(p);
  return { busy: fresh.length > 0 || load.length > 0, fresh, load };
}

export function clockState() {
  const [gr, mem, ps, reasons, temp, pw, pl] = smi(['--query-gpu=clocks.gr,clocks.mem,pstate,clocks_event_reasons.active,temperature.gpu,power.draw,power.limit', '--format=csv,noheader,nounits']).trim().split(',').map((s) => s.trim());
  return { gr: +gr, mem: +mem, pstate: ps, reasons: parseInt(reasons, 16), temp: +temp, power: +pw, powerLimit: +pl };
}

// clock-event bits from nvml.h: 0x1 idle, 0x2 app clocks, 0x4 SW power cap, 0x8 HW slowdown, 0x10 sync boost,
// 0x20 SW thermal, 0x40 HW thermal, 0x80 HW power brake, 0x100 display clock. SW power cap is the normal boost
// regulator: without a clock lock the RTX 2060 reports it in ~every sample under load, so it is logged but not
// rejected (the 5% clock-deviation rule covers its effect). Rejected: HW slowdown and the thermal/brake bits.
export const SW_POWER_CAP = 0x4;
export const THROTTLE = 0x8 | 0x20 | 0x40 | 0x80;

export function startLogger(periodMs = 100) {
  const samples = [];
  const p = spawn('nvidia-smi', ['--query-gpu=timestamp,clocks.gr,clocks.mem,pstate,clocks_event_reasons.active,temperature.gpu,power.draw,utilization.gpu', '--format=csv,noheader,nounits', `-lms`, String(periodMs)]);
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const f = line.split(',').map((s) => s.trim());
      if (f.length < 8) continue;
      const t = Date.parse(f[0].replace(/\//g, '-').replace(' ', 'T'));
      samples.push({ t, gr: +f[1], mem: +f[2], pstate: f[3], reasons: parseInt(f[4], 16), temp: +f[5], power: +f[6], util: +f[7] });
    }
  });
  return { samples, stop() { p.kill(); return samples; } };
}

// nearest logger sample for each wall-clock time (ms epoch)
export function nearest(samples, t) {
  let lo = 0, hi = samples.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m].t < t) lo = m + 1; else hi = m; }
  const a = samples[Math.max(0, lo - 1)], b = samples[lo];
  const s = Math.abs(a.t - t) < Math.abs(b.t - t) ? a : b;
  return Math.abs(s.t - t) <= 250 ? s : null;
}
