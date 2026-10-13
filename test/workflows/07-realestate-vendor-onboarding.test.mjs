// Real estate: deterministic Code nodes from workflows/07-realestate-vendor-onboarding.json, run against fixed scenarios.

import assert from 'node:assert/strict';
import { load, run, test, days } from '../helpers.mjs';
import { routes } from '../e2e/scenarios/07-realestate-vendor-onboarding.mjs';

const wf = load('07-realestate-vendor-onboarding.json');
console.log('Real Estate & Construction · Vendor onboarding');
const Config = {
  min_confidence: 0.85, min_gl_each_occurrence: 1000000, coi_min_days_valid: 30,
  portal_writable_statuses: ['submitted', 'resubmitted', 'action_required', 'pending_approval'],
  required_docs_by_trade: { default: ['w9', 'coi'], electrical: ['w9', 'coi', 'license', 'safety_program'] },
};
const req = { business_key: 'VA-1', application_id: 'VA-1', legal_name: 'Acme Electric LLC', trade: 'electrical', state: 'TX', license_number: 'E-1', project_id: null };
const docs = (o = {}) => ['w9', 'coi', 'license', 'safety_program'].map((d) => ({ document: d, status: 'valid', expires_on: d === 'coi' ? days(200) : null, detail: '', ...(o[d] ?? {}) }));
const COI = { gl_each_occurrence: 2000000, gl_aggregate: 4000000, auto_limit: 1000000, umbrella_each_occurrence: 0, employers_liability_each_accident: 1000000, workers_comp: true, additional_insured: true, waiver_of_subrogation: true, primary_non_contributory: false, expires_on: days(200) };
const agent = (o = {}) => ({ output: {
  documents: docs(), coi: { ...COI },
  license: { status: 'active', expires_on: days(400), holder_matches: true }, sanctions: 'clear', sanctions_detail: '', ready_for_approval: true, confidence: 0.92, ...o } });

// Fresh reads the guardrail relies on. The board writes the name differently (comma, case) to prove normalisation.
const screen = (o = {}) => ({ query: { name: req.legal_name }, status: 'clear', matches: [], ...o });
const licRec = (o = {}) => ({ license_number: 'E-1', holder_name: 'ACME ELECTRIC, LLC', status: 'active', expires_on: days(400), ...o });
const lookup = (o = {}) => ({ state: 'TX', number: 'E-1', found: true, results: [licRec(o)] });
const app = (o = {}) => ({ id: 'VA-1', status: 'submitted', ...o });
const PROJECT = {
  project_id: 'PRJ-1',
  insurance: {
    general_liability: { each_occurrence: 1000000, aggregate: 2000000 },
    auto_liability: { combined_single_limit: 1000000 },
    workers_compensation: { required: true, limit: 'statutory' },
    employers_liability: { each_accident: 500000 },
    umbrella: { required: false, each_occurrence: 0 },
  },
  endorsements: { additional_insured: true, waiver_of_subrogation: true, primary_non_contributory: false },
  min_days_of_cover_remaining: 30,
};

// fresh: override any fresh read; undefined means that node did not run.
const g = (a, fresh = {}, r = req) => {
  const reads = { 'Re-screen sanctions': screen(), 'Re-check license': lookup(), 'Read current application': app(), ...fresh };
  const nodes = { Config, 'Normalize application': r, 'Vendor onboarding agent': a };
  for (const [k, v] of Object.entries(reads)) if (v !== undefined) nodes[k] = v;
  return run(wf, 'Guardrails', { json: reads['Read current application'] ?? {}, nodes });
};
const why = (out) => out.guardrail_reasons.join('; ');
const escalates = (out, re) => {
  assert.equal(out.route, 'escalate', 'expected escalate');
  assert.deepEqual(out.planned_actions, [], 'nothing planned');
  if (re) assert.match(why(out), re);
};

test('complete file goes to procurement', () => {
  const out = g(agent());
  assert.equal(out.route, 'auto', why(out));
  assert.equal(out.portal_status, 'pending_approval');
});
test('certificate expiring in 10 days asks the vendor', () => {
  const out = g(agent({ documents: docs({ coi: { expires_on: days(10) } }), ready_for_approval: false }));
  assert.equal(out.route, 'auto', why(out));
  assert.equal(out.portal_status, 'action_required');
  assert.match(out.vendor_items.join(' '), /expires/);
});
test('missing safety program asks the vendor', () => {
  const out = g(agent({ documents: docs({ safety_program: { status: 'missing' } }), ready_for_approval: false }));
  assert.equal(out.portal_status, 'action_required');
});
test('low liability limit asks the vendor', () => {
  const out = g(agent({ coi: { ...COI, gl_each_occurrence: 500000 }, ready_for_approval: false }));
  assert.match(out.vendor_items.join(' '), /general liability/);
});
test('sanctions possible match escalates', () => assert.equal(g(agent({ sanctions: 'possible_match' })).route, 'escalate'));
test('agent says ready but checks disagree escalates', () => assert.equal(g(agent({ documents: docs({ w9: { status: 'missing' } }) })).route, 'escalate'));

