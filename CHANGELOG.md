# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Live end-to-end suite (`npm run test:e2e`, `test/e2e/`): imports test copies of every workflow into a real n8n 2.40.7 with real Claude, mocks Stripe, Salesforce, Slack, Gmail and the gateway APIs, and checks each outcome and every write. 27 cases including a prompt-injection case per workflow. Latest run: 25 of 27 passed.
- 197 more offline guardrail scenarios (241 in total), split into one test file per workflow, plus a check that every Config setting has the type n8n expects.
- `docs/testing.md`.

### Changed

- Energy is now a poller plus a per-ticket triage sub-workflow. Run live in a batch, n8n's AI Agent node mixed tickets between tool rounds, sent a hazard report the safety screen had held back to the model, and lost the whole batch when one ticket failed. The hazard screen now reads the full description with whole-word patterns; the guardrail re-reads the network trace and customer flags instead of trusting the model; a ticket claimed by another run is skipped quietly; a failed customer notice escalates.
- Guardrails that took the model's word now re-read the system of record:
  - Logistics: cost and ETA come from the TMS quote; waits are checked against the promise; the customer email uses only TMS data.
  - Healthcare: patient and coverage are re-read from FHIR; cited sources must be references a tool returned; urgency is never downgraded; malformed requests reach a person.
  - Manufacturing: duplicates are checked in code; missing figures fail closed; the approval read-back checks amount and reason.
  - LegalTech: contract links must be on an allowlisted host (closes an SSRF path); an empty counterparty fails closed.
  - Real Estate: sanctions and license are re-read; approved applications are never overwritten; TINs and bank numbers are masked in stored exceptions.
- All workflows: the output parser's Auto-Fix Format is on; the hand-off and audit steps can no longer fail on a lost item link; hand-off Slack messages are escaped.

- Repository moved to the Aelix-Echo GitHub organization.
- Secret scan runs the gitleaks CLI (checksum-verified) instead of gitleaks-action, which needs a license on organization repos.
- Model stays Claude Opus 5: Opus 5.5 rejects the history edits n8n's agent makes (tested live; see docs/architecture.md).

## [1.0.0] - 2026-10-05

### Added

- Seven n8n agent workflows: FinTech refund handler, Healthcare prior-auth triage, Manufacturing invoice exception, Logistics shipment exceptions, LegalTech contract intake, Energy outage ticket triage, Real Estate vendor onboarding.
- Postgres schema for `agent_runs`, `agent_exceptions` and `pa_worklist`.
- Sample request payloads for every workflow.
- 44 guardrail, verification, safety-screen and hand-off test scenarios.
- CI: source and JSON drift check, tests on Node 22 and 24, n8n schema and layout validation, secret scan.
- Architecture, setup, contributing and security documentation.

### Changed

- Workflow source moved from `scripts/` to `src/`, and tests to `test/`. Generated JSON is unchanged.
