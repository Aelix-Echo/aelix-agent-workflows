// Healthcare product agents: guardrails, routing, approval recording and verification.
import { assert, loadProduct, run, test, section, done, days } from '../harness.mjs';

const bundle = (...resources) => ({ resourceType: 'Bundle', entry: resources.map((resource) => ({ resource })) });

// ---------------- Aelix Vitals · Deterioration Watch Agent ----------------
{
  const wf = loadProduct('healthcare', 'vitals-deterioration-watch');
  section('Aelix Vitals · Deterioration Watch Agent');
  const Config = { lookback_hours: 12, max_claims: 12, max_brief_chars: 2500, min_confidence: 0.7, reviewer_slack_user: 'rapid-response-rn' };
  const req = { business_key: 'RSK-1', event_id: 'RSK-1', patient_id: 'pat-1', encounter_id: 'enc-1', unit: '4W', model: 'deterioration-index', score_observation_id: 'risk-1', score: 62, previous_score: 41, score_delta: 21 };
  const record = (o = {}) => bundle(
    { resourceType: 'Observation', id: 'risk-1', status: 'final', valueQuantity: { value: 62 }, ...o },
    { resourceType: 'Observation', id: 'rr-1', status: 'final' },
    { resourceType: 'Observation', id: 'rr-2', status: 'final' },
    { resourceType: 'DocumentReference', id: 'note-1', status: 'current' },
  );
  const agent = (o = {}) => ({ output: {
    headline: 'Respiratory rate and oxygen need rose overnight.', trend: 'worsening', score_observation_id: 'risk-1',
    claims: [
      { statement: 'Respiratory rate rose from 18 at 02:00 to 28 at 08:00.', citations: ['Observation/rr-1', 'Observation/rr-2'] },
      { statement: 'Night nurse documented new confusion at 05:30.', citations: ['DocumentReference/note-1'] },
    ],
    data_gaps: ['no lactate in the window'], confidence: 0.85, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = record(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize risk event': req, 'Deterioration watch agent': a } });

  test('fully cited brief goes to the named nurse reviewer', () => {
    const out = g();
    assert.equal(out.route, 'draft', out.guardrail_reasons.join('; '));
    assert.deepEqual(out.draft.cited_resources, ['Observation/rr-1', 'Observation/rr-2', 'DocumentReference/note-1']);
    assert.deepEqual(out.planned_actions, [{ action: 'draft_for_review' }]);
  });
  test('Slack summary carries ids only, no scores or findings', () => {
    const s = g().draft_summary;
    assert.match(s, /RSK-1 · encounter enc-1 · unit 4W · score rose · 2 cited findings/);
    assert.doesNotMatch(s, /62|41|Respiratory|confusion|pat-1/);
  });
  test('a finding with no citation escalates', () => {
    const out = g(record(), agent({ claims: [{ statement: 'Looks unwell.', citations: [] }] }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /no citation/);
  });
  test('a citation not in the patient record escalates', () => assert.equal(g(record(), agent({ claims: [{ statement: 'x', citations: ['Observation/someone-else'] }] })).route, 'escalate'));
  test('a citation to a non-Observation, non-note resource escalates', () => assert.equal(g(record(), agent({ claims: [{ statement: 'x', citations: ['MedicationRequest/m1'] }] })).route, 'escalate'));
  test('score on record that differs from the event escalates', () => assert.equal(g(record({ valueQuantity: { value: 55 } })).route, 'escalate'));
  test('missing score Observation escalates', () => assert.equal(g(bundle({ resourceType: 'Observation', id: 'rr-1' })).route, 'escalate'));
  test('order or treatment language escalates', () => {
    const out = g(record(), agent({ questions_for_human: ['Administer a fluid bolus now?'] }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /order or treatment language/);
  });
  test('low confidence escalates', () => assert.equal(g(record(), agent({ confidence: 0.4 })).route, 'escalate'));
}

// ---------------- Aelix Vitals · Documentation Agent ----------------
{
  const wf = loadProduct('healthcare', 'vitals-documentation');
  section('Aelix Vitals · Documentation Agent');
  const Config = {
    note_sections: { progress_note: ['Subjective', 'Objective', 'Assessment', 'Plan'] },
    clinician_sections: ['Assessment', 'Plan'], max_note_chars: 12000, min_confidence: 0.7, reviewer_slack_user: 'documentation-reviewer',
  };
  const req = { business_key: 'DOC-1', request_id: 'DOC-1', patient_id: 'pat-2', encounter_id: 'enc-2', author_practitioner_id: 'prac-1', note_type: 'progress_note', source_document_ids: ['amb-1'], instructions: '' };
  const record = (encStatus = 'in-progress') => bundle(
    { resourceType: 'Encounter', id: 'enc-2', status: encStatus },
    { resourceType: 'DocumentReference', id: 'amb-1', status: 'current' },
    { resourceType: 'Observation', id: 'bp-1' },
    { resourceType: 'Condition', id: 'c-1' },
  );
  const sec = (title, citations, text = 'Text.') => ({ title, text, citations });
  const agent = (o = {}) => ({ output: {
    note_type: 'progress_note',
    sections: [
      sec('Subjective', ['DocumentReference/amb-1']),
      sec('Objective', ['Observation/bp-1']),
      sec('Assessment', ['DocumentReference/amb-1', 'Condition/c-1']),
      sec('Plan', ['DocumentReference/amb-1']),
    ],
    items_for_author: [], confidence: 0.8, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = record(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize note request': req, 'Documentation agent': a } });

  test('complete cited note goes to review as an unsigned AI draft', () => {
    const out = g();
    assert.equal(out.route, 'draft', out.guardrail_reasons.join('; '));
    assert.equal(out.draft.status, 'unsigned_ai_draft');
    assert.match(out.draft.notice, /Not part of the medical record/);
  });
  test('Slack summary carries ids only', () => assert.doesNotMatch(g().draft_summary, /Text\.|pat-2/));
  test('missing required section escalates', () => assert.equal(g(record(), agent({ sections: agent().output.sections.slice(0, 3) })).route, 'escalate'));
  test('plan that does not cite the clinician\'s own words escalates', () => {
    const s = agent().output.sections.slice(0, 3).concat(sec('Plan', ['Observation/bp-1']));
    const out = g(record(), agent({ sections: s }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /does not cite the author/);
  });
  test('citation to a resource outside the record escalates', () => assert.equal(g(record(), agent({ sections: agent().output.sections.slice(0, 3).concat(sec('Plan', ['DocumentReference/amb-1', 'Observation/ghost'])) })).route, 'escalate'));
  test('signature language in the draft escalates', () => assert.equal(g(record(), agent({ sections: agent().output.sections.slice(0, 3).concat(sec('Plan', ['DocumentReference/amb-1'], 'Electronically signed by Dr X')) })).route, 'escalate'));
  test('encounter entered in error escalates', () => assert.equal(g(record('entered-in-error')).route, 'escalate'));
  test('note type other than requested escalates', () => assert.equal(g(record(), agent({ note_type: 'discharge_summary' })).route, 'escalate'));
}

// ---------------- Aelix Pulse · Medical Coding Agent ----------------
{
  const wf = loadProduct('healthcare', 'pulse-medical-coding');
  section('Aelix Pulse · Medical Coding Agent');
  const Config = { max_codes: 25, min_confidence: 0.85, approver_slack_user: 'coding-lead', approval_timeout_hours: 24 };
  const req = { business_key: 'CT-1', coding_task_id: 'CT-1', claim_id: 'CLM-1', patient_id: 'pat-3', encounter_id: 'enc-3', setting: 'outpatient', date_of_service: '2026-10-10' };
  const task = (o = {}) => ({ task_id: 'CT-1', status: 'open', claim_id: 'CLM-1', claim_status: 'pending_coding', document_ids: ['doc-op', 'doc-pn'], ...o });
  const code = (o) => ({ modifiers: [], units: 1, source_document_id: 'doc-pn', source_excerpt: 'quote', rationale: 'r', ...o });
  const codes = [
    code({ system: 'ICD-10-CM', code: 'M17.11', role: 'principal_diagnosis' }),
    code({ system: 'ICD-10-CM', code: 'E11.9', role: 'secondary_diagnosis' }),
    code({ system: 'CPT', code: '20610', role: 'procedure', modifiers: ['RT'], source_document_id: 'doc-op' }),
    code({ system: 'HCPCS', code: 'J3301', role: 'procedure', units: 4, source_document_id: 'doc-op' }),
  ];
  const agent = (o = {}) => ({ output: { codes, confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = task(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize coding task': req, 'Medical coding agent': a } });
  const swap = (i, o) => agent({ codes: codes.map((c, j) => (j === i ? { ...c, ...o } : c)) });

  test('well-formed, cited codes go to the coder', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.codes.length, 4);
    assert.equal(out.action.claim_id, 'CLM-1');
  });
  test('approval summary carries counts, not codes', () => {
    const s = g().approval_summary;
    assert.match(s, /2 diagnosis codes and 2 procedure codes/);
    assert.doesNotMatch(s, /M17|20610|J3301/);
  });
  test('malformed ICD-10-CM code escalates without putting the code in the reason', () => {
    const out = g(task(), swap(1, { code: 'E119X' }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /code 2 \(ICD-10-CM\) is not a well-formed/);
    assert.doesNotMatch(out.guardrail_reasons.join(';'), /E119X/);
  });
  test('malformed CPT code escalates', () => assert.equal(g(task(), swap(2, { code: '2061' })).route, 'escalate'));
  test('malformed HCPCS code escalates', () => assert.equal(g(task(), swap(3, { code: 'Z9999A' })).route, 'escalate'));
  test('code without a citation escalates', () => {
    const out = g(task(), swap(1, { source_document_id: '' }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /no source citation/);
  });
  test('code citing a document from another encounter escalates', () => assert.equal(g(task(), swap(2, { source_document_id: 'doc-other' })).route, 'escalate'));
  test('two principal diagnoses escalate', () => assert.equal(g(task(), swap(1, { role: 'principal_diagnosis' })).route, 'escalate'));
  test('diagnosis code used as a procedure escalates', () => assert.equal(g(task(), swap(1, { role: 'procedure' })).route, 'escalate'));
  test('claim already released escalates', () => assert.equal(g(task({ claim_status: 'submitted' })).route, 'escalate'));
  test('low confidence escalates', () => assert.equal(g(task(), agent({ confidence: 0.7 })).route, 'escalate'));

  test('approval is recorded with the named coder', () => assert.equal(run(wf, 'Record approval', { json: { data: { approved: true } }, nodes: { Config } }).approver, 'coding-lead'));
  const planned = { codes: [{ system: 'ICD-10-CM', code: 'M17.11', role: 'principal_diagnosis', modifiers: [], units: 1 }, { system: 'CPT', code: '20610', role: 'procedure', modifiers: ['RT'], units: 1 }] };
  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: planned } } });
  test('verify accepts a claim holding exactly the approved codes', () => assert.equal(v({ codes: [...planned.codes].reverse() }).verified, true));
  test('verify rejects a claim missing a modifier', () => assert.equal(v({ codes: [planned.codes[0], { ...planned.codes[1], modifiers: [] }] }).verified, false));
}

// ---------------- Aelix Pulse · Prior Authorization Agent ----------------
{
  const wf = loadProduct('healthcare', 'pulse-prior-authorization');
  section('Aelix Pulse · Prior Authorization Agent');
  const Config = { submission_transport: 'fhir_pas', min_narrative_chars: 300, max_narrative_chars: 4000, min_confidence: 0.85, approver_slack_user: 'pa-clinician-reviewer', approval_timeout_hours: 8 };
  const req = { business_key: 'PA-1', pa_request_id: 'PA-1', patient_id: 'pat-4', coverage_id: 'cov-4', service_request_id: 'sr-4', cpt_codes: ['72148'], icd10_codes: ['M54.16'], urgency: 'standard', office_note: '' };
  const ctx = (o = {}) => ({ pa_request_id: 'PA-1', status: 'pending_submission', payer_id: 'PAYER-A', coverage_active: true, pa_required: true, criteria: [{ id: 'C1' }, { id: 'C2' }], available_document_ids: ['doc-pt', 'doc-mri-order', 'doc-note'], open_authorizations: [], ...o });
  const crit = (id, o = {}) => ({ criterion_id: id, status: 'documented', evidence: ['DocumentReference/doc-pt'], note: 'n', ...o });
  const agent = (o = {}) => ({ output: {
    criteria: [crit('C1'), crit('C2', { evidence: ['DocumentReference/doc-note'] })], narrative: 'n'.repeat(800),
    procedure_codes: ['72148'], diagnosis_codes: ['M54.16', 'M51.26'], attachments: ['doc-pt', 'doc-note'], urgency: 'standard',
    confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = ctx(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize PA request': req, 'Prior authorization agent': a } });

  test('fully documented request goes to the clinician', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.transport, 'fhir_pas');
    assert.deepEqual(out.action.attachments, ['doc-pt', 'doc-note']);
    assert.doesNotMatch(out.approval_summary, /72148|M54/);
  });
  test('payer does not require PA: recorded as no action', () => assert.equal(g(ctx({ pa_required: false })).route, 'none'));
  test('criterion not documented escalates', () => assert.equal(g(ctx(), agent({ criteria: [crit('C1'), crit('C2', { status: 'not_documented', evidence: [] })] })).route, 'escalate'));
  test('payer criterion not addressed escalates', () => assert.equal(g(ctx(), agent({ criteria: [crit('C1')] })).route, 'escalate'));
  test('evidence from outside the chart escalates', () => assert.equal(g(ctx(), agent({ criteria: [crit('C1'), crit('C2', { evidence: ['DocumentReference/doc-ghost'] })] })).route, 'escalate'));
  test('changed ordered codes escalate', () => assert.equal(g(ctx(), agent({ procedure_codes: ['72148', '72149'] })).route, 'escalate'));
  test('urgency changed by the agent escalates', () => assert.equal(g(ctx(), agent({ urgency: 'expedited' })).route, 'escalate'));
  test('open authorization for the same code escalates', () => assert.equal(g(ctx({ open_authorizations: [{ auth_id: 'AUTH-9', code: '72148' }] })).route, 'escalate'));
  test('inactive coverage escalates', () => assert.equal(g(ctx({ coverage_active: false })).route, 'escalate'));
  test('narrative too short escalates', () => assert.equal(g(ctx(), agent({ narrative: 'short' })).route, 'escalate'));

  const planned = { transport: 'fhir_pas', attachments: ['doc-pt', 'doc-note'] };
  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: planned } } });
  test('verify accepts a submitted request with tracking id and all attachments', () => assert.equal(v({ status: 'submitted', submission: { tracking_id: 'T-1', transport: 'fhir_pas', attachment_ids: ['doc-pt', 'doc-note'] } }).verified, true));
  test('verify rejects a submission missing an attachment', () => assert.equal(v({ status: 'submitted', submission: { tracking_id: 'T-1', transport: 'fhir_pas', attachment_ids: ['doc-pt'] } }).verified, false));
  test('verify rejects a request still in draft', () => assert.equal(v({ status: 'draft', submission: {} }).verified, false));
}

// ---------------- Aelix Pulse · Denial Management Agent ----------------
{
  const wf = loadProduct('healthcare', 'pulse-denial-management');
  section('Aelix Pulse · Denial Management Agent');
  const Config = {
    appeal_window_days: { default: 180 }, timely_filing_days: { default: 365 }, deadline_buffer_days: 3,
    no_action_carcs: ['CO-45', 'PR-1', 'PR-2', 'PR-3'], min_appeal_chars: 400, max_appeal_chars: 8000,
    min_confidence: 0.85, approver_slack_user: 'denials-lead', approval_timeout_hours: 24,
  };
  const reqFor = (o = {}) => ({ business_key: 'CLM-5:ERA-5', remit_id: 'ERA-5', claim_id: 'CLM-5', payer_id: 'PAYER-A', remit_date: days(-10), carcs: ['CO-197'], rarcs: ['N54'], payer_letter: '', ...o });
  const claim = (o = {}) => ({ claim_id: 'CLM-5', status: 'denied', payer_id: 'PAYER-A', date_of_service: days(-40), denial: { carcs: ['CO-197'] }, documents: [{ id: 'doc-auth-letter' }, { id: 'doc-op' }], authorizations: [{ auth_number: 'AUTH-123' }], appeals: [], ...o });
  const appeal = (o = {}) => ({ output: {
    category: 'missing_authorization', decision: 'appeal', cited_carcs: ['CO-197'], corrections: [], appeal_level: 'first_level',
    appeal_letter: 'a'.repeat(900), evidence_document_ids: ['doc-auth-letter'], confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const fix = (o = {}) => appeal({ decision: 'correct_and_resubmit', appeal_level: 'none', appeal_letter: '', evidence_document_ids: [],
    corrections: [{ field: 'prior_auth_number', line: null, from_value: '', to_value: 'AUTH-123', source_id: 'AUTH-123' }], ...o });
  const g = (json = claim(), a = appeal(), req = reqFor()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize denial': req, 'Denial management agent': a } });

  test('appeal inside the window goes to the denials lead', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.type, 'appeal');
    assert.equal(out.action.deadline, days(170));
  });
  test('corrected claim with the authorization on file goes to the denials lead', () => {
    const out = g(claim(), fix());
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.type, 'corrected_claim');
    assert.equal(out.action.frequency_code, '7');
  });
  test('appeal after the deadline escalates', () => {
    const out = g(claim(), appeal(), reqFor({ remit_date: days(-181) }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /deadline passed/);
  });
  test('appeal inside the buffer before the deadline escalates', () => assert.equal(g(claim(), appeal(), reqFor({ remit_date: days(-178) })).route, 'escalate'));
  test('corrected claim past timely filing escalates', () => assert.equal(g(claim({ date_of_service: days(-400) }), fix()).route, 'escalate'));
  test('authorization number not on file escalates', () => assert.equal(g(claim(), fix({ corrections: [{ field: 'prior_auth_number', line: null, from_value: '', to_value: 'AUTH-999', source_id: 'doc-auth-letter' }] })).route, 'escalate'));
  test('CARC not on the remittance escalates', () => assert.equal(g(claim(), appeal({ cited_carcs: ['CO-50'] })).route, 'escalate'));
  test('appeal evidence not on the claim escalates', () => assert.equal(g(claim(), appeal({ evidence_document_ids: ['doc-ghost'] })).route, 'escalate'));
  test('medical necessity appeal goes to clinical review', () => assert.equal(g(claim(), appeal({ category: 'medical_necessity' })).route, 'escalate'));
  test('second-level appeal without a decided first level escalates', () => assert.equal(g(claim(), appeal({ appeal_level: 'second_level' })).route, 'escalate'));
  test('write-off goes to a person', () => assert.equal(g(claim(), appeal({ decision: 'write_off_review' })).route, 'escalate'));
  test('contractual adjustment only is recorded as no action', () => {
    const req = reqFor({ carcs: ['CO-45', 'PR-2'] });
    assert.equal(g(claim({ denial: { carcs: ['CO-45', 'PR-2'] } }), appeal({ decision: 'no_action', cited_carcs: [] }), req).route, 'none');
  });
  test('no action on a real denial escalates', () => assert.equal(g(claim(), appeal({ decision: 'no_action' })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts a submitted first-level appeal', () => assert.equal(v({ appeals: [{ level: 'first_level', status: 'submitted' }] }, { type: 'appeal', appeal_level: 'first_level' }).verified, true));
  test('verify rejects an appeal that did not land', () => assert.equal(v({ appeals: [] }, { type: 'appeal', appeal_level: 'first_level' }).verified, false));
  test('verify accepts a resubmitted frequency 7 claim', () => assert.equal(v({ status: 'resubmitted', submissions: [{ frequency_code: '1' }, { frequency_code: '7', corrections: [{}] }] }, { type: 'corrected_claim', corrections: [{}] }).verified, true));
}

// ---------------- Aelix Nexus · EMPI Resolution Steward ----------------
{
  const wf = loadProduct('healthcare', 'nexus-empi-resolution');
  section('Aelix Nexus · EMPI Resolution Steward');
  const SSN = 'http://hl7.org/fhir/sid/us-ssn';
  const Config = { min_match_score: 0.95, hard_identifier_systems: [SSN], min_confidence: 0.9, approver_slack_user: 'him-data-steward', approval_timeout_hours: 48 };
  const req = { business_key: 'T-1', task_id: 'T-1', record_a: 'EMPI-A', record_b: 'EMPI-B', engine_score: 0.91 };
  const rec = (id, o = {}) => ({ record_id: id, status: 'active', merged_into: null, birth_date: '1970-01-01', sex: 'female', identifiers: [{ system: SSN, value: '000-00-0001' }], history: [], ...o });
  const pair = (a = {}, b = {}) => ({ a: rec('EMPI-A', a), b: rec('EMPI-B', b) });
  const agent = (o = {}) => ({ output: {
    decision: 'same_person', match_score: 0.98, surviving_record: 'a',
    evidence: [
      { attribute: 'name', comparison: 'match', source: 'EMPI-A.name', note: '' },
      { attribute: 'birth_date', comparison: 'match', source: 'EMPI-B.birth_date', note: '' },
      { attribute: 'sex', comparison: 'match', source: 'EMPI-A.sex', note: '' },
    ],
    conflicts_explained: [], confidence: 0.95, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = pair(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize match task': req, 'EMPI resolution agent': a } });

  test('clean match goes to the data steward', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.deepEqual([out.action.survivor_id, out.action.retired_id], ['EMPI-A', 'EMPI-B']);
    assert.doesNotMatch(out.approval_summary, /1970|000-00/);
  });
  test('different dates of birth without evidence block the merge', () => {
    const out = g(pair({}, { birth_date: '1971-01-01' }), agent({ evidence: agent().output.evidence.map((e) => (e.attribute === 'birth_date' ? { ...e, comparison: 'conflict' } : e)) }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /dates of birth differ/);
  });
  test('date of birth conflict explained by a cited history entry goes to the steward', () => {
    const json = pair({ history: [{ id: 'H-77', field: 'birth_date' }] }, { birth_date: '1970-01-10' });
    const a = agent({ evidence: agent().output.evidence.map((e) => (e.attribute === 'birth_date' ? { ...e, comparison: 'conflict' } : e)), conflicts_explained: [{ attribute: 'birth_date', explanation: 'registration typo corrected', supporting_source: 'H-77' }] });
    assert.equal(g(json, a).route, 'approve', g(json, a).guardrail_reasons.join('; '));
  });
  test('explanation citing an unknown history entry still blocks', () => assert.equal(g(pair({}, { birth_date: '1970-01-10' }), agent({ conflicts_explained: [{ attribute: 'birth_date', explanation: 'x', supporting_source: 'H-404' }] })).route, 'escalate'));
  test('different sex without evidence blocks the merge', () => assert.equal(g(pair({}, { sex: 'male' })).route, 'escalate'));
  test('agent claiming a match where the records differ escalates', () => assert.match(g(pair({}, { sex: 'male' })).guardrail_reasons.join(';'), /agent says sex matches/));
  test('different SSNs block the merge', () => assert.equal(g(pair({}, { identifiers: [{ system: SSN, value: '000-00-0002' }] })).route, 'escalate'));
  test('record already merged blocks the merge', () => {
    const out = g(pair({}, { status: 'merged', merged_into: 'EMPI-Z' }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /already merged into EMPI-Z/);
  });
  test('score below the floor escalates', () => assert.equal(g(pair(), agent({ match_score: 0.9 })).route, 'escalate'));
  test('different people is recorded as no action', () => assert.equal(g(pair(), agent({ decision: 'different_people' })).route, 'none'));
  test('uncertain goes to a person', () => assert.equal(g(pair(), agent({ decision: 'uncertain' })).route, 'escalate'));

  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: { survivor_id: 'EMPI-A', retired_id: 'EMPI-B' } } } });
  test('verify accepts the retired record merged into the survivor', () => assert.equal(v({ status: 'merged', merged_into: 'EMPI-A' }).verified, true));
  test('verify rejects a record still active', () => assert.equal(v({ status: 'active', merged_into: null }).verified, false));
}

// ---------------- Aelix Nexus · Mapping Copilot ----------------
{
  const wf = loadProduct('healthcare', 'nexus-mapping-copilot');
  section('Aelix Nexus · Mapping Copilot');
  const Config = { min_sample_messages: 3, max_rules: 200, allowed_target_resources: ['Patient', 'Encounter'], min_confidence: 0.75, reviewer_slack_user: 'integration-engineer' };
  const req = { business_key: 'MAP-1', mapping_request_id: 'MAP-1', interface_id: 'IF-1', message_type: 'ADT^A08', target_profiles: ['us-core-patient'], sample_message_ids: ['M1', 'M2', 'M3'], change_request: '' };
  const result = (id, o = {}) => ({ message_id: id, transformed: true, validation_errors: [], ...o });
  const dry = (o = {}) => ({ dry_run_id: 'DR-9', sandbox: true, committed: false, mapping_version_current: 'v12', results: [result('M1'), result('M2'), result('M3')], ...o });
  const rule = (o) => ({ value_map_id: null, notes: '', transform: 'copy', ...o });
  const agent = (o = {}) => ({ output: {
    base_mapping_version: 'v12', dry_run_id: 'DR-8', change_summary: 'Adds telecom and visit number.',
    rules: [
      rule({ rule_id: 'R1', source: 'PID-5.1', target: 'Patient.name.family' }),
      rule({ rule_id: 'R2', source: 'PID-13.4', target: 'Patient.telecom.value' }),
      rule({ rule_id: 'R3', source: 'PV1-19', target: 'Encounter.identifier.value' }),
      rule({ rule_id: 'R4', source: 'PID-8', target: 'Patient.gender', transform: 'map_code', value_map_id: 'VM-SEX' }),
    ],
    confidence: 0.85, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = dry(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize mapping request': req, 'Mapping copilot agent': a } });

  test('passing dry run goes to the integration engineer as a draft', () => {
    const out = g();
    assert.equal(out.route, 'draft', out.guardrail_reasons.join('; '));
    assert.deepEqual([out.draft.dry_run.passed, out.draft.dry_run.dry_run_id], [3, 'DR-9']);
    assert.match(out.draft.commit, /Not committed/);
  });
  test('summary carries ids and counts only', () => assert.match(g().draft_summary, /IF-1 · ADT\^A08 · 4 rules · dry run DR-9 passed on 3 of 3/));
  test('profile validation error in the dry run escalates', () => assert.equal(g(dry({ results: [result('M1'), result('M2', { validation_errors: [{ severity: 'error', path: 'Patient.gender', message: 'binding' }] }), result('M3')] })).route, 'escalate'));
  test('warnings travel with the draft instead of stopping it', () => {
    const out = g(dry({ results: [result('M1', { validation_errors: [{ severity: 'warning', path: 'Patient.telecom', message: 'must-support empty' }] }), result('M2'), result('M3')] }));
    assert.equal(out.route, 'draft');
    assert.equal(out.draft.dry_run.warnings.length, 1);
  });
  test('message that failed to transform escalates', () => assert.equal(g(dry({ results: [result('M1'), result('M2', { transformed: false }), result('M3')] })).route, 'escalate'));
  test('sample message missing from the dry run escalates', () => assert.equal(g(dry({ results: [result('M1'), result('M2')] })).route, 'escalate'));
  test('response that does not confirm the sandbox escalates', () => assert.equal(g(dry({ committed: true })).route, 'escalate'));
  test('live mapping version moved escalates', () => assert.equal(g(dry({ mapping_version_current: 'v13' })).route, 'escalate'));
  test('rule targeting a resource outside the allowed list escalates', () => assert.equal(g(dry(), agent({ rules: [rule({ rule_id: 'R1', source: 'OBX-5', target: 'MedicationRequest.note' })] })).route, 'escalate'));
  test('code mapping without a value map escalates', () => assert.equal(g(dry(), agent({ rules: [rule({ rule_id: 'R1', source: 'PID-8', target: 'Patient.gender', transform: 'map_code' })] })).route, 'escalate'));
  test('malformed HL7v2 source path escalates', () => assert.equal(g(dry(), agent({ rules: [rule({ rule_id: 'R1', source: 'pid5', target: 'Patient.name.family' })] })).route, 'escalate'));
}

// ---------------- Aelix Shield · SOC Triage Copilot ----------------
{
  const wf = loadProduct('healthcare', 'shield-soc-triage');
  section('Aelix Shield · SOC Triage Copilot');
  const Config = { life_sustaining_classes: ['ventilator', 'infusion_pump'], auto_close_min_confidence: 0.95, min_confidence: 0.8, approver_slack_user: 'soc-lead', approval_timeout_hours: 2 };
  const req = { business_key: 'ALR-1', alert_id: 'ALR-1', device_id: 'DEV-1', source: 'mdsp', alert_type: 'unusual_outbound_connection', severity: 'medium', description: '' };
  const alert = (dev = {}, o = {}) => ({ alert_id: 'ALR-1', status: 'open', device: { device_id: 'DEV-1', device_class: 'pacs_workstation', life_sustaining: false, ...dev }, ...o });
  const agent = (o = {}) => ({ output: {
    verdict: 'benign', benign_reason: 'vendor_remote_support', recommended_action: 'close', containment: null,
    indicators: [{ value: '203.0.113.45', intel_verdict: 'clean' }], evidence_refs: ['FLOW-1', 'MW-7'], phi_exposure_suspected: false,
    confidence: 0.97, rationale: 'r', questions_for_human: [], ...o } });
  const g = (json = alert(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize device alert': req, 'SOC triage agent': a } });

  test('benign close on an ordinary device acts inside the envelope', () => {
    const out = g();
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.action.type, 'close');
  });
  test('life-sustaining device by inventory flag is never auto-closed', () => assert.equal(g(alert({ life_sustaining: true })).route, 'approve'));
  test('life-sustaining device by class is never auto-closed', () => {
    const out = g(alert({ device_class: 'ventilator', life_sustaining: false }));
    assert.equal(out.route, 'approve');
    assert.match(out.approval_summary, /life-sustaining/);
  });
  test('device not in the inventory is never auto-closed', () => assert.equal(g(alert({ device_class: null })).route, 'approve'));
  test('benign close below the auto-close confidence asks the SOC lead', () => assert.equal(g(alert(), agent({ confidence: 0.9 })).route, 'approve'));
  test('containment asks the SOC lead', () => assert.equal(g(alert(), agent({ verdict: 'malicious', benign_reason: 'not_benign', recommended_action: 'contain', containment: { type: 'block_indicator', target: '203.0.113.45' } })).route, 'approve'));
  test('suspicious verdict kept under watch asks the SOC lead', () => assert.equal(g(alert(), agent({ verdict: 'suspicious', benign_reason: 'not_benign', recommended_action: 'monitor' })).route, 'approve'));
  test('possible PHI exposure asks the SOC lead and flags the privacy officer', () => {
    const out = g(alert(), agent({ phi_exposure_suspected: true }));
    assert.equal(out.route, 'approve');
    assert.match(out.approval_summary, /privacy officer/);
  });
  test('close with a non-benign verdict escalates', () => assert.equal(g(alert(), agent({ verdict: 'suspicious', benign_reason: 'not_benign' })).route, 'escalate'));
  test('benign verdict against malicious intel escalates', () => assert.equal(g(alert(), agent({ indicators: [{ value: '203.0.113.45', intel_verdict: 'malicious' }] })).route, 'escalate'));
  test('containment without a target escalates', () => assert.equal(g(alert(), agent({ verdict: 'malicious', benign_reason: 'not_benign', recommended_action: 'contain', containment: null })).route, 'escalate'));
  test('alert already closed escalates', () => assert.equal(g(alert({}, { status: 'closed' })).route, 'escalate'));
  test('investigate goes to a person', () => assert.equal(g(alert(), agent({ verdict: 'needs_investigation', benign_reason: 'not_benign', recommended_action: 'investigate' })).route, 'escalate'));

  const v = (json, action) => run(wf, 'Verify', { json, nodes: { Guardrails: { action } } });
  test('verify accepts a closed alert with the planned verdict', () => assert.equal(v({ status: 'closed', verdict: 'benign' }, { type: 'close', verdict: 'benign' }).verified, true));
  test('verify rejects a containment that was not applied', () => assert.equal(v({ status: 'contained', verdict: 'malicious', containment: { status: 'failed', target: '203.0.113.45' } }, { type: 'contain', verdict: 'malicious', containment: { target: '203.0.113.45' } }).verified, false));
  test('verify accepts an applied containment', () => assert.equal(v({ status: 'contained', verdict: 'malicious', containment: { status: 'applied', target: '203.0.113.45' } }, { type: 'contain', verdict: 'malicious', containment: { target: '203.0.113.45' } }).verified, true));
}

done();
