// Runs every offline scenario in test/workflows/*.test.mjs: the deterministic Code nodes
// (guardrails, verification, safety screen, hand-off) from the built workflow JSON.
// No n8n, no model, no network.
// Usage: node test/guardrails.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { results } from './helpers.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(path.join(dir, f)).href);
}

console.log(`\n${results.passed} passed${results.failed ? `, ${results.failed} failed` : ''}`);
