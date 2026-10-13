// Manufacturing: deterministic Code nodes from workflows/03-manufacturing-invoice-exception.json, run against fixed scenarios.

import assert from 'node:assert/strict';
import { load, run, test } from '../helpers.mjs';

const wf = load('03-manufacturing-invoice-exception.json');
console.log('Manufacturing · Invoice exception');
const Config = { price_tolerance_pct: 2, max_auto_variance_amount: 500, min_confidence: 0.85, duplicate_lookback_days: 120 };
const req = { business_key: 'INV-1', invoice_id: 'INV-1', invoice_number: 'NFW-0912', vendor_id: 'V-1', po_number: '4500001', amount: 1015, currency: 'USD' };
const lines = [{ line: '1', received_qty: 100, invoiced_qty: 100, po_unit_price: 10, invoiced_unit_price: 10.15 }];
const agent = (o = {}) => ({ output: { recommended_action: 'approve_within_tolerance', total_variance_amount: 15, duplicate_of_invoice_id: null, confidence: 0.92, ...o } });
const self = { id: 'INV-1', invoice_number: 'NFW-0912', po_number: '4500001', amount: 1015, currency: 'USD', status: 'match_exception' };
const older = { id: 'INV-0', invoice_number: 'NFW-0788', po_number: '4500000', amount: 1500, currency: 'USD', status: 'paid' };
const history = (...extra) => ({ invoices: [self, older, ...extra] });
// m: the re-read match view; h: the re-read vendor invoice history (the Guardrails node's direct input).
const g = (m, a = agent(), h = history(), r = req) => run(wf, 'Guardrails', {
  json: h,
  nodes: { Config, 'Normalize exception': r, 'Invoice exception agent': a, 'Re-read three-way match (ERP)': m },
});
const has = (out, re) => assert.ok(out.guardrail_reasons.some((x) => re.test(x)), 'reasons: ' + out.guardrail_reasons.join('; '));

test('1.5% price variance approves', () => {
  const out = g({ status: 'match_exception', lines });
  assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
  assert.equal(out.variance, 15);
  assert.equal(out.planned_actions[0].reason_code, 'PRICE_VARIANCE_WITHIN_TOLERANCE');
});
test('quantity over receipt escalates', () => assert.equal(g({ status: 'match_exception', lines: [{ ...lines[0], received_qty: 90 }] }).route, 'escalate'));
test('5% variance escalates', () => assert.equal(g({ status: 'match_exception', lines: [{ ...lines[0], invoiced_unit_price: 10.5 }] }, agent({ total_variance_amount: 50 })).route, 'escalate'));
test('agent arithmetic mismatch escalates', () => assert.equal(g({ status: 'match_exception', lines }, agent({ total_variance_amount: 5 })).route, 'escalate'));
test('status changed underneath escalates', () => assert.equal(g({ status: 'approved', lines }).route, 'escalate'));

