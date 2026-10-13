// Manufacturing product agents: guardrails, verification and approval recording.
import { assert, loadProduct, run, test, section, done, days } from '../harness.mjs';

const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();

// ---------------- Aelix IQ · Maintenance Agent ----------------
{
  const wf = loadProduct('manufacturing', 'iq-maintenance');
  section('Aelix IQ · Maintenance Agent');
  const Config = { min_lead_hours: 2, max_days_ahead: 21, min_confidence: 0.8, approver_slack_user: 'maintenance-engineer', approval_timeout_hours: 8 };
  const req = { business_key: 'ALR-1', alert_id: 'ALR-1', asset_id: 'CMP-7', asset_name: 'Compressor 7', site: 'PLANT-1' };
  const agent = (o = {}, wo = {}) => ({ output: {
    finding: 'confirmed_fault', failure_mode: 'drive-end bearing wear', noise_reason: null, predicted_failure_by: inHours(24 * 7),
    work_order: { title: 'Replace DE bearing', description: 'Vibration at 2x rising.', job_plan_id: 'JP-BRG', work_type: 'predictive', priority: 2, tasks: ['Isolate', 'Replace bearing'], craft: 'mechanical', estimated_duration_hours: 3, ...wo },
    parts: [{ part_id: 'BRG-6309', qty: 2 }], window_start: inHours(24), window_end: inHours(28),
    confidence: 0.9, rationale: 'Trend and history agree.', questions_for_human: [], ...o } });
  const ctx = (o = {}) => ({
    alert: { status: 'open' }, open_work_orders: [],
    production_schedule: [
      { type: 'production', order_id: 'MO-1', start: inHours(10), end: inHours(23) },
      { type: 'planned_downtime', start: inHours(23), end: inHours(30) },
      { type: 'production', order_id: 'MO-2', start: inHours(30), end: inHours(40) },
    ],
    parts: [{ part_id: 'BRG-6309', on_hand: 3, reserved: 0 }],
    ...o,
  });
  const g = (json = ctx(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize alert': req, 'Maintenance agent': a } });

  test('fault with a clear window and parts in stock goes to the engineer', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.type, 'create_and_schedule_work_order');
    assert.deepEqual(out.action.parts, [{ part_id: 'BRG-6309', qty: 2 }]);
    assert.match(out.approval_summary, /Replace DE bearing/);
  });
  test('noise is recorded as no action', () => {
    const out = g(ctx(), agent({ finding: 'noise', noise_reason: 'sensor replaced yesterday', window_start: null, window_end: null, parts: [] }));
    assert.equal(out.route, 'none', out.guardrail_reasons.join('; '));
    assert.deepEqual(out.planned_actions, []);
  });
  test('window overlapping a production run escalates', () => {
    const out = g(ctx(), agent({ window_start: inHours(28), window_end: inHours(32) }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /MO-2/);
  });
  test('part short after reservations escalates', () => {
    const out = g(ctx({ parts: [{ part_id: 'BRG-6309', on_hand: 3, reserved: 2 }] }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /need 2, available 1/);
  });
  test('part missing from stock escalates', () => assert.equal(g(ctx({ parts: [] })).route, 'escalate'));
  test('window shorter than the job escalates', () => assert.equal(g(ctx(), agent({}, { estimated_duration_hours: 5 })).route, 'escalate'));
  test('window ending after the predicted failure escalates', () => assert.equal(g(ctx(), agent({ predicted_failure_by: inHours(26) })).route, 'escalate'));
  test('window starting inside the lead time escalates', () => assert.equal(g(ctx({ production_schedule: [] }), agent({ window_start: inHours(1), window_end: inHours(5) })).route, 'escalate'));
  test('existing open work order on the asset escalates', () => assert.equal(g(ctx({ open_work_orders: [{ work_order_id: 'WO-88' }] })).route, 'escalate'));
  test('alert already closed escalates', () => assert.equal(g(ctx({ alert: { status: 'closed' } })).route, 'escalate'));
  test('inconclusive finding escalates', () => assert.equal(g(ctx(), agent({ finding: 'inconclusive' })).route, 'escalate'));
  test('low confidence escalates', () => assert.equal(g(ctx(), agent({ confidence: 0.5 })).route, 'escalate'));

  test('approval click is recorded with the named engineer', () => {
    const r = run(wf, 'Record approval', { json: { data: { approved: true, respondedAt: '2026-10-13T10:00:00Z' } }, nodes: { Config } });
    assert.deepEqual([r.decision, r.approver], ['approved', 'maintenance-engineer']);
  });

  const planned = { asset_id: 'CMP-7', window_start: '2026-10-20T08:00:00Z', window_end: '2026-10-20T12:00:00Z', parts: [{ part_id: 'BRG-6309', qty: 2 }] };
  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: planned } } });
  const wo = (o = {}) => ({ work_order_id: 'WO-1', status: 'scheduled', asset_id: 'CMP-7', scheduled_start: '2026-10-20T08:00:00.000Z', scheduled_end: '2026-10-20T12:00:00Z', reservations: [{ part_id: 'BRG-6309', qty: 2 }], ...o });
  test('verify accepts a scheduled work order with parts reserved', () => assert.equal(v(wo()).verified, true));
  test('verify rejects a different window', () => assert.equal(v(wo({ scheduled_start: '2026-10-21T08:00:00Z' })).verified, false));
  test('verify rejects missing reservations', () => {
    const r = v(wo({ reservations: [] }));
    assert.equal(r.verified, false);
    assert.match(r.verify_detail, /BRG-6309/);
  });
  test('verify rejects a work order left unscheduled', () => assert.equal(v(wo({ status: 'waiting_approval' })).verified, false));
}

