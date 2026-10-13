// Healthcare: deterministic Code nodes from workflows/02-healthcare-prior-auth-triage.json, run against fixed scenarios.

import assert from 'node:assert/strict';
import { load, run, test } from '../helpers.mjs';

const wf = load('02-healthcare-prior-auth-triage.json');
console.log('Healthcare · Prior-auth triage');
const FHIR = 'https://fhir.example/R4';
const Config = { min_confidence: 0.8, fhir_base_url: FHIR };
const req = {
  business_key: 'PA-1', request_id: 'PA-1', patient_id: 'pat-1', coverage_id: 'cov-1', requested_urgency: 'standard', urgency_unrecognised: null,
  requested_date: '2026-11-01', documents: [{ type: 'order', url: 'https://docs.example.com/pa/PA-1/order.pdf' }],
};
const patient = { resourceType: 'Patient', id: 'pat-1' };
const coverage = (o = {}) => ({
  resourceType: 'Coverage', id: 'cov-1', status: 'active', period: { start: '2026-01-01', end: '2026-12-31' },
  beneficiary: { reference: 'Patient/pat-1' },
  payor: [{ reference: 'Organization/org-exhp', identifier: { value: 'EXHP01' }, display: 'Example Health Plan (synthetic)' }], ...o,
});
const agent = (o = {}) => ({ output: {
  patient_found: true, coverage_active: true, payer_name: 'Example Health Plan (synthetic)', pa_required: 'yes', urgency_assessment: 'standard', route_queue: 'needs_documents',
  packet: [{ item: 'MRI order', status: 'present', source: 'ServiceRequest/1' }, { item: 'PT notes', status: 'missing', source: '' }], confidence: 0.9, ...o },
  // What the agent's tools returned: a cited id must appear here.
  intermediateSteps: [{ action: { tool: 'Find documents (FHIR)' }, observation: JSON.stringify({ entry: ['ServiceRequest/1', 'DocumentReference/doc-h1-pt', 'Binary/doc-h1-pt', 'Observation/obs-1', 'DocumentReference/d1'].map((r) => ({ resource: { id: r.split('/')[1] } })) }) }],
});
const g = (a, { r = req, p = patient, c = coverage() } = {}) =>
  run(wf, 'Guardrails', { json: c, nodes: { Config, 'Normalize request': r, 'Prior-auth agent': a, 'Re-read patient (FHIR)': p } });
const escalates = (res, re) => {
  assert.equal(res.route, 'escalate');
  if (re) assert.ok(res.guardrail_reasons.some((x) => re.test(x)), 'reasons: ' + res.guardrail_reasons.join('; '));
};

test('complete triage routes auto', () => assert.equal(g(agent()).route, 'auto'));
test('urgency disagreement escalates', () => assert.equal(g(agent({ urgency_assessment: 'expedited' })).route, 'escalate'));
test('ready with gaps escalates', () => assert.equal(g(agent({ route_queue: 'ready_for_submission_review' })).route, 'escalate'));
test('present without source escalates', () => assert.equal(g(agent({ packet: [{ item: 'x', status: 'present', source: '' }] })).route, 'escalate'));
test('unknown PA need escalates', () => assert.equal(g(agent({ pa_required: 'unknown' })).route, 'escalate'));

// ---------- intake: urgency normalisation (finding 1) ----------
const intake = (body) => run(wf, 'Normalize request', { json: { body: { request_id: 'PA-9', patient_id: 'pat-9', coverage_id: 'cov-9', service: { cpt_codes: ['73721'] }, ...body } }, nodes: {} });
test('urgency: case, spacing and urgent synonyms become expedited', () => {
  for (const u of ['Expedited', ' EXPEDITED ', 'urgent', 'stat', 'STAT', 'emergent', 'ASAP']) {
    const n = intake({ urgency: u });
    assert.equal(n.requested_urgency, 'expedited', u);
    assert.equal(n.urgency_unrecognised, null, u);
  }
});
test('urgency: standard, routine and missing stay standard', () => {
  for (const u of ['standard', 'Routine', undefined, '']) assert.equal(intake({ urgency: u }).requested_urgency, 'standard', String(u));
});
test('urgency: an unrecognised value is never standard, it is expedited and flagged', () => {
  const n = intake({ urgency: 'high-ish' });
  assert.equal(n.requested_urgency, 'expedited');
  assert.equal(n.urgency_unrecognised, 'high-ish');
});
test('urgency: an unrecognised value escalates to a person even when the agent agrees', () => {
  escalates(g(agent({ urgency_assessment: 'expedited' }), { r: { ...req, requested_urgency: 'expedited', urgency_unrecognised: 'high-ish' } }), /unrecognised value "high-ish"/);
});

