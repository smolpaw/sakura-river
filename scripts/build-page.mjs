// Inline the bundled engine into the page template -> dist/sakura-river.html (single self-contained file).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tpl = readFileSync(join(root, 'page/template.html'), 'utf8');
const engine = readFileSync(join(root, 'dist/sakura.js'), 'utf8');
if (engine.includes('</script')) throw new Error('engine bundle contains </script and cannot be inlined');
writeFileSync(join(root, 'dist/sakura-river.html'), tpl.replace('/*__ENGINE__*/', () => engine));
console.log('built dist/sakura-river.html');
