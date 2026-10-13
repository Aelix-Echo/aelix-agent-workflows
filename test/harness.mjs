// Shared helpers for running a workflow's Code nodes outside n8n.
// No n8n, no model, no network: the node's JavaScript runs against stand-ins for
// $json, $('Node').item / .first() and $execution.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export { assert };
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const loadReference = (file) => JSON.parse(fs.readFileSync(path.join(root, 'workflows', file), 'utf8'));
export const loadProduct = (suite, file) =>
  JSON.parse(fs.readFileSync(path.join(root, 'workflows', 'products', suite, `${file}.json`), 'utf8'));

// Runs one Code node. `nodes` maps node names to the json that $('Name') should return.
export function run(wf, nodeName, { json = {}, nodes = {} } = {}) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `node ${nodeName} not found in ${wf.name}`);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`no paired item for ${name}`);
    return { item: { json: nodes[name] }, first: () => ({ json: nodes[name] }) };
  };
  const fn = new Function('$json', '$', '$execution', node.parameters.jsCode);
  return fn(json, $, { id: 'test-exec' }).json;
}

export const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let passed = 0;
let failed = 0;
export function test(name, f) {
  try { f(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
export function section(title) { console.log(title); }
export function done() { console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ''}`); }