// ---------- intake: malformed requests reach the hand-off (finding 2) ----------
test('intake: a well-formed request is valid', () => {
  const n = intake({});
  assert.equal(n.valid, true);
  assert.equal(n.handoff_reason, null);
  assert.deepEqual(n.cpt_codes, ['73721']);
});
test('intake: missing ids do not throw, they produce a handoff_reason', () => {
  const n = run(wf, 'Normalize request', { json: { body: { patient_id: 'pat-9', service: { cpt_codes: ['73721'] } } }, nodes: {} });
  assert.equal(n.valid, false);
  assert.match(n.handoff_reason, /missing fields: request_id, coverage_id/);
});
test('intake: no CPT codes and junk documents do not throw', () => {
  const n = intake({ service: {}, documents: [null, 'x', { url: 'https://docs.example.com/a.pdf' }] });
  assert.equal(n.valid, false);
  assert.match(n.handoff_reason, /no CPT codes/);
  assert.equal(n.documents.length, 1);
});
test('intake: invalid requests are routed to the hand-off, valid ones to the agent', () => {
  const outs = wf.connections['Request complete?'].main;
  assert.ok(outs[0].some((c) => c.node === 'Prior-auth agent'));
  assert.ok(outs[1].some((c) => c.node === 'Build exception'));
});
test('hand-off records the intake handoff_reason', () => {
  const bad = run(wf, 'Normalize request', { json: { body: {} }, nodes: {} });
  const ex = run(wf, 'Build exception', { json: bad, nodes: { 'Normalize request': bad } });
  assert.ok(ex.reasons.some((r) => /intake_rejected: .*missing fields/.test(r)), ex.reasons.join('; '));
});

// ---------- fresh FHIR re-reads (finding 3) ----------
test('re-reads: Patient and Coverage are read by the request ids and failures go to the hand-off', () => {
  const rp = wf.nodes.find((n) => n.name === 'Re-read patient (FHIR)');
  const rc = wf.nodes.find((n) => n.name === 'Re-read coverage (FHIR)');
  assert.match(rp.parameters.url, /fhir_base_url \}\}\/Patient\/\{\{ encodeURIComponent\(\$\('Normalize request'\)\.item\.json\.patient_id\) \}\}$/);
  assert.match(rc.parameters.url, /fhir_base_url \}\}\/Coverage\/\{\{ encodeURIComponent\(\$\('Normalize request'\)\.item\.json\.coverage_id\) \}\}$/);
  for (const n of [rp, rc]) {
    assert.equal(n.parameters.method, 'GET');
    assert.equal(n.onError, 'continueErrorOutput');
    assert.ok(wf.connections[n.name].main[1].some((c) => c.node === 'Build exception'), n.name);
  }
  assert.ok(wf.connections['Prior-auth agent'].main[0].some((c) => c.node === 'Re-read patient (FHIR)'));
  assert.ok(wf.connections['Re-read coverage (FHIR)'].main[0].some((c) => c.node === 'Guardrails'));
});
test('re-read: patient missing in the EHR escalates even if the agent says found', () => {
  escalates(g(agent(), { p: { resourceType: 'OperationOutcome' } }), /patient pat-1 not found/);
});
test('re-read: cancelled coverage escalates even if the agent says active', () => {
  escalates(g(agent(), { c: coverage({ status: 'cancelled' }) }), /coverage status is cancelled/);
});
test('re-read: coverage period not covering the requested date escalates', () => {
  escalates(g(agent(), { c: coverage({ period: { start: '2026-01-01', end: '2026-10-01' } }) }), /does not include 2026-11-01/);
});
test('re-read: coverage for a different patient escalates', () => {
  escalates(g(agent(), { c: coverage({ beneficiary: { reference: 'Patient/pat-2' } }) }), /does not belong to patient/);
});
test('re-read: a different coverage id than requested escalates', () => {
  escalates(g(agent(), { c: coverage({ id: 'cov-2' }) }), /coverage cov-1 not found/);
});
test('re-read: payer the coverage does not name escalates', () => {
  escalates(g(agent({ payer_name: 'Other Health Co' })), /payer: agent said Other Health Co/);
  escalates(g(agent({ payer_name: null })), /payer: agent said none/);
});
test('re-read: payer matches by display, display without suffix, payer id or Organization id', () => {
  for (const p of ['Example Health Plan (synthetic)', 'example health plan', 'EXHP01', 'org-exhp']) assert.equal(g(agent({ payer_name: p })).route, 'auto', p);
});
test('agent booleans still count: patient_found false escalates', () => {
  escalates(g(agent({ patient_found: false })), /agent could not confirm the patient/);
});

