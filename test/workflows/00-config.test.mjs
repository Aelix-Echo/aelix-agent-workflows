// Every workflow: Config settings carry the type n8n's Set node will accept for their value.
// n8n rejects a mismatch at run time (e.g. a list declared as 'object'), before any hand-off
// exists to catch it, so this is checked offline.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { load, test } from '../helpers.mjs';

console.log('All workflows · Config');
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../workflows');
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const config = load(file).nodes.find((n) => n.name === 'Config');
  if (!config) continue;
  test(`${file}: Config types match their values`, () => {
    for (const a of config.parameters.assignments.assignments) {
      const literal = typeof a.value === 'string' && /^=\{\{ [[{]/.test(a.value) ? JSON.parse(a.value.slice(4, -3)) : undefined;
      if (Array.isArray(literal)) assert.equal(a.type, 'array', a.name);
      else if (literal && typeof literal === 'object') assert.equal(a.type, 'object', a.name);
      else if (typeof a.value === 'number') assert.equal(a.type, 'number', a.name);
      else if (typeof a.value === 'boolean') assert.equal(a.type, 'boolean', a.name);
    }
  });
}
