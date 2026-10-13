// Live end-to-end run: real n8n 2.40.7, real Postgres, real Claude; mocked Stripe, Salesforce,
// Slack, Gmail and gateway APIs. Spends real API credit. See docs/testing.md.
//
// Usage: node test/e2e/run.mjs [--only <slug>[,<slug>]] [--concurrency 4] [--keep]
// Needs Docker, and ANTHROPIC_API_KEY in the environment or in test/e2e/.env.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CREDS } from './prepare.mjs';
import { MODEL_ID } from '../../src/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.out');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : dflt);
const only = opt('only', '').split(',').filter(Boolean);
const concurrency = Number(opt('concurrency', 4));
const RUN_TIMEOUT_MS = 8 * 60 * 1000;

// Host ports for the disposable stack. Never n8n's default 5678: this stack is wiped on every
// run, so it must not sit where a real n8n would. Override with E2E_N8N_PORT / E2E_MOCK_PORT.
process.env.E2E_N8N_PORT ??= '15678';
process.env.E2E_MOCK_PORT ??= '14010';
const N8N = `http://localhost:${process.env.E2E_N8N_PORT}`;
const MOCK = `http://localhost:${process.env.E2E_MOCK_PORT}`;
if ([process.env.E2E_N8N_PORT, process.env.E2E_MOCK_PORT].includes('5678')) {
  console.error('Refusing to run the disposable test stack on port 5678 (n8n\'s default). Pick another E2E_*_PORT.');
  process.exit(2);
}

// List prices per million tokens; 5-minute cache writes are 1.25x input.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
};
const PRICE = PRICES[process.env.E2E_MODEL ?? MODEL_ID] ?? PRICES[MODEL_ID];

// ---------- key ----------
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envFile = path.join(here, '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/^\s*ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s]+)/m);
    if (m) return m[1];
  }
  console.error('No ANTHROPIC_API_KEY. Export it, or put ANTHROPIC_API_KEY=... in test/e2e/.env (git-ignored).');
  process.exit(2);
}
const key = apiKey();

// ---------- docker ----------
const compose = (...a) => execFileSync('docker', ['compose', '-f', path.join(here, 'docker-compose.yml'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// The n8n CLI and the running n8n server share one SQLite file, so a CLI write can briefly hit
// SQLITE_BUSY. Retry those; fail on anything else.
const n8n = (...a) => {
  for (let attempt = 1; ; attempt++) {
    try { return compose('exec', '-T', 'n8n', 'n8n', ...a); }
    catch (e) {
      if (attempt >= 6 || !/SQLITE_BUSY/.test(String(e.stderr) + String(e.stdout) + e.message)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * attempt);
    }
  }
};
const sql = (q) => compose('exec', '-T', 'postgres', 'psql', '-U', 'aelix', '-d', 'aelix', '-tA', '-c', q).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error('timed out waiting for ' + url);
}

const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
const scenarioFiles = fs.readdirSync(path.join(here, 'scenarios')).filter((f) => f.endsWith('.mjs')).sort();
const suites = [];
for (const f of scenarioFiles) {
  // A hard-coded host could reach a real service on this machine (it once hit localhost:5678).
  if (/localhost|127\.0\.0\.1/.test(fs.readFileSync(path.join(here, 'scenarios', f), 'utf8'))) {
    console.error(`${f}: scenarios must not hard-code hosts; use ctx.mockUrl and ctx.retrigger().`);
    process.exit(2);
  }
  const mod = await import(pathToFileURL(path.join(here, 'scenarios', f)).href);
  if (only.length && !only.includes(mod.workflow)) continue;
  if (!manifest[mod.workflow]) throw new Error(`${f}: unknown workflow ${mod.workflow}`);
  suites.push(mod);
}
const keysOf = (c) => [].concat(c.keys ?? c.payload.request_id);

// Only ever removes this project's own containers (compose project "aelix-e2e").
compose('down', '-v', '--remove-orphans');

// Never take over a port something else is using: stop with a clear message instead.
const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
  srv.listen(Number(port), '0.0.0.0');
});
for (const port of [process.env.E2E_N8N_PORT, process.env.E2E_MOCK_PORT]) {
  if (!(await portFree(port))) {
    console.error(`Port ${port} is in use by something else. Free it, or set E2E_N8N_PORT / E2E_MOCK_PORT to unused ports.`);
    process.exit(2);
  }
}

