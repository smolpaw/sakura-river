// Runs generation jobs on a small pool of inline workers, longest job first.
// Falls back to the main thread (one job per task) when workers are unavailable.
import GenWorker from './worker.js?worker&inline';
import { JOBS, COST } from './jobs.js';
import { packDeep, unpackDeep } from './pack.js';

function spawn() {
  try { return new GenWorker(); } catch (e) { return null; }
}

// jobs: { key: { name, args } } -> Promise<{ results: { key: data }, stats }>
export async function runJobs(jobs, { workers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)), mainThread = false } = {}) {
  const t0 = performance.now();
  const queue = Object.entries(jobs).sort((a, b) => (COST[b[1].name] || 1) - (COST[a[1].name] || 1));
  const results = {}, timing = {};
  const pool = mainThread ? [] : Array.from({ length: Math.min(workers, queue.length) }, spawn).filter(Boolean);
  if (!pool.length) {
    for (const [key, j] of queue) {
      await new Promise((r) => setTimeout(r, 0)); // yield between jobs
      const s = performance.now();
      results[key] = unpackDeep(packDeep(JOBS[j.name](j.args), new Set()));
      timing[key] = performance.now() - s;
    }
    return { results, stats: { workers: 0, ms: performance.now() - t0, timing } };
  }
  let next = 0, id = 0;
  await Promise.all(pool.map((w) => new Promise((resolve, reject) => {
    const pending = new Map();
    const take = () => {
      if (next >= queue.length) { w.terminate(); resolve(); return; }
      const [key, j] = queue[next++];
      const my = id++;
      pending.set(my, key);
      w.postMessage({ id: my, name: j.name, args: j.args });
    };
    w.onmessage = (e) => {
      const key = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (e.data.error) { w.terminate(); reject(new Error(`generation job ${key} failed: ${e.data.error}`)); return; }
      results[key] = unpackDeep(e.data.result);
      timing[key] = e.data.ms;
      take();
    };
    w.onerror = (e) => { w.terminate(); reject(new Error('generation worker error: ' + (e.message || e))); };
    take();
  })));
  return { results, stats: { workers: pool.length, ms: performance.now() - t0, timing } };
}
