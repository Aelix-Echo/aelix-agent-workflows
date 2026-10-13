// Energy and Utilities product agents: guardrails, verification and approval recording.
import { assert, loadProduct, run, test, section, done, days } from '../harness.mjs';

const reasonsOf = (out) => out.guardrail_reasons.join('; ');

// ---------------- Aelix Core · Threat Triage Agent ----------------
{
  const wf = loadProduct('energy', 'core-threat-triage');
  section('Aelix Core · Threat Triage Agent');
  const Config = {
    no_containment_classes: ['safety_instrumented_system', 'protection_relay', 'safety_controller', 'rtu', 'plc'],
    isolate_ot_hosts: false,
    allowed_enforcement_points: ['edr', 'it_perimeter_firewall', 'dns_sinkhole', 'secure_web_gateway'],
    protected_indicators: ['198.51.100.10'],
    min_score_for_containment: 60, min_confidence: 0.85, approver_slack_user: 'soc-ot-security-lead', approval_timeout_hours: 1,
  };
  const req = {
    business_key: 'SEC-1', alert_id: 'SEC-1', source: 'sentinel', domain: 'it', rule_name: 'Beaconing', asset_id: 'AST-1', hostname: 'ops-ws-117',
    indicators: [{ type: 'domain', value: 'cdn-update-check.example' }, { type: 'ip', value: '203.0.113.48' }, { type: 'ip', value: '10.4.2.9' }],
  };
  const agent = (o = {}) => ({ output: {
    verdict: 'true_positive', score: 82, recommendation: 'isolate_host', target_asset_id: 'AST-1', indicator: null, enforcement_point: null,
    safety_critical_involved: false, attack_techniques: ['T1071.001'], closing_notes: '', confidence: 0.9, rationale: 'Regular beaconing.', questions_for_human: [], ...o } });
  const asset = (o = {}) => ({ asset_id: 'AST-1', hostname: 'ops-ws-117', asset_class: 'workstation', domain: 'it', status: 'active', safety_critical: false, ...o });
  const g = (json = asset(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize alert': req, 'Threat triage agent': a } });
  const block = (o = {}) => agent({ recommendation: 'block_indicator', indicator: { type: 'domain', value: 'cdn-update-check.example' }, enforcement_point: 'dns_sinkhole', ...o });

  test('host isolation on an IT host goes to the approver', () => {
    const out = g();
    assert.equal(out.route, 'approve', reasonsOf(out));
    assert.equal(out.action.type, 'isolate_host');
    assert.equal(out.action.asset_id, 'AST-1');
    assert.equal(out.action.enforcement_point, 'edr');
    assert.match(out.approval_summary, /isolate_host/);
  });
  test('indicator block at an allowed point goes to the approver', () => {
    const out = g(asset(), block());
    assert.equal(out.route, 'approve', reasonsOf(out));
    assert.deepEqual(out.action.indicator, { type: 'domain', value: 'cdn-update-check.example' });
  });
  test('benign closure with notes is recorded as no action', () => {
    const out = g(asset(), agent({ verdict: 'benign', score: 10, recommendation: 'close_benign', closing_notes: 'Known update service.' }));
    assert.equal(out.route, 'none', reasonsOf(out));
    assert.deepEqual(out.planned_actions, []);
  });
  test('benign closure without notes escalates', () => assert.equal(g(asset(), agent({ verdict: 'benign', recommendation: 'close_benign', closing_notes: ' ' })).route, 'escalate'));
  test('containment on a benign verdict escalates', () => assert.equal(g(asset(), agent({ verdict: 'benign' })).route, 'escalate'));
  test('closure on a true-positive verdict escalates', () => assert.equal(g(asset(), agent({ recommendation: 'close_benign', closing_notes: 'x' })).route, 'escalate'));
  test('asset flagged safety-critical escalates with a safety reason', () => {
    const out = g(asset({ safety_critical: true }), block());
    assert.equal(out.route, 'escalate');
    assert.match(reasonsOf(out), /SAFETY/);
  });
  test('protection relay class escalates even without the flag', () => assert.equal(g(asset({ asset_class: 'protection_relay', domain: 'ot' }), block()).route, 'escalate'));
  test('agent reporting a safety-critical asset escalates', () => assert.equal(g(asset(), agent({ safety_critical_involved: true })).route, 'escalate'));
  test('target missing from the inventory escalates', () => assert.equal(g({}).route, 'escalate'));
  test('inventory returning a different asset escalates', () => assert.equal(g(asset({ asset_id: 'AST-2' })).route, 'escalate'));
  test('retired asset escalates', () => assert.equal(g(asset({ status: 'retired' })).route, 'escalate'));
  test('isolating an OT host escalates while turned off', () => assert.equal(g(asset({ domain: 'ot', asset_class: 'hmi' })).route, 'escalate'));
  test('indicator not in the alert escalates', () => assert.equal(g(asset(), block({ indicator: { type: 'domain', value: 'other.example' } })).route, 'escalate'));
  test('private address block escalates', () => assert.equal(g(asset(), block({ indicator: { type: 'ip', value: '10.4.2.9' }, enforcement_point: 'it_perimeter_firewall' })).route, 'escalate'));
  test('protected indicator escalates', () => {
    const r = { ...req, indicators: [...req.indicators, { type: 'ip', value: '198.51.100.10' }] };
    const out = run(wf, 'Guardrails', { json: asset(), nodes: { Config, 'Normalize alert': r, 'Threat triage agent': block({ indicator: { type: 'ip', value: '198.51.100.10' }, enforcement_point: 'it_perimeter_firewall' }) } });
    assert.equal(out.route, 'escalate');
  });
  test('enforcement point not allowed escalates', () => assert.equal(g(asset(), block({ enforcement_point: 'ot_firewall' })).route, 'escalate'));
  test('score below the containment floor escalates', () => assert.equal(g(asset(), agent({ score: 40 })).route, 'escalate'));
  test('score out of range escalates', () => assert.equal(g(asset(), agent({ score: 140 })).route, 'escalate'));
  test('low confidence escalates', () => assert.equal(g(asset(), agent({ confidence: 0.5 })).route, 'escalate'));

  test('approval click is recorded with the named approver', () => {
    const r = run(wf, 'Record approval', { json: { data: { approved: true, respondedAt: '2026-10-13T07:00:00Z' } }, nodes: { Config } });
    assert.deepEqual([r.decision, r.approver], ['approved', 'soc-ot-security-lead']);
  });

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts an executed isolation of the planned host', () => assert.equal(v({ status: 'executed', type: 'isolate_host', asset_id: 'AST-1' }, { type: 'isolate_host', asset_id: 'AST-1' }).verified, true));
  test('verify rejects an isolation still pending', () => assert.equal(v({ status: 'pending', type: 'isolate_host', asset_id: 'AST-1' }, { type: 'isolate_host', asset_id: 'AST-1' }).verified, false));
  test('verify rejects a block on a different indicator', () => {
    const planned = { type: 'block_indicator', indicator: { type: 'domain', value: 'a.example' }, enforcement_point: 'dns_sinkhole' };
    assert.equal(v({ status: 'executed', type: 'block_indicator', indicator: { value: 'b.example' }, enforcement_point: 'dns_sinkhole' }, planned).verified, false);
  });
}

// ---------------- Aelix GridIQ · Outage Response Agent ----------------
{
  const wf = loadProduct('energy', 'gridiq-outage-response');
  section('Aelix GridIQ · Outage Response Agent');
  const Config = { active_outage_statuses: ['active', 'assessing', 'crew_assigned'], customers_affected_tolerance: 5, max_switching_steps: 20, min_confidence: 0.85, approver_slack_user: 'control-room-operator', approval_timeout_hours: 1 };
  const req = { business_key: 'OUT-1', outage_id: 'OUT-1', feeder_id: 'FDR-12', operated_device_id: 'BRK-12', field_notes: 'Recloser locked out. No visible damage at the recloser.' };
  // S0 substation bus -- BRK-12 -- S1 -- SW-A -- S2 (faulted) -- SW-B -- S3 -- TIE-1 (normally open) -- S4 adjacent feeder
  const snap = (o = {}) => ({
    outage_id: 'OUT-1', status: 'active',
    sections: [
      { section_id: 'S0', is_source: true }, { section_id: 'S1' }, { section_id: 'S2' }, { section_id: 'S3' }, { section_id: 'S4', is_source: true },
    ],
    devices: [
      { device_id: 'BRK-12', sections: ['S0', 'S1'], state: 'open', tags: [] },
      { device_id: 'SW-A', sections: ['S1', 'S2'], state: 'closed', tags: [] },
      { device_id: 'SW-B', sections: ['S2', 'S3'], state: 'closed', tags: [] },
      { device_id: 'TIE-1', sections: ['S3', 'S4'], state: 'open', tags: [] },
    ],
    meter_events: [
      { meter_id: 'M1', premise_id: 'P1', event: 'last_gasp', at: '2026-10-13T05:47:11Z' },
      { meter_id: 'M2', premise_id: 'P2', event: 'last_gasp', at: '2026-10-13T05:47:12Z' },
      { meter_id: 'M3', premise_id: 'P3', event: 'last_gasp', at: '2026-10-13T05:47:12Z' },
      { meter_id: 'M4', premise_id: 'P4', event: 'last_gasp', at: '2026-10-13T05:47:13Z' },
      { meter_id: 'M4', premise_id: 'P4', event: 'power_restore', at: '2026-10-13T05:49:00Z' },
    ],
    ...o,
  });
  const steps = [
    { step: 1, device_id: 'SW-A', from_state: 'closed', to_state: 'open', purpose: 'isolate' },
    { step: 2, device_id: 'SW-B', from_state: 'closed', to_state: 'open', purpose: 'isolate' },
    { step: 3, device_id: 'BRK-12', from_state: 'open', to_state: 'closed', purpose: 'restore' },
    { step: 4, device_id: 'TIE-1', from_state: 'open', to_state: 'closed', purpose: 'backfeed' },
  ];
  const agent = (o = {}) => ({ output: {
    plan_type: 'restoration_plan', faulted_section_id: 'S2', localization_evidence: 'S2 meters dark, S1 meters dark behind BRK-12.',
    switching_steps: steps, sections_to_restore: ['S1', 'S3'], load_flow_study_id: 'LF-881', customers_affected: 3, crew_id: 'CREW-7',
    crew_task: 'Patrol S2 and repair.', confidence: 0.9, rationale: 'Last gasps bound the fault to S2.', questions_for_human: [], ...o } });
  const g = (json = snap(), a = agent(), r = req) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize outage event': r, 'Outage response agent': a } });
  const withSection = (id, extra) => snap({ sections: snap().sections.map((s) => (s.section_id === id ? { ...s, ...extra } : s)) });
  const withDevice = (id, extra) => snap({ devices: snap().devices.map((d) => (d.device_id === id ? { ...d, ...extra } : d)) });

  test('safe isolation and restoration plan goes to the operator', () => {
    const out = g();
    assert.equal(out.route, 'approve', reasonsOf(out));
    assert.equal(out.action.switching_steps.length, 4);
    assert.match(out.approval_summary, /pending operator execution/);
  });
  test('customers affected is recomputed from meter data', () => {
    const out = g(snap(), agent({ customers_affected: 4 }));
    assert.equal(out.action.customers_affected, 3);
  });
  test('customer count far from meter data escalates', () => assert.equal(g(snap(), agent({ customers_affected: 40 })).route, 'escalate'));
  test('device not in the stated state escalates', () => assert.equal(g(withDevice('SW-A', { state: 'open' })).route, 'escalate'));
  test('device missing from the network model escalates', () => {
    const out = g(snap(), agent({ switching_steps: [...steps, { step: 5, device_id: 'SW-X', from_state: 'open', to_state: 'closed', purpose: 'restore' }] }));
    assert.equal(out.route, 'escalate');
    assert.match(reasonsOf(out), /SW-X is not in the network model/);
  });
  test('tagged device escalates', () => assert.equal(g(withDevice('TIE-1', { tags: ['HOLD-221'] })).route, 'escalate'));
  test('re-energizing a section with an open hazard escalates', () => {
    const out = g(withSection('S3', { open_hazards: ['wire down'] }));
    assert.equal(out.route, 'escalate');
    assert.match(reasonsOf(out), /SAFETY: step 4 .* section S3/);
  });
  test('re-energizing a tagged section escalates', () => assert.equal(g(withSection('S1', { tags: ['CLEARANCE-77'] })).route, 'escalate'));
  test('closing in before isolating the fault escalates', () => {
    const out = g(snap(), agent({ switching_steps: [{ step: 1, device_id: 'BRK-12', from_state: 'open', to_state: 'closed', purpose: 'restore' }], sections_to_restore: ['S1'] }));
    assert.equal(out.route, 'escalate');
    assert.match(reasonsOf(out), /section S2 with faulted section/);
  });
  test('backfeed without a load-flow study escalates', () => assert.equal(g(snap(), agent({ load_flow_study_id: null })).route, 'escalate'));
  test('hazard words in field notes escalate', () => assert.equal(g(snap(), agent(), { ...req, field_notes: 'Crew sees wires down on Elm Rd.' }).route, 'escalate'));
  test('outage no longer active escalates', () => assert.equal(g(snap({ status: 'restored' })).route, 'escalate'));
  test('plan with no crew escalates', () => assert.equal(g(snap(), agent({ crew_id: null })).route, 'escalate'));
  test('already restored with all meters back is recorded as no action', () => {
    const allBack = snap({ meter_events: [{ premise_id: 'P1', event: 'last_gasp', at: '2026-10-13T05:47:11Z' }, { premise_id: 'P1', event: 'power_restore', at: '2026-10-13T06:10:00Z' }] });
    assert.equal(g(allBack, agent({ plan_type: 'already_restored', switching_steps: [], customers_affected: 0, crew_id: null })).route, 'none');
  });
  test('already restored while meters are still dark escalates', () => assert.equal(g(snap(), agent({ plan_type: 'already_restored', switching_steps: [], customers_affected: 0 })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  const planned = { switching_steps: steps, crew_id: 'CREW-7' };
  const filed = steps.map((s) => ({ device_id: s.device_id, to_state: s.to_state }));
  test('verify accepts a pending switching order and a dispatched crew', () => assert.equal(v({ switching_order: { status: 'pending_operator_execution', steps: filed }, dispatch: { crew_id: 'CREW-7', status: 'dispatched' } }, planned).verified, true));
  test('verify rejects a switching order that is not pending operator execution', () => assert.equal(v({ switching_order: { status: 'executed', steps: filed }, dispatch: { crew_id: 'CREW-7', status: 'dispatched' } }, planned).verified, false));
  test('verify rejects a different crew', () => assert.equal(v({ switching_order: { status: 'pending_operator_execution', steps: filed }, dispatch: { crew_id: 'CREW-9', status: 'dispatched' } }, planned).verified, false));
}

// ---------------- Aelix AssetGuard · Permit Prep Agent ----------------
{
  const wf = loadProduct('energy', 'assetguard-permit-prep');
  section('Aelix AssetGuard · Permit Prep Agent');
  const Config = { confined_space_required_gases: ['O2', 'LEL', 'H2S', 'CO'], min_fire_watch_minutes_after: 60, min_lead_hours: 12, min_confidence: 0.8, reviewer_slack_user: 'permit-issuer' };
  const req = { business_key: 'WO-1', work_order_id: 'WO-1', permit_types: ['confined_space', 'hot_work'], asset_id: 'AST-V3', location_id: 'LOC-V3', planned_start: days(3) + 'T07:00:00Z' };
  const loto = (o = {}) => ({ asset_id: 'AST-V3', asset_status: 'active', isolation_points: [
    { point_id: 'IP-101', energy_type: 'electrical', status: 'active' },
    { point_id: 'IP-102', energy_type: 'process', status: 'active' },
  ], ...o });
  const persons = [
    { role: 'entry_supervisor', person_id: 'EMP-1' }, { role: 'attendant', person_id: 'EMP-2' }, { role: 'gas_tester', person_id: 'EMP-3' },
    { role: 'fire_watch', person_id: 'EMP-4' }, { role: 'authorized_isolator', person_id: 'EMP-5' },
  ];
  const agent = (o = {}) => ({ output: {
    permit_types: ['confined_space', 'hot_work'],
    hazards: [{ hazard: 'Oxygen-deficient atmosphere', control: 'Forced ventilation and continuous monitoring' }, { hazard: 'Ignition of flammables', control: 'LEL test before hot work, fire watch' }],
    isolation_points: [
      { point_id: 'IP-101', energy_type: 'electrical', method: 'Rack out and lock', verification: 'Test for dead' },
      { point_id: 'IP-102', energy_type: 'process', method: 'Close and lock sump pump valve', verification: 'Try start' },
    ],
    gas_tests: ['O2', 'LEL', 'H2S', 'CO'].map((gas) => ({ gas, acceptable_range: 'site standard', frequency: 'before entry and every 30 minutes' })),
    continuous_monitoring: true, attendant_required: true, rescue_plan: 'Tripod and winch at vault entry, rescue team on standby.',
    fire_watch_required: true, fire_watch_minutes_after: 60, ppe: ['FR coveralls', 'Welding helmet', 'Harness'], competent_persons: persons,
    missing_information: [], confidence: 0.9, rationale: 'Vault 3 is a registered confined space.', questions_for_human: [], ...o } });
  const g = (json = loto(), a = agent(), r = req) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize permit request': r, 'Permit prep agent': a } });

  test('complete package goes to the permit issuer, not issued', () => {
    const out = g();
    assert.equal(out.route, 'draft', reasonsOf(out));
    assert.equal(out.draft.status, 'draft_not_issued');
    assert.equal(out.draft.isolation_points.length, 2);
    assert.match(out.draft_summary, /No permit has been issued/);
  });
  test('isolation point not in the LOTO register escalates', () => {
    const a = agent();
    a.output.isolation_points.push({ point_id: 'IP-999', energy_type: 'electrical', method: 'x', verification: 'y' });
    assert.match(reasonsOf(g(loto(), a)), /IP-999 is not in the LOTO register/);
  });
  test('register isolation point left out of the package escalates', () => {
    const out = g(loto({ isolation_points: [...loto().isolation_points, { point_id: 'IP-103', energy_type: 'stored', status: 'active' }] }));
    assert.equal(out.route, 'escalate');
    assert.match(reasonsOf(out), /IP-103/);
  });
  test('retired register points are not required', () => assert.equal(g(loto({ isolation_points: [...loto().isolation_points, { point_id: 'IP-100', energy_type: 'electrical', status: 'retired' }] })).route, 'draft'));
  test('asset missing from the LOTO register escalates', () => assert.equal(g({}).route, 'escalate'));
  test('confined space without an H2S test escalates', () => assert.equal(g(loto(), agent({ gas_tests: ['O2', 'LEL', 'CO'].map((gas) => ({ gas, acceptable_range: 'x', frequency: 'y' })) })).route, 'escalate'));
  test('confined space without an attendant requirement escalates', () => assert.equal(g(loto(), agent({ attendant_required: false })).route, 'escalate'));
  test('confined space without a named attendant escalates', () => assert.equal(g(loto(), agent({ competent_persons: persons.filter((p) => p.role !== 'attendant') })).route, 'escalate'));
  test('confined space without a rescue plan escalates', () => assert.equal(g(loto(), agent({ rescue_plan: '' })).route, 'escalate'));
  test('hot work fire watch shorter than the site standard escalates', () => assert.equal(g(loto(), agent({ fire_watch_minutes_after: 30 })).route, 'escalate'));
  test('hot work only does not need gas tests or an attendant', () => {
    const r = { ...req, permit_types: ['hot_work'] };
    const out = g(loto(), agent({ permit_types: ['hot_work'], gas_tests: [], attendant_required: false, rescue_plan: '' }), r);
    assert.equal(out.route, 'draft', reasonsOf(out));
  });
  test('start inside the lead time escalates', () => assert.equal(g(loto(), agent(), { ...req, planned_start: new Date(Date.now() + 3600000).toISOString() }).route, 'escalate'));
  test('open items travel with the draft', () => {
    const out = g(loto(), agent({ missing_information: ['No second attendant on night shift'] }));
    assert.equal(out.route, 'draft');
    assert.match(out.draft_summary, /1 items still open/);
  });
}

// ---------------- Aelix CX · Revenue Protection Agent ----------------
{
  const wf = loadProduct('energy', 'cx-revenue-protection');
  section('Aelix CX · Revenue Protection Agent');
  const Config = { baseline_days: 90, min_loss_amount: 250, loss_estimate_tolerance: 0.1, min_confidence: 0.8, approver_slack_user: 'revenue-protection-operator', approval_timeout_hours: 24 };
  const req = { business_key: 'RPC-1', candidate_id: 'RPC-1', premise_id: 'PRM-1', meter_id: 'MTR-1', rule: 'tamper_event_with_consumption_drop' };
  const day = (base, i) => new Date(Date.parse(base) + i * 86400000).toISOString().slice(0, 10);
  // 90 days at 30 kWh before 2026-08-01, 60 days at 10 kWh from it: 20 kWh/day x 60 days = 1200 kWh.
  const reads = (o = {}) => [
    ...Array.from({ length: 90 }, (_, i) => ({ date: day('2026-05-03', i), kwh: 30 })),
    ...Array.from({ length: 60 }, (_, i) => ({ date: day('2026-08-01', i), kwh: 10, ...o })),
  ];
  const data = (o = {}) => ({ premise_id: 'PRM-1', meter_id: 'MTR-1', tariff_rate_per_kwh: 0.25, flags: { medical_baseline: false, life_support: false }, open_investigation_id: null,
    meter_events: [{ event_id: 'EV-1', type: 'cover_open', at: '2026-08-01T02:10:00Z' }, { event_id: 'EV-2', type: 'magnetic', at: '2026-08-01T02:11:00Z' }], daily_reads: reads(), ...o });
  const agent = (o = {}) => ({ output: {
    recommendation: 'open_investigation', anomaly_type: 'meter_tamper_events', evidence_event_ids: ['EV-1', 'EV-2'], anomaly_start: '2026-08-01',
    baseline_kwh_per_day: 30, observed_kwh_per_day: 10, estimated_loss_kwh: 1200, estimated_loss_amount: 300, medical_flag: false,
    ordinary_explanations_checked: ['vacancy', 'solar'], case_summary: 'Cover-open and magnetic events on 2026-08-01, then daily use fell from about 30 kWh to about 10 kWh.',
    confidence: 0.88, rationale: 'EV-1 and EV-2 precede the drop.', questions_for_human: [], ...o } });
  const g = (json = data(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize candidate': req, 'Revenue protection agent': a } });

  test('supported case goes to the operator with the recomputed loss', () => {
    const out = g();
    assert.equal(out.route, 'approve', reasonsOf(out));
    assert.equal(out.action.estimated_loss_kwh, 1200);
    assert.equal(out.action.estimated_loss_amount, 300);
    assert.equal(out.action.customer_contact, false);
  });
  test('medical-baseline premise is highlighted at the top of the approval and the dispatch', () => {
    const out = g(data({ flags: { medical_baseline: true } }));
    assert.equal(out.route, 'approve', reasonsOf(out));
    assert.equal(out.action.medical_flag, true);
    assert.match(out.approval_summary, /^:warning: \*MEDICAL BASELINE/);
  });
  test('life-support flag comes from the fresh read even when the agent missed it', () => assert.equal(g(data({ flags: { life_support: true } }), agent({ medical_flag: false })).action.medical_flag, true));
  test('cited meter event the system does not return escalates', () => assert.match(reasonsOf(g(data(), agent({ evidence_event_ids: ['EV-1', 'EV-77'] }))), /EV-77/));
  test('case with no cited events escalates', () => assert.equal(g(data(), agent({ evidence_event_ids: [] })).route, 'escalate'));
  test('agent loss estimate far from the meter data escalates', () => assert.equal(g(data(), agent({ estimated_loss_kwh: 2400 })).route, 'escalate'));
  test('recomputed loss below the case threshold escalates', () => assert.equal(g(data({ tariff_rate_per_kwh: 0.1 })).route, 'escalate'));
  test('estimated reads are left out of the loss', () => assert.equal(g(data({ daily_reads: reads({ estimated: true }) })).route, 'escalate'));
  test('accusatory case wording escalates', () => assert.match(reasonsOf(g(data(), agent({ case_summary: 'Clear energy theft by the occupant.' }))), /accusatory/));
  test('open investigation at the premise escalates', () => assert.equal(g(data({ open_investigation_id: 'INV-55' })).route, 'escalate'));
  test('meter exchanged since the sweep escalates', () => assert.equal(g(data({ meter_id: 'MTR-2' })).route, 'escalate'));
  test('no case is recorded as no action', () => assert.equal(g(data(), agent({ recommendation: 'no_case', evidence_event_ids: [] })).route, 'none'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  const planned = { premise_id: 'PRM-1', medical_flag: true };
  test('verify accepts a dispatched investigation carrying the medical flag', () => assert.equal(v({ status: 'dispatched', investigation: { premise_id: 'PRM-1', type: 'field_investigation', medical_flag: true, customer_contact: false } }, planned).verified, true));
  test('verify rejects a dispatch that dropped the medical flag', () => assert.equal(v({ status: 'dispatched', investigation: { premise_id: 'PRM-1', type: 'field_investigation', medical_flag: false } }, planned).verified, false));
  test('verify rejects a dispatch with customer contact', () => assert.equal(v({ status: 'dispatched', investigation: { premise_id: 'PRM-1', type: 'field_investigation', medical_flag: true, customer_contact: true } }, planned).verified, false));
}

// ---------------- Aelix GreenTrack · PPA Shortfall Agent ----------------
{
  const wf = loadProduct('energy', 'greentrack-ppa-shortfall');
  section('Aelix GreenTrack · PPA Shortfall Agent');
  const Config = { send_no_shortfall_drafts: false, shortfall_tolerance_mwh: 5, max_replacement_headroom: 0.2, urgent_days_to_close: 10, min_confidence: 0.8, reviewer_slack_user: 'energy-trader' };
  const req = { business_key: 'PPA-1:Q4', contract_id: 'PPA-1', project_id: 'PRJ-1', period_id: 'Q4', period_start: days(-60), period_end: days(20) };
  // 60 days at 10 MWh = 600 delivered, 300 forecast, 1000 obligation: 100 MWh short.
  const pos = (o = {}) => ({
    contract_id: 'PPA-1', period_start: days(-60), period_end: days(20), min_delivery_mwh: 1000, shortfall_price_per_mwh: 50,
    metered: [...Array.from({ length: 60 }, (_, i) => ({ date: days(-60 + i), mwh: 10 })), { date: days(-90), mwh: 500 }],
    forecast_remaining_mwh_p50: 300,
    forward_prices: [{ product: 'forward_block', delivery_from: days(1), delivery_to: days(20), price_per_mwh: 62.5 }],
    ...o,
  });
  const agent = (o = {}, rep = {}) => ({ output: {
    delivered_to_date_mwh: 600, forecast_remaining_mwh: 300, min_obligation_mwh: 1000, projected_shortfall_mwh: 100, shortfall_drivers: ['Low wind in October'],
    replacement: { product: 'forward_block', volume_mwh: 110, delivery_from: days(2), delivery_to: days(19), indicative_price_per_mwh: 62.5, ...rep },
    confidence: 0.85, rationale: 'Forward block is below the remedy price.', questions_for_human: [], ...o } });
  const g = (json = pos(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize contract period': req, 'PPA shortfall agent': a } });

  test('projected shortfall goes to the trader with a recomputed position', () => {
    const out = g();
    assert.equal(out.route, 'draft', reasonsOf(out));
    assert.deepEqual(out.draft.position, { min_obligation_mwh: 1000, delivered_to_date_mwh: 600, forecast_remaining_mwh_p50: 300, projected_shortfall_mwh: 100, shortfall_remedy_exposure: 5000 });
    assert.equal(out.draft.status, 'draft_no_trade');
    assert.match(out.draft_summary, /100 MWh.*Nothing has been bought or nominated/s);
  });
  test('generation outside the period is not counted', () => assert.equal(g().draft.position.delivered_to_date_mwh, 600));
  test('delivered volume that does not match metered data escalates', () => assert.equal(g(pos(), agent({ delivered_to_date_mwh: 700 })).route, 'escalate'));
  test('shortfall that does not match the recompute escalates', () => assert.equal(g(pos(), agent({ projected_shortfall_mwh: 40 })).route, 'escalate'));
  test('replacement that does not cover the shortfall escalates', () => assert.equal(g(pos(), agent({}, { volume_mwh: 80 })).route, 'escalate'));
  test('replacement well beyond the shortfall escalates', () => assert.equal(g(pos(), agent({}, { volume_mwh: 200 })).route, 'escalate'));
  test('replacement delivered after the period ends escalates', () => assert.equal(g(pos(), agent({}, { delivery_to: days(25) })).route, 'escalate'));
  test('price the ETRM did not return escalates', () => assert.equal(g(pos(), agent({}, { indicative_price_per_mwh: 48 })).route, 'escalate'));
  test('portfolio transfer needs no market price', () => assert.equal(g(pos(), agent({}, { product: 'portfolio_transfer', indicative_price_per_mwh: null })).route, 'draft'));
  test('shortfall with no replacement escalates', () => assert.equal(g(pos(), agent({}, { product: 'none', volume_mwh: 0 })).route, 'escalate'));
  test('no shortfall gives a short no-shortfall draft', () => {
    const out = g(pos({ min_delivery_mwh: 850 }), agent({ projected_shortfall_mwh: 0, min_obligation_mwh: 850 }, { product: 'none', volume_mwh: 0, delivery_from: null, delivery_to: null, indicative_price_per_mwh: null }));
    assert.equal(out.route, 'draft', reasonsOf(out));
    assert.equal(out.draft.replacement, null);
    assert.match(out.draft_summary, /no shortfall projected/);
  });
  test('replacement recommended with no shortfall escalates', () => assert.equal(g(pos({ min_delivery_mwh: 850 }), agent({ projected_shortfall_mwh: 0 })).route, 'escalate'));
  test('closed period escalates', () => assert.equal(g(pos({ period_end: days(-1) })).route, 'escalate'));
  test('period close inside the urgency window is flagged', () => {
    const p = pos({ period_end: days(5), forward_prices: [{ product: 'forward_block', delivery_from: days(1), delivery_to: days(5), price_per_mwh: 62.5 }] });
    const out = g(p, agent({}, { delivery_to: days(5) }));
    assert.equal(out.route, 'draft', reasonsOf(out));
    assert.match(out.draft_summary, /^:warning: \*5 days to period close/);
  });
}

// ---------------- Aelix GreenTrack · ESG Reporting Agent ----------------
{
  const wf = loadProduct('energy', 'greentrack-esg-reporting');
  section('Aelix GreenTrack · ESG Reporting Agent');
  const Config = { approved_factor_set_version: 'EF-2026.1', rounding_tolerance_tco2e: 0.5, min_confidence: 0.8, reviewer_slack_user: 'sustainability-reporting-lead' };
  const req = { business_key: 'ESG-1', request_id: 'ESG-1', reporting_entity_id: 'ENT-1', period: 'FY2026', frameworks: ['SEC', 'CSRD'] };
  const row = (record_id, scope, category, tco2e, o = {}) => ({ record_id, scope, category, tco2e, period: 'FY2026', factor_version: 'EF-2026.1', source_system: 'historian', ...o });
  const rows = () => [
    row('R1', 'scope_1', 'stationary_combustion', 100.5), row('R2', 'scope_1', 'sf6', 20),
    row('R3', 'scope_2_location', 'aux_load', 50), row('R4', 'scope_2_market', 'aux_load', 40), row('R5', 'scope_3', 'cat1_purchased_goods', 200),
  ];
  const figures = () => [
    { scope: 'scope_1', category: 'stationary_combustion', tco2e: 100.5, source_record_ids: ['R1'] },
    { scope: 'scope_1', category: 'sf6', tco2e: 20, source_record_ids: ['R2'] },
    { scope: 'scope_2_location', category: 'aux_load', tco2e: 50, source_record_ids: ['R3'] },
    { scope: 'scope_2_market', category: 'aux_load', tco2e: 40, source_record_ids: ['R4'] },
    { scope: 'scope_3', category: 'cat1_purchased_goods', tco2e: 200, source_record_ids: ['R5'] },
  ];
  const agent = (o = {}) => ({ output: {
    period: 'FY2026', factor_set_version: 'EF-2026.1', figures: figures(),
    totals: { scope_1: 120.5, scope_2_location: 50, scope_2_market: 40, scope_3: 200 },
    sections: [{ heading: 'Emissions by scope', text: 'Prepared with the SEC and CSRD structures in view.' }],
    methodology_notes: 'Operational control.', missing_information: [], confidence: 0.85, rationale: 'All rows traced.', questions_for_human: [], ...o } });
  const g = (json = { rows: rows() }, a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize reporting request': req, 'ESG reporting agent': a } });

  test('fully traced package goes to the reporting lead, not filed or signed', () => {
    const out = g();
    assert.equal(out.route, 'draft', reasonsOf(out));
    assert.equal(out.draft.status, 'draft_not_filed_not_signed');
    assert.deepEqual(out.draft.totals_tco2e, { scope_1: 120.5, scope_2_location: 50, scope_2_market: 40, scope_3: 200 });
    assert.match(out.draft.legal_note, /counsel/);
    assert.equal(out.draft.figures[0].source_records[0].source_system, 'historian');
  });
  test('figure without lineage escalates', () => {
    const f = figures(); f[1].source_record_ids = [];
    assert.match(reasonsOf(g({ rows: rows() }, agent({ figures: f }))), /no lineage/);
  });
  test('figure citing a record not in the source escalates', () => {
    const f = figures(); f[0].source_record_ids = ['R1', 'R99'];
    assert.equal(g({ rows: rows() }, agent({ figures: f })).route, 'escalate');
  });
  test('figure citing a row from another scope escalates', () => {
    const f = figures(); f[2].source_record_ids = ['R4'];
    assert.equal(g({ rows: rows() }, agent({ figures: f })).route, 'escalate');
  });
  test('figure that does not equal its source rows escalates', () => {
    const f = figures(); f[4].tco2e = 210;
    assert.equal(g({ rows: rows() }, agent({ figures: f })).route, 'escalate');
  });
  test('scope total that differs from the source rows escalates', () => assert.match(reasonsOf(g({ rows: rows() }, agent({ totals: { scope_1: 120.5, scope_2_location: 50, scope_2_market: 40, scope_3: 150 } }))), /scope_3 total/));
  test('row counted twice escalates', () => {
    const f = figures(); f[0].source_record_ids = ['R1', 'R2'];
    assert.match(reasonsOf(g({ rows: rows() }, agent({ figures: f }))), /more than one figure/);
  });
  test('source row left out of every figure escalates', () => assert.match(reasonsOf(g({ rows: [...rows(), row('R6', 'scope_3', 'cat3_fuel', 12)] })), /in no reported figure/));
  test('source row from another period escalates', () => assert.equal(g({ rows: [...rows().slice(0, 4), row('R5', 'scope_3', 'cat1_purchased_goods', 200, { period: 'FY2025' })] }).route, 'escalate'));
  test('source row on an old factor set escalates', () => assert.equal(g({ rows: [row('R1', 'scope_1', 'stationary_combustion', 100.5, { factor_version: 'EF-2025.2' }), ...rows().slice(1)] }).route, 'escalate'));
  test('draft on the wrong factor set version escalates', () => assert.equal(g({ rows: rows() }, agent({ factor_set_version: 'EF-2025.2' })).route, 'escalate'));
  test('draft for the wrong period escalates', () => assert.equal(g({ rows: rows() }, agent({ period: 'FY2025' })).route, 'escalate'));
  test('no source rows escalates', () => assert.equal(g({ rows: [] }, agent({ figures: [] })).route, 'escalate'));
}

done();
