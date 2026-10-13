// FinTech product agents: guardrails, verification and approval recording.
import { assert, loadProduct, run, test, section, done, days } from '../harness.mjs';

// ---------------- Aelix CoreLink · Payment Exception Agent ----------------
{
  const wf = loadProduct('fintech', 'corelink-payment-exception');
  section('Aelix CoreLink · Payment Exception Agent');
  const Config = {
    max_retries: 2, min_confidence: 0.85, approver_slack_user: 'payments-ops-lead', approval_timeout_hours: 4,
    rail_limits: { UPI: { min: 1, max: 100000 }, IMPS: { min: 1, max: 500000 }, NEFT: { min: 1, max: 1e9 }, RTGS: { min: 200000, max: 1e9 } },
  };
  const req = { business_key: 'PAY-1', payment_id: 'PAY-1', rail: 'IMPS', amount: 185000, currency: 'INR' };
  const agent = (o = {}) => ({ output: { root_cause: 'rail_timeout', debtor_debited: true, recommendation: 'retry_same_rail', target_rail: null, confidence: 0.9, rationale: 'IMPS recovered.', ...o } });
  const pay = (o = {}) => ({ payment_id: 'PAY-1', status: 'failed', rail: 'IMPS', amount: 185000, retry_count: 0, debit_status: 'debited', reversal_status: 'none', ...o });
  const g = (json, a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize failure event': req, 'Payment exception agent': a } });

  test('retry on a healthy rail goes to the approver', () => {
    const out = g(pay());
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.deepEqual(out.action, { type: 'retry_same_rail', payment_id: 'PAY-1', rail: 'IMPS', amount: 185000 });
    assert.match(out.approval_summary, /retry_same_rail/);
  });
  test('retry limit reached escalates', () => assert.equal(g(pay({ retry_count: 2 })).route, 'escalate'));
  test('reroute to UPI above its limit escalates', () => assert.equal(g(pay(), agent({ recommendation: 'reroute', target_rail: 'UPI' })).route, 'escalate'));
  test('reroute to NEFT within limits goes to the approver', () => assert.equal(g(pay(), agent({ recommendation: 'reroute', target_rail: 'NEFT' })).route, 'approve'));
  test('RTGS below its minimum escalates', () => assert.equal(g(pay({ amount: 50000 }), agent({ recommendation: 'reroute', target_rail: 'RTGS' })).route, 'escalate'));
  test('refund of an undebited payment escalates', () => assert.equal(g(pay({ debit_status: 'not_debited' }), agent({ recommendation: 'refund_to_source' })).route, 'escalate'));
  test('refund already reversed escalates', () => assert.equal(g(pay({ reversal_status: 'reversed' }), agent({ recommendation: 'refund_to_source' })).route, 'escalate'));
  test('payment no longer failed escalates', () => assert.equal(g(pay({ status: 'settled' })).route, 'escalate'));
  test('suspected fraud escalates', () => assert.equal(g(pay(), agent({ root_cause: 'suspected_fraud' })).route, 'escalate'));
  test('low confidence escalates', () => assert.equal(g(pay(), agent({ confidence: 0.6 })).route, 'escalate'));

  test('approval click is recorded with the named approver', () => {
    const r = run(wf, 'Record approval', { json: { data: { approved: true, respondedAt: '2026-10-13T10:00:00Z' } }, nodes: { Config } });
    assert.deepEqual([r.decision, r.approver, r.decided_at], ['approved', 'payments-ops-lead', '2026-10-13T10:00:00Z']);
  });
  test('decline is recorded as declined', () => assert.equal(run(wf, 'Record approval', { json: { data: { approved: false } }, nodes: { Config } }).decision, 'declined'));
  test('no answer is a timeout with a hand-off reason', () => {
    const r = run(wf, 'Record approval', { json: {}, nodes: { Config } });
    assert.equal(r.decision, 'timed_out');
    assert.match(r.handoff_reason, /timed out/);
  });

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts a retry now processing on the planned rail', () => assert.equal(v({ status: 'processing', rail: 'IMPS' }, { type: 'retry_same_rail', rail: 'IMPS' }).verified, true));
  test('verify rejects a reroute that stayed on the old rail', () => assert.equal(v({ status: 'processing', rail: 'IMPS' }, { type: 'reroute', rail: 'NEFT' }).verified, false));
  test('verify accepts an initiated reversal', () => assert.equal(v({ status: 'reversal_initiated', rail: 'IMPS' }, { type: 'refund_to_source', rail: 'IMPS' }).verified, true));
}

// ---------------- Aelix Guardian · SAR Drafting Agent ----------------
{
  const wf = loadProduct('fintech', 'guardian-sar-drafting');
  section('Aelix Guardian · SAR Drafting Agent');
  const Config = { filing_days_from_detection: 30, max_narrative_chars: 17000, min_confidence: 0.75, reviewer_slack_user: 'bsa-officer' };
  const req = { business_key: 'AML-1', case_id: 'AML-1', detected_on: '2026-10-06' };
  const txns = { transactions: [
    { id: 't1', date: '2026-09-02T10:00:00Z', amount: 9500 },
    { id: 't2', date: '2026-09-04T10:00:00Z', amount: 9800 },
    { id: 't3', date: '2026-09-09T10:00:00Z', amount: 9700.5 },
  ] };
  const agent = (o = {}) => ({ output: {
    narrative: 'x'.repeat(1200), categories: [{ category: 'Structuring', subtype: 'Transactions below CTR threshold' }],
    activity_from: '2026-09-02', activity_to: '2026-09-09', amount_involved: 29000.5, subject_type: 'individual',
    instruments: ['cash'], continuing_activity: false, missing_information: [], confidence: 0.85, ...o } });
  const g = (json = txns, a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize case decision': req, 'SAR drafting agent': a } });

  test('consistent draft goes to the BSA officer', () => {
    const out = g();
    assert.equal(out.route, 'draft', out.guardrail_reasons.join('; '));
    assert.equal(out.draft.filing_deadline, '2026-11-05');
    assert.equal(out.draft.fields.amount_involved, 29000.5);
  });
  test('Slack summary carries no narrative or subject detail', () => assert.doesNotMatch(g().draft_summary, /x{20}|individual|Structuring/));
  test('amount that does not match the transactions escalates', () => assert.equal(g(txns, agent({ amount_involved: 30000 })).route, 'escalate'));
  test('date range that does not match escalates', () => assert.equal(g(txns, agent({ activity_from: '2026-08-30' })).route, 'escalate'));
  test('narrative over the limit escalates', () => assert.equal(g(txns, agent({ narrative: 'x'.repeat(17001) })).route, 'escalate'));
  test('missing facts travel with the draft instead of stopping it', () => {
    const out = g(txns, agent({ missing_information: ['subject occupation'] }));
    assert.equal(out.route, 'draft');
    assert.deepEqual(out.draft.missing_information, ['subject occupation']);
  });
  test('case with no flagged transactions escalates', () => assert.equal(g({ transactions: [] }).route, 'escalate'));
}

// ---------------- Aelix Guardian · Alert Triage Agent ----------------
{
  const wf = loadProduct('fintech', 'guardian-alert-triage');
  section('Aelix Guardian · Alert Triage Agent');
  const Config = { repeat_alert_threshold: 3, sar_min_amount: 5000, min_confidence: 0.8, approver_slack_user: 'aml-analyst-on-duty', approval_timeout_hours: 8 };
  const req = { business_key: 'ALR-1', alert_id: 'ALR-1', scenario_code: 'TM-STRUCT-04', customer_ref: 'CUST-00418873' };
  const alert = (o = {}) => ({ status: 'open', customer_ref: 'CUST-00418873', transactions: [{ id: 'TX1', amount: 9500 }, { id: 'TX2', amount: 9800 }],
    screening: { sanctions_match: false, pep_match: false }, prior_alert_count_365d: 0, ...o });
  const agent = (o = {}) => ({ output: { disposition: 'escalate', close_reason: null, typologies: ['structuring'],
    risk_indicators: [{ indicator: 'Two cash deposits just below the threshold in three days', evidence_ids: ['TX1', 'TX2'] }],
    total_flagged_amount: 19300, activity_fits_profile: false, confidence: 0.9, rationale: 'TX1 and TX2.', questions_for_human: [], ...o } });
  const close = { disposition: 'close', close_reason: 'explained_by_profile', typologies: [], risk_indicators: [] };
  const g = (json = alert(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize alert': req, 'Alert triage agent': a } });

  test('escalation with cited evidence goes to the analyst', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.case_status, 'escalated');
    assert.equal(out.action.total_flagged_amount, 19300);
  });
  test('Slack summary carries no customer ref', () => assert.doesNotMatch(g().approval_summary, /CUST-00418873/));
  test('file marks for the SAR process, nothing filed', () => {
    const out = g(alert(), agent({ disposition: 'file' }));
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.case_status, 'sar_pending');
    assert.match(out.approval_summary, /nothing is filed/);
  });
  test('file below the SAR amount floor escalates', () => assert.equal(
    g(alert({ transactions: [{ id: 'TX1', amount: 1000 }, { id: 'TX2', amount: 1200 }] }), agent({ disposition: 'file', total_flagged_amount: 2200 })).route, 'escalate'));
  test('documented close goes to the analyst', () => assert.equal(g(alert(), agent(close)).route, 'approve'));
  test('close with a sanctions match escalates', () => assert.equal(g(alert({ screening: { sanctions_match: true } }), agent(close)).route, 'escalate'));
  test('close with a repeat-alert pattern escalates', () => assert.equal(g(alert({ prior_alert_count_365d: 3 }), agent(close)).route, 'escalate'));
  test('close without a reason escalates', () => assert.equal(g(alert(), agent({ ...close, close_reason: null })).route, 'escalate'));
  test('flagged total that does not match the record escalates', () => assert.equal(g(alert(), agent({ total_flagged_amount: 18000 })).route, 'escalate'));
  test('evidence that cites no flagged transaction escalates', () => assert.equal(
    g(alert(), agent({ risk_indicators: [{ indicator: 'x', evidence_ids: ['TX99'] }] })).route, 'escalate'));
  test('alert already dispositioned escalates', () => assert.equal(g(alert({ status: 'closed' })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts the escalated disposition', () => assert.equal(v({ status: 'escalated', disposition: 'escalate' }, { disposition: 'escalate', case_status: 'escalated' }).verified, true));
  test('verify rejects a SAR filing flag', () => assert.equal(v({ status: 'sar_pending', disposition: 'file', sar_filed: true }, { disposition: 'file', case_status: 'sar_pending' }).verified, false));
  test('approval is recorded with the analyst role', () => assert.equal(run(wf, 'Record approval', { json: { data: { approved: true } }, nodes: { Config } }).approver, 'aml-analyst-on-duty'));
}

// ---------------- Aelix CreditFlow · Underwriting Copilot ----------------
{
  const wf = loadProduct('fintech', 'creditflow-underwriting-copilot');
  section('Aelix CreditFlow · Underwriting Copilot');
  const Config = {
    min_bureau_score: 700, max_bureau_age_days: 30, min_aa_months: 6, max_emi_bounces_6m: 1,
    max_foir: { personal_loan: 0.5, home_loan: 0.6, lap: 0.55 },
    rate_band_pct: { personal_loan: [10.5, 24], home_loan: [8.25, 12], lap: [9.5, 15] },
    amount_range: { personal_loan: [50000, 4000000], home_loan: [500000, 50000000], lap: [500000, 30000000] },
    max_tenure_months: { personal_loan: 60, home_loan: 360, lap: 180 },
    home_loan_ltv_slabs: [{ upto: 3000000, max: 0.9 }, { upto: 7500000, max: 0.8 }, { upto: null, max: 0.75 }],
    lap_max_ltv: 0.6,
    required_documents: { home_loan: ['pan', 'aadhaar_ekyc', 'salary_slips', 'aa_bank_statement', 'property_title', 'valuation_report'] },
    reason_codes: ['SCORE_LOW', 'DPD_RECENT', 'WRITE_OFF_OR_SETTLED', 'FOIR_HIGH', 'LTV_HIGH', 'INCOME_UNVERIFIED', 'EMI_BOUNCES', 'DOCS_INCOMPLETE', 'AMOUNT_ABOVE_ELIGIBILITY', 'POLICY_OTHER'],
    min_confidence: 0.8, approver_slack_user: 'credit-officer', approval_timeout_hours: 24,
  };
  const req = { business_key: 'LA-1', application_id: 'LA-1', product: 'home_loan', requested_amount: 4500000, requested_tenure_months: 240 };
  const docs = Config.required_documents.home_loan.map((type) => ({ type, status: 'verified' }));
  const snap = (o = {}) => ({ status: 'under_underwriting', requested_amount: 4500000, property_value: 6200000,
    bureau: { score: 780, report_date: days(-5), max_dpd_12m: 0, written_off_or_settled: false },
    aa: { avg_monthly_income: 150000, existing_emi_total: 20000, emi_bounces_6m: 0, months_analysed: 12 }, documents: docs, ...o });
  // 45 lakh over 240 months at 8.75 percent: EMI 39766.98, FOIR 0.3984, LTV 0.7258.
  const agent = (o = {}) => ({ output: { decision: 'approve', amount: 4500000, tenure_months: 240, interest_rate_pct: 8.75, emi: 39766.98,
    bureau_score: 780, monthly_income_used: 150000, existing_emis: 20000, foir: 0.3984, ltv: 0.7258, reason_codes: [],
    document_checks: [{ document: 'pan', status: 'verified' }], conditions: [], confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = snap(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize application': req, 'Underwriting copilot': a } });

  test('approval inside policy goes to the credit officer', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.emi, 39766.98);
    assert.equal(out.action.foir, 0.3984);
    assert.equal(out.action.ltv, 0.7258);
  });
  test('Slack summary carries no score or income', () => assert.doesNotMatch(g().approval_summary, /780|150000/));
  test('misstated EMI escalates', () => assert.equal(g(snap(), agent({ emi: 35000 })).route, 'escalate'));
  test('FOIR above the cap escalates', () => assert.equal(
    g(snap({ aa: { avg_monthly_income: 90000, existing_emi_total: 20000, emi_bounces_6m: 0, months_analysed: 12 } }), agent({ monthly_income_used: 90000, foir: 0.6641 })).route, 'escalate'));
  test('LTV above the RBI slab escalates', () => assert.equal(g(snap({ property_value: 5000000 }), agent({ ltv: 0.9 })).route, 'escalate'));
  test('declared income in place of AA income escalates', () => assert.equal(g(snap(), agent({ monthly_income_used: 200000 })).route, 'escalate'));
  test('unverified required document escalates', () => assert.equal(
    g(snap({ documents: docs.map((d) => (d.type === 'valuation_report' ? { ...d, status: 'pending' } : d)) })).route, 'escalate'));
  test('stale bureau report escalates', () => assert.equal(g(snap({ bureau: { score: 780, report_date: days(-60), max_dpd_12m: 0 } })).route, 'escalate'));
  test('score below the minimum escalates an approval', () => assert.equal(
    g(snap({ bureau: { score: 650, report_date: days(-5), max_dpd_12m: 0 } }), agent({ bureau_score: 650 })).route, 'escalate'));
  test('counter-offer with reason codes goes to the credit officer', () => {
    const out = g(snap(), agent({ decision: 'counter_offer', amount: 3500000, emi: 30929.87, foir: 0.3395, ltv: 0.5645, reason_codes: ['AMOUNT_ABOVE_ELIGIBILITY'] }));
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.deepEqual(out.action.reason_codes, ['AMOUNT_ABOVE_ELIGIBILITY']);
  });
  test('counter-offer without reason codes escalates', () => assert.equal(
    g(snap(), agent({ decision: 'counter_offer', amount: 3500000, emi: 30929.87, foir: 0.3395, ltv: 0.5645, reason_codes: [] })).route, 'escalate'));
  test('approve at different terms escalates', () => assert.equal(
    g(snap(), agent({ amount: 3500000, emi: 30929.87, foir: 0.3395, ltv: 0.5645 })).route, 'escalate'));
  const decline = { decision: 'decline', amount: 0, tenure_months: 0, interest_rate_pct: 0, emi: 0, foir: 0, ltv: null };
  test('decline with a supported reason code goes to the credit officer', () => assert.equal(
    g(snap({ bureau: { score: 650, report_date: days(-5) } }), agent({ ...decline, bureau_score: 650, reason_codes: ['SCORE_LOW'] })).route, 'approve'));
  test('decline citing SCORE_LOW on a good score escalates', () => assert.equal(g(snap(), agent({ ...decline, reason_codes: ['SCORE_LOW'] })).route, 'escalate'));
  test('reason code outside the policy list escalates', () => assert.equal(g(snap(), agent({ ...decline, reason_codes: ['GUT_FEEL'] })).route, 'escalate'));
  test('refer escalates', () => assert.equal(g(snap(), agent({ ...decline, decision: 'refer' })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  const planned = { decision: 'counter_offer', amount: 3500000, tenure_months: 240, reason_codes: ['AMOUNT_ABOVE_ELIGIBILITY'] };
  test('verify accepts the recorded decision', () => assert.equal(v({ underwriting_decision: { ...planned, approved_by: 'credit-officer' } }, planned).verified, true));
  test('verify rejects a different amount in the LOS', () => assert.equal(v({ underwriting_decision: { ...planned, amount: 4500000, approved_by: 'credit-officer' } }, planned).verified, false));
}

// ---------------- Aelix CoreLink · Reconciliation Agent ----------------
{
  const wf = loadProduct('fintech', 'corelink-reconciliation');
  section('Aelix CoreLink · Reconciliation Agent');
  const Config = { max_adjustment_amount: 25000, max_entry_lines: 6, max_timing_days: 3, suspense_accounts: ['199900'], min_confidence: 0.85, approver_slack_user: 'recon-operator', approval_timeout_hours: 8 };
  const req = { business_key: 'BRK-1', break_id: 'BRK-1', recon_id: 'NOSTRO-USD', ledger_account: '110250', currency: 'USD', break_amount: -35, value_date: days(-1) };
  const brk = (o = {}) => ({ status: 'open', currency: 'USD',
    items: [{ id: 'L1', side: 'ledger', amount: 10000 }, { id: 'S1', side: 'statement', amount: 9965 }],
    rules: { allowed_accounts: ['640100'], period_status: 'open' }, ...o });
  const fee = [{ gl_account: '640100', debit: 35, credit: 0, reference: 'FT1' }, { gl_account: '110250', debit: 0, credit: 35, reference: 'FT1' }];
  const agent = (o = {}) => ({ output: { cause: 'bank_fee_or_charge', proposal: 'post_entries', break_amount: -35,
    matches: [{ ledger_item_ids: ['L1'], statement_item_ids: ['S1'] }], entries: fee, confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = brk(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize break': req, 'Reconciliation agent': a } });

  test('balanced fee entries that net to the break go to the operator', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.net_amount, -35);
    assert.equal(out.action.entries.length, 2);
  });
  test('entries that do not balance escalate', () => assert.equal(g(brk(), agent({ entries: [fee[0], { ...fee[1], credit: 30 }] })).route, 'escalate'));
  test('entries that net the wrong way escalate', () => assert.equal(g(brk(), agent({ entries: [
    { gl_account: '110250', debit: 35, credit: 0, reference: 'FT1' }, { gl_account: '640100', debit: 0, credit: 35, reference: 'FT1' }] })).route, 'escalate'));
  test('posting to suspense escalates', () => assert.equal(g(brk({ rules: { allowed_accounts: ['640100', '199900'], period_status: 'open' } }), agent({ entries: [{ ...fee[0], gl_account: '199900' }, fee[1]] })).route, 'escalate'));
  test('account not on the allowed list escalates', () => assert.equal(g(brk(), agent({ entries: [{ ...fee[0], gl_account: '700000' }, fee[1]] })).route, 'escalate'));
  test('items left unmatched escalate', () => assert.equal(g(brk({ items: [...brk().items, { id: 'L2', side: 'ledger', amount: 50 }, { id: 'S2', side: 'statement', amount: 50 }] })).route, 'escalate'));
  test('agent break amount that differs from the items escalates', () => assert.equal(g(brk(), agent({ break_amount: -30 })).route, 'escalate'));
  test('closed accounting period escalates', () => assert.equal(g(brk({ rules: { allowed_accounts: ['640100'], period_status: 'closed' } })).route, 'escalate'));
  test('adjustment above the limit escalates', () => {
    const r = { ...req, break_amount: -30000 };
    const items = [{ id: 'L1', side: 'ledger', amount: 40000 }, { id: 'S1', side: 'statement', amount: 10000 }];
    const e = [{ ...fee[0], debit: 30000 }, { ...fee[1], credit: 30000 }];
    const out = run(wf, 'Guardrails', { json: brk({ items }), nodes: { Config, 'Normalize break': r, 'Reconciliation agent': agent({ break_amount: -30000, entries: e }) } });
    assert.equal(out.route, 'escalate');
    assert.ok(out.guardrail_reasons.some((x) => /controller/.test(x)));
  });
  test('match only on a zero break goes to the operator', () => {
    const r = { ...req, break_amount: 0 };
    const items = [{ id: 'L1', side: 'ledger', amount: 9965 }, { id: 'S1', side: 'statement', amount: 9965 }];
    const out = run(wf, 'Guardrails', { json: brk({ items }), nodes: { Config, 'Normalize break': r, 'Reconciliation agent': agent({ cause: 'keying_error', proposal: 'match_only', break_amount: 0, entries: [] }) } });
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
  });
  test('match only on a non-zero break escalates', () => assert.equal(g(brk(), agent({ proposal: 'match_only', entries: [] })).route, 'escalate'));
  test('fresh timing difference is recorded as no action', () => assert.equal(g(brk(), agent({ cause: 'timing_difference', proposal: 'no_action', matches: [], entries: [] })).route, 'none'));
  test('old timing difference escalates', () => assert.equal(
    run(wf, 'Guardrails', { json: brk(), nodes: { Config, 'Normalize break': { ...req, value_date: days(-10) }, 'Reconciliation agent': agent({ cause: 'timing_difference', proposal: 'no_action', matches: [], entries: [] }) } }).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts a resolved break with the planned journal', () => assert.equal(v({ status: 'resolved', residual_amount: 0, journal: { line_count: 2 } }, { entries: fee }).verified, true));
  test('verify rejects a residual left on the break', () => assert.equal(v({ status: 'resolved', residual_amount: 5, journal: { line_count: 2 } }, { entries: fee }).verified, false));
}

// ---------------- Aelix Assurance · Claims Adjudication Agent ----------------
{
  const wf = loadProduct('fintech', 'assurance-claims-adjudication');
  section('Aelix Assurance · Claims Adjudication Agent');
  const Config = { standard_queues: ['motor-fast-track', 'motor-standard', 'coverage-review'], siu_queue: 'siu-intake', siu_score_threshold: 0.7, envelope_max_amount: 10000,
    min_confidence: 0.8, approver_slack_user: 'claims-supervisor', approval_timeout_hours: 4 };
  const req = { business_key: 'CLM-1', claim_id: 'CLM-1', line: 'motor', loss_date: days(-2), reported_at: days(-1) + 'T10:00:00Z', claimed_amount: 3800, currency: 'USD' };
  const claim = (o = {}) => ({ status: 'new', assigned_queue: null, claimed_amount: 3800,
    policy: { status: 'active', period_start: days(-100), period_end: days(265), limit: 50000 }, fraud: { score: 0.12 }, ...o });
  const agent = (o = {}) => ({ output: { complexity: 'simple', coverage_assessment: 'likely_covered', fraud_score: 0.12, fraud_indicators: [],
    recommendation: 'fast_track', queue: 'motor-fast-track', indicative_reserve: 3500, next_steps: ['Request repair estimate'], confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = claim(), a = agent(), r = req) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize claim': r, 'Claims adjudication agent': a } });

  test('small clean claim to a standard queue routes on its own', () => {
    const out = g();
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.deepEqual([out.action.queue, out.action.recommendation], ['motor-fast-track', 'fast_track']);
  });
  test('large claim goes to the supervisor', () => {
    const out = g(claim({ claimed_amount: 25000 }), agent({ complexity: 'moderate', recommendation: 'standard_adjustment', queue: 'motor-standard', indicative_reserve: 20000 }), { ...req, claimed_amount: 25000 });
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.match(out.approval_summary, /amount above 10000/);
  });
  test('high fraud score on a standard route goes to the supervisor', () => assert.equal(
    g(claim({ fraud: { score: 0.82 } }), agent({ fraud_score: 0.82, complexity: 'moderate', recommendation: 'standard_adjustment', queue: 'motor-standard' })).route, 'approve'));
  test('SIU referral with indicators goes to the supervisor', () => assert.equal(
    g(claim({ fraud: { score: 0.82 } }), agent({ fraud_score: 0.82, recommendation: 'siu_referral', queue: 'siu-intake', complexity: 'complex', fraud_indicators: ['Policy incepted 9 days before loss (POL record)'] })).route, 'approve'));
  test('SIU referral without indicators escalates', () => assert.equal(
    g(claim({ fraud: { score: 0.82 } }), agent({ fraud_score: 0.82, recommendation: 'siu_referral', queue: 'siu-intake', complexity: 'complex' })).route, 'escalate'));
  test('SIU referral to a standard queue escalates', () => assert.equal(
    g(claim(), agent({ recommendation: 'siu_referral', queue: 'motor-standard', fraud_indicators: ['x'] })).route, 'escalate'));
  test('fraud score that differs from the record escalates', () => assert.equal(g(claim(), agent({ fraud_score: 0.05 })).route, 'escalate'));
  test('lapsed policy with a fast track escalates', () => assert.equal(g(claim({ policy: { status: 'lapsed', period_start: days(-400), period_end: days(-35), limit: 50000 } })).route, 'escalate'));
  test('coverage review on a lapsed policy routes on its own', () => assert.equal(
    g(claim({ policy: { status: 'lapsed', period_start: days(-400), period_end: days(-35), limit: 50000 } }),
      agent({ complexity: 'moderate', coverage_assessment: 'coverage_question', recommendation: 'coverage_review', queue: 'coverage-review' })).route, 'auto'));
  test('unknown queue escalates', () => assert.equal(g(claim(), agent({ queue: 'motor-vip' })).route, 'escalate'));
  test('claim already assigned escalates', () => assert.equal(g(claim({ assigned_queue: 'motor-standard' })).route, 'escalate'));
  test('reserve above the policy limit escalates', () => assert.equal(g(claim(), agent({ indicative_reserve: 60000 })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  const planned = { queue: 'motor-fast-track', recommendation: 'fast_track' };
  test('verify accepts the routed claim with nothing paid or reserved', () => assert.equal(v({ assigned_queue: 'motor-fast-track', recommendation: { type: 'fast_track' }, status: 'assigned', payments: [], reserve: null }, planned).verified, true));
  test('verify rejects a claim with a reserve set', () => assert.equal(v({ assigned_queue: 'motor-fast-track', recommendation: { type: 'fast_track' }, status: 'assigned', payments: [], reserve: 3500 }, planned).verified, false));
}

// ---------------- Aelix Propel · Portfolio Drift Agent ----------------
{
  const wf = loadProduct('fintech', 'propel-portfolio-drift');
  section('Aelix Propel · Portfolio Drift Agent');
  const Config = { wash_sale_days: 30, min_harvest_loss: 500, min_cash_weight: 0.01, max_orders: 20, min_confidence: 0.85, approver_slack_user: 'account-advisor', approval_timeout_hours: 24 };
  const req = { business_key: 'RV-1', review_id: 'RV-1', account_id: 'ACC-1' };
  // 100,000 account: VTI 70 percent and BND 25 percent against targets of 60 and 35 (bands 5).
  const ctx = (o = {}) => ({ status: 'active', account_type: 'taxable', cash: 5000,
    holdings: [
      { symbol: 'VTI', quantity: 700, price: 100, lots: [{ lot_id: 'L1', quantity: 400, cost_per_share: 80 }, { lot_id: 'L2', quantity: 300, cost_per_share: 120 }] },
      { symbol: 'BND', quantity: 250, price: 100, lots: [{ lot_id: 'B1', quantity: 250, cost_per_share: 98 }] },
    ],
    prices: { ITOT: 100 }, targets: [{ symbol: 'VTI', weight: 0.6, band: 0.05 }, { symbol: 'BND', weight: 0.35, band: 0.05 }],
    recent_trades: [], restricted_symbols: [], identical_groups: [['VTI', 'VTSAX']], approved_substitutes: ['ITOT'], ...o });
  const balanced = { cash: 5000, holdings: [
    { symbol: 'VTI', quantity: 600, price: 100, lots: [{ lot_id: 'L1', quantity: 300, cost_per_share: 80 }, { lot_id: 'L2', quantity: 300, cost_per_share: 120 }] },
    { symbol: 'BND', quantity: 350, price: 100, lots: [{ lot_id: 'B1', quantity: 350, cost_per_share: 98 }] }] };
  const rebalance = [{ symbol: 'VTI', side: 'sell', quantity: 100, lot_ids: ['L1'], purpose: 'rebalance' }, { symbol: 'BND', side: 'buy', quantity: 100, lot_ids: [], purpose: 'rebalance' }];
  const harvest = [{ symbol: 'VTI', side: 'sell', quantity: 300, lot_ids: ['L2'], purpose: 'tax_loss' }, { symbol: 'ITOT', side: 'buy', quantity: 300, lot_ids: [], purpose: 'replacement' }];
  const agent = (o = {}) => ({ output: { proposal: 'rebalance', drift: [{ symbol: 'VTI', current_weight: 0.7, target_weight: 0.6 }, { symbol: 'BND', current_weight: 0.25, target_weight: 0.35 }],
    orders: rebalance, estimated_harvested_loss: 0, confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = ctx(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize review': req, 'Portfolio drift agent': a } });

  test('rebalance back into band goes to the advisor with every order listed', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.match(out.approval_summary, /SELL 100 VTI/);
    assert.match(out.approval_summary, /BUY 100 BND/);
  });
  test('sell above holdings escalates', () => assert.equal(g(ctx(), agent({ orders: [{ ...rebalance[0], quantity: 800, lot_ids: ['L1', 'L2'] }, rebalance[1]] })).route, 'escalate'));
  test('sell from a lot not held escalates', () => assert.equal(g(ctx(), agent({ orders: [{ ...rebalance[0], lot_ids: ['L9'] }, rebalance[1]] })).route, 'escalate'));
  test('rebalance that leaves a position out of band escalates', () => assert.equal(
    g(ctx(), agent({ orders: [{ ...rebalance[0], quantity: 20 }, { ...rebalance[1], quantity: 20 }] })).route, 'escalate'));
  test('misstated drift escalates', () => assert.equal(g(ctx(), agent({ drift: [{ symbol: 'VTI', current_weight: 0.62, target_weight: 0.6 }] })).route, 'escalate'));
  const tlh = { proposal: 'tax_loss_harvest', drift: [], orders: harvest, estimated_harvested_loss: 6000 };
  test('tax-loss harvest into an approved substitute goes to the advisor', () => {
    const out = g(ctx(balanced), agent(tlh));
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.harvested_loss, 6000);
    assert.deepEqual(out.action.wash_sale_blocks[0].symbols, ['VTI', 'VTSAX']);
  });
  test('harvest after a recent buy of an identical fund escalates (wash sale)', () => assert.equal(
    g(ctx({ ...balanced, recent_trades: [{ symbol: 'VTSAX', side: 'buy', trade_date: days(-10), quantity: 5 }] }), agent(tlh)).route, 'escalate'));
  test('harvest that buys the same security back escalates (wash sale)', () => assert.equal(
    g(ctx(balanced), agent({ ...tlh, orders: [harvest[0], { symbol: 'VTI', side: 'buy', quantity: 300, lot_ids: [], purpose: 'rebalance' }] })).route, 'escalate'));
  test('buy within the window of a loss sale escalates (wash sale)', () => assert.equal(
    g(ctx({ recent_trades: [{ symbol: 'BND', side: 'sell', trade_date: days(-12), quantity: 50, realized_gain: -300 }] })).route, 'escalate'));
  test('harvest in a tax-deferred account escalates', () => assert.equal(g(ctx({ ...balanced, account_type: 'ira' }), agent(tlh)).route, 'escalate'));
  test('harvest of a lot at a gain escalates', () => assert.equal(
    g(ctx(balanced), agent({ ...tlh, orders: [{ ...harvest[0], lot_ids: ['L1'] }, harvest[1]] })).route, 'escalate'));
  test('restricted security escalates', () => assert.equal(g(ctx({ restricted_symbols: ['BND'] })).route, 'escalate'));
  test('no action with everything in band is recorded', () => assert.equal(g(ctx(balanced), agent({ proposal: 'no_action', drift: [], orders: [] })).route, 'none'));
  test('no action while out of band escalates', () => assert.equal(g(ctx(), agent({ proposal: 'no_action', drift: [], orders: [] })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts an advisor-approved batch with exactly the planned orders', () => assert.equal(
    v({ status: 'accepted', approval_status: 'advisor_approved', orders: [...rebalance].reverse() }, { orders: rebalance }).verified, true));
  test('verify rejects a batch with a different quantity', () => assert.equal(
    v({ status: 'accepted', approval_status: 'advisor_approved', orders: [{ ...rebalance[0], quantity: 110 }, rebalance[1]] }, { orders: rebalance }).verified, false));
}

// ---------------- Aelix Vantage · Win-Back Agent ----------------
{
  const wf = loadProduct('fintech', 'vantage-win-back');
  section('Aelix Vantage · Win-Back Agent');
  const Config = { max_offers_per_year: 2, offer_cooldown_days: 90, min_days_since_marketing_contact: 14, max_offer_value: 250, eligible_statuses: ['active', 'pending_closure'],
    min_confidence: 0.8, approver_slack_user: 'retention-lead', approval_timeout_hours: 24 };
  const req = { business_key: 'CHS-1', signal_id: 'CHS-1', customer_id: 'CUS-1', churn_signal: 'balance_outflow' };
  const ctx = (o = {}) => ({ status: 'active', do_not_contact: false, open_complaint: false, consent: { email: true, sms: false }, last_marketing_contact_at: days(-40),
    offer_history: [{ offer_id: 'OFF-OLD', sent_at: days(-200) }],
    eligible_offers: [{ offer_id: 'OFF-FEE-WAIVE-12M', template_id: 'TPL-RET-017', channels: ['email', 'in_app'], value: 120, expires_on: days(60) }], ...o });
  const agent = (o = {}) => ({ output: { churn_risk: 'high', churn_drivers: ['Salary credits moved out (usage)'], proposal: 'send_offer', offer_id: 'OFF-FEE-WAIVE-12M', channel: 'email',
    confidence: 0.85, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = ctx(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize churn signal': req, 'Win-back agent': a } });

  test('eligible offer by a consented channel goes to the retention lead', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.template_id, 'TPL-RET-017');
    assert.equal(out.action.offer_value, 120);
  });
  test('template comes from the catalogue, not the agent', () => assert.equal(g(ctx(), agent({ template_id: 'TPL-FAKE' })).action.template_id, 'TPL-RET-017'));
  test('do-not-contact escalates', () => assert.equal(g(ctx({ do_not_contact: true })).route, 'escalate'));
  test('channel without consent escalates', () => assert.equal(g(ctx({ eligible_offers: [{ ...ctx().eligible_offers[0], channels: ['email', 'sms'] }] }), agent({ channel: 'sms' })).route, 'escalate'));
  test('offer not in the eligible catalogue escalates', () => assert.equal(g(ctx(), agent({ offer_id: 'OFF-CASHBACK-500' })).route, 'escalate'));
  test('yearly offer cap escalates', () => assert.equal(g(ctx({ offer_history: [{ offer_id: 'A', sent_at: days(-300) }, { offer_id: 'B', sent_at: days(-150) }] })).route, 'escalate'));
  test('offer inside the cool-down escalates', () => assert.equal(g(ctx({ offer_history: [{ offer_id: 'A', sent_at: days(-30) }] })).route, 'escalate'));
  test('open complaint escalates', () => assert.equal(g(ctx({ open_complaint: true })).route, 'escalate'));
  test('offer above the value cap escalates', () => assert.equal(g(ctx({ eligible_offers: [{ ...ctx().eligible_offers[0], value: 400 }] })).route, 'escalate'));
  test('no offer is recorded, not escalated', () => assert.equal(g(ctx({ do_not_contact: true }), agent({ proposal: 'no_offer', offer_id: null, channel: null })).route, 'none'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  const planned = { customer_id: 'CUS-1', offer_id: 'OFF-FEE-WAIVE-12M', template_id: 'TPL-RET-017', channel: 'email' };
  test('verify accepts the queued catalogue template', () => assert.equal(v({ ...planned, status: 'queued' }, planned).verified, true));
  test('verify rejects a different template', () => assert.equal(v({ ...planned, template_id: 'TPL-OTHER', status: 'sent' }, planned).verified, false));
}

done();
