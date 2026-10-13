// Real Estate and Construction product agents: guardrails, routing, approval and verification.
import { assert, loadProduct, run, test, section, done, days } from '../harness.mjs';

// ---------------- Aelix Estate · Estate Agent ----------------
{
  const wf = loadProduct('realestate', 'estate-maintenance-dispatch');
  section('Aelix Estate · Estate Agent');
  const Config = {
    emergency_terms: ['gas', 'gas leak', 'smell gas', 'carbon monoxide', 'fire', 'smoke', 'flood', 'flooding', 'burst pipe', 'sparking', 'sparks'],
    no_heat_terms: ['no heat', 'heat not working', 'furnace out'],
    no_heat_emergency_below_f: 32, coi_min_days_valid: 7,
    min_confidence: 0.85, approver_slack_user: 'property-ops-manager', approval_timeout_hours: 2,
  };
  const intake = (body) => run(wf, 'Normalize ticket', { json: { body }, nodes: { Config } });
  const req = (o = {}) => ({ business_key: 'MT-1', ticket_id: 'MT-1', property_id: 'PRP-1', unit_id: '3B', category: 'plumbing',
    title: 'Sink leaking', description: 'Water drips from the pipe under the kitchen sink.', emergency_terms: [], ...o });
  const agent = (o = {}) => ({ output: { recommendation: 'dispatch_vendor', emergency: false, trade: 'plumbing', priority: 'routine', vendor_id: 'V-7',
    labor_hours: 2, materials_cost: 40, estimated_total: 285, not_to_exceed: 350, scope_of_work: 'Leak at the sink trap in unit 3B kitchen.',
    confidence: 0.9, rationale: 'Plumbing leak.', questions_for_human: [], ...o } });
  const ctx = ({ ticket = {}, vendor = {}, property = {}, open = [] } = {}) => ({
    ticket: { ticket_id: 'MT-1', status: 'open', title: 'Sink leaking', description: 'Water drips from the pipe under the kitchen sink.', tenant_email: 'tenant@example.com', tenant_first_name: 'Ana', ...ticket },
    vendor: { vendor_id: 'V-7', name: 'Brightline Plumbing', status: 'approved', approved_trades: ['plumbing'], coi_expires_on: days(90), hourly_rate: 110, trip_charge: 25, ...vendor },
    property: { property_id: 'PRP-1', nte_limit: 500, outdoor_temp_f: 58, ...property },
    open_work_orders: open,
  });
  const g = (json = ctx(), a = agent(), r = req()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize ticket': r, 'Maintenance dispatch agent': a } });

  test('routine dispatch with a qualified vendor goes to the ops manager', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.estimate, 285);
    assert.equal(out.action.tenant_email, 'tenant@example.com');
    assert.equal(out.action.trade_label, 'plumbing');
  });
  test('vendor not approved for the trade escalates', () => {
    const out = g(ctx({ vendor: { approved_trades: ['hvac'] } }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(), /not approved for plumbing/);
  });
  test('vendor with a non-approved status escalates', () => assert.equal(g(ctx({ vendor: { status: 'suspended' } })).route, 'escalate'));
  test('expired certificate of insurance escalates', () => {
    const out = g(ctx({ vendor: { coi_expires_on: days(-1) } }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(), /certificate of insurance expires/);
  });
  test('certificate expiring inside the validity window escalates', () => assert.equal(g(ctx({ vendor: { coi_expires_on: days(3) } })).route, 'escalate'));
  test('estimate the agent got wrong escalates', () => assert.match(g(ctx(), agent({ estimated_total: 250 })).guardrail_reasons.join(), /recomputed 285/));
  test('cap above the property not-to-exceed escalates', () => assert.equal(g(ctx(), agent({ not_to_exceed: 600 })).route, 'escalate'));
  test('estimate above the property not-to-exceed escalates', () => assert.equal(g(ctx({ property: { nte_limit: 250 } }), agent({ not_to_exceed: 250 })).route, 'escalate'));
  test('cap below the estimate escalates', () => assert.equal(g(ctx(), agent({ not_to_exceed: 200 })).route, 'escalate'));
  test('gas smell in the ticket escalates as an emergency even if the agent missed it', () => {
    const out = g(ctx({ ticket: { description: 'I smell gas near the stove.' } }));
    assert.equal(out.route, 'escalate');
    assert.equal(out.action.emergency, true);
    assert.match(out.guardrail_reasons.join(), /possible emergency \(.*gas/);
  });
  test('electrical sparking escalates as an emergency', () => assert.equal(g(ctx({ ticket: { description: 'The outlet is sparking when I plug in.' } })).action.emergency, true));
  test('no heat in freezing weather escalates', () => assert.match(g(ctx({ ticket: { description: 'No heat since last night.' }, property: { outdoor_temp_f: 20 } })).guardrail_reasons.join(), /no heat at 20F/));
  test('no heat on a mild day is not an emergency', () => assert.equal(g(ctx({ ticket: { description: 'No heat since last night.' }, property: { outdoor_temp_f: 60 } }), agent({ trade: 'hvac' }), req()).action.emergency, false));
  test('fireplace does not trip the fire keyword', () => assert.equal(g(ctx({ ticket: { description: 'Fireplace screen is loose.' } })).action.emergency, false));
  test('intake flags emergency words before the agent runs', () => {
    assert.deepEqual(intake({ ticket_id: 'MT-9', property_id: 'PRP-1', description: 'Basement is flooding fast' }).emergency_terms, ['flooding']);
    assert.deepEqual(intake({ ticket_id: 'MT-9', property_id: 'PRP-1', description: 'Dishwasher will not drain' }).emergency_terms, []);
  });
  test('ticket that already has an open work order is recorded as no action', () =>
    assert.equal(g(ctx({ open: [{ work_order_id: 'WO-1' }] }), agent({ recommendation: 'already_dispatched', vendor_id: null })).route, 'none'));
  test('dispatch while a work order is already open escalates', () => assert.equal(g(ctx({ open: [{ work_order_id: 'WO-1' }] })).route, 'escalate'));
  test('ticket closed since intake escalates', () => assert.equal(g(ctx({ ticket: { status: 'closed' } })).route, 'escalate'));
  test('low confidence escalates', () => assert.equal(g(ctx(), agent({ confidence: 0.5 })).route, 'escalate'));

  test('tenant update is a fixed template with no model text', () => {
    const node = wf.nodes.find((n) => n.name === 'Send tenant update (fixed template)');
    assert.ok(node, 'tenant update node exists');
    const text = node.parameters.message + node.parameters.subject;
    assert.doesNotMatch(text, /scope_of_work|rationale|\.output/);
    assert.ok(wf.connections['Verified?'].main[0].some((c) => c.node === node.name), 'tenant update runs only after verification');
  });
  test('approval click is recorded with the named approver', () => {
    const r = run(wf, 'Record approval', { json: { data: { approved: true, respondedAt: '2026-10-13T10:00:00Z' } }, nodes: { Config } });
    assert.deepEqual([r.decision, r.approver], ['approved', 'property-ops-manager']);
  });
  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: { ticket_id: 'MT-1', vendor_id: 'V-7', not_to_exceed: 350 } } } });
  test('verify accepts the dispatched work order', () => assert.equal(v({ work_order_id: 'WO-5', status: 'dispatched', ticket_id: 'MT-1', vendor_id: 'V-7', not_to_exceed: 350 }).verified, true));
  test('verify rejects a different vendor', () => assert.equal(v({ work_order_id: 'WO-5', status: 'dispatched', ticket_id: 'MT-1', vendor_id: 'V-8', not_to_exceed: 350 }).verified, false));
}

