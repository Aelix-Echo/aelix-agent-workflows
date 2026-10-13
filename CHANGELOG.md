# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- 38 product agent workflows, one for each agent in the Aelix Echo agent catalogue (FinTech 8, Healthcare 8, Energy and Utilities 6, Manufacturing 4, Logistics 4, LegalTech 4, Real Estate and Construction 4), built from `src/products/` with sample payloads.
- `src/product.mjs`: one builder for three patterns: approve then act (named approver in Slack, with decline and timeout handling), act inside a pre-approved envelope else approve, and draft for a named reviewer. Approve and envelope agents also record "no action" runs.
- Tamper-evident audit: `agent_runs` is append-only and hash-chained, with `agent_runs_verify()`. Every run records the approval decision, approver and time.
- `agent_drafts` table for draft-for-review agents.
- `docs/product-agents.md`, generated from the source.
- 565 new guardrail, approval and verification test scenarios (609 in total); `npm test` now runs every test file.
- Build and validate accept a suite filter; validate also compiles every Code node and checks workflow ids are unique.

### Changed

- Repository moved to the Aelix-Echo GitHub organization.
- Secret scan runs the gitleaks CLI (checksum-verified) instead of gitleaks-action, which needs a license on organization repos.

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
