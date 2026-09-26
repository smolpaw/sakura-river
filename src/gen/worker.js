// Generation worker: runs one job per message and transfers the result's buffers back.
import { JOBS } from './jobs.js';
import { packDeep } from './pack.js';

self.onmessage = (e) => {
  const { id, name, args } = e.data;
  try {
    const t0 = performance.now();
    const transfer = new Set();
    const result = packDeep(JOBS[name](args), transfer);
    self.postMessage({ id, result, ms: performance.now() - t0 }, [...transfer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
