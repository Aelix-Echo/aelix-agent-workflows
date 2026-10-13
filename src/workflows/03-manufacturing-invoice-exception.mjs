import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  webhook, config, code, ifTrue, http, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

export default function build() {
  const wf = new Workflow('Manufacturing · Invoice exception agent', 'manufacturing-invoice-exception');
  const AGENT = 'Invoice exception agent';
  const INTAKE = 'Normalize exception';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const erp = { kind: 'header' };

  // ---------- intake ----------
  wf.add(webhook('Match exception raised', [0, 0], 'aelix/manufacturing/invoice-exception', wf.slug));
  wf.add(config('Config', [220, 0], {
    erp_base_url: 'https://erp-gateway.YOUR-COMPANY.example/api/v1',
    price_tolerance_pct: 2,
    max_auto_variance_amount: 500,
    min_confidence: 0.85,
    duplicate_lookback_days: 120,
    slack_channel: '#ap-exceptions',
  }));
  wf.add(code(INTAKE, [440, 0], `
const b = $json.body ?? $json;
const missing = ['invoice_id', 'vendor_id', 'po_number'].filter((k) => !b[k]);
if (missing.length) throw new Error('Invoice exception missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(b.invoice_id),
    invoice_id: String(b.invoice_id),
    invoice_number: String(b.invoice_number ?? ''),
    vendor_id: String(b.vendor_id),
    po_number: String(b.po_number),
    // null when the request carries no amount, so the guardrail can tell 'not given' from 0.
    // A non-numeric amount is kept as text so the guardrail sees it and escalates.
    amount: b.amount == null || b.amount === '' ? null : Number.isFinite(Number(b.amount)) ? Number(b.amount) : String(b.amount),
    currency: String(b.currency ?? 'USD').toUpperCase(),
    exception_code: String(b.exception_code ?? 'UNSPECIFIED'),
  },
};
`));
  wf.chain('Match exception raised', 'Config', INTAKE);

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 700,
    prompt: `=Invoice {{ $json.invoice_id }} (vendor invoice number {{ $json.invoice_number || 'not given' }}) failed three-way match.
Vendor id: {{ $json.vendor_id }}
PO number: {{ $json.po_number }}
Invoice amount: {{ $json.amount ?? 'not given' }} {{ $json.currency }}
Exception code from the ERP: {{ $json.exception_code }}
Tolerance for this run: {{ ${cfg}.price_tolerance_pct }}% and at most {{ ${cfg}.max_auto_variance_amount }} {{ $json.currency }} in total

Find out why it failed, and recommend how to resolve it.`,
    system: `
You resolve accounts-payable invoice exceptions for a manufacturer. An invoice failed three-way match (purchase order, goods receipt, invoice). Your job is to find the cause line by line and recommend a resolution. AP clerks act on anything you do not clear.

How to work the exception:
- Read the invoice lines, the PO lines and the goods receipts. Match lines by PO line number, then by item number.
- For every mismatched line, record PO quantity, received quantity, invoiced quantity, PO unit price, invoiced unit price and the variance amount.
- Compute variance exactly like this, because code recomputes it the same way and compares: line variance = (invoiced unit price minus PO unit price) times invoiced quantity. total_variance_amount = the sum of line variances over every invoice line (lines with no price difference add 0). Keep the sign: under-billing is negative. Variance percent = total variance divided by the sum of PO unit price times invoiced quantity, times 100. Quantity shortfalls are not part of the variance; report them through received and invoiced quantity.
- Check for duplicates: search the vendor's recent invoices for another invoice with the same vendor invoice number, or the same amount on the same PO.
- Look at the vendor record for payment terms and the AP contact.

Recommendations:
- approve_within_tolerance: only price variance, every invoiced quantity was received, and the total variance is inside the stated tolerance.
- hold_for_receipt: invoiced quantity exceeds received quantity and the goods may still be arriving.
- request_credit_note: the vendor overbilled beyond tolerance.
- reject_duplicate: this invoice duplicates one already recorded.
- escalate: anything else, including missing PO, freight or tax disputes, or records that contradict each other.

For every recommendation except approval, draft the email to the vendor's AP contact. A clerk reviews and sends it.

Tools:
- "Get invoice (ERP)", "Get purchase order (ERP)", "List goods receipts (ERP)", "Get vendor (ERP)": read records.
- "Search vendor invoices (ERP)": recent invoices for a vendor, for the duplicate check.
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Get invoice (ERP)',
        description: 'Get a supplier invoice with its lines (line number, PO line, item, quantity, unit price, amount), status and dates.',
        url: `={{ ${cfg}.erp_base_url }}/invoices/{{ $fromAI('invoice_id', 'ERP invoice id', 'string') }}`,
        auth: erp,
      },
      {
        name: 'Get purchase order (ERP)',
        description: 'Get a purchase order with its lines (line number, item, ordered quantity, unit price, unit of measure).',
        url: `={{ ${cfg}.erp_base_url }}/purchase-orders/{{ $fromAI('po_number', 'Purchase order number', 'string') }}`,
        auth: erp,
      },
      {
        name: 'List goods receipts (ERP)',
        description: 'List goods receipts posted against a purchase order, with received quantity per PO line and receipt date.',
        url: `={{ ${cfg}.erp_base_url }}/purchase-orders/{{ $fromAI('po_number', 'Purchase order number', 'string') }}/receipts`,
        auth: erp,
      },
      {
        name: 'Get vendor (ERP)',
        description: 'Get a vendor record: legal name, payment terms, AP contact name and email.',
        url: `={{ ${cfg}.erp_base_url }}/vendors/{{ $fromAI('vendor_id', 'ERP vendor id', 'string') }}`,
        auth: erp,
      },
      {
        name: 'Search vendor invoices (ERP)',
        description: 'List a vendor\'s invoices from the last 120 days (id, vendor invoice number, amount, date, status). Use for the duplicate check.',
        url: `={{ ${cfg}.erp_base_url }}/vendors/{{ $fromAI('vendor_id', 'ERP vendor id', 'string') }}/invoices`,
        auth: erp,
        query: { since_days: '120' },
      },
    ],
    schema: S.obj({
      exception_type: S.enum(['price_variance', 'quantity_variance', 'missing_receipt', 'duplicate_invoice', 'unknown_po', 'tax_or_freight', 'other'], 'Main cause.'),
      line_findings: S.arr(S.obj({
        line: S.str('Invoice line number.'),
        po_qty: S.num('Ordered quantity.'),
        received_qty: S.num('Received quantity.'),
        invoiced_qty: S.num('Invoiced quantity.'),
        po_unit_price: S.num('PO unit price.'),
        invoiced_unit_price: S.num('Invoiced unit price.'),
        variance_amount: S.num('(invoiced unit price minus PO unit price) times invoiced quantity. Signed.'),
      }), 'One entry per mismatched line.'),
      total_variance_amount: S.num('Sum of line variances over every invoice line. Signed.'),
      duplicate_of_invoice_id: S.nullable(S.str('Existing invoice this duplicates, or null.')),
      recommended_action: S.enum(['approve_within_tolerance', 'hold_for_receipt', 'request_credit_note', 'reject_duplicate', 'escalate'], 'Recommended resolution.'),
      vendor_email_draft: S.obj({ to: S.str('Vendor AP email.'), subject: S.str('Subject.'), body: S.str('Body. Reviewed by a clerk before sending.') }),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link(INTAKE, AGENT);

  // ---------- guardrails ----------
  // Every agent result is checked in code, not only approvals: the clerk sees what the code found,
  // and a duplicate is caught even when the model recommends something else.
  const gx = block.right + 140;
  const MATCH = 'Re-read three-way match (ERP)';
  const HISTORY = 'Re-read vendor invoices (ERP)';
  wf.add(http(MATCH, [gx, 0], {
    url: `={{ ${cfg}.erp_base_url }}/invoices/{{ $('${INTAKE}').item.json.invoice_id }}/match`,
    auth: erp,
    errorOutput: true,
  }));
  wf.add(http(HISTORY, [gx + 220, 0], {
    url: `={{ ${cfg}.erp_base_url }}/vendors/{{ $('${INTAKE}').item.json.vendor_id }}/invoices`,
    auth: erp,
    query: { since_days: `={{ ${cfg}.duplicate_lookback_days }}` },
    errorOutput: true,
  }));
  wf.add(code(GUARD, [gx + 440, 0], `
${guardPreamble(AGENT)}
const req = $('${INTAKE}').item.json;
const m = $('${MATCH}').item.json; // fresh three-way match view: { status, lines: [{ line, received_qty, invoiced_qty, po_unit_price, invoiced_unit_price, already_invoiced_qty? }] }
const hist = $json; // fresh vendor invoice history: { invoices: [{ id, invoice_number, po_number, amount, currency, status }] }

// Only finite numbers count. null, '', missing or text become NaN and stop the approval.
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const fin = Number.isFinite;

if (out && out.recommended_action !== 'approve_within_tolerance') reasons.push('agent recommends ' + out.recommended_action + ', not approval');

// Recompute the variance here instead of trusting the agent's arithmetic:
// sum over every line of (invoiced unit price - PO unit price) * invoiced quantity.
const lines = Array.isArray(m.lines) ? m.lines : [];
if (!Array.isArray(m.lines)) reasons.push('match view has no lines array');
else if (!lines.length) reasons.push('match view returned no lines');
let variance = 0;
let poValue = 0;
let invoicedValue = 0;
for (const l of lines) {
  const f = { received_qty: num(l.received_qty), invoiced_qty: num(l.invoiced_qty), po_unit_price: num(l.po_unit_price), invoiced_unit_price: num(l.invoiced_unit_price) };
  const bad = Object.keys(f).filter((k) => !fin(f[k]));
  if (bad.length) { reasons.push('line ' + l.line + ' has no usable ' + bad.join(', ') + ' in the match view'); variance = NaN; continue; }
  if (f.invoiced_qty > f.received_qty) reasons.push('line ' + l.line + ' invoiced ' + f.invoiced_qty + ' but received ' + f.received_qty);
  if (l.already_invoiced_qty != null) {
    const already = num(l.already_invoiced_qty);
    if (!fin(already)) reasons.push('line ' + l.line + ' has an unusable already_invoiced_qty');
    else if (already + f.invoiced_qty > f.received_qty) reasons.push('line ' + l.line + ' already invoiced ' + already + ' plus ' + f.invoiced_qty + ' on this invoice exceeds received ' + f.received_qty + '; possible duplicate billing');
  }
  variance += (f.invoiced_unit_price - f.po_unit_price) * f.invoiced_qty;
  poValue += f.po_unit_price * f.invoiced_qty;
  invoicedValue += f.invoiced_unit_price * f.invoiced_qty;
}
const pct = poValue > 0 ? (variance / poValue) * 100 : NaN;
if (lines.length && fin(variance) && !(poValue > 0)) reasons.push('PO value of the invoiced lines is ' + poValue + '; cannot compute a variance percent');
const computable = fin(variance) && fin(pct);
if (lines.length && !computable) reasons.push('variance could not be computed from the match view');

if (m.status !== 'match_exception') reasons.push('invoice status is now ' + m.status);
if (computable) {
  if (variance < 0) reasons.push('invoice is under PO price; confirm with the vendor before approving');
  if (Math.abs(variance) > cfg.max_auto_variance_amount) reasons.push('variance ' + variance.toFixed(2) + ' above ' + cfg.max_auto_variance_amount);
  if (Math.abs(pct) > cfg.price_tolerance_pct) reasons.push('variance ' + pct.toFixed(2) + '% above ' + cfg.price_tolerance_pct + '%');
  if (out && !(Math.abs(num(out.total_variance_amount) - variance) <= 0.01)) reasons.push('agent variance ' + out.total_variance_amount + ' differs from recomputed ' + variance.toFixed(2));
}
if (out?.duplicate_of_invoice_id) reasons.push('agent flagged a possible duplicate of ' + out.duplicate_of_invoice_id);

// Duplicate check on the vendor's fresh invoice history, independent of what the agent found.
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normPo = (s) => norm(s).replace(/^PO/, '');
const history = Array.isArray(hist.invoices) ? hist.invoices : null;
if (!history) reasons.push('vendor invoice history unavailable; duplicate check not possible');
const self = (history ?? []).find((i) => String(i.id ?? '') === req.invoice_id) ?? null;
const others = (history ?? []).filter((i) => String(i.id ?? '') !== req.invoice_id);

// Intake amount against the ERP's own invoice total, when both are present.
const erpTotal = [self?.amount, m.invoice_total, m.total_amount].map(num).find(fin);
if (req.amount != null && !fin(num(req.amount))) reasons.push('intake amount ' + req.amount + ' is not a number');
if (fin(num(req.amount)) && erpTotal !== undefined && Math.abs(num(req.amount) - erpTotal) > 0.01) reasons.push('intake amount ' + req.amount + ' differs from ERP invoice total ' + erpTotal);
if (self?.currency && req.currency && String(self.currency).toUpperCase() !== req.currency) reasons.push('intake currency ' + req.currency + ' differs from ERP ' + self.currency);

const myNumbers = new Set([req.invoice_number, self?.invoice_number].map(norm).filter(Boolean));
const myAmount = [erpTotal, num(req.amount), invoicedValue].find((v) => fin(v) && v > 0);
const myPo = normPo(req.po_number);
const dupes = [];
for (const o of others) {
  if (myNumbers.has(norm(o.invoice_number))) dupes.push(o.id + ' has the same vendor invoice number ' + o.invoice_number + ' (status ' + o.status + ')');
  else if (myPo && normPo(o.po_number) === myPo && fin(num(o.amount)) && myAmount !== undefined && Math.abs(num(o.amount) - myAmount) <= 0.01) dupes.push(o.id + ' has the same amount ' + o.amount + ' on PO ' + o.po_number + ' (status ' + o.status + ')');
}
for (const d of dupes) reasons.push('possible duplicate: ' + d);

const ok = reasons.length === 0;
const v2 = fin(variance) ? Number(variance.toFixed(2)) : null;
const p3 = fin(pct) ? Number(pct.toFixed(3)) : null;
return {
  json: {
    business_key: req.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    variance: v2,
    variance_pct: p3,
    erp_invoice_total: erpTotal ?? null,
    duplicate_candidates: dupes,
    planned_actions: ok ? [{ action: 'erp.approve_invoice', invoice_id: req.invoice_id, reason_code: 'PRICE_VARIANCE_WITHIN_TOLERANCE', variance: v2, variance_pct: p3 }] : [],
  },
};
`));
  wf.add(ifTrue('Within tolerance?', [gx + 660, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, MATCH, 0);
  wf.link(MATCH, HISTORY, 0);
  wf.link(HISTORY, GUARD, 0);
  wf.link(GUARD, 'Within tolerance?');

  // ---------- act & verify ----------
  const ax = gx + 920;
  wf.add(http('Approve with variance (ERP)', [ax, 0], {
    method: 'POST',
    url: `={{ ${cfg}.erp_base_url }}/invoices/{{ $('${INTAKE}').item.json.invoice_id }}/approve`,
    auth: erp,
    headers: { 'Idempotency-Key': `=approve-{{ $('${INTAKE}').item.json.invoice_id }}` },
    json: `={{ JSON.stringify({ reason_code: $json.planned_actions[0].reason_code, variance_amount: $json.planned_actions[0].variance, variance_pct: $json.planned_actions[0].variance_pct, approved_by: 'aelix-invoice-agent', n8n_execution_id: $execution.id }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Read back invoice (ERP)', [ax + 220, 0], {
    url: `={{ ${cfg}.erp_base_url }}/invoices/{{ $('${INTAKE}').item.json.invoice_id }}`,
    auth: erp,
    errorOutput: true,
  }));
  wf.add(code('Verify approval', [ax + 440, 0], `
// The approval counts only if the ERP recorded exactly what the guardrail planned.
const plan = $('${GUARD}').item.json.planned_actions?.[0] ?? null;
const inv = $json;
const rec = inv.approval ?? null;
const problems = [];
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
if (!plan) problems.push('no planned approval found');
if (inv.status !== 'approved') problems.push('invoice status is ' + inv.status + ' after approval call');
if (plan && inv.id != null && String(inv.id) !== plan.invoice_id) problems.push('read back invoice ' + inv.id + ', expected ' + plan.invoice_id);
if (!rec) problems.push('no approval record on the invoice');
if (rec && plan) {
  if (rec.reason_code !== plan.reason_code) problems.push('recorded reason code ' + rec.reason_code + ', planned ' + plan.reason_code);
  if (!(Math.abs(num(rec.variance_amount) - plan.variance) <= 0.005)) problems.push('recorded variance ' + rec.variance_amount + ', planned ' + plan.variance);
  if (rec.variance_pct != null && !(Math.abs(num(rec.variance_pct) - plan.variance_pct) <= 0.0005)) problems.push('recorded variance percent ' + rec.variance_pct + ', planned ' + plan.variance_pct);
}
const ok = problems.length === 0;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: problems.join('; '),
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 660, 0], '={{ $json.verified }}'));
  wf.add(setFields('Mark completed', [ax + 880, 0], { outcome: 'completed' }));
  wf.link('Within tolerance?', 'Approve with variance (ERP)', 0);
  wf.link('Approve with variance (ERP)', 'Read back invoice (ERP)', 0);
  wf.link('Read back invoice (ERP)', 'Verify approval', 0);
  wf.link('Verify approval', 'Verified?');
  wf.link('Verified?', 'Mark completed', 0);

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax, y: 560, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'AP clerks', channel: `={{ ${cfg}.slack_channel }}`,
    summary: `'Invoice ' + intake.invoice_id + ' (PO ' + intake.po_number + ') · ' + (agent?.output?.exception_type ?? 'unknown') + ' · recommends ' + (agent?.output?.recommended_action ?? 'review') + (String(agent?.output?.vendor_email_draft?.to ?? '').trim() && String(agent?.output?.vendor_email_draft?.body ?? '').trim() ? ' · vendor email drafted' : ' · no vendor email drafted')`,
  });
  wf.link(AGENT, h.first, 1);
  wf.link(MATCH, h.first, 1);
  wf.link(HISTORY, h.first, 1);
  wf.link('Within tolerance?', h.first, 1);
  wf.link('Approve with variance (ERP)', h.first, 1);
  wf.link('Read back invoice (ERP)', h.first, 1);
  wf.link('Verified?', h.first, 1);

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1200, y: 280, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: ['Match exception raised', 'Config', INTAKE], body: `
The ERP (or its integration layer) posts every invoice that fails three-way match. **Config** holds the tolerance (percent and absolute), the confidence floor and the Slack channel.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Match (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude reads invoice, PO, goods receipts and vendor, compares line by line, checks for duplicates, and recommends: approve within tolerance, hold for receipt, request a credit note, reject as duplicate, or escalate.
For anything but approval it **drafts** the vendor email. It never sends it.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: [MATCH, HISTORY, GUARD, 'Within tolerance?'], body: `
Every agent result is checked here. The match view and the vendor's invoice history are **re-read**, and the variance is **recomputed in code** as the sum of (invoiced price minus PO price) times invoiced quantity. Any missing or non-numeric figure stops the approval.
Approve only when the agent recommends it, every line was received and not already billed, the variance is positive and inside both tolerances, the invoice is still in exception, the agent's math agrees, the intake amount matches the ERP total, and no other invoice has the same vendor invoice number or the same amount on the same PO.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Act and verify', color: COLOR.act, nodes: ['Approve with variance (ERP)', 'Read back invoice (ERP)', 'Verify approval', 'Verified?', 'Mark completed'], body: `
Approves with a reason code and an idempotency key, then reads the invoice back. It counts only if the ERP shows **approved** with the planned reason code and variance.` });
  wf.group({ name: 'Stage: hand off', title: '5 · Draft and escalate', color: COLOR.handoff, nodes: h.nodes, body: `
Holds, credit-note requests, duplicates and every stopped approval go to AP with the code's findings, the line findings, the drafted vendor email when there is one, and the full tool trace. A clerk edits and sends.` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per exception.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    overview: `## Manufacturing · Invoice exception agent
**Job:** take three-way-match exceptions off the AP desk. Find the cause line by line, clear small price variances inside tolerance, and hand everything else to a clerk with the findings and a drafted vendor email.

**Flow:** intake → agent matches and recommends (read-only) → guardrails re-read and recompute → approve, read back → draft and escalate the rest → audit.

**Never does**
- Approves quantity variances or unreceived goods
- Approves anything outside tolerance, or under-billing
- Approves a possible duplicate, or a line with a missing figure
- Emails vendors. Drafts only.
- Changes PO or receipt records

**Model:** Claude Opus 5, adaptive thinking, effort high.`,
    setup: `## Setup
1. Run **sql/schema.sql**. Select the Postgres credential on *Queue exception* and *Write audit record*.
2. Credentials: **Anthropic**, **Header Auth** for the ERP gateway, **Slack**.
3. **ERP endpoints are a thin gateway contract**: invoices, purchase-orders, receipts, vendors, vendor invoice history, the /match view and /approve. Map them to SAP (API_SUPPLIERINVOICE_PROCESS_SRV, API_PURCHASEORDER_PROCESS_SRV), Oracle Fusion Payables, or D365 in your integration layer, or edit the URLs here.
4. Edit **Config**: tolerances, confidence floor, duplicate lookback days, channel.
5. Test: \`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/manufacturing-invoice-exception.json\``,
  });

  return wf;
}
