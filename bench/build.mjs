// Build the engine as one ES module for the bench harness.
//   node bench/build.mjs <label> [git-ref]
// Without a ref it builds the working tree. With a ref it builds that commit from a git worktree in bench/.wt/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { BENCH } from './lib/serve.mjs';

const ROOT = path.resolve(BENCH, '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

export async function buildEngine(label, ref) {
  let root = ROOT, sha = git('rev-parse', 'HEAD'), dirty = git('status', '--porcelain', '--', 'src', 'package.json').length > 0;
  if (ref) {
    sha = git('rev-parse', ref);
    dirty = false;
    root = path.join(BENCH, '.wt', sha.slice(0, 12));
    if (!fs.existsSync(root)) {
      git('worktree', 'add', '--detach', root, sha);
      execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
    }
  }
  const outDir = path.join(BENCH, 'builds', label);
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir, emptyOutDir: true, target: 'es2022', minify: true, reportCompressedSize: false,
      lib: { entry: path.join(root, 'src/main.js'), formats: ['es'], fileName: () => 'engine.js' },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/three/package.json'), 'utf8'));
  const meta = { label, ref: ref || 'WORKTREE', sha, dirty, three: pkg.version, builtAt: new Date().toISOString(), bytes: fs.statSync(path.join(outDir, 'engine.js')).size };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [label, ref] = process.argv.slice(2);
  if (!label) { console.error('usage: node bench/build.mjs <label> [git-ref]'); process.exit(1); }
  console.log(await buildEngine(label, ref));
}
