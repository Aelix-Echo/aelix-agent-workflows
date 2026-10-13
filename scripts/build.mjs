// Generates workflows/*.json from src/workflows/*.mjs.
// Usage: node scripts/build.mjs           write the JSON files
//        node scripts/build.mjs --check   fail if a committed JSON file is out of date with its source
//        node scripts/build.mjs 03        build only the sources whose file name starts with 03

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'workflows');
const outDir = path.join(root, 'workflows');
const check = process.argv.includes('--check');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
fs.mkdirSync(outDir, { recursive: true });

let stale = 0;
const expected = new Set();
for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs') && (!only.length || only.some((o) => f.startsWith(o)))).sort()) {
  const { default: build } = await import(pathToFileURL(path.join(srcDir, file)).href);
  // A source may build one workflow or several (e.g. a poller plus the sub-workflow it calls).
  // Each is written as <number>-<slug>.json.
  const prefix = file.match(/^(\d+)-/)[1];
  for (const wf of [].concat(build())) {
    const out = path.join(outDir, `${prefix}-${wf.slug}.json`);
    const rel = path.relative(root, out);
    const json = JSON.stringify(wf.toJSON(), null, 2) + '\n';
    expected.add(path.basename(out));
    if (check) {
      const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
      if (current === json) console.log(`ok    ${rel}`);
      else { console.log(`STALE ${rel}  (run npm run build and commit the result)`); stale++; }
      continue;
    }
    fs.writeFileSync(out, json);
    const counts = wf.nodes.reduce((acc, n) => ((acc[n.type === 'n8n-nodes-base.stickyNote' ? 'stickies' : 'nodes']++), acc), { nodes: 0, stickies: 0 });
    console.log(`${rel}  ${counts.nodes} nodes, ${counts.stickies} stickies`);
  }
}

// A JSON file that no source builds any more (e.g. after a rename) is stale too.
for (const f of only.length ? [] : fs.readdirSync(outDir).filter((f) => f.endsWith('.json') && !expected.has(f))) {
  if (check) { console.log(`STALE workflows/${f}  (no source builds it; delete it)`); stale++; }
  else { fs.rmSync(path.join(outDir, f)); console.log(`removed workflows/${f}  (no source builds it)`); }
}
process.exit(stale ? 1 : 0);