console.log(`Starting the disposable test stack: n8n on ${N8N}, mock on ${MOCK} (wiped again at the end)...`);
compose('up', '-d', '--wait');

try {
  // Credentials file holds the key only until n8n has imported (and encrypted) it.
  const credFile = path.join(out, 'credentials.json');
  fs.writeFileSync(credFile, JSON.stringify([
    { id: CREDS.anthropic.id, name: CREDS.anthropic.name, type: 'anthropicApi', data: { apiKey: key, url: 'http://mock:4010/_anthropic' } },
    { id: CREDS.postgres.id, name: CREDS.postgres.name, type: 'postgres', data: { host: 'postgres', port: 5432, database: 'aelix', user: 'aelix', password: 'aelix', ssl: 'disable' } },
  ]), { mode: 0o600 });
  try { n8n('import:credentials', '--input=/e2e-out/credentials.json'); } finally { fs.rmSync(credFile, { force: true }); }

  n8n('import:workflow', '--separate', '--input=/e2e-out/workflows');
  // Publish everything: some suites start through another workflow (Energy's poller calls a sub-workflow).
  for (const m of Object.values(manifest)) n8n('publish:workflow', `--id=${m.id}`);
  compose('restart', 'n8n');
  await waitFor(`${N8N}/healthz`);
  // Healthy is not the same as ready: wait until every test webhook is registered. A GET on a
  // POST-only webhook answers "Did you mean to make a POST request?" once it is registered.
  for (const m of Object.values(manifest).filter((m) => m.webhookPath)) {
    const end = Date.now() + 60000;
    for (;;) {
      const text = await (await fetch(`${N8N}/webhook/${m.webhookPath}`).catch(() => ({ text: async () => '' }))).text();
      if (/Did you mean/i.test(text)) break;
      if (Date.now() > end) throw new Error(`webhook ${m.webhookPath} was not registered within 60s`);
      await sleep(1000);
    }
  }

  await fetch(`${MOCK}/_keys`, { method: 'POST', body: JSON.stringify(suites.flatMap((s) => s.cases.flatMap(keysOf))) });

  const jobs = suites.flatMap((s) => s.cases.map((c) => ({ suite: s, c })));
  console.log(`Running ${jobs.length} cases across ${suites.length} workflows (concurrency ${concurrency})\n`);
  const results = [];

  async function runCase({ suite, c }) {
    const t0 = Date.now();
    const keys = keysOf(c);
    const res = { workflow: suite.workflow, name: c.name, keys, ok: false, error: null, seconds: 0 };
    try {
      const webhookUrl = `${N8N}/webhook/${manifest[suite.trigger ?? suite.workflow].webhookPath}`;
      const post = (body) => fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      const r = await post(c.payload);
      if (!r.ok) throw new Error(`webhook returned ${r.status}: ${(await r.text()).slice(0, 200)}`);

      const runs = {};
      const end = t0 + RUN_TIMEOUT_MS;
      while (Object.keys(runs).length < keys.length) {
        if (Date.now() > end) throw new Error(`no agent_runs row after ${RUN_TIMEOUT_MS / 60000} min for ${keys.filter((k) => !runs[k]).join(', ')}`);
        await sleep(3000);
        for (const k of keys) {
          if (runs[k]) continue;
          const row = sql(`SELECT row_to_json(r) FROM agent_runs r WHERE workflow=${lit(suite.workflow)} AND business_key=${lit(k)} ORDER BY id DESC LIMIT 1`);
          if (row) runs[k] = JSON.parse(row);
        }
      }
      await sleep(1500); // let trailing nodes (notifications) land
      const exceptions = {};
      for (const k of keys) {
        const row = sql(`SELECT row_to_json(e) FROM agent_exceptions e WHERE workflow=${lit(suite.workflow)} AND business_key=${lit(k)} ORDER BY id DESC LIMIT 1`);
        exceptions[k] = row ? JSON.parse(row) : null;
      }
      const log = (await (await fetch(`${MOCK}/_log`)).json()).filter((e) => e.t >= t0);
      const ctx = {
        run: runs[keys[0]], runs, exception: exceptions[keys[0]], exceptions, log,
        sql,
        requests: (method, prefix) => log.filter((e) => e.method === method && e.path.startsWith(prefix)),
        // Scenarios never hard-code hosts: the test stack's addresses come from here.
        mockUrl: MOCK,
        retrigger: (body) => post(body),
      };
      res.outcomes = Object.fromEntries(keys.map((k) => [k, runs[k].outcome]));
      res.reasons = Object.fromEntries(keys.map((k) => [k, exceptions[k]?.reasons ?? runs[k].guardrail_reasons ?? []]));

      const want = c.expect.outcome;
      for (const k of keys) {
        const w = typeof want === 'string' ? want : want?.[k];
        if (w && runs[k].outcome !== w) {
          throw new Error(`${k}: outcome ${runs[k].outcome}, expected ${w}. Reasons: ${JSON.stringify(res.reasons[k]).slice(0, 400)}`);
        }
        // An escalation only counts if the workflow decided to escalate, not if something broke.
        const broken = (res.reasons[k] ?? []).filter((r) => /^system_error|agent_produced_no_valid_output/.test(r));
        if (broken.length && !c.expect.allowSystemError) throw new Error(`${k}: escalated because of a failure, not a decision: ${broken.join('; ').slice(0, 300)}`);
      }
      if (c.expect.check) await c.expect.check(ctx);
      res.ok = true;
    } catch (e) {
      res.error = e.message;
    }
    res.seconds = Math.round((Date.now() - t0) / 1000);
    console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${suite.workflow} · ${c.name}  (${res.seconds}s)${res.ok ? '' : '\n      ' + res.error}`);
    results.push(res);
  }

  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await runCase(queue.shift());
  }));

  // ---------- usage and cost ----------
  const usage = await (await fetch(`${MOCK}/_usage`)).json();
  const tok = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  for (const u of usage) {
    tok.input += u.input_tokens; tok.output += u.output_tokens;
    tok.cache_write += u.cache_creation_input_tokens; tok.cache_read += u.cache_read_input_tokens;
  }
  const cost = Object.entries(tok).reduce((s, [k, v]) => s + (v / 1e6) * PRICE[k], 0);
  const apiErrors = usage.filter((u) => u.status >= 400);
  const models = [...new Set(usage.map((u) => u.model))];
  const toolChoices = [...new Set(usage.map((u) => JSON.stringify(u.tool_choice)))];

  const passed = results.filter((r) => r.ok).length;
  const summary = {
    date: new Date().toISOString(), passed, failed: results.length - passed, results,
    claude: { calls: usage.length, models, tool_choice_sent: toolChoices, api_errors: apiErrors.map((u) => ({ status: u.status, error: u.error })), tokens: tok, estimated_cost_usd: Number(cost.toFixed(2)) },
  };
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(summary, null, 2));

  console.log(`\n${passed}/${results.length} passed`);
  console.log(`Claude: ${usage.length} calls, model ${models.join(', ')}, ${apiErrors.length} API errors`);
  console.log(`Tokens: ${tok.input} in, ${tok.output} out, ${tok.cache_write} cache write, ${tok.cache_read} cache read  ≈ $${cost.toFixed(2)}`);
  console.log(`Details: ${path.relative(process.cwd(), path.join(out, 'results.json'))}`);
  process.exitCode = passed === results.length ? 0 : 1;
} finally {
  if (flag('keep')) console.log('\n--keep: stack left running. Stop it with: docker compose -f test/e2e/docker-compose.yml down -v');
  else compose('down', '-v', '--remove-orphans');
}