// ---------------- Aelix Blueprint · BIM Agent ----------------
{
  const wf = loadProduct('realestate', 'blueprint-bim-clash');
  section('Aelix Blueprint · BIM Agent');
  const Config = { max_clash_test_age_hours: 24, max_issues_per_push: 25, min_confidence: 0.8, approver_slack_user: 'bim-coordinator', approval_timeout_hours: 24 };
  const req = { business_key: 'CT-1:RUN-1', project_id: 'PRJ-1', clash_test_id: 'CT-1', run_id: 'RUN-1', test_name: 'L4 MEP vs STR' };
  const clash = (id, a, ad, b, bd, status = 'new') => ({ clash_id: id, status, element_a: { element_id: a, discipline: ad }, element_b: { element_id: b, discipline: bd }, location: { level: 'L4' } });
  const snap = (o = {}) => ({
    clash_test: { run_id: 'RUN-1', ran_at: new Date(Date.now() - 3600000).toISOString(), clashes: [
      clash('C-1', 'DUCT-10', 'mechanical', 'BEAM-4', 'structural'),
      clash('C-2', 'PIPE-22', 'plumbing', 'DUCT-10', 'mechanical'),
      clash('C-3', 'CONDUIT-5', 'electrical', 'BEAM-4', 'structural'),
    ] },
    open_issues: [],
    responsibility: { mechanical: 'mechanical-sub', plumbing: 'plumbing-sub', electrical: 'electrical-sub', structural: 'steel-erector' },
    ...o,
  });
  const issue = (o = {}) => ({ clash_id: 'C-1', rank: 1, priority: 'high', responsible_element_id: 'DUCT-10', discipline: 'mechanical', assigned_trade: 'mechanical-sub', title: 'L4 grid C3: duct through beam', description: 'Lower duct 150 mm.', ...o });
  const agent = (issues = [issue(), issue({ clash_id: 'C-2', rank: 2, responsible_element_id: 'PIPE-22', discipline: 'plumbing', assigned_trade: 'plumbing-sub', title: 'L4: pipe through duct' })], o = {}) =>
    ({ output: { issues, skipped_count: 1, confidence: 0.88, rationale: 'Ranked.', questions_for_human: [], ...o } });
  const g = (json = snap(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize clash test run': req, 'BIM clash agent': a } });

  test('ranked issues for the responsible trades go to the coordinator', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.deepEqual(out.action.topics.map((t) => [t.clash_id, t.assigned_trade, t.rank]), [['C-1', 'mechanical-sub', 1], ['C-2', 'plumbing-sub', 2]]);
    assert.deepEqual(out.action.topics[0].element_ids, ['DUCT-10', 'BEAM-4']);
  });
  test('a clash missing from the fresh read escalates', () => {
    const out = g(snap(), agent([issue({ clash_id: 'C-99' })]));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(), /C-99 is not in the fresh clash test read/);
  });
  test('assignment to the wrong trade escalates', () => assert.match(g(snap(), agent([issue({ assigned_trade: 'steel-erector' })])).guardrail_reasons.join(), /mechanical elements belong to mechanical-sub/));
  test('responsible element that is not part of the clash escalates', () => assert.equal(g(snap(), agent([issue({ responsible_element_id: 'WALL-1' })])).route, 'escalate'));
  test('discipline missing from the responsibility matrix escalates', () => assert.equal(g(snap({ responsibility: { plumbing: 'plumbing-sub' } }), agent([issue()])).route, 'escalate'));
  test('duplicate of an open issue by clash id is dropped', () => {
    const out = g(snap({ open_issues: [{ issue_id: 'ISS-1', clash_id: 'C-1', element_ids: [] }] }));
    assert.equal(out.route, 'approve');
    assert.deepEqual(out.action.topics.map((t) => t.clash_id), ['C-2']);
    assert.deepEqual(out.action.dropped, [{ clash_id: 'C-1', reason: 'already has an open issue' }]);
  });
  test('duplicate of an open issue by element pair is dropped', () =>
    assert.deepEqual(g(snap({ open_issues: [{ issue_id: 'ISS-2', clash_id: 'C-OLD', element_ids: ['BEAM-4', 'DUCT-10'] }] })).action.topics.map((t) => t.clash_id), ['C-2']));
  test('resolved clash is dropped', () => {
    const s = snap();
    s.clash_test.clashes[1].status = 'resolved';
    assert.deepEqual(g(s).action.topics.map((t) => t.clash_id), ['C-1']);
  });
  test('everything already open is recorded as no action', () =>
    assert.equal(g(snap({ open_issues: [{ clash_id: 'C-1' }, { clash_id: 'C-2' }] })).route, 'none'));
  test('stale clash test escalates', () => assert.equal(g(snap({ clash_test: { ...snap().clash_test, ran_at: new Date(Date.now() - 48 * 3600000).toISOString() } })).route, 'escalate'));
  test('ranks are renumbered in order', () => {
    const out = g(snap(), agent([issue({ rank: 7 }), issue({ clash_id: 'C-3', rank: 3, responsible_element_id: 'CONDUIT-5', discipline: 'electrical', assigned_trade: 'electrical-sub' })]));
    assert.deepEqual(out.action.topics.map((t) => [t.clash_id, t.rank]), [['C-3', 1], ['C-1', 2]]);
  });
  test('batch over the push limit escalates', () => assert.equal(run(wf, 'Guardrails', { json: snap(), nodes: { Config: { ...Config, max_issues_per_push: 1 }, 'Normalize clash test run': req, 'BIM clash agent': agent() } }).route, 'escalate'));

  const planned = { topics: [{ clash_id: 'C-1', assigned_trade: 'mechanical-sub' }, { clash_id: 'C-2', assigned_trade: 'plumbing-sub' }] };
  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: planned } } });
  test('verify accepts every topic with its assignee', () => assert.equal(v({ topics: [{ clash_id: 'C-1', assigned_trade: 'mechanical-sub' }, { clash_id: 'C-2', assigned_trade: 'plumbing-sub' }] }).verified, true));
  test('verify rejects a missing topic', () => assert.equal(v({ topics: [{ clash_id: 'C-1', assigned_trade: 'mechanical-sub' }] }).verified, false));
  test('verify rejects a wrong assignee', () => assert.equal(v({ topics: [{ clash_id: 'C-1', assigned_trade: 'steel-erector' }, { clash_id: 'C-2', assigned_trade: 'plumbing-sub' }] }).verified, false));
}

