// Mock for every external system the workflows call, plus a logging proxy to the Claude API.
//
//   /<original-host>/<path>   routes declared by test/e2e/scenarios/*.mjs (Stripe, Salesforce, gateways)
//   /_notify/slack|gmail      stand-ins for the Slack and Gmail nodes (prepare.mjs rewrites them)
//   /_anthropic/*             forwarded to api.anthropic.com; token usage is recorded
//   /_log                     every request received, for assertions
//   /_usage                   Claude token usage, tagged with the business key found in the prompt
//
// No dependencies: runs on plain Node 24.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4010;

const routes = [];
for (const file of fs.readdirSync(path.join(here, 'scenarios')).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(pathToFileURL(path.join(here, 'scenarios', file)).href);
  for (const r of mod.routes ?? []) routes.push({ ...r, source: file, re: compile(r.path) });
}

// '/v1/payment_intents/:id' -> regex with named groups
function compile(p) {
  return new RegExp('^' + p.replace(/[.+?^$|()[\]\\]/g, '\\$&').replace(/:(\w+)/g, '(?<$1>[^/]+)').replace(/\*/g, '.*') + '/?$');
}

const log = [];
const usage = [];
const responses = [];
let keys = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function parseBody(buf, type = '') {
  const text = buf.toString('utf8');
  if (!text) return null;
  if (type.includes('json')) try { return JSON.parse(text); } catch { return text; }
  if (type.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { return text; }
}

function send(res, status, body, type = 'application/json') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(type.includes('json') ? JSON.stringify(body) : String(body));
  res.writeHead(status, { 'content-type': type, 'content-length': payload.length });
  res.end(payload);
}

// Usage from a JSON response or an SSE stream.
function extractUsage(text) {
  const u = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const add = (x) => { if (!x) return; for (const k of Object.keys(u)) if (typeof x[k] === 'number') u[k] = Math.max(u[k], x[k]); };
  try { const j = JSON.parse(text); add(j.usage); return { usage: u, model: j.model, stop_reason: j.stop_reason }; } catch {}
  let model, stop_reason;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const e = JSON.parse(line.slice(5));
      if (e.type === 'message_start') { add(e.message?.usage); model = e.message?.model; }
      if (e.type === 'message_delta') { add(e.usage); stop_reason = e.delta?.stop_reason ?? stop_reason; }
    } catch {}
  }
  return { usage: u, model, stop_reason };
}

async function proxyAnthropic(req, res, url, raw) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) headers[k] = v;
  const upstream = await fetch('https://api.anthropic.com' + url.pathname.replace(/^\/_anthropic/, '') + url.search, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  if (url.pathname.endsWith('/messages')) {
    const reqText = raw.toString('utf8');
    const sent = parseBody(raw, 'json') ?? {};
    const { usage: u, model, stop_reason } = extractUsage(body.toString('utf8'));
    usage.push({
      t: Date.now(),
      key: keys.find((k) => reqText.includes(k)) ?? null,
      status: upstream.status,
      model: model ?? sent.model,
      stop_reason,
      thinking: sent.thinking,
      effort: sent.output_config?.effort,
      tool_choice: sent.tool_choice ?? null,
      tools: (sent.tools ?? []).length,
      format_tool: (sent.tools ?? []).find((t) => t.name === 'format_final_json_response')?.input_schema,
      // Shape of the conversation, for debugging which item a call belongs to (test data only).
      messages: (sent.messages ?? []).length,
      first_message: JSON.stringify(sent.messages?.[0]?.content ?? '').slice(0, 160),
      error: upstream.status >= 400 ? body.toString('utf8').slice(0, 500) : undefined,
      ...u,
    });
    // Keep the model's reply for debugging (GET /_responses); never the request, which holds the prompt.
    responses.push({ t: Date.now(), key: usage.at(-1).key, body: body.toString('utf8').slice(0, 200000) });
  }
  const type = upstream.headers.get('content-type') ?? 'application/json';
  res.writeHead(upstream.status, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const raw = await readBody(req);
  try {
    if (url.pathname === '/_health') return send(res, 200, { ok: true, routes: routes.length });
    if (url.pathname === '/_log') return send(res, 200, log);
    if (url.pathname === '/_usage') return send(res, 200, usage);
    if (url.pathname === '/_responses') return send(res, 200, responses.filter((r) => !url.searchParams.get('key') || r.key === url.searchParams.get('key')));
    if (url.pathname === '/_keys' && req.method === 'POST') { keys = parseBody(raw, 'json') ?? []; return send(res, 200, { keys: keys.length }); }
    if (url.pathname.startsWith('/_anthropic/')) return await proxyAnthropic(req, res, url, raw);

    const body = parseBody(raw, req.headers['content-type']);
    const entry = {
      t: Date.now(),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      idempotency_key: req.headers['idempotency-key'] ?? null,
      body,
    };
    log.push(entry);

    if (url.pathname.startsWith('/_notify/')) return send(res, 200, { ok: true, ts: String(Date.now() / 1000), id: 'msg_' + log.length });

    // /<host>/<rest>: the first segment is the original host the workflow would have called.
    const [, host, ...rest] = url.pathname.split('/');
    const sub = '/' + rest.join('/');
    for (const r of routes) {
      if (r.host !== host || (r.method ?? 'GET') !== req.method) continue;
      const m = sub.match(r.re);
      if (!m) continue;
      const out = await r.handler({ params: m.groups ?? {}, query: entry.query, body, headers: req.headers, log });
      entry.status = out.status ?? 200;
      if (out.file) return send(res, entry.status, out.file, out.type ?? 'application/octet-stream');
      return send(res, entry.status, out.json ?? {}, 'application/json');
    }
    entry.status = 404;
    return send(res, 404, { error: { message: `mock: no route for ${req.method} ${url.pathname}` } });
  } catch (e) {
    return send(res, 500, { error: { message: 'mock error: ' + e.message } });
  }
}).listen(PORT, () => console.log(`mock listening on ${PORT} with ${routes.length} routes`));