// Finding 1: deterministic duplicate check on the re-read vendor invoice history.
test('same vendor invoice number on another invoice escalates even if the agent saw no duplicate', () => {
  const out = g({ status: 'match_exception', lines }, agent(), history({ id: 'INV-9', invoice_number: 'nfw 0912', po_number: '4599999', amount: 77, status: 'paid' }));
  assert.equal(out.route, 'escalate');
  has(out, /possible duplicate: INV-9 has the same vendor invoice number/);
});
test('same amount on the same PO escalates', () => {
  const out = g({ status: 'match_exception', lines }, agent(), history({ id: 'INV-8', invoice_number: 'OTHER-1', po_number: 'PO-4500001', amount: 1015, status: 'paid' }));
  assert.equal(out.route, 'escalate');
  has(out, /possible duplicate: INV-8 has the same amount 1015 on PO/);
});
test('same amount on a different PO does not count as a duplicate', () => {
  const out = g({ status: 'match_exception', lines }, agent(), history({ id: 'INV-7', invoice_number: 'OTHER-2', po_number: '4500002', amount: 1015, status: 'paid' }));
  assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
});
test('the invoice itself in the history is not a duplicate', () => assert.equal(g({ status: 'match_exception', lines }, agent(), { invoices: [self] }).route, 'auto'));
test('missing vendor invoice history escalates', () => has(g({ status: 'match_exception', lines }, agent(), {}), /vendor invoice history unavailable/));
test('duplicate is found by code when the agent recommends rejection (live case SI-E2E-3103 shape)', () => {
  const m = { status: 'match_exception', lines: [{ line: '1', received_qty: 100, already_invoiced_qty: 100, invoiced_qty: 100, po_unit_price: 18.75, invoiced_unit_price: 18.75 }] };
  const r = { business_key: 'SI-3103', invoice_id: 'SI-3103', invoice_number: 'HH-88412', vendor_id: 'V-3', po_number: '4500093103', amount: 1875, currency: 'USD' };
  const h = { invoices: [
    { id: 'SI-3103', invoice_number: 'HH-88412', po_number: '4500093103', amount: 1875, currency: 'USD', status: 'match_exception' },
    { id: 'SI-3090', invoice_number: 'HH-88412', po_number: '4500093103', amount: 1875, currency: 'USD', status: 'paid' },
  ] };
  const out = g(m, agent({ recommended_action: 'reject_duplicate', total_variance_amount: 0, duplicate_of_invoice_id: null }), h, r);
  assert.equal(out.route, 'escalate');
  has(out, /possible duplicate: SI-3090 has the same vendor invoice number HH-88412/);
  has(out, /already invoiced 100 plus 100 on this invoice exceeds received 100/);
  has(out, /agent recommends reject_duplicate, not approval/);
});
test('a model approval of a duplicate with zero variance is still stopped', () => {
  const m = { status: 'match_exception', lines: [{ line: '1', received_qty: 100, invoiced_qty: 100, po_unit_price: 18.75, invoiced_unit_price: 18.75 }] };
  const r = { ...req, invoice_number: 'HH-88412', amount: 1875 };
  const h = { invoices: [{ ...self, amount: 1875, invoice_number: 'HH-88412' }, { id: 'SI-3090', invoice_number: 'HH-88412', po_number: '4500001', amount: 1875, status: 'paid' }] };
  const out = g(m, agent({ total_variance_amount: 0 }), h, r);
  assert.equal(out.route, 'escalate');
  assert.deepEqual(out.planned_actions, []);
});

// Finding 2: missing or non-numeric figures fail closed.
for (const k of ['invoiced_unit_price', 'po_unit_price', 'received_qty', 'invoiced_qty']) {
  test(`missing ${k} on a match line escalates`, () => {
    const l = { ...lines[0] };
    delete l[k];
    const out = g({ status: 'match_exception', lines: [l] });
    assert.equal(out.route, 'escalate');
    has(out, new RegExp('line 1 has no usable ' + k));
  });
}
test('null or text figures on a match line escalate', () => {
  assert.equal(g({ status: 'match_exception', lines: [{ ...lines[0], received_qty: null }] }).route, 'escalate');
  assert.equal(g({ status: 'match_exception', lines: [{ ...lines[0], invoiced_unit_price: 'n/a' }] }).route, 'escalate');
});
test('empty lines array escalates', () => has(g({ status: 'match_exception', lines: [] }, agent({ total_variance_amount: 0 })), /no lines/));
test('missing lines field escalates', () => has(g({ status: 'match_exception' }, agent({ total_variance_amount: 0 })), /no lines array/));
test('zero PO value escalates', () => {
  const out = g({ status: 'match_exception', lines: [{ ...lines[0], po_unit_price: 0, invoiced_unit_price: 0 }] }, agent({ total_variance_amount: 0 }));
  assert.equal(out.route, 'escalate');
  has(out, /cannot compute a variance percent/);
});
test('non-numeric agent total escalates', () => assert.equal(g({ status: 'match_exception', lines }, agent({ total_variance_amount: null })).route, 'escalate'));

// Finding 3: the prompt's variance definition matches the code (signed sum over all lines of price diff times invoiced qty).
test('variance is the signed sum of (invoiced price - PO price) * invoiced qty over every line', () => {
  const two = [lines[0], { line: '2', received_qty: 50, invoiced_qty: 50, po_unit_price: 4, invoiced_unit_price: 4 }];
  const h = { invoices: [{ ...self, amount: 1215 }] };
  const out = g({ status: 'match_exception', lines: two }, agent(), h, { ...req, amount: 1215 });
  assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
  assert.equal(out.variance, 15);
  assert.equal(out.variance_pct, 1.25);
  const prompt = wf.nodes.find((n) => n.name === 'Invoice exception agent').parameters.options.systemMessage;
  assert.match(prompt, /\(invoiced unit price minus PO unit price\) times invoiced quantity/);
  assert.match(prompt, /sum of line variances over every invoice line/);
});

