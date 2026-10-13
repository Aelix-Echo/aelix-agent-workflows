# Setup

Built and tested against **n8n 2.40.7**.

## 1. Database

Run `sql/schema.sql` on a Postgres 13+ database. It creates `agent_runs`, `agent_exceptions` and `pa_worklist`.

## 2. Import

In n8n: *Workflows → Import from file*, one file at a time. Or with the CLI:

```bash
n8n import:workflow --separate --input=workflows/
```

Each workflow has a stable id, so re-importing updates it instead of creating a duplicate.

**Energy is two workflows.** Import both `06-energy-outage-ticket-poller.json` and `06-energy-outage-ticket-triage.json`, and activate only the poller. It fetches new tickets every two minutes and starts the triage workflow once per ticket, passing the gateway URL from its own Config.

## 3. Credentials

Open each workflow and connect the credentials its Setup sticky lists. Nothing in this repository contains a credential.

| Workflow | Credentials |
|---|---|
| All | Anthropic, Postgres, Slack |
| FinTech | Stripe, Salesforce OAuth2, Gmail |
| Healthcare | Header Auth for FHIR and the payer-rules service |
| Manufacturing | Header Auth for the ERP gateway |
| Logistics | Header Auth for the TMS API, Gmail |
| LegalTech | Header Auth for the CLM and playbook APIs, Gmail |
| Energy | Header Auth for the ops gateway |
| Real Estate | Header Auth for the portal, document, license and screening APIs, Gmail |

## 4. Config

Each workflow has a **Config** node with every tunable in one place: base URLs, limits, tolerances, the confidence floor and Slack channels. Two settings matter before going live:

- **LegalTech `allowed_document_hosts`**: the document stores intake links may point at, mapped to the base URL each file is fetched from. A link on any other host goes to a person and is never downloaded.
- **Real Estate `portal_writable_statuses`**: the application statuses the workflow may write over. An application in any other status (for example already approved) goes to a person.

## 5. Test

Each Setup sticky has a `curl` line that posts the matching file from `samples/` to the test webhook URL. For example:

```bash
curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/fintech-refund-request.json
```

Energy runs on a schedule; use *Execute workflow* against a staging gateway, with `samples/energy-tickets-response.json` as the reference response.

Start with test-mode keys and staging endpoints, and read the first few `agent_exceptions` rows before raising any limits.

## Integrations you have to map

FinTech calls the real Salesforce and Stripe APIs. The other six call a **thin gateway contract** (for example `GET /invoices/{id}/match` or `POST /shipments/{id}/rebook`), because every client's ERP, TMS, EHR, CLM or OMS is different. Each Setup sticky names the systems the contract usually maps to (SAP, Oracle, D365; OTM, Blue Yonder; Ironclad; Oracle NMS; and so on). Either stand that contract up in your integration layer, or edit the URLs on the tool and HTTP nodes.

## Healthcare and PHI

Only send PHI to Claude under a signed BAA with Anthropic, on a self-hosted n8n you control. Set execution-data pruning to match your retention policy (*Settings → Executions pruning*). The workflow keeps PHI out of Slack; messages carry request ids only.
