// Logistics product agents: guardrails, envelope routing and verification.
import { assert, loadProduct, run, test, section, done } from '../harness.mjs';

// ---------------- Echo Optima · Replenishment Agent ----------------
{
  const wf = loadProduct('logistics', 'optima-replenishment');
  section('Echo Optima · Replenishment Agent');
  const Config = { auto_order_max_value: 15000, max_weeks_of_cover: 8, min_confidence: 0.85, approver_slack_user: 'inventory-planner', approval_timeout_hours: 8 };
  const req = { business_key: 'RS-1', signal_id: 'RS-1', sku: 'CTN-3340', location: 'DC-DAL', signal: 'projected_stockout' };
  const terms = (o = {}) => ({ suppliers: [{ supplier_id: 'SUP-1', approved: true, preferred: true, moq: 100, case_pack: 20, unit_cost: 12.5, ...o }] });
  const agent = (o = {}) => ({ output: { proposal_type: 'new_order', supplier_id: 'SUP-1', order_qty: 400, unit_cost: 12.5, purchase_order_id: null, needed_by: '2026-10-22', weeks_of_cover_after: 5, confidence: 0.9, ...o } });
  const g = (json = terms(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize signal': req, 'Replenishment agent': a } });

  test('small order with preferred supplier acts inside the envelope', () => {
    const out = g();
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.action.value, 5000);
  });
  test('order above the value limit asks the planner', () => assert.equal(g(terms(), agent({ order_qty: 2000 })).route, 'approve'));
  test('non-preferred approved supplier asks the planner', () => assert.equal(g(terms({ preferred: false })).route, 'approve'));
  test('unapproved supplier escalates', () => assert.equal(g(terms({ approved: false })).route, 'escalate'));
  test('quantity off the case pack escalates', () => assert.equal(g(terms(), agent({ order_qty: 410 })).route, 'escalate'));
  test('below MOQ escalates', () => assert.equal(g(terms(), agent({ order_qty: 60 })).route, 'escalate'));
  test('unit cost the agent got wrong escalates', () => assert.equal(g(terms(), agent({ unit_cost: 11 })).route, 'escalate'));
  test('too many weeks of cover escalates', () => assert.equal(g(terms(), agent({ weeks_of_cover_after: 12 })).route, 'escalate'));
  test('expedite asks the planner', () => assert.equal(g(terms(), agent({ proposal_type: 'expedite_existing', purchase_order_id: 'PO-9', order_qty: 0 })).route, 'approve'));
  test('no change is recorded, not escalated', () => assert.equal(g(terms(), agent({ proposal_type: 'no_change', order_qty: 0, supplier_id: null })).route, 'none'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts the actioned signal', () => assert.equal(v({ status: 'actioned', action: { type: 'new_order', qty: 400 } }, { type: 'new_order', qty: 400 }).verified, true));
  test('verify rejects a different quantity', () => assert.equal(v({ status: 'actioned', action: { type: 'new_order', qty: 40 } }, { type: 'new_order', qty: 400 }).verified, false));
}

// ---------------- Echo Sense · Exception Resolution Agent ----------------
{
  const wf = loadProduct('logistics', 'sense-exception-resolution');
  section('Echo Sense · Exception Resolution Agent');
  const Config = { max_logger_gap_minutes: 30, minutes_tolerance: 5, open_statuses: ['in_transit', 'at_facility', 'held_pending_review'], min_confidence: 0.85, approver_slack_user: 'quality-approver', approval_timeout_hours: 2 };
  const req = { business_key: 'TA-1', alert_id: 'TA-1', shipment_id: 'SHP-1', logger_id: 'LGR-1', sku: 'VAC-1', lot: 'L1' };
  const t0 = Date.parse('2026-10-13T04:00:00Z');
  const series = (temps, step = 10) => temps.map((c, i) => ({ ts: new Date(t0 + i * step * 60000).toISOString(), temp_c: c }));
  // Readings 2, 3 and 4 are above 8 C: four 10-minute intervals touch them, so 40 minutes out of range.
  const log = (o = {}, temps = [5, 5, 9, 9.5, 9, 5, 5]) => ({ shipment_id: 'SHP-1', status: 'in_transit', sku: 'VAC-1', lot: 'L1', readings: series(temps), stability: { min_c: 2, max_c: 8, excursion_budget_minutes: 60, prior_excursion_minutes: 0 }, logger: { calibration_due: '2099-01-01' }, ...o });
  const rec = { title: 'High temperature at MEM-02', description: 'Readings above 8 C from 04:20 to 04:40.', product_impact: '40 of 60 minutes', immediate_action: 'Release', root_cause_hypothesis: 'Defrost cycle', corrective_action_suggestion: 'Review defrost settings' };
  const agent = (o = {}) => ({ output: { root_cause: 'defrost_cycle', minutes_out_of_range: 40, peak_temp_c: 9.5, disposition: 'release', reroute_facility_id: null, deviation_record: rec, confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = log(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize temperature alert': req, 'Exception resolution agent': a } });

  test('release inside the excursion budget goes to the approver', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.minutes_out_of_range, 40);
    assert.equal(out.action.peak_temp_c, 9.5);
  });
  test('release is blocked when the lot budget is exceeded', () => {
    const out = g(log({ stability: { min_c: 2, max_c: 8, excursion_budget_minutes: 60, prior_excursion_minutes: 30 } }));
    assert.equal(out.route, 'escalate');
    assert.ok(out.guardrail_reasons.some((r) => r.startsWith('release blocked') && r.includes('70 minutes')), out.guardrail_reasons.join('; '));
  });
  test('quarantine over budget still goes to the approver', () => {
    const out = g(log({ stability: { min_c: 2, max_c: 8, excursion_budget_minutes: 30, prior_excursion_minutes: 0 } }), agent({ disposition: 'quarantine' }));
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
  });
  test('a low excursion counts too', () => assert.equal(g(log({}, [5, 1.5, 1.8, 5])).action.minutes_out_of_range, 30));
  test('agent minutes that disagree with the log escalate', () => assert.equal(g(log(), agent({ minutes_out_of_range: 15 })).route, 'escalate'));
  test('a gap in the logger record escalates', () => {
    const json = log();
    json.readings.splice(5, 1); json.readings.splice(4, 1); json.readings.splice(3, 1);
    const out = g(json);
    assert.equal(out.route, 'escalate');
    assert.ok(out.guardrail_reasons.some((r) => r.includes('gap')));
  });
  test('release on an out-of-calibration logger escalates', () => assert.equal(g(log({ logger: { calibration_due: '2025-01-01' } })).route, 'escalate'));
  test('no excursion on a clean log is recorded, not escalated', () => assert.equal(g(log({}, [5, 5, 6, 5]), agent({ disposition: 'no_excursion', minutes_out_of_range: 0 })).route, 'none'));
  test('no excursion claimed against an excursion in the log escalates', () => assert.equal(g(log(), agent({ disposition: 'no_excursion', minutes_out_of_range: 40 })).route, 'escalate'));
  test('shipment already dispositioned escalates', () => assert.equal(g(log({ status: 'quarantined' })).route, 'escalate'));
  test('reroute without a facility escalates', () => assert.equal(g(log(), agent({ disposition: 'reroute' })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  const planned = { type: 'quarantine', alert_id: 'TA-1', reroute_facility_id: null };
  test('verify accepts the filed deviation and quarantined shipment', () => assert.equal(v({ status: 'quarantined', deviations: [{ alert_id: 'TA-1', status: 'filed', disposition: 'quarantine' }] }, planned).verified, true));
  test('verify rejects a shipment still in transit', () => assert.equal(v({ status: 'in_transit', deviations: [{ alert_id: 'TA-1', status: 'filed', disposition: 'quarantine' }] }, planned).verified, false));
  test('verify rejects a missing deviation record', () => assert.equal(v({ status: 'quarantined', deviations: [] }, planned).verified, false));
}

// ---------------- Echo Move · Dispatch Agent ----------------
{
  const wf = loadProduct('logistics', 'move-dispatch');
  section('Echo Move · Dispatch Agent');
  const Config = {
    hos: { max_driving_minutes: 660, max_window_minutes: 840, break_after_driving_minutes: 480, break_minutes: 30, reset_off_duty_minutes: 600, restart_off_duty_minutes: 2040, cycle_limits_minutes: { '60_7': 3600, '70_8': 4200 } },
    hos_buffer_minutes: 30, default_on_duty_minutes: 90, drive_estimate_tolerance_pct: 10,
    min_confidence: 0.85, approver_slack_user: 'dispatcher', approval_timeout_hours: 1,
  };
  const req = { business_key: 'LD-1', load_id: 'LD-1', origin: 'DC-DAL', destination: 'Memphis', equipment_type: 'reefer', hazmat: false };
  const hos = (o = {}) => ({ duty_status: 'off_duty', current_status_minutes: 600, driving_minutes: 0, window_elapsed_minutes: 0, driving_since_break_minutes: 0, cycle_minutes_used: 2400, ...o });
  // as_of 08:00, start 10:00. Trip 420 loaded + 30 deadhead, 90 on duty.
  const check = ({ load = {}, driver = {}, h = {}, tractor = {}, trailer = {} } = {}) => ({
    as_of: '2026-10-14T08:00:00Z',
    load: { load_id: 'LD-1', status: 'tendered', equipment_type: 'reefer', hazmat: false, tank: false, estimated_drive_minutes: 420, on_duty_minutes: 90, pickup_window_end: '2026-10-14T14:00:00Z', ...load },
    driver: { driver_id: 'DRV-1', current_load_id: null, cycle_rule: '70_8', endorsements: ['T'], cdl_expires: '2028-01-01', medical_card_expires: '2027-06-01', hos: hos(h), ...driver },
    tractor: { tractor_id: 'TRC-1', in_service: true, ...tractor },
    trailer: { trailer_id: 'TRL-1', equipment_type: 'reefer', in_service: true, ...trailer },
  });
  const agent = (o = {}) => ({ output: { recommendation: 'assign', driver_id: 'DRV-1', tractor_id: 'TRC-1', trailer_id: 'TRL-1', planned_start: '2026-10-14T10:00:00Z', deadhead_drive_minutes: 30, loaded_drive_minutes: 420, alternatives_considered: [], confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = check(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize load': req, 'Dispatch agent': a } });
  const has = (out, text) => assert.ok(out.guardrail_reasons.some((r) => r.includes(text)), out.guardrail_reasons.join('; '));

  test('rested, qualified driver on the right trailer goes to the dispatcher', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.driver_id, 'DRV-1');
    assert.ok(out.approval_summary.includes('driving 450/660'));
  });
  test('11-hour driving limit escalates', () => {
    const out = g(check({ h: { duty_status: 'on_duty', current_status_minutes: 20, driving_minutes: 300, window_elapsed_minutes: 300, driving_since_break_minutes: 0 } }));
    assert.equal(out.route, 'escalate'); has(out, 'driving would reach 750');
  });
  test('14-hour window escalates even when driving time is fine', () => {
    const out = g(check({ h: { duty_status: 'on_duty', current_status_minutes: 20, driving_minutes: 100, window_elapsed_minutes: 600, driving_since_break_minutes: 0 } }));
    assert.equal(out.route, 'escalate'); has(out, '14-hour window');
  });
  test('the 30-minute break after 8 hours driving is counted in the window', () => {
    const h = { duty_status: 'on_duty', current_status_minutes: 10, driving_minutes: 200, window_elapsed_minutes: 400, driving_since_break_minutes: 200 };
    const json = check({ load: { estimated_drive_minutes: 300 }, h });
    json.as_of = '2026-10-14T10:00:00Z';
    const out = g(json, agent({ loaded_drive_minutes: 300, deadhead_drive_minutes: 0 }));
    assert.equal(out.route, 'escalate'); has(out, '1 required break');
    // The same trip fits when the driver has just had a 30-minute break.
    const rested = check({ load: { estimated_drive_minutes: 300 }, h: { ...h, current_status_minutes: 30 } });
    rested.as_of = json.as_of;
    assert.equal(g(rested, agent({ loaded_drive_minutes: 300, deadhead_drive_minutes: 0 })).route, 'approve');
  });
  test('70-hour cycle escalates', () => { const out = g(check({ h: { cycle_minutes_used: 3800 } })); assert.equal(out.route, 'escalate'); has(out, '70_8 cycle'); });
  test('60-hour cycle uses its own limit', () => {
    assert.equal(g(check({ h: { cycle_minutes_used: 3100 } })).route, 'approve');
    assert.equal(g(check({ driver: { cycle_rule: '60_7' }, h: { cycle_minutes_used: 3100 } })).route, 'escalate');
  });
  test('a 34-hour restart clears the cycle', () => assert.equal(g(check({ h: { current_status_minutes: 2100, cycle_minutes_used: 4000 } })).route, 'approve'));
  test('a trip longer than one duty period escalates', () => { const out = g(check({ load: { estimated_drive_minutes: 700 } }), agent({ loaded_drive_minutes: 700 })); assert.equal(out.route, 'escalate'); has(out, 'relay'); });
  test('drive time under the TMS estimate escalates and the longer time is used', () => {
    const out = g(check({ load: { estimated_drive_minutes: 620 } }), agent({ loaded_drive_minutes: 420 }));
    assert.equal(out.route, 'escalate'); has(out, 'under the TMS estimate'); has(out, 'driving would reach 650');
  });
  test('hazmat load needs an H or X endorsement', () => {
    assert.equal(g(check({ load: { hazmat: true } })).route, 'escalate');
    assert.equal(g(check({ load: { hazmat: true }, driver: { endorsements: ['H'] } })).route, 'approve');
  });
  test('tank load needs an N or X endorsement', () => assert.equal(g(check({ load: { tank: true } })).route, 'escalate'));
  test('wrong trailer type escalates', () => { const out = g(check({ trailer: { equipment_type: 'dry_van' } })); assert.equal(out.route, 'escalate'); has(out, 'needs reefer'); });
  test('tractor out of service escalates', () => assert.equal(g(check({ tractor: { in_service: false } })).route, 'escalate'));
  test('driver on another load escalates', () => assert.equal(g(check({ driver: { current_load_id: 'LD-9' } })).route, 'escalate'));
  test('expired medical card escalates', () => assert.equal(g(check({ driver: { medical_card_expires: '2026-10-01' } })).route, 'escalate'));
  test('load no longer open escalates', () => assert.equal(g(check({ load: { status: 'assigned' } })).route, 'escalate'));
  test('no feasible assignment goes to a person', () => assert.equal(g(check(), agent({ recommendation: 'no_feasible_assignment', driver_id: null, tractor_id: null, trailer_id: null, planned_start: null })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  const planned = { load_id: 'LD-1', driver_id: 'DRV-1', tractor_id: 'TRC-1', trailer_id: 'TRL-1' };
  test('verify accepts the assigned load', () => assert.equal(v({ status: 'assigned', driver_id: 'DRV-1', tractor_id: 'TRC-1', trailer_id: 'TRL-1' }, planned).verified, true));
  test('verify rejects a different driver', () => assert.equal(v({ status: 'assigned', driver_id: 'DRV-2', tractor_id: 'TRC-1', trailer_id: 'TRL-1' }, planned).verified, false));
}

// ---------------- Echo Flow · Document Exception Agent ----------------
{
  const wf = loadProduct('logistics', 'flow-document-exception');
  section('Echo Flow · Document Exception Agent');
  const Config = { tolerance_amount: 25, tolerance_pct: 1, approval_limit_amount: 500, approval_limit_pct: 5, open_statuses: ['received', 'in_review', 'exception'], min_confidence: 0.85, approver_slack_user: 'freight-audit-approver', approval_timeout_hours: 24 };
  const req = { business_key: 'DOC-1', document_id: 'DOC-1', invoice_number: 'INV-1', vendor_id: 'VEN-1', po_number: 'PO-1', currency: 'USD' };
  // PO: 100 x ITEM-A at 40.00 plus an agreed fuel charge of 200.00 = 4200.00 expected.
  const ctx = ({ lines, inv = {}, po = {}, bols } = {}) => {
    const l = lines ?? [{ type: 'goods', item: 'ITEM-A', qty: 100, unit_price: 40 }, { type: 'charge', item: 'FUEL', qty: 1, unit_price: 200 }];
    const total = Math.round(l.reduce((s, x) => s + x.qty * x.unit_price, 0) * 100) / 100;
    return {
      invoice: { invoice_id: 'DOC-1', invoice_number: 'INV-1', vendor_id: 'VEN-1', po_number: 'PO-1', status: 'received', currency: 'USD', total, lines: l, duplicate_of: null, ...inv },
      po: { po_number: 'PO-1', vendor_id: 'VEN-1', status: 'open', currency: 'USD', lines: [{ type: 'goods', item: 'ITEM-A', qty: 100, unit_price: 40 }, { type: 'charge', item: 'FUEL', qty: 1, unit_price: 200 }], ...po },
      bols: bols ?? [{ bol_id: 'BOL-1', po_number: 'PO-1', signed: true, lines: [{ item: 'ITEM-A', qty: 100 }] }],
    };
  };
  const agent = (o = {}) => ({ output: { proposed_outcome: 'reconcile', exception_type: 'none', po_number: 'PO-1', bol_ids: ['BOL-1'], variance_amount: 0, exception_reason: '', confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = ctx(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize document': req, 'Document exception agent': a } });
  const has = (out, text) => assert.ok(out.guardrail_reasons.some((r) => r.includes(text)), out.guardrail_reasons.join('; '));
  const charge = (amount) => [{ type: 'goods', item: 'ITEM-A', qty: 100, unit_price: 40 }, { type: 'charge', item: 'FUEL', qty: 1, unit_price: 200 }, { type: 'charge', item: 'DETENTION', qty: 1, unit_price: amount }];

  test('clean three-way match reconciles inside the envelope', () => {
    const out = g();
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.action.type, 'reconcile');
    assert.equal(out.action.variance_amount, 0);
  });
  test('a small price difference inside tolerance reconciles', () => {
    const out = g(ctx({ lines: [{ type: 'goods', item: 'ITEM-A', qty: 100, unit_price: 40.2 }, { type: 'charge', item: 'FUEL', qty: 1, unit_price: 200 }] }), agent({ variance_amount: 20 }));
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.action.variance_amount, 20);
  });
  test('an unagreed charge inside the approval limit asks the approver', () => {
    const out = g(ctx({ lines: charge(150) }), agent({ proposed_outcome: 'accept_variance', exception_type: 'unagreed_charge', variance_amount: 150 }));
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.type, 'accept_variance');
    assert.equal(out.action.variance_pct, 3.57);
  });
  test('a variance above the approval limit escalates with the reason', () => { const out = g(ctx({ lines: charge(600) }), agent({ variance_amount: 600 })); assert.equal(out.route, 'escalate'); has(out, 'above the approval limit'); });
  test('a variance under 500 but over 5% still escalates', () => {
    const lines = [{ type: 'goods', item: 'ITEM-A', qty: 10, unit_price: 40 }, { type: 'charge', item: 'FUEL', qty: 1, unit_price: 200 }, { type: 'charge', item: 'DETENTION', qty: 1, unit_price: 100 }];
    const json = ctx({ lines, bols: [{ bol_id: 'BOL-1', po_number: 'PO-1', signed: true, lines: [{ item: 'ITEM-A', qty: 10 }] }] });
    assert.equal(g(json, agent({ variance_amount: 100 })).route, 'escalate');
  });
  test('agent variance that disagrees with the recomputed one escalates', () => { const out = g(ctx({ lines: charge(150) }), agent({ variance_amount: 50 })); assert.equal(out.route, 'escalate'); has(out, 'differs from recomputed 150.00'); });
  test('PO from another vendor is a wrong PO', () => { const out = g(ctx({ po: { vendor_id: 'VEN-9' } })); assert.equal(out.route, 'escalate'); has(out, 'wrong PO'); });
  test('matching against a PO the invoice does not name escalates', () => { const out = g(ctx({ inv: { po_number: 'PO-7' } })); assert.equal(out.route, 'escalate'); has(out, 'invoice names PO-7'); });
  test('no PO found escalates', () => { const json = ctx(); json.po = null; const out = g(json); assert.equal(out.route, 'escalate'); has(out, 'wrong PO'); });
  test('missing BOL escalates', () => { const out = g(ctx({ bols: [] })); assert.equal(out.route, 'escalate'); has(out, 'missing BOL'); });
  test('unsigned BOL escalates', () => assert.equal(g(ctx({ bols: [{ bol_id: 'BOL-1', po_number: 'PO-1', signed: false, lines: [{ item: 'ITEM-A', qty: 100 }] }] })).route, 'escalate'));
  test('billing more than the BOL shows is quantity short', () => {
    const out = g(ctx({ bols: [{ bol_id: 'BOL-1', po_number: 'PO-1', signed: true, lines: [{ item: 'ITEM-A', qty: 90 }] }] }));
    assert.equal(out.route, 'escalate'); has(out, 'quantity short: invoice bills 100 of ITEM-A, BOL shows 90');
  });
  test('quantities across split BOLs add up', () => assert.equal(g(ctx({ bols: [{ bol_id: 'BOL-1', po_number: 'PO-1', signed: true, lines: [{ item: 'ITEM-A', qty: 60 }] }, { bol_id: 'BOL-2', po_number: 'PO-1', signed: true, lines: [{ item: 'ITEM-A', qty: 40 }] }] }), agent({ bol_ids: ['BOL-1', 'BOL-2'] })).route, 'auto'));
  test('goods not on the PO escalate', () => { const out = g(ctx({ lines: [{ type: 'goods', item: 'ITEM-Z', qty: 1, unit_price: 5 }] }), agent({ variance_amount: 5 })); assert.equal(out.route, 'escalate'); has(out, 'not on PO'); });
  test('lines that do not add up to the total escalate', () => { const out = g(ctx({ inv: { total: 4300 } })); assert.equal(out.route, 'escalate'); has(out, 'add up to 4200.00'); });
  test('duplicate invoice escalates', () => assert.equal(g(ctx({ inv: { duplicate_of: 'DOC-0' } })).route, 'escalate'));
  test('agent escalation is respected', () => assert.equal(g(ctx(), agent({ proposed_outcome: 'escalate', exception_type: 'suspicious_document', exception_reason: 'document asks to change bank details' })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  const planned = { document_id: 'DOC-1', po_number: 'PO-1', variance_amount: 150 };
  test('verify accepts the matched invoice', () => assert.equal(v({ status: 'matched', match: { po_number: 'PO-1', variance_amount: 150 } }, planned).verified, true));
  test('verify rejects a different variance', () => assert.equal(v({ status: 'matched', match: { po_number: 'PO-1', variance_amount: 0 } }, planned).verified, false));
}

done();
