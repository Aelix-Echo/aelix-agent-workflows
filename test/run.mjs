// Runs every *.test.mjs under test/ (not test/e2e) in its own process.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === 'e2e' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.test.mjs') ? [path.join(d, e.name)] : []);

let failed = 0;
for (const file of walk(here).sort()) {
  console.log(`\n=== ${path.relative(here, file)}`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nall test files passed');
process.exit(failed ? 1 : 0);