// ---------------- Aelix Forge · Re-planning Agent ----------------
{
  const wf = loadProduct('manufacturing', 'forge-replanning');
  section('Aelix Forge · Re-planning Agent');
  const Config = { max_overtime_hours: 8, replan_horizon_hours: 72, min_confidence: 0.8, approver_slack_user: 'production-planner', approval_timeout_hours: 2 };
  const base = Date.parse(days(1) + 'T00:00:00Z');
  const at = (h) => new Date(base + h * 3600000).toISOString();
  const req = { business_key: 'STOP-1', stop_id: 'STOP-1', site: 'PLANT-MN', line_id: 'L2', reason_code: 'EQUIP_FAILURE', stopped_at: at(0), expected_restart_at: at(20) };
  const shifts = [{ start: at(0), end: at(16) }];
  const snap = (o = {}) => ({
    stop: { stop_id: 'STOP-1', status: 'stopped', line_id: 'L2', stopped_at: at(0), expected_restart_at: at(20) },
    jobs: [
      { job_id: 'J1', product_id: 'P1', order_id: 'O1', line_id: 'L2', planned_start: at(2), planned_end: at(6), run_minutes: 240, due_at: at(30) },
      { job_id: 'J2', product_id: 'P2', order_id: 'O2', line_id: 'L2', planned_start: at(8), planned_end: at(12), run_minutes: 240, due_at: at(14) },
      { job_id: 'J3', product_id: 'P1', order_id: 'O3', line_id: 'L3', planned_start: at(0), planned_end: at(4), run_minutes: 240, due_at: at(40) },
    ],
    lines: [
      { line_id: 'L2', status: 'down', clearance_minutes: 30, last_product_id: 'P1', available_from: at(0), shifts },
      { line_id: 'L3', status: 'running', clearance_minutes: 30, last_product_id: 'P1', available_from: at(0), shifts },
      { line_id: 'L4', status: 'running', clearance_minutes: 30, last_product_id: 'P3', available_from: at(0), shifts },
    ],
    qualifications: [
      { line_id: 'L2', product_id: 'P1', status: 'validated' },
      { line_id: 'L2', product_id: 'P2', status: 'validated' },
      { line_id: 'L3', product_id: 'P1', status: 'validated' },
      { line_id: 'L3', product_id: 'P2', status: 'not_validated' },
      { line_id: 'L4', product_id: 'P2', status: 'validated', valid_until: at(200) },
    ],
    changeovers: [
      { line_id: 'L4', from_product_id: 'P3', to_product_id: 'P2', minutes: 60 },
      { line_id: 'L3', from_product_id: 'P1', to_product_id: 'P2', minutes: 90 },
    ],
    ...o,
  });
  const goodMoves = [
    { job_id: 'J1', to_line: 'L3', new_start: at(4.5), new_end: at(8.5), changeover_minutes: 0 },
    { job_id: 'J2', to_line: 'L4', new_start: at(1.5), new_end: at(5.5), changeover_minutes: 60 },
  ];
  const agent = (o = {}) => ({ output: { plan_status: 'replan_proposed', moves: goodMoves, orders_late: [], overtime_hours: 0, changeovers_added: 1, alternatives_considered: ['Hold J2 until restart: O2 late'], confidence: 0.9, rationale: 'Validated lines with capacity.', questions_for_human: [], ...o } });
  const withJ2 = (m) => [goodMoves[0], { job_id: 'J2', to_line: 'L4', changeover_minutes: 60, ...m }];
  const g = (json = snap(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize line stop': req, 'Re-planning agent': a } });
  const why = (out) => out.guardrail_reasons.join('; ');

  test('re-plan on validated lines with clearance goes to the planner with trade-offs', () => {
    const out = g();
    assert.equal(out.route, 'approve', why(out));
    assert.equal(out.action.moves.length, 2);
    assert.deepEqual(out.action.tradeoffs, { orders_late: [], overtime_hours: 0, changeovers_added: 1 });
    assert.match(out.approval_summary, /Trade-offs/);
    assert.match(out.approval_summary, /Changeovers added: 1/);
  });
  test('move to a line not validated for the product escalates', () => {
    const out = g(snap(), agent({ moves: [goodMoves[0], { job_id: 'J2', to_line: 'L3', new_start: at(10), new_end: at(14), changeover_minutes: 90 }] }));
    assert.equal(out.route, 'escalate');
    assert.match(why(out), /L3 is not validated for product P2/);
  });
  test('validation expiring mid-run escalates', () => {
    const s = snap();
    s.qualifications[4].valid_until = at(3);
    assert.match(why(g(s)), /expires/);
  });
  test('gap shorter than clearance plus changeover escalates', () => {
    const out = g(snap(), agent({ moves: withJ2({ new_start: at(1), new_end: at(5) }) }));
    assert.equal(out.route, 'escalate');
    assert.match(why(out), /needs 90 min \(clearance 30 \+ changeover 60\)/);
  });
  test('agent changeover minutes that differ from the matrix escalate', () => assert.equal(g(snap(), agent({ moves: withJ2({ new_start: at(1.5), new_end: at(5.5), changeover_minutes: 0 }) })).route, 'escalate'));
  test('missing changeover entry for a product pair escalates', () => {
    const s = snap();
    s.changeovers = s.changeovers.filter((c) => c.line_id !== 'L4');
    assert.match(why(g(s)), /no validated changeover time from P3 to P2/);
  });
  test('job put back on the stopped line before restart escalates', () => {
    const out = g(snap(), agent({ moves: [{ job_id: 'J1', to_line: 'L2', new_start: at(10), new_end: at(14), changeover_minutes: 0 }, goodMoves[1]] }));
    assert.match(why(out), /before its expected restart/);
  });
  test('job left on the stopped line during the stop escalates', () => {
    const out = g(snap(), agent({ moves: [goodMoves[0]], changeovers_added: 0 }));
    assert.match(why(out), /J2 is still scheduled on stopped line L2/);
  });
  test('overlap with an existing job escalates', () => assert.match(why(g(snap(), agent({ moves: [{ job_id: 'J1', to_line: 'L3', new_start: at(2), new_end: at(6), changeover_minutes: 0 }, goodMoves[1]] }))), /overlaps job J3/));
  test('late order the agent did not declare escalates', () => assert.match(why(g(snap(), agent({ moves: withJ2({ new_start: at(11), new_end: at(15) }) }))), /late orders in the plan are O2/));
  test('declared late order goes to the planner and is spelled out', () => {
    const out = g(snap(), agent({ moves: withJ2({ new_start: at(11), new_end: at(15) }), orders_late: [{ order_id: 'O2', due_at: at(14), new_completion: at(15) }] }));
    assert.equal(out.route, 'approve', why(out));
    assert.match(out.approval_summary, /Orders late: O2/);
  });
  test('overtime is recomputed from shifts and must match', () => {
    const moves = withJ2({ new_start: at(14), new_end: at(18) });
    const late = [{ order_id: 'O2', due_at: at(14), new_completion: at(18) }];
    assert.match(why(g(snap(), agent({ moves, orders_late: late, overtime_hours: 0 }))), /overtime recomputed as 2 h/);
    const ok = g(snap(), agent({ moves, orders_late: late, overtime_hours: 2 }));
    assert.equal(ok.route, 'approve', why(ok));
    assert.match(ok.approval_summary, /Overtime: 2 h/);
  });
  test('overtime above the cap escalates', () => {
    const moves = withJ2({ new_start: at(14), new_end: at(18) });
    const out = run(wf, 'Guardrails', { json: snap(), nodes: { Config: { ...Config, max_overtime_hours: 1 }, 'Normalize line stop': req, 'Re-planning agent': agent({ moves, orders_late: [{ order_id: 'O2' }], overtime_hours: 2 }) } });
    assert.match(why(out), /above the 1 h cap/);
  });
  test('stop already cleared escalates', () => assert.equal(g(snap({ stop: { ...snap().stop, status: 'running' } })).route, 'escalate'));
  test('no jobs affected is recorded as no change', () => {
    const s = snap({ jobs: [snap().jobs[2]] });
    const out = g(s, agent({ plan_status: 'no_change_needed', moves: [], changeovers_added: 0 }));
    assert.equal(out.route, 'none', why(out));
  });
  test('no feasible re-plan escalates', () => assert.equal(g(snap(), agent({ plan_status: 'no_feasible_replan', moves: [] })).route, 'escalate'));

  const planned = { moves: [{ job_id: 'J1', to_line: 'L3', new_start: '2026-10-14T04:30:00Z', new_end: '2026-10-14T08:30:00Z' }] };
  const v = (jobs) => run(wf, 'Verify', { json: { jobs }, nodes: { Guardrails: { action: planned } } });
  test('verify accepts the MES showing the approved slot', () => assert.equal(v([{ job_id: 'J1', line_id: 'L3', planned_start: '2026-10-14T04:30:00.000Z', planned_end: '2026-10-14T08:30:00Z' }]).verified, true));
  test('verify rejects a job still on the old line', () => assert.equal(v([{ job_id: 'J1', line_id: 'L2', planned_start: '2026-10-14T04:30:00Z', planned_end: '2026-10-14T08:30:00Z' }]).verified, false));
  test('verify rejects a missing job', () => assert.equal(v([]).verified, false));
}

// ---------------- Aelix Ops · Supplier Risk Agent ----------------
{
  const wf = loadProduct('manufacturing', 'ops-supplier-risk');
  section('Aelix Ops · Supplier Risk Agent');
  const Config = { low_cover_weeks: 4, min_confidence: 0.75, reviewer_slack_user: 'supply-chain-lead' };
  const req = { business_key: 'SIG-1', signal_id: 'SIG-1', supplier_id: 'SUP-1', supplier_name: 'Sample Castings', signal_type: 'financial_distress', source: 'trade_press' };
  const exposure = () => ({
    supplier: { supplier_id: 'SUP-1', status: 'active' }, currency: 'EUR',
    parts: [{ part_id: 'P-1', on_hand: 400, weekly_usage: 200, approved_sources: 1 }, { part_id: 'P-2', on_hand: 1000, weekly_usage: 100, approved_sources: 2 }],
    open_pos: [{ po_id: 'PO-1', part_id: 'P-1', open_qty: 500, unit_price: 12.5 }, { po_id: 'PO-2', part_id: 'P-2', open_qty: 100, unit_price: 3 }],
    where_used: [{ part_id: 'P-1', fg_id: 'FG-A' }, { part_id: 'P-2', fg_id: 'FG-A' }, { part_id: 'P-2', fg_id: 'FG-B' }, { part_id: 'P-9', fg_id: 'FG-Z' }],
    sales_orders: [
      { order_id: 'SO-1', customer_id: 'C-1', fg_id: 'FG-A', open_value: 10000 },
      { order_id: 'SO-2', customer_id: 'C-1', fg_id: 'FG-B', open_value: 500 },
      { order_id: 'SO-3', customer_id: 'C-2', fg_id: 'FG-B', open_value: 2000 },
      { order_id: 'SO-4', customer_id: 'C-3', fg_id: 'FG-Z', open_value: 999 },
    ],
  });
  const agent = (o = {}) => ({ output: {
    signal_assessment: 'unverified', severity: 'high',
    parts: [{ part_id: 'P-1', single_sourced: true, weeks_of_cover: 2 }, { part_id: 'P-2', single_sourced: false, weeks_of_cover: 10 }],
    open_po_ids: ['PO-1', 'PO-2'], open_po_value: 6550, finished_goods: ['FG-A', 'FG-B'],
    customers: [{ customer_id: 'C-1', open_order_value: 10500 }, { customer_id: 'C-2', open_order_value: 2000 }],
    mitigations: [{ action: 'Qualify an alternate source for P-1', owner_role: 'category buyer', by_when: '2026-10-27', part_ids: ['P-1'] }],
    brief: 'x'.repeat(300), confidence: 0.85, rationale: 'ERP records.', questions_for_human: [], ...o } });
  const g = (json = exposure(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize risk signal': req, 'Supplier risk agent': a } });
  const why = (out) => out.guardrail_reasons.join('; ');

  test('consistent exposure brief goes to the supply chain lead', () => {
    const out = g();
    assert.equal(out.route, 'draft', why(out));
    assert.equal(out.draft.exposure.open_po_value, 6550);
    assert.deepEqual(out.draft.exposure.customers, [{ customer_id: 'C-1', open_order_value: 10500 }, { customer_id: 'C-2', open_order_value: 2000 }]);
    assert.equal(out.draft.exposure.parts[0].low_cover, true);
    assert.match(out.draft_summary, /1 single-sourced, 1 under 4 weeks/);
    assert.deepEqual(out.planned_actions, [{ action: 'draft_for_review' }]);
  });
  test('Slack summary carries counts, not the brief text', () => assert.doesNotMatch(g().draft_summary, /x{20}/));
  test('open PO value that does not recompute escalates', () => assert.match(why(g(exposure(), agent({ open_po_value: 6000 }))), /recomputed as 6550/));
  test('missing part escalates', () => assert.match(why(g(exposure(), agent({ parts: [{ part_id: 'P-1', single_sourced: true, weeks_of_cover: 2 }] }))), /leaves out parts P-2/));
  test('missing open PO escalates', () => assert.match(why(g(exposure(), agent({ open_po_ids: ['PO-1'] }))), /leaves out open POs PO-2/));
  test('finished good missing from the brief escalates', () => assert.match(why(g(exposure(), agent({ finished_goods: ['FG-A'] }))), /FG-B/));
  test('customer with no dependent orders escalates', () => assert.match(why(g(exposure(), agent({ customers: [...agent().output.customers, { customer_id: 'C-3', open_order_value: 999 }] }))), /C-3/));
  test('single-sourcing that does not match the ERP escalates', () => assert.equal(g(exposure(), agent({ parts: [{ part_id: 'P-1', single_sourced: false, weeks_of_cover: 2 }, { part_id: 'P-2', single_sourced: false, weeks_of_cover: 10 }] })).route, 'escalate'));
  test('weeks of cover that do not recompute escalate', () => assert.match(why(g(exposure(), agent({ parts: [{ part_id: 'P-1', single_sourced: true, weeks_of_cover: 6 }, { part_id: 'P-2', single_sourced: false, weeks_of_cover: 10 }] }))), /cover recomputed as 2/));
  test('exposure without mitigations escalates', () => assert.equal(g(exposure(), agent({ mitigations: [] })).route, 'escalate'));
  test('low confidence escalates', () => assert.equal(g(exposure(), agent({ confidence: 0.5 })).route, 'escalate'));
}

// ---------------- Aelix Link · Recall Agent ----------------
{
  const wf = loadProduct('manufacturing', 'link-recall');
  section('Aelix Link · Recall Agent');
  const Config = { max_trace_depth: 10, min_confidence: 0.8, reviewer_slack_user: 'quality-regulatory-lead' };
  const req = { business_key: 'RC-1', recall_case_id: 'RC-1', suspect_lot_ids: ['RES-A'], suspect_lots: [{ lot_id: 'RES-A' }] };
  const trace = (o = {}) => ({
    complete: true, unreachable_sites: [],
    lots: [
      { lot_id: 'RES-A', item_id: 'RM', site: 'TX', parent_lot_ids: [], qty_on_hand: 200 },
      { lot_id: 'MLD-1', item_id: 'HSG', site: 'TX', parent_lot_ids: ['RES-A'], qty_on_hand: 0 },
      { lot_id: 'ASM-1', item_id: 'FG', site: 'MX', parent_lot_ids: ['MLD-1', 'OTHER-9'], qty_on_hand: 50 },
      { lot_id: 'OTHER-9', item_id: 'X', site: 'MX', parent_lot_ids: [], qty_on_hand: 10 },
    ],
    shipments: [
      { shipment_id: 'SH-1', lot_id: 'MLD-1', ship_to_id: 'SITE-MX', ship_to_type: 'internal_site', country: 'MX', qty: 500 },
      { shipment_id: 'SH-2', lot_id: 'ASM-1', ship_to_id: 'CUST-1', ship_to_type: 'customer', country: 'US', qty: 300 },
      { shipment_id: 'SH-3', lot_id: 'ASM-1', ship_to_id: 'DIST-1', ship_to_type: 'distributor', country: 'CA', qty: 150 },
      { shipment_id: 'SH-9', lot_id: 'OTHER-9', ship_to_id: 'CUST-2', ship_to_type: 'customer', country: 'US', qty: 5 },
    ],
    ...o,
  });
  const lotsOut = [
    { lot_id: 'RES-A', item_id: 'RM', site: 'TX', qty_on_hand: 200, qty_shipped: 0 },
    { lot_id: 'MLD-1', item_id: 'HSG', site: 'TX', qty_on_hand: 0, qty_shipped: 0 },
    { lot_id: 'ASM-1', item_id: 'FG', site: 'MX', qty_on_hand: 50, qty_shipped: 450 },
  ];
  const shipsOut = ['SH-1', 'SH-2', 'SH-3'].map((id) => ({ shipment_id: id }));
  const actions = [
    { action: 'quarantine_on_hand', lot_ids: ['RES-A', 'ASM-1'], party_or_site: 'TX, MX', detail: 'Hold on-hand stock.' },
    { action: 'customer_notification', lot_ids: ['ASM-1'], party_or_site: 'CUST-1, DIST-1', detail: 'Draft notice.' },
    { action: 'regulatory_assessment', lot_ids: ['ASM-1'], party_or_site: 'US, CA', detail: 'Assess reporting.' },
  ];
  const agent = (o = {}) => ({ output: { affected_lots: lotsOut, shipments: shipsOut, recall_actions: actions, health_hazard_notes: 'Housing strength may be reduced.', confidence: 0.9, rationale: 'Genealogy trace.', questions_for_human: [], ...o } });
  const g = (json = trace(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize recall case': req, 'Recall agent': a } });
  const why = (out) => out.guardrail_reasons.join('; ');

  test('traced draft matching the genealogy goes to the quality lead', () => {
    const out = g();
    assert.equal(out.route, 'draft', why(out));
    assert.deepEqual(out.draft.affected_lots.map((l) => l.lot_id), ['RES-A', 'MLD-1', 'ASM-1']);
    assert.deepEqual(out.draft.totals, { lots: 3, sites: 2, qty_on_hand: 250, qty_shipped_external: 450, ship_to_parties: 2, countries: ['CA', 'US'] });
  });
  test('Slack summary carries counts, not customer ids', () => assert.doesNotMatch(g().draft_summary, /CUST-1|DIST-1/));
  test('draft missing a descendant lot escalates', () => assert.match(why(g(trace(), agent({ affected_lots: lotsOut.slice(0, 2) }))), /misses affected lots ASM-1/));
  test('draft including an unlinked lot escalates', () => assert.match(why(g(trace(), agent({ affected_lots: [...lotsOut, { lot_id: 'OTHER-9', qty_on_hand: 10, qty_shipped: 5 }] }))), /does not link.*OTHER-9/));
  test('incomplete trace escalates', () => assert.equal(g(trace({ complete: false })).route, 'escalate'));
  test('unreachable site escalates', () => assert.match(why(g(trace({ unreachable_sites: ['PLANT-DE'] }))), /PLANT-DE/));
  test('suspect lot missing from genealogy escalates', () => assert.match(why(g(trace({ lots: trace().lots.filter((l) => l.lot_id !== 'RES-A') }))), /suspect lots not found/));
  test('shipped quantity that does not recompute escalates', () => assert.match(why(g(trace(), agent({ affected_lots: [lotsOut[0], lotsOut[1], { ...lotsOut[2], qty_shipped: 300 }] }))), /shipped externally is 450/));
  test('missing shipment escalates', () => assert.match(why(g(trace(), agent({ shipments: shipsOut.slice(0, 2) }))), /misses shipments SH-3/));
  test('on-hand lot without a quarantine action escalates', () => assert.match(why(g(trace(), agent({ recall_actions: [{ ...actions[0], lot_ids: ['RES-A'] }, actions[1], actions[2]] }))), /ASM-1 has 50 on hand/));
  test('shipped lot without a notification or retrieval escalates', () => assert.match(why(g(trace(), agent({ recall_actions: [actions[0], actions[2]] }))), /no notification or retrieval/));
  test('draft without a regulatory assessment escalates', () => assert.match(why(g(trace(), agent({ recall_actions: actions.slice(0, 2) }))), /regulatory assessment/));
  test('low confidence escalates', () => assert.equal(g(trace(), agent({ confidence: 0.6 })).route, 'escalate'));
}

done();
