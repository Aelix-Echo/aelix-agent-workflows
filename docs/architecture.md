# Architecture

This repository holds two sets of workflows on one design:

- **Seven reference workflows** (`src/workflows/`), one per industry card on aelixecho.com/ai-agents.
- **The product agents** (`src/products/<suite>/`), one per agent in the Aelix Echo agent catalogue. They are listed in [product-agents.md](product-agents.md), which is generated from the source.

All workflows share one design. They are generated from code (`src/lib.mjs` plus one file per workflow in `src/workflows/`), so the stage layout, guardrail pattern, hand-off and audit are identical across industries. Only the prompts, tools, schema and guardrail rules differ.

## The six stages

Every canvas has the same six stages, each inside a colour-coded sticky note. An Overview and a Setup sticky sit on the left of each canvas.

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

| Stage | What happens | Can change a system of record? |
|---|---|---|
| 1 Intake | Webhook or schedule; the request is normalised and given a business key | No |
| 2 Observe and plan | A Claude agent calls read-only tools and returns a proposal validated against a JSON schema | No |
| 3 Guardrails | A Code node re-reads the system of record and checks the proposal against the limits in **Config** | No |
| 4 Act and verify | Idempotent writes, then a read-back to confirm the system shows the planned result | Yes |
| 5 Hand off | One exception path for every stop: an `agent_exceptions` row and a Slack post | Queue only |
| 6 Audit | One `agent_runs` row per run, whichever way it ended | Audit log only |

## Design principles

- **The agent only reads.** Every tool attached to the AI Agent node is a GET (or a read-only quote). The agent cannot change a system of record.
- **Guardrails are deterministic.** The Guardrails node re-reads the source of truth where it matters (Stripe payment, ERP match view, OMS outage, TMS shipment). The model's arithmetic is recomputed, not trusted.
- **Writes are idempotent and verified.** Write calls carry an idempotency key. The run counts as done only when a read-back shows the planned result.
- **Every stop goes to one hand-off.** Agent errors, guardrail stops, failed writes and failed verification all land in the same place, with the reasons, the proposal, the agent's questions for a person, and every tool call and observation.
- **Customers and vendors only get fixed templates.** Model-written text goes to reviewers, never straight to an outside party.
- **Untrusted text is data.** Customer reasons, carrier notes, contract text and ticket descriptions are passed inside tags and labelled as data, not instructions.
- **One place to tune.** Each workflow has a **Config** node with every limit, tolerance, URL, confidence floor and channel.

## Product agents: three ways to finish

The product agents add a named-approver step. Each one is built by `productAgent()` in `src/product.mjs` from a single spec, so all of them share the same stages, approval handling, hand-off and audit.

| Pattern | Used when the catalogue says | What happens after the guardrails |
|---|---|---|
| **Approve, then act** | "a person approves", "after sign-off", "nothing is pushed until..." | The run pauses and sends the proposal to one named person in Slack (`approver_slack_user` in Config). Approve: act, then read back. Decline: recorded as declined. No answer within `approval_timeout_hours`: hand-off. |
| **Envelope, else approve** | "acts alone only inside a pre-approved envelope", "planners approve above set limits" | Inside the envelope defined in Config, act and read back with no pause. Outside it, the named approver is asked first. |
| **Draft for review** | "drafts ... the officer signs", "it never files" | Nothing is written, filed or sent. The draft is saved to `agent_drafts` and the named reviewer gets a direct message with ids only. |

Approve and envelope agents also have a **no action** route for when the agent finds nothing to do (for example, no reorder needed); it is recorded, not escalated.

The approval request is a direct message to the one person `approver_slack_user` names, and the audit row records that handle, the decision and the response time. n8n does not record which Slack user clicked the button, so keep `approver_slack_user` pointed at an individual, never a shared account or channel.

## Tamper-evident audit

`agent_runs` is append-only and hash-chained (see `sql/schema.sql`):

- A trigger gives each new row a `chain_seq`, the previous row's hash, and a SHA-256 over that hash plus the row's content, inside a lock so the chain has no gaps or forks.
- `UPDATE`, `DELETE` and `TRUNCATE` are refused.
- `SELECT * FROM agent_runs_verify();` returns nothing when the chain is intact, or the first row where it breaks.

This makes edits detectable, not impossible: a database superuser can disable the triggers. To catch that too, copy the latest `row_hash` on a schedule to storage the database owner cannot overwrite (for example write-once object storage).

## Model

**Claude Opus 5** (`claude-opus-5`, set in `src/lib.mjs`) with adaptive thinking. Effort is high everywhere except Energy, which uses medium for high-volume triage. Prompt caching is on (5 minutes). Change the model on each workflow's `… · Claude` node, or in `MODEL_ID` and rebuild.

## What each workflow will not do

| Workflow | Always goes to a person |
|---|---|
| Refund handler | Denials; refunds above the auto limit, outside the window, on disputed charges or with mismatched identity |
| Prior-auth triage | Every payer submission; urgency disagreements; unknown PA requirement. It never decides medical necessity. |
| Invoice exception | Quantity variances, anything outside tolerance, under-billing, duplicates. Vendor emails are drafts only. |
| Shipment exceptions | Damage, customs, hazmat and address issues; paid re-plans over the cost limit or that still miss the promise |
| Contract intake | Every approval, redline and signature; routing disagreements; counterparty mismatches; scanned PDFs |
| Outage triage | Every crew dispatch; hazard reports (caught by a keyword screen before the model runs); critical customers |
| Vendor onboarding | Every vendor approval; sanctions hits; license-holder mismatches |

## Data model

`sql/schema.sql` (Postgres 13+) creates four tables:

| Table | Purpose |
|---|---|
| `agent_runs` | One row per run: outcome, route, the agent's decision, guardrail reasons, actions taken, the approval (who, what, when), tool-call count, model and n8n execution id. Append-only and hash-chained. |
| `agent_exceptions` | The human review queue: team, status, reasons, proposed action, confidence, the agent's questions, the full trace, and resolution fields |
| `pa_worklist` | Healthcare prior-auth worklist. Holds PHI, so restrict access accordingly. |
| `agent_drafts` | Drafts waiting for a named reviewer (draft-for-review agents), with review status and notes |
