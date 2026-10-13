# Aelix Echo agent workflows for n8n

[![CI](https://github.com/Aelix-Echo/aelix-agent-workflows/actions/workflows/ci.yml/badge.svg)](https://github.com/Aelix-Echo/aelix-agent-workflows/actions/workflows/ci.yml)
![n8n 2.40.7](https://img.shields.io/badge/n8n-2.40.7-EA4B71)
![Node 24+](https://img.shields.io/badge/node-%E2%89%A524-339933)
![Guardrail tests: 241](https://img.shields.io/badge/guardrail%20tests-241-blue)
![Live end-to-end: 25 of 27](https://img.shields.io/badge/live%20e2e-25%2F27-yellowgreen)

Seven n8n workflows, one for each industry card on [aelixecho.com/ai-agents](https://aelixecho.com/ai-agents). Each one runs the loop the page describes: observe, plan, act, verify, hand off.

| # | Workflow | Industry | Work taken off the desk | Trigger |
|---|---|---|---|---|
| 1 | [`01-fintech-refund-handler`](workflows/01-fintech-refund-handler.json) | FinTech | Refund handling: eligibility check and refund | Webhook |
| 2 | [`02-healthcare-prior-auth-triage`](workflows/02-healthcare-prior-auth-triage.json) | Healthcare | Prior-auth triage: packet assembly and routing | Webhook |
| 3 | [`03-manufacturing-invoice-exception`](workflows/03-manufacturing-invoice-exception.json) | Manufacturing | Invoice exceptions: match, draft, escalate | Webhook |
| 4 | [`04-logistics-shipment-exceptions`](workflows/04-logistics-shipment-exceptions.json) | Logistics | Shipment exceptions: trace, re-plan, escalate | Webhook |
| 5 | [`05-legaltech-contract-intake`](workflows/05-legaltech-contract-intake.json) | LegalTech | Contract intake: classify and route | Webhook |
| 6 | [`06-energy-outage-ticket-triage`](workflows/06-energy-outage-ticket-triage.json) + [`poller`](workflows/06-energy-outage-ticket-poller.json) | Energy & Utilities | Outage ticket triage: correlate and dispatch | Every 2 min (poller starts one run per ticket) |
| 7 | [`07-realestate-vendor-onboarding`](workflows/07-realestate-vendor-onboarding.json) | Real Estate & Construction | Vendor onboarding: document collection | Webhook |

## How every workflow is built

```mermaid
flowchart LR
    I["1 Intake"] --> P["2 Observe and plan<br/><i>agent, read-only</i>"]
    P --> G["3 Guardrails<br/><i>plain code</i>"]
    G --> A["4 Act and verify<br/><i>write, read back</i>"]
    A --> AU["6 Audit"]
    P -- "agent error" --> H["5 Hand off"]
    G -- "guardrail stop" --> H
    A -- "write or verify failed" --> H
    H --> AU
```

- **The agent only reads.** It returns a structured proposal validated against a JSON schema and cannot change a system of record.
- **Guardrails are deterministic code.** They re-read the source of truth and recompute the model's arithmetic instead of trusting it.
- **Writes are idempotent and verified** by reading the record back.
- **Every stop goes to one hand-off**, with the reasons, the proposal and the full tool-call trace, so a person can decide quickly.
- **Every run is audited**, and customers and vendors only ever receive fixed templates.

More in [docs/architecture.md](docs/architecture.md), including what each workflow always leaves to a person.

## Quick start

```bash
psql "$DATABASE_URL" -f sql/schema.sql                 # 1. audit and exception tables
n8n import:workflow --separate --input=workflows/       # 2. import all of them (Energy is two files)
```

Then connect credentials, edit each **Config** node, and post a file from `samples/` to the test webhook. Full steps in [docs/setup.md](docs/setup.md).

## Repository layout

```
├── workflows/          Ready-to-import n8n workflows (generated, do not edit by hand)
├── src/
│   ├── lib.mjs         Shared builders: agent, guardrails, hand-off, audit, stickies
│   └── workflows/      One source file per workflow: prompts, tools, schema, rules
├── test/
│   ├── workflows/      Offline guardrail, verification and hand-off scenarios (241), one file per workflow
│   └── e2e/            Live end-to-end suite: real n8n and Claude, mocked business systems
├── scripts/            build.mjs (source to JSON) and validate.mjs (n8n validator)
├── samples/            Example request payloads, one per workflow
├── sql/                Postgres schema for runs, exceptions and the PA worklist
├── docs/               Architecture, setup and testing guides
└── .github/            CI, Dependabot, PR template, code owners
```

## Quality checks

Every push runs [CI](.github/workflows/ci.yml):

| Check | What it proves |
|---|---|
| Build check | The committed JSON is exactly what the source generates |
| Guardrail tests | 241 scenarios across all seven workflows, on Node 22 and 24, with no network or model |
| n8n validation | Node parameters pass n8n's own schema validator; canvas layout and connections are sound |
| Secret scan | No credentials anywhere in the git history |

Run them locally with `npm run check`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

On demand, `npm run test:e2e` runs every workflow end to end in a real n8n with real Claude, against mocked business systems, and checks each outcome and every write. It calls the Claude API (about $2 a run). See [docs/testing.md](docs/testing.md).

## Status

- **Offline:** all eight workflow files import into n8n 2.40.7 and pass its validator, and the guardrail, verification, safety-screen and hand-off logic passes 241 scenarios.
- **Live, with real Claude (Opus 5) in real n8n:** the latest full run passed 25 of 27 cases across all seven workflows. Every success path completed with exactly one verified write, and every escalation and prompt-injection case was stopped with no write.
- **Known limitation:** in about 6% of live cases (4 of 64 across the post-fix runs), Claude's final answer fails n8n's output-format check. The workflow then escalates to a person with the error recorded and makes no write, so it fails safe, but that case needs a human that it would not otherwise have needed. Both failures in the latest run were this.
- **Not tested:** the real Stripe, Salesforce and gateway APIs (the live suite uses mocks with the same contracts). Run each workflow first with test-mode keys and staging endpoints.
- **Model:** Claude Opus 5. Opus 5.5 is not yet usable from n8n; see [docs/architecture.md](docs/architecture.md#model).

## Security

Credentials live in n8n, never in this repository. For PHI handling and how to report a vulnerability, see [SECURITY.md](SECURITY.md).
