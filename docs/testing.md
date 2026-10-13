# Testing

There are three layers of tests. The first two run on every push in CI; the third runs on demand because it calls the Claude API and costs money.

| Layer | Command | What it proves | Needs |
|---|---|---|---|
| Build check | `npm run build:check` | The committed workflow JSON is exactly what `src/` generates | Node 22+ |
| Guardrail tests | `npm test` (844 scenarios) | The deterministic Code nodes (guardrails, verification, safety screen, hand-off) behave correctly against fixed scenarios | Node 22+ |
| n8n validation | `npm run validate` | Every node passes n8n's own schema validator; canvas layout and connections are sound | `npm ci` (pinned n8n) |
| Live end to end | `npm run test:e2e` | Each workflow, imported into a real n8n with real Claude, reaches the right outcome and never performs a write it should not | Docker, an Anthropic API key |

## Guardrail tests

`test/workflows/<number>-<workflow>.test.mjs` holds the scenarios for one reference workflow and `test/products/<suite>.test.mjs` those for one product suite; `npm test` (`test/run.mjs`) runs every file in its own process. `test/helpers.mjs` and `test/harness.mjs` run a Code node from the built JSON with stand-ins for n8n's `$json` and `$('Node')`. No n8n, no model, no network. Any new escalation or guardrail rule needs a scenario here.

## Live end-to-end tests

`test/e2e/` starts n8n 2.40.7, Postgres and a mock server in Docker, imports **test copies** of the workflows, posts each test case to its webhook, waits for the `agent_runs` row, and checks the outcome and what reached the mock. The workflows in `workflows/` are not changed.

**What is real:** n8n, Postgres, the workflow logic, and Claude (your key, through a logging proxy that records token usage).
**What is mocked:** Stripe, Salesforce, Slack, Gmail and each industry's gateway API, with consistent synthetic data per case (`test/e2e/scenarios/*.mjs`).

The live suite covers the seven reference workflows; the product agents are not yet live-tested. Each workflow has a success case, escalation cases from its "never does" list, and a prompt-injection case. A case fails if:

- the outcome is wrong,
- a write happened that should not have (or did not happen exactly once, with its idempotency key, when it should), or
- the run escalated because something broke rather than because the workflow decided to escalate.

### Running it

```bash
# once: put your key in test/e2e/.env (git-ignored)
echo 'ANTHROPIC_API_KEY=sk-ant-...' > test/e2e/.env

npm run test:e2e                                      # all workflows
node test/e2e/run.mjs --only fintech-refund-handler   # one workflow
node test/e2e/run.mjs --keep                          # leave the stack running to inspect it
E2E_MODEL=claude-opus-5-5 npm run test:e2e            # try another model without changing the repo
```

The test stack is disposable: it is created fresh and deleted at the start and end of every run. So it never uses n8n's default port 5678, and never touches any other n8n on your machine. n8n listens on **http://localhost:15678** and the mock on **14010** (override with `E2E_N8N_PORT` / `E2E_MOCK_PORT`). If either port is busy, the run stops with a message instead of starting.

The key is copied into n8n only for the run; the temporary file is deleted after import and the stack is removed at the end. Results, token counts and an estimated cost are written to `test/e2e/.out/results.json`. A full run of all workflows costs roughly $2 to $3 on Claude Opus 5.

### What the live run has found

The first full run (October 2026) found problems the offline tests could not:

- **n8n's AI Agent node mixes items in a batch.** Processing several outage tickets in one execution, later tool rounds were rendered against the wrong ticket, so a hazard report that the safety screen had held back reached the model, and one ticket's failure crashed the hand-off for the whole batch. Energy now triages each ticket in its own sub-workflow execution.
- **Large structured outputs occasionally failed to parse.** All workflows now use the output parser's Auto-Fix Format option, which sends a malformed answer back to the model once to repair it.
- **Claude Opus 5.5 is not yet compatible with n8n.** See [architecture.md](architecture.md#model).
- Several guardrails still took the model's word for something they could check. Each is now re-read from the system of record and covered by a guardrail test.