// ---------- finding 2: fresh sanctions screen and license lookup ----------
test('fresh screen possible_match escalates even when the agent says clear', () => {
  const out = g(agent(), { 'Re-screen sanctions': screen({ status: 'possible_match', matches: [{ list: 'OFAC SDN', entity_name: 'ACME TRADING FZE' }] }) });
  escalates(out, /^sanctions screening: possible_match OFAC SDN ACME TRADING FZE/m);
});
test('fresh screen with an unknown status escalates', () => escalates(g(agent(), { 'Re-screen sanctions': screen({ status: 'pending' }) }), /sanctions screening: pending/));
test('fresh screen "clear" but carrying matches escalates', () => escalates(g(agent(), { 'Re-screen sanctions': screen({ matches: [{ list: 'BIS' }] }) }), /clear status but 1 matches/));
test('screen that did not run escalates', () => escalates(g(agent(), { 'Re-screen sanctions': undefined }), /sanctions screening did not run/));
test('license not in state lookup escalates even when the agent says active', () => {
  escalates(g(agent(), { 'Re-check license': { found: false, results: [] } }), /license not found in state lookup/);
});
test('lookup record for a different license number is not accepted', () => {
  escalates(g(agent(), { 'Re-check license': lookup({ license_number: 'E-2' }) }), /license not found in state lookup/);
});
test('license inactive in the state lookup escalates (no longer a vendor item)', () => {
  escalates(g(agent({ license: { status: 'inactive', expires_on: days(400), holder_matches: true }, ready_for_approval: false }), { 'Re-check license': lookup({ status: 'inactive' }) }), /license status in state lookup is inactive/);
});
test('license past its expiry in the state lookup escalates', () => {
  escalates(g(agent(), { 'Re-check license': lookup({ expires_on: days(-3) }) }), /license expired/);
});
test('holder mismatch from the board escalates even when the agent says it matches', () => {
  const out = g(agent(), { 'Re-check license': lookup({ holder_name: 'Tidewater Climate Services Inc' }) });
  escalates(out, /license holder name does not match the legal name/);
  assert.match(why(out), /agent holder_matches \(true\) disagrees/);
});
test('holder with a different entity suffix (Inc vs LLC) is a mismatch', () => {
  escalates(g(agent(), { 'Re-check license': lookup({ holder_name: 'Acme Electric Inc' }) }), /license holder name does not match/);
});
test('license lookup that did not run escalates when the trade needs a license', () => {
  escalates(g(agent(), { 'Re-check license': undefined }), /state license lookup did not run/);
});
test('license lookup is not needed for a trade that does not require one', () => {
  const out = g(agent({ documents: docs().filter((d) => ['w9', 'coi'].includes(d.document)), license: { status: 'not_required', expires_on: null, holder_matches: false } }), { 'Re-check license': undefined }, { ...req, trade: 'landscaping' });
  assert.equal(out.route, 'auto', why(out));
});

// ---------- finding 6: not_required for a trade that needs a license ----------
test('agent marking the license not_required for electrical escalates', () => {
  const out = g(agent({ license: { status: 'not_required', expires_on: null, holder_matches: true } }));
  escalates(out, /agent marked the license not_required, but the electrical trade requires one/);
  assert.ok(!out.vendor_items.some((i) => /not_required/.test(i)), 'not turned into a vendor item');
});