// Finding 5b: intake amount against the ERP invoice total.
test('intake amount differing from the ERP total escalates', () => has(g({ status: 'match_exception', lines }, agent(), history(), { ...req, amount: 900 }), /intake amount 900 differs from ERP invoice total 1015/));
test('no intake amount skips the total comparison', () => assert.equal(g({ status: 'match_exception', lines }, agent(), history(), { ...req, amount: null }).route, 'auto'));
test('non-numeric intake amount escalates', () => {
  const r = run(wf, 'Normalize exception', { json: { body: { invoice_id: 'INV-1', vendor_id: 'V-1', po_number: '4500001', amount: 'ten' } } });
  assert.equal(r.amount, 'ten');
  assert.equal(run(wf, 'Normalize exception', { json: { body: { invoice_id: 'INV-1', vendor_id: 'V-1', po_number: '4500001' } } }).amount, null);
  has(g({ status: 'match_exception', lines }, agent(), history(), { ...req, amount: r.amount }), /intake amount ten is not a number/);
});

// Finding 5a: the approval read-back must show what was planned.
const plan = { route: 'auto', planned_actions: [{ action: 'erp.approve_invoice', invoice_id: 'INV-1', reason_code: 'PRICE_VARIANCE_WITHIN_TOLERANCE', variance: 15, variance_pct: 1.5 }] };
const approval = { approval_id: 'APR-INV-1', reason_code: 'PRICE_VARIANCE_WITHIN_TOLERANCE', variance_amount: 15, variance_pct: 1.5, approved_by: 'aelix-invoice-agent' };
const v = (json) => run(wf, 'Verify approval', { json, nodes: { Guardrails: plan } });
test('read-back with the planned reason code and variance verifies', () => assert.equal(v({ id: 'INV-1', status: 'approved', approval }).verified, true));
test('read-back not approved fails', () => assert.equal(v({ id: 'INV-1', status: 'match_exception', approval: null }).verify_failed, true));
test('read-back with a different variance fails', () => {
  const out = v({ id: 'INV-1', status: 'approved', approval: { ...approval, variance_amount: 150 } });
  assert.equal(out.verified, false);
  assert.match(out.verify_detail, /recorded variance 150, planned 15/);
});
test('read-back with a different reason code fails', () => assert.equal(v({ id: 'INV-1', status: 'approved', approval: { ...approval, reason_code: 'MANUAL' } }).verified, false));
test('read-back with no approval record fails', () => assert.equal(v({ id: 'INV-1', status: 'approved' }).verified, false));
test('read-back of another invoice fails', () => assert.equal(v({ id: 'INV-2', status: 'approved', approval }).verified, false));

// Finding 4: the Slack summary mentions a vendor email only when one was drafted.
const be = (nodes, json = {}) => run(wf, 'Build exception', { json, nodes });
test('summary says the vendor email was drafted when there is a draft', () => {
  const out = be({ 'Normalize exception': { ...req }, 'Invoice exception agent': agent({ recommended_action: 'hold_for_receipt', exception_type: 'quantity_variance', vendor_email_draft: { to: 'ap@vendor.example', subject: 'Hold', body: 'Hello' } }) });
  assert.match(out.summary, /· vendor email drafted$/);
});
test('summary does not claim a vendor email after a system error', () => {
  const out = be({ 'Normalize exception': { ...req } }, { error: { message: 'ERP timeout' } });
  assert.doesNotMatch(out.summary, /· vendor email drafted/);
  assert.match(out.summary, /no vendor email drafted/);
});
test('summary does not claim a vendor email when the draft is empty', () => {
  const out = be({ 'Normalize exception': { ...req }, 'Invoice exception agent': agent({ vendor_email_draft: { to: '', subject: '', body: '' } }) });
  assert.match(out.summary, /no vendor email drafted/);
});