// ---------------- Aelix SiteOps · Site Agent ----------------
{
  const wf = loadProduct('realestate', 'siteops-incident');
  section('Aelix SiteOps · Site Agent');
  const Config = {
    max_window_hours: 12,
    serious_potential_types: ['fall_from_height', 'struck_by', 'caught_in_between', 'electrical_contact'],
    injury_terms: ['injur', 'hurt', 'ambulance', 'first aid', 'hospital'],
    min_confidence: 0.8, approver_slack_user: 'project-manager', approval_timeout_hours: 24,
  };
  const req = (o = {}) => ({ business_key: 'INC-1', incident_id: 'INC-1', project_id: 'PRJ-1', site_id: 'S-1', incident_type: 'property_damage',
    window_start: '2026-10-13T13:20:00.000Z', window_end: '2026-10-13T14:05:00.000Z', report_note: 'Telehandler backed into the fence. No one nearby.', ...o });
  const evidence = (o = {}) => ({
    incident: { incident_id: 'INC-1', status: 'open', incident_type: 'property_damage', window_start: '2026-10-13T13:20:00Z', window_end: '2026-10-13T14:05:00Z', injury_reported: false, report_filed: false, ...(o.incident ?? {}) },
    camera_events: [
      { event_id: 'CAM-1', camera_id: 'N-GATE', occurred_at: '2026-10-13T13:31:10Z', event_type: 'equipment_proximity' },
      { event_id: 'CAM-2', camera_id: 'N-GATE', occurred_at: '2026-10-13T12:10:00Z', event_type: 'ppe_missing' },
      ...(o.cams ?? []),
    ],
    logs: [
      { log_id: 'LOG-1', logged_at: '2026-10-13T13:35:00Z', log_type: 'daily_log', text: 'Fence panel bent at north gate.' },
      ...(o.logs ?? []),
    ],
  });
  const agent = (o = {}) => ({ output: {
    classification: 'property_damage', injury_involved: false, serious_potential: false, summary: 'A telehandler reversing at the north gate struck the temporary fence.',
    timeline: [
      { at: '2026-10-13T13:31:10Z', source: 'camera_event', ref_id: 'CAM-1', what_happened: 'Telehandler reverses toward the fence.' },
      { at: '2026-10-13T13:35:00Z', source: 'site_log', ref_id: 'LOG-1', what_happened: 'Damage logged.' },
    ],
    contributing_factors: ['No spotter at the gate'], corrective_actions: ['Spotter for reversing at gates'], evidence_gaps: [],
    confidence: 0.86, rationale: 'CAM-1 and LOG-1.', questions_for_human: [], ...o } });
  const g = (json = evidence(), a = agent(), r = req()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize incident': r, 'Site incident agent': a } });

  test('pack built from returned evidence inside the window goes to the project manager', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.deepEqual(out.action.evidence, { camera_event_ids: ['CAM-1'], log_ids: ['LOG-1'] });
    assert.equal(out.action.timeline[0].at, '2026-10-13T13:31:10.000Z');
  });
  test('a camera event the tools never returned escalates', () => {
    const a = agent();
    a.output.timeline.push({ at: '2026-10-13T13:40:00Z', source: 'camera_event', ref_id: 'CAM-404', what_happened: 'x' });
    assert.match(g(evidence(), a).guardrail_reasons.join(), /CAM-404 was not returned/);
  });
  test('a log cited as a camera event escalates', () => {
    const a = agent();
    a.output.timeline[1].source = 'camera_event';
    assert.equal(g(evidence(), a).route, 'escalate');
  });
  test('evidence outside the incident window escalates', () => {
    const a = agent();
    a.output.timeline.push({ at: '2026-10-13T12:10:00Z', source: 'camera_event', ref_id: 'CAM-2', what_happened: 'PPE missing.' });
    assert.match(g(evidence(), a).guardrail_reasons.join(), /CAM-2 at .* is outside the incident window/);
  });
  test('a timestamp that does not match the record escalates', () => {
    const a = agent();
    a.output.timeline[0].at = '2026-10-13T13:50:00Z';
    assert.match(g(evidence(), a).guardrail_reasons.join(), /cited at .* but recorded at/);
  });
  test('injury reported on the incident goes to the safety manager', () => {
    const out = g(evidence({ incident: { injury_reported: true } }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(), /safety manager .* OSHA recordability/);
  });
  test('injury words in the site note go to the safety manager even if the agent says none', () =>
    assert.equal(g(evidence(), agent(), req({ report_note: 'Laborer got first aid for a cut hand.' })).action.injury_involved, true));
  test('near miss with a serious-potential event type goes to the safety manager', () => {
    const ev = evidence({ cams: [{ event_id: 'CAM-3', occurred_at: '2026-10-13T13:45:00Z', event_type: 'struck_by' }] });
    const a = agent({ classification: 'near_miss' });
    a.output.timeline.push({ at: '2026-10-13T13:45:00Z', source: 'camera_event', ref_id: 'CAM-3', what_happened: 'Load swings near a worker.' });
    const out = g(ev, a);
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(), /serious potential \(struck_by\)/);
  });
  test('agent judging serious potential goes to the safety manager', () => assert.equal(g(evidence(), agent({ serious_potential: true })).route, 'escalate'));
  test('incident already filed escalates', () => assert.equal(g(evidence({ incident: { report_filed: true } })).route, 'escalate'));
  test('empty timeline escalates', () => assert.equal(g(evidence(), agent({ timeline: [] })).route, 'escalate'));
  test('intake rejects a window longer than the limit', () =>
    assert.throws(() => run(wf, 'Normalize incident', { json: { body: { ...req(), window_end: '2026-10-14T13:20:00Z' } }, nodes: { Config } }), /longer than 12 hours/));
  test('setup sticky says OSHA recordability stays with the safety manager', () =>
    assert.ok(wf.nodes.some((n) => n.name === 'Setup' && /OSHA recordability decisions stay with the safety manager/.test(n.parameters.content))));

  const planned = { evidence: { camera_event_ids: ['CAM-1'], log_ids: ['LOG-1'] } };
  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: planned } } });
  test('verify accepts a filed report with the cited evidence', () => assert.equal(v({ status: 'report_filed', report: { camera_event_ids: ['CAM-1'], log_ids: ['LOG-1'] } }).verified, true));
  test('verify rejects a report missing evidence', () => assert.equal(v({ status: 'report_filed', report: { camera_event_ids: [], log_ids: ['LOG-1'] } }).verified, false));
  test('verify rejects an unfiled incident', () => assert.equal(v({ status: 'open', report: { camera_event_ids: ['CAM-1'], log_ids: ['LOG-1'] } }).verified, false));
}

