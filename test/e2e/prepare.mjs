// Builds test copies of workflows/*.json for the local end-to-end run. The originals are not changed.
//
// What changes in the copy, and nothing else:
//  - https://<host>/... URLs (Config base URLs, Stripe) point at the mock: http://mock:4010/<host>/...
//  - HTTP nodes drop their Stripe / Salesforce / Header Auth credential (the mock needs none)
//  - Slack and Gmail nodes become HTTP posts to the mock, keeping their name, message and error handling
//  - The schedule trigger (Energy) becomes a webhook so the test can start a run on demand
//  - The Claude and Postgres nodes get the test credentials created by run.mjs
//
// Writes test/e2e/.out/workflows/*.json and test/e2e/.out/manifest.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ID } from '../../src/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.join(here, '.out', 'workflows');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

export const CREDS = {
  anthropic: { id: 'e2eAnthropicCred', name: 'E2E Anthropic (via mock proxy)' },
  postgres: { id: 'e2ePostgresCred0', name: 'E2E Postgres' },
};
const MOCK = 'http://mock:4010';

// E2E_MODEL=<model id> runs the test copies on another model (the model node and the audit row both change).
const model = process.env.E2E_MODEL ?? MODEL_ID;
const rewriteUrls = (v) => (typeof v === 'string' ? v.replace(/https:\/\/([A-Za-z0-9.-]+)/g, `${MOCK}/$1`).replaceAll(`'${MODEL_ID}'`, `'${model}'`) : v);
const setModel = (node) => {
  if (node.parameters.model?.value === MODEL_ID) node.parameters.model = { ...node.parameters.model, value: model, cachedResultName: model };
  return node;
};
const deep = (o, f) => {
  if (Array.isArray(o)) return o.map((x) => deep(x, f));
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deep(v, f)]));
  return f(o);
};

function notifyNode(n, kind) {
  const p = n.parameters;
  const fields = kind === 'slack'
    ? { channel: p.channelId?.value ?? '', text: p.text ?? '' }
    : { to: p.sendTo ?? '', subject: p.subject ?? '', message: p.message ?? '' };
  return {
    ...n,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.5,
    parameters: {
      method: 'POST',
      url: `${MOCK}/_notify/${kind}`,
      sendBody: true,
      contentType: 'json',
      bodyParameters: { parameters: Object.entries(fields).map(([name, value]) => ({ name, value })) },
      options: {},
    },
  };
}

const manifest = {};
for (const file of fs.readdirSync(path.join(root, 'workflows')).filter((f) => f.endsWith('.json')).sort()) {
  const wf = JSON.parse(fs.readFileSync(path.join(root, 'workflows', file), 'utf8'));
  const slug = file.replace(/^\d+-/, '').replace(/\.json$/, '');
  let webhookPath = null;

  wf.nodes = wf.nodes.map((n) => {
    if (n.type === 'n8n-nodes-base.stickyNote') return n;
    let node = { ...n, parameters: deep(n.parameters, rewriteUrls) };

    if (node.type === 'n8n-nodes-base.httpRequest' || node.type === 'n8n-nodes-base.httpRequestTool') {
      const { authentication, nodeCredentialType, genericAuthType, ...rest } = node.parameters;
      node.parameters = { ...rest, authentication: 'none' };
    }
    if (node.type === 'n8n-nodes-base.slack') node = notifyNode(node, 'slack');
    if (node.type === 'n8n-nodes-base.gmail') node = notifyNode(node, 'gmail');
    if (node.type === 'n8n-nodes-base.scheduleTrigger') {
      node = {
        ...node,
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2.1,
        webhookId: `e2e-${slug}`,
        parameters: { httpMethod: 'POST', path: `e2e/${slug}`, responseMode: 'onReceived', options: {} },
      };
    }
    if (node.type === 'n8n-nodes-base.webhook') webhookPath = node.parameters.path;
    if (node.type === '@n8n/n8n-nodes-langchain.lmChatAnthropic') node = { ...setModel(node), credentials: { anthropicApi: CREDS.anthropic } };
    if (node.type === 'n8n-nodes-base.postgres') node.credentials = { postgres: CREDS.postgres };
    return node;
  });

  wf.name = `[e2e] ${wf.name}`;
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(wf, null, 2));
  manifest[slug] = { id: wf.id, file, webhookPath };
}

fs.writeFileSync(path.join(here, '.out', 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`prepared ${Object.keys(manifest).length} test workflows in ${path.relative(root, outDir)}`);