// ---------- finding 3: insurance fails closed and uses project requirements ----------
test('certificate marked valid with no coverage details escalates', () => {
  escalates(g(agent({ coi: null })), /marked valid but no coverage details/);
});
test('policy expiring inside the window (coi.expires_on) asks the vendor even when the document date is fine', () => {
  const out = g(agent({ coi: { ...COI, expires_on: days(12) }, ready_for_approval: false }));
  assert.equal(out.route, 'auto', why(out));
  assert.ok(out.vendor_items.some((i) => i === 'Certificate of insurance: expires ' + days(12) + ', we need at least 30 days of cover'), out.vendor_items.join('; '));
});
test('unreadable coi expiry escalates', () => escalates(g(agent({ coi: { ...COI, expires_on: 'soon' } })), /expiry date could not be read/));
test('project requirements are met: complete file still goes to procurement', () => {
  const out = g(agent(), { 'Read project requirements': PROJECT }, { ...req, project_id: 'PRJ-1' });
  assert.equal(out.route, 'auto', why(out));
  assert.equal(out.portal_status, 'pending_approval');
});
test('project limits and endorsements become fixed vendor items', () => {
  const p = structuredClone(PROJECT);
  p.insurance.auto_liability.combined_single_limit = 2000000;
  p.insurance.general_liability.aggregate = 5000000;
  p.insurance.umbrella = { required: true, each_occurrence: 5000000 };
  p.insurance.employers_liability.each_accident = 2000000;
  p.endorsements.primary_non_contributory = true;
  p.min_days_of_cover_remaining = 300;
  const out = g(agent({ coi: { ...COI, waiver_of_subrogation: false }, ready_for_approval: false }), { 'Read project requirements': p }, { ...req, project_id: 'PRJ-1' });
  assert.equal(out.route, 'auto', why(out));
  const items = out.vendor_items.join('\n');
  for (const re of [/auto liability must be at least 2,000,000/, /aggregate must be at least 5,000,000/, /umbrella liability must be at least 5,000,000/, /employers' liability must be at least 2,000,000/, /waiver of subrogation/, /primary and non-contributory/, /we need at least 300 days of cover/]) assert.match(items, re);
});
test('project given but requirements not read escalates', () => {
  escalates(g(agent(), {}, { ...req, project_id: 'PRJ-1' }), /project requirements for PRJ-1 could not be read/);
});
test('requirements for another project escalate', () => {
  escalates(g(agent(), { 'Read project requirements': { ...PROJECT, project_id: 'PRJ-9' } }, { ...req, project_id: 'PRJ-1' }), /requirements returned for project PRJ-9/);
});
test('a project requirement the checks do not know escalates', () => {
  const p = structuredClone(PROJECT);
  p.insurance.pollution_liability = { each_occurrence: 1000000 };
  escalates(g(agent(), { 'Read project requirements': p }, { ...req, project_id: 'PRJ-1' }), /insurance.pollution_liability is not checked/);
});

// ---------- finding 4: current portal status ----------
for (const s of ['approved', 'rejected', 'closed', 'suspended']) {
  test(`application already ${s} in the portal escalates and is not written`, () => {
    escalates(g(agent(), { 'Read current application': app({ status: s }) }), new RegExp(`portal status is ${s}`));
  });
}
test('resubmission while action_required is still updated', () => {
  assert.equal(g(agent(), { 'Read current application': app({ status: 'action_required' }) }).route, 'auto');
});
test('application that could not be read escalates', () => escalates(g(agent(), { 'Read current application': undefined }), /could not be read/));

// ---------- finding 5: contact email required at intake ----------
const intake = (body) => run(wf, 'Normalize application', { json: { body } });
const BODY = { vendor_application_id: 'VA-9', legal_name: 'Acme Electric LLC', trade: 'Electrical', contact: { name: 'Ann Lee', email: 'Ann@Acme.example' } };
test('complete intake passes', () => {
  const r = intake(BODY);
  assert.equal(r.intake_ok, true);
  assert.equal(r.contact_email, 'ann@acme.example');
  assert.equal(r.handoff_reason, null);
});
test('contact without email goes to the hand-off instead of throwing', () => {
  const r = intake({ ...BODY, contact: { name: 'Ann Lee' } });
  assert.equal(r.intake_ok, false);
  assert.match(r.handoff_reason, /^intake_incomplete: .*missing contact\.email/);
});
test('invalid contact email goes to the hand-off', () => {
  assert.match(intake({ ...BODY, contact: { email: 'ann at acme' } }).handoff_reason, /not a valid address/);
});
test('missing legal name goes to the hand-off with the business key kept', () => {
  const r = intake({ ...BODY, legal_name: '' });
  assert.equal(r.intake_ok, false);
  assert.equal(r.business_key, 'VA-9');
  assert.match(r.handoff_reason, /missing legal_name/);
});
test('incomplete intake reason reaches the exception record', () => {
  const r = intake({ ...BODY, contact: {} });
  const ex = run(wf, 'Build exception', { json: r, nodes: { 'Normalize application': r } });
  assert.ok(ex.reasons.some((x) => /intake_incomplete/.test(x)), ex.reasons.join('; '));
  assert.equal(ex.business_key, 'VA-9');
});

// ---------- wiring ----------
const outputs = (from, idx) => (wf.connections[from]?.main?.[idx] ?? []).map((c) => c.node);
test('intake gate, re-reads and the vendor email all fail to the hand-off', () => {
  assert.deepEqual(outputs('Intake complete?', 0), ['Vendor onboarding agent']);
  assert.deepEqual(outputs('Intake complete?', 1), ['Build exception']);
  for (const n of ['Re-screen sanctions', 'Re-check license', 'Read project requirements', 'Read current application', 'Request documents from vendor']) {
    assert.ok(outputs(n, 1).includes('Build exception'), n + ' error output goes to the hand-off');
  }
  assert.equal(wf.nodes.find((n) => n.name === 'Request documents from vendor').onError, 'continueErrorOutput');
  assert.deepEqual(outputs('Read current application', 0), ['Guardrails']);
});
test('re-reads hit the same endpoints as the agent tools', () => {
  const p = (n) => wf.nodes.find((x) => x.name === n).parameters;
  assert.equal(p('Re-screen sanctions').url, p('Screen sanctions').url);
  assert.equal(p('Re-check license').url, p('Verify contractor license').url);
  assert.match(p('Read project requirements').url, /\/projects\/\{\{ .*project_id \}\}\/requirements$/);
  assert.equal(p('Read current application').url, p('Read back application').url);
});

// ---------- finding 1: TINs and bank account numbers are masked in the stored trace ----------
const extract = routes.find((r) => r.path === '/api/extract').handler;
const observe = (app, type) => JSON.stringify(extract({ query: { url: `https://vendors.YOUR-COMPANY.example/uploads/${app}/${type}.pdf` } }).json);
const exceptionFor = (observations) => run(wf, 'Build exception', { json: {}, nodes: {
  'Normalize application': { business_key: 'VA-E2E-7101', legal_name: 'x', trade: 'electrical', application_id: 'VA-E2E-7101' },
  'Vendor onboarding agent': { output: agent().output, intermediateSteps: observations.map((o) => ({ action: { tool: 'Read document', toolInput: {} }, observation: o })) },
  Guardrails: { guardrail_reasons: ['test'] },
} });
test('W-9 TIN and bank letter account number from the live mock are masked in the trace', () => {
  const w9 = observe('VA-E2E-7101', 'w9');
  const bank = observe('VA-E2E-7101', 'bank_letter');
  assert.ok(w9.includes('98-7101101') && bank.includes('000710110199'), 'fixtures carry the secrets');
  const trace = JSON.stringify(exceptionFor([w9, bank]).trace);
  for (const s of ['98-7101101', '987101101', '7101101', '000710110199']) assert.ok(!trace.includes(s), 'trace leaks ' + s);
  assert.match(trace, /\[redacted\]/);
  // Dates and the rest of the text survive.
  for (const d of [/Date: \d{4}-\d{2}-\d{2}/, /since 2019/, /Example National Bank/]) assert.match(trace, d);
});
test('certificate amounts, dates and policy numbers are not masked', () => {
  const coi = observe('VA-E2E-7101', 'coi');
  const trace = exceptionFor([coi]).trace[0].observation;
  assert.equal(trace, coi.slice(0, 1500), 'nothing in the certificate was redacted');
});
test('other TIN and bank number shapes are masked', () => {
  const text = 'SSN 123-45-6789; ITIN 912 78 1234; EIN 987101101; TIN\\n123456789; Routing number: 021000021; Account no. 4455-66778; ACCT # 99 88 77; ABA 1234 5678. Dated 2026-10-13, limit $1,000,000, NAIC 99001, Alabama 35203.';
  const obs = exceptionFor([text]).trace[0].observation;
  for (const s of ['123-45-6789', '912 78 1234', '987101101', '123456789', '021000021', '4455-66778', '99 88 77', '1234 5678']) assert.ok(!obs.includes(s), 'leaks ' + s + ': ' + obs);
  for (const s of ['2026-10-13', '$1,000,000', 'NAIC 99001', 'Alabama 35203']) assert.ok(obs.includes(s), 'over-masked ' + s + ': ' + obs);
});
test('numbers the model repeats in its proposal or questions are masked too', () => {
  const ex = run(wf, 'Build exception', {
    json: { handoff_reason: 'x' },
    nodes: { 'Normalize application': { business_key: 'VA-1', application_id: 'VA-1', legal_name: 'A', trade: 'electrical' }, 'Vendor onboarding agent': { output: { confidence: 0.5, rationale: 'W-9 EIN 12-3456789 checked', questions_for_human: ['Confirm account 000123456789?'] } } },
  });
  assert.doesNotMatch(JSON.stringify(ex.proposed), /12-3456789/);
  assert.doesNotMatch(JSON.stringify(ex.questions), /000123456789/);
  assert.equal(ex.proposed.confidence, 0.5);
});