// ---------------- Aelix Spaces · Building Agent ----------------
{
  const wf = loadProduct('realestate', 'spaces-setpoint');
  section('Aelix Spaces · Building Agent');
  const Config = {
    comfort_bands_f: { office: { cooling: { min: 74, max: 78 }, heating: { min: 68, max: 72 } } },
    max_step_f: 2, max_step_occupied_f: 1, excluded_zone_types: ['lab', 'data_room', 'healthcare'], excluded_zone_ids: ['L09-EXEC'],
    heating_floor_f: 55, cooling_ceiling_f: 85, min_deadband_f: 2,
    min_confidence: 0.85, approver_slack_user: 'facilities-manager', approval_timeout_hours: 4,
  };
  const req = { business_key: 'D-1', signal_id: 'D-1', building_id: 'B-1', zone_id: 'L07-EAST', drift_type: 'energy_above_baseline' };
  const zone = (o = {}) => ({ zone_id: 'L07-EAST', zone_type: 'office', occupied_now: false, cooling_setpoint_f: 74, heating_setpoint_f: 70, override_active: false, open_comfort_complaints: 0, ...o });
  const agent = (o = {}) => ({ output: { proposal_type: 'change_setpoint', point: 'cooling_setpoint', current_setpoint_f: 74, proposed_setpoint_f: 76, confidence: 0.9, rationale: 'Overcooling after hours.', questions_for_human: [], ...o } });
  const g = (json = zone(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize drift signal': req, 'Building setpoint agent': a } });

  test('in-band change within the step limit acts inside the envelope', () => {
    const out = g();
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.deepEqual([out.action.from_f, out.action.to_f, out.action.step_f], [74, 76, 2]);
  });
  test('the same step during occupied hours asks the facilities manager', () => {
    const out = g(zone({ occupied_now: true }));
    assert.equal(out.route, 'approve');
    assert.match(out.approval_summary, /occupied-hours limit of 1/);
  });
  test('a 1 F step during occupied hours stays inside the envelope', () => assert.equal(g(zone({ occupied_now: true }), agent({ proposed_setpoint_f: 75 })).route, 'auto'));
  test('outside the comfort band asks the facilities manager', () => assert.equal(g(zone({ cooling_setpoint_f: 77 }), agent({ current_setpoint_f: 77, proposed_setpoint_f: 79 })).route, 'approve'));
  test('step above the maximum asks the facilities manager', () => assert.equal(g(zone({ cooling_setpoint_f: 74 }), agent({ proposed_setpoint_f: 77 })).route, 'approve'));
  test('lab zone asks the facilities manager', () => {
    const out = g(zone({ zone_type: 'lab' }));
    assert.equal(out.route, 'approve');
    assert.match(out.approval_summary, /lab zones are excluded/);
  });
  test('data room and healthcare zones ask the facilities manager', () => {
    assert.equal(g(zone({ zone_type: 'data_room' })).within_envelope, false);
    assert.equal(g(zone({ zone_type: 'healthcare' })).within_envelope, false);
  });
  test('excluded zone id asks the facilities manager', () => assert.equal(g(zone({ zone_id: 'L09-EXEC' })).route, 'approve'));
  test('manual override asks the facilities manager', () => assert.equal(g(zone({ override_active: true })).route, 'approve'));
  test('open comfort complaint asks the facilities manager', () => assert.equal(g(zone({ open_comfort_complaints: 2 })).route, 'approve'));
  test('setpoint that changed since the agent read it escalates', () => assert.match(g(zone({ cooling_setpoint_f: 75 })).guardrail_reasons.join(), /zone now reads 75/));
  test('the step is recomputed from the fresh read, not the agent', () => {
    const out = g(zone({ cooling_setpoint_f: 75 }), agent({ current_setpoint_f: 75, proposed_setpoint_f: 76 }));
    assert.equal(out.action.step_f, 1);
  });
  test('closing the deadband escalates', () => assert.equal(g(zone(), agent({ point: 'heating_setpoint', current_setpoint_f: 70, proposed_setpoint_f: 73 })).route, 'escalate'));
  test('heating below the floor escalates', () => assert.equal(g(zone({ heating_setpoint_f: 56 }), agent({ point: 'heating_setpoint', current_setpoint_f: 56, proposed_setpoint_f: 54 })).route, 'escalate'));
  test('value off the 0.5 F grid escalates', () => assert.equal(g(zone(), agent({ proposed_setpoint_f: 75.3 })).route, 'escalate'));
  test('equipment fault escalates', () => assert.equal(g(zone(), agent({ proposal_type: 'investigate_equipment', point: null, current_setpoint_f: null, proposed_setpoint_f: null })).route, 'escalate'));
  test('no change is recorded, not escalated', () => assert.equal(g(zone(), agent({ proposal_type: 'no_change', point: null, current_setpoint_f: null, proposed_setpoint_f: null })).route, 'none'));
  test('low confidence escalates', () => assert.equal(g(zone(), agent({ confidence: 0.6 })).route, 'escalate'));

  test('automatic runs name the envelope as the approver', () => {
    const w = wf.nodes.find((n) => n.name === 'Write setpoint (BMS)');
    assert.match(w.parameters.jsonBody, /'envelope:comfort_bands_f,max_step_f,max_step_occupied_f,excluded_zones'/);
    assert.ok(w.parameters.headerParameters.parameters.some((h) => h.name === 'Idempotency-Key'));
  });
  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts the zone at the planned value', () => assert.equal(v({ cooling_setpoint_f: 76 }, { point: 'cooling_setpoint', to_f: 76 }).verified, true));
  test('verify rejects a zone still at the old value', () => assert.equal(v({ cooling_setpoint_f: 74 }, { point: 'cooling_setpoint', to_f: 76 }).verified, false));
}

done();