// ---------- packet sources (finding 4) ----------
test('source: free text or an unknown URL is not a recognisable source', () => {
  for (const source of ['payer-portal', 'in the chart', 'https://evil.example/DocumentReference/1', 'Payer/portal']) {
    escalates(g(agent({ packet: [{ item: 'x', status: 'present', source }, { item: 'y', status: 'missing', source: '' }] })), /without a recognisable/);
  }
});
test('source: FHIR references, FHIR base URLs and request document URLs are accepted', () => {
  for (const source of ['DocumentReference/doc-h1-pt', `${FHIR}/Binary/doc-h1-pt`, 'Observation/obs-1/_history/2', 'https://docs.example.com/pa/PA-1/order.pdf']) {
    assert.equal(g(agent({ packet: [{ item: 'x', status: 'present', source }, { item: 'y', status: 'missing', source: '' }] })).route, 'auto', source);
  }
});

// ---------- queue consistency (finding 5) ----------
test('ready with an empty packet escalates', () => {
  escalates(g(agent({ route_queue: 'ready_for_submission_review', packet: [] })), /packet is empty/);
});
test('ready with a complete sourced packet routes auto', () => {
  assert.equal(g(agent({ route_queue: 'ready_for_submission_review', packet: [{ item: 'x', status: 'present', source: 'DocumentReference/d1' }] })).route, 'auto');
});
test('pa_required no with a PA queue escalates', () => {
  escalates(g(agent({ pa_required: 'no', route_queue: 'ready_for_submission_review', packet: [{ item: 'x', status: 'present', source: 'DocumentReference/d1' }] })), /PA not required but queued/);
});
test('pa_required yes with no_pa_required_confirm escalates', () => {
  escalates(g(agent({ pa_required: 'yes', route_queue: 'no_pa_required_confirm' })), /queued as no PA required but pa_required is yes/);
});
test('pa_required no with no_pa_required_confirm routes auto', () => {
  assert.equal(g(agent({ pa_required: 'no', route_queue: 'no_pa_required_confirm', packet: [] })).route, 'auto');
});

test('source: a reference followed by a note in brackets is accepted', () => {
  const out = g(agent({ route_queue: 'ready_for_submission_review', packet: [{ item: 'PT notes', status: 'present', source: 'DocumentReference/doc-h1-pt (PT discharge summary, http://ehr.example/x)' }] }));
  assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
});
test('source: a well-formed reference to an id no tool returned escalates', () => {
  const out = g(agent({ packet: [{ item: 'X-ray', status: 'present', source: 'DocumentReference/invented-99' }] }));
  assert.equal(out.route, 'escalate');
  assert.match(out.guardrail_reasons.join(' '), /recognisable/);
});
