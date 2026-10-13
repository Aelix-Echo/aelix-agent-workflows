// Shared helpers for the offline tests in test/workflows/. They run the deterministic Code nodes
// (guardrails, verification, safety screen, hand-off) from the built workflow JSON.
// No n8n, no model, no network.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const load = (f) => JSON.parse(fs.readFileSync(path.join(root, 'workflows', f), 'utf8'));

// Minimal stand-ins for the n8n Code node globals used in these nodes.
export function run(wf, nodeName, { json = {}, nodes = {} }) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `node ${nodeName} not found`);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`no paired item for ${name}`);
    return { item: { json: nodes[name] }, first: () => ({ json: nodes[name] }), all: () => [{ json: nodes[name] }] };
  };
  const fn = new Function('$json', '$', '$execution', node.parameters.jsCode);
  return fn(json, $, { id: 'test-exec' }).json;
}

export const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export const results = { passed: 0, failed: 0 };
export const test = (name, f) => {
  try { f(); results.passed++; console.log('  ok  ' + name); }
  catch (e) { results.failed++; console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

// Each test file runs in its own process (test/run.mjs); print its total when it finishes.
process.on('exit', () => console.log(`\n${results.passed} passed${results.failed ? `, ${results.failed} failed` : ''}`));
