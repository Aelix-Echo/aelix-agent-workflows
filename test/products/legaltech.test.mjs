// LegalTech product agents: guardrails, verification and approval recording.
import { assert, loadProduct, run, test, section, done, days } from '../harness.mjs';

// ---------------- Aelix LexReview · Contract Agent ----------------
{
  const wf = loadProduct('legaltech', 'lexreview-contract');
  section('Aelix LexReview · Contract Agent');
  const Config = {
    clm_review_url: 'https://clm.example/agreements', reviewable_statuses: ['counterparty_paper_received', 'internal_review'],
    cover_template_id: 'counterparty-redline-cover-v1', min_confidence: 0.85, approver_slack_user: 'contracts-counsel', approval_timeout_hours: 24,
  };
  const req = { business_key: 'AGR-1@v3', agreement_id: 'AGR-1', version_id: 'v3', contract_type: 'msa' };
  const ctx = (o = {}) => ({
    agreement_id: 'AGR-1', status: 'counterparty_paper_received', current_version: { version_id: 'v3', sha256: 'abc123' },
    playbook: { clauses: [
      { clause: 'limitation_of_liability', preferred_id: 'LOL-P', fallback_id: 'LOL-F' },
      { clause: 'indemnity', preferred_id: 'IND-P', fallback_id: 'IND-F' },
      { clause: 'governing_law', preferred_id: 'GL-P', fallback_id: 'GL-F' },
    ] },
    ...o,
  });
  const clauses = () => [
    { clause: 'limitation_of_liability', section: '9.2', counterparty_tier: 'walk_away', proposed_action: 'replace_with_fallback', playbook_position_id: 'LOL-F', risk_flag: { severity: 'medium', note: 'Cap at twelve months of fees, below preferred.' } },
    { clause: 'indemnity', section: '10', counterparty_tier: 'fallback', proposed_action: 'replace_with_preferred', playbook_position_id: 'IND-P', risk_flag: null },
    { clause: 'governing_law', section: '15', counterparty_tier: 'preferred', proposed_action: 'accept', playbook_position_id: null, risk_flag: null },
  ];
  const agent = (o = {}) => ({ output: { version_id_reviewed: 'v3', clause_review: clauses(), counsel_notes: '', confidence: 0.9, rationale: 'Read v3.', questions_for_human: [], ...o } });
  const withClause = (i, patch) => { const c = clauses(); c[i] = { ...c[i], ...patch }; return agent({ clause_review: c }); };
  const g = (json = ctx(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize contract event': req, 'Contract agent': a } });

  test('playbook redline with flagged departures goes to counsel', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.deepEqual(out.action.edits.map((e) => e.playbook_position_id), ['LOL-F', 'IND-P']);
    assert.equal(out.action.base_version_id, 'v3');
    assert.match(out.action.fingerprint, /^[0-9a-f]{8}$/);
    assert.match(out.approval_summary, /fingerprint/);
  });
  test('approval message carries ids and tiers, not clause text', () => assert.doesNotMatch(g().approval_summary, /twelve months/));
  test('departure without a risk flag escalates', () => {
    const out = g(ctx(), withClause(0, { risk_flag: null }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /without a risk flag/);
  });
  test('accepting a walk-away position needs a high flag', () => assert.equal(g(ctx(), withClause(0, { proposed_action: 'accept', playbook_position_id: null })).route, 'escalate'));
  test('accepting a walk-away position with a high flag goes to counsel', () => assert.equal(g(ctx(), withClause(0, { proposed_action: 'accept', playbook_position_id: null, risk_flag: { severity: 'high', note: 'At walk-away.' } })).route, 'approve'));
  test('position outside the walk-away blocks', () => {
    const out = g(ctx(), withClause(0, { counterparty_tier: 'outside_walk_away' }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /outside the playbook walk-away/);
  });
  test('edit that is not the playbook position escalates', () => assert.equal(g(ctx(), withClause(1, { playbook_position_id: 'IND-CUSTOM' })).route, 'escalate'));
  test('playbook clause left out of the review escalates', () => assert.equal(g(ctx(), agent({ clause_review: clauses().slice(0, 2) })).route, 'escalate'));
  test('new counterparty version since the event escalates', () => assert.equal(g(ctx({ current_version: { version_id: 'v4', sha256: 'def' } })).route, 'escalate'));
  test('agreement already out for signature escalates', () => assert.equal(g(ctx({ status: 'out_for_signature' })).route, 'escalate'));
  test('contract that matches the playbook needs no redline', () => {
    const all = clauses().map((c) => ({ ...c, counterparty_tier: 'preferred', proposed_action: 'accept', playbook_position_id: null, risk_flag: null }));
    assert.equal(g(ctx(), agent({ clause_review: all })).route, 'none');
  });
  test('low confidence escalates', () => assert.equal(g(ctx(), agent({ confidence: 0.6 })).route, 'escalate'));

  test('approval click is recorded with the named counsel', () => {
    const r = run(wf, 'Record approval', { json: { data: { approved: true, respondedAt: '2026-10-13T10:00:00Z' } }, nodes: { Config } });
    assert.deepEqual([r.decision, r.approver], ['approved', 'contracts-counsel']);
  });

  const planned = g().action;
  const sent = (o = {}) => ({ status: 'sent', agreement_id: 'AGR-1', base_version_id: 'v3', base_sha256: 'abc123', edits: planned.edits, cover_template_id: 'counterparty-redline-cover-v1', ...o });
  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: planned } } });
  test('verify accepts the redline counsel approved', () => assert.equal(v(sent()).verified, true));
  test('verify rejects a sent redline with different edits', () => assert.equal(v(sent({ edits: [planned.edits[0]] })).verified, false));
  test('verify rejects a redline on another version', () => assert.equal(v(sent({ base_version_id: 'v4' })).verified, false));
}

// ---------------- Aelix Litigate · Research Agent ----------------
{
  const wf = loadProduct('legaltech', 'litigate-research');
  section('Aelix Litigate · Research Agent');
  const Config = { max_memo_chars: 40000, min_confidence: 0.75, reviewer_slack_user: 'litigation-attorney' };
  const req = { business_key: 'LR-1', request_id: 'LR-1', matter_id: 'MAT-1', due_by: '2026-10-20' };
  const A1 = { ref: 1, authority_id: 'auth-111', citation: 'Berman v. Freedom Fin. Network, LLC, 30 F.4th 849 (9th Cir. 2022)', proposition: 'Notice standard for online terms.', treatment: 'positive', treatment_discussed: false };
  const A2 = { ref: 2, authority_id: 'auth-222', citation: 'Old Case v. Example Corp., 100 F.3d 200 (9th Cir. 1996)', proposition: 'Older rule on modification.', treatment: 'overruled', treatment_discussed: true };
  const pad = ' ' + 'Further analysis of the record follows.'.repeat(15);
  const memo = (p2 = 'Old Case [2] once held otherwise, but it was overruled on this point and is cited only for completeness.') =>
    'Discussion. Under [1], the user must have reasonable notice of updated terms.' + pad + '\n\n' + p2 + pad;
  const steps = (cits = [A1, A2]) => [
    { action: { tool: 'Get_matter', toolInput: { matter_id: 'MAT-1' } }, observation: '{"court":"N.D. Cal."}' },
    { action: { tool: 'Search_authority', toolInput: { q: 'browsewrap notice' } }, observation: JSON.stringify({ hits: cits.map((a) => ({ authority_id: a.authority_id, citation: a.citation })) }) },
  ];
  const agent = (o = {}, s = steps()) => ({ intermediateSteps: s, output: { question_presented: 'Q', short_answer: 'A', memo: memo(), authorities: [A1, A2], open_issues: [], confidence: 0.85, rationale: 'r', questions_for_human: [], ...o } });
  const cite = (o = {}) => ({ results: [{ authority_id: 'auth-111', found: true, treatment: 'positive' }, { authority_id: 'auth-222', found: true, treatment: 'overruled', ...o }] });
  const g = (json = cite(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize research request': req, 'Research agent': a } });

  test('cite-checked memo goes to the named attorney', () => {
    const out = g();
    assert.equal(out.route, 'draft', out.guardrail_reasons.join('; '));
    assert.equal(out.draft.status, 'draft_not_filed');
    assert.equal(out.draft.attorney, 'litigation-attorney');
    assert.equal(out.draft.authorities[1].citator.treatment, 'overruled');
  });
  test('Slack summary carries ids and counts, not the memo', () => {
    const s = g().draft_summary;
    assert.match(s, /LR-1/);
    assert.doesNotMatch(s, /Berman|reasonable notice/);
  });
  test('authority not returned by a research tool in this run escalates', () => {
    const out = g(cite(), agent({}, steps([A1])));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /not returned by a research tool/);
  });
  test('authority seen only in matter documents does not count as returned', () => {
    const s = [{ action: { tool: 'Get_matter' }, observation: JSON.stringify([A1, A2]) }];
    assert.equal(g(cite(), agent({}, s)).route, 'escalate');
  });
  test('overruled authority not discussed where cited escalates', () => {
    const out = g(cite(), agent({ memo: memo('Old Case [2] supports the same rule.') }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /overruled treatment/);
  });
  test('treatment that differs from the citator escalates', () => assert.equal(g(cite(), agent({ authorities: [A1, { ...A2, treatment: 'positive' }] })).route, 'escalate'));
  test('negative treatment found on re-check escalates when the memo calls it positive', () => assert.equal(g({ results: [{ authority_id: 'auth-111', found: true, treatment: 'negative' }, { authority_id: 'auth-222', found: true, treatment: 'overruled' }] }).route, 'escalate'));
  test('authority the citator cannot find escalates', () => assert.equal(g(cite({ found: false })).route, 'escalate'));
  test('reporter citation typed into the memo text escalates', () => {
    const out = g(cite(), agent({ memo: memo() + ' See also 512 U.S. 79.' }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /outside the authorities list/);
  });
  test('memo reference with no authority behind it escalates', () => assert.equal(g(cite(), agent({ memo: memo() + ' Compare [3].' })).route, 'escalate'));
}

// ---------------- Aelix PracticeOS · Billing Agent ----------------
{
  const wf = loadProduct('legaltech', 'practiceos-billing');
  section('Aelix PracticeOS · Billing Agent');
  const Config = { invoice_template_id: 'client-invoice-cover-v1', hours_increment: 0.1, min_confidence: 0.85, approver_slack_user: 'billing-partner', approval_timeout_hours: 48 };
  const req = { business_key: 'MAT-1@2026-09-30', matter_id: 'MAT-1', client_id: 'CL-1', period_end: '2026-09-30' };
  const rec = (o = {}, g = {}) => ({
    matter: { matter_id: 'MAT-1', status: 'open', client_id: 'CL-1', currency: 'USD', billing_format: 'LEDES1998B' },
    entries: [
      { id: 'TE-1', timekeeper_id: 'TK-A', date: '2026-09-10', hours: 2.5, status: 'unbilled', narrative: 'Draft motion to compel arbitration' },
      { id: 'TE-2', timekeeper_id: 'TK-B', date: '2026-09-12', hours: 1.2, status: 'unbilled', narrative: 'Review production set' },
      { id: 'TE-9', timekeeper_id: 'TK-B', date: '2026-10-02', hours: 3, status: 'unbilled', narrative: 'Next period work' },
    ],
    rates: { 'TK-A': 950, 'TK-B': 450 },
    guidelines: { block_billing_prohibited: true, task_codes_required: true, rate_caps: { 'TK-A': 900 }, allowed_task_codes: [], ...g },
    ...o,
  });
  const lines = () => [
    { entry_id: 'TE-1', timekeeper_id: 'TK-A', date: '2026-09-10', hours: 2.5, rate: 900, amount: 2250, task_code: 'L250', activity_code: 'A103', narrative: 'Draft motion to compel arbitration' },
    { entry_id: 'TE-2', timekeeper_id: 'TK-B', date: '2026-09-12', hours: 1.2, rate: 450, amount: 540, task_code: 'L320', activity_code: 'A104', narrative: 'Review production set' },
  ];
  const agent = (o = {}) => ({ output: { lines: lines(), held_entries: [], invoice_total: 2790, confidence: 0.9, rationale: 'r', questions_for_human: [], ...o } });
  const withLine = (i, patch, o = {}) => { const l = lines(); l[i] = { ...l[i], ...patch }; return agent({ lines: l, ...o }); };
  const g = (json = rec(), a = agent()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize billing request': req, 'Billing agent': a } });

  test('invoice that recomputes cleanly goes to the billing partner', () => {
    const out = g();
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.equal(out.action.total, 2790);
    assert.equal(out.action.template_id, 'client-invoice-cover-v1');
    assert.match(out.approval_summary, /2790 USD/);
  });
  test('approval message carries no narratives', () => assert.doesNotMatch(g().approval_summary, /motion|production/));
  test('rate above the client cap escalates', () => {
    const out = g(rec(), withLine(0, { rate: 950, amount: 2375 }, { invoice_total: 2915 }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /client cap 900/);
  });
  test('line amount the agent got wrong escalates', () => assert.equal(g(rec(), withLine(1, { amount: 560 }, { invoice_total: 2810 })).route, 'escalate'));
  test('invoice total that does not add up escalates', () => assert.equal(g(rec(), agent({ invoice_total: 2800 })).route, 'escalate'));
  test('billing more hours than recorded escalates', () => assert.equal(g(rec(), withLine(1, { hours: 1.5, amount: 675 }, { invoice_total: 2925 })).route, 'escalate'));
  test('write-down goes to the partner and is shown', () => {
    const out = g(rec(), withLine(1, { hours: 1.0, amount: 450 }, { invoice_total: 2700 }));
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
    assert.match(out.approval_summary, /write-downs: TE-2 1.2 to 1h/);
  });
  test('block-billed entry escalates when the client prohibits it', () => {
    const r = rec();
    r.entries[1].narrative = 'Review production set; call with client; draft letter';
    const out = g(r);
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /block-billed/);
  });
  test('LEDES client line without a UTBMS task code escalates', () => assert.equal(g(rec(), withLine(0, { task_code: null })).route, 'escalate'));
  test('task codes are not needed for a standard-format client without the rule', () => {
    const r = rec({ matter: { matter_id: 'MAT-1', status: 'open', client_id: 'CL-1', currency: 'USD', billing_format: 'standard' } }, { task_codes_required: false });
    const out = g(r, agent({ lines: lines().map((l) => ({ ...l, task_code: null, activity_code: null })) }));
    assert.equal(out.route, 'approve', out.guardrail_reasons.join('; '));
  });
  test('closed matter escalates', () => assert.equal(g(rec({ matter: { status: 'closed', client_id: 'CL-1', billing_format: 'LEDES1998B' } })).route, 'escalate'));
  test('unbilled entry silently dropped escalates', () => {
    const out = g(rec(), agent({ lines: lines().slice(0, 1), invoice_total: 2250 }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /TE-2 is neither billed nor held/);
  });
  test('held entry with a reason is fine', () => assert.equal(g(rec(), agent({ lines: lines().slice(0, 1), held_entries: [{ entry_id: 'TE-2', reason: 'Belongs to MAT-2' }], invoice_total: 2250 })).route, 'approve'));
  test('nothing unbilled in the period is recorded as no action', () => assert.equal(g(rec({ entries: [] }), agent({ lines: [], invoice_total: 0 })).route, 'none'));

  test('timeout is recorded with a hand-off reason', () => {
    const r = run(wf, 'Record approval', { json: {}, nodes: { Config } });
    assert.equal(r.decision, 'timed_out');
    assert.match(r.handoff_reason, /48 hours/);
  });
  const planned = g().action;
  const inv = (o = {}) => ({ status: 'sent', total: 2790, sent_template_id: 'client-invoice-cover-v1', lines: [{ entry_id: 'TE-2' }, { entry_id: 'TE-1' }], ...o });
  const v = (json) => run(wf, 'Verify', { json, nodes: { Guardrails: { action: planned } } });
  test('verify accepts the issued invoice', () => assert.equal(v(inv()).verified, true));
  test('verify rejects a different total', () => assert.equal(v(inv({ total: 2800 })).verified, false));
  test('verify rejects a non-standard template', () => assert.equal(v(inv({ sent_template_id: 'custom' })).verified, false));
}

// ---------------- Aelix TrustVault · Compliance Agent ----------------
{
  const wf = loadProduct('legaltech', 'trustvault-compliance');
  section('Aelix TrustVault · Compliance Agent');
  const Config = { max_notice_chars: 60000, min_confidence: 0.75, reviewer_slack_user: 'compliance-lead' };
  const text = 'Controllers that process location data collected from connected vehicles must carry out a data protection impact assessment before processing begins. Controllers must document the retention period for each purpose.';
  const req = (o = {}) => ({ business_key: 'RCN-1', notice_id: 'RCN-1', regulator: 'EDPB', jurisdiction: 'EU', title: 't', effective_on: days(120), notice_text: text, ...o });
  const lib = (o = {}) => ({ policies: [
    { policy_id: 'POL-PRIV-01', version: '4.2', status: 'active', owner: 'privacy-office', controls: [{ control_id: 'CTL-DPIA', owner: 'privacy-engineering' }, { control_id: 'CTL-RET', owner: 'records-management' }], ...o },
    { policy_id: 'POL-SEC-02', version: '2.0', status: 'active', owner: 'security-office', controls: [] },
  ] });
  const base = () => ({
    applicable: true,
    obligations: [{ obligation_id: 'O1', quote: 'Controllers that process location data collected from connected vehicles must carry out a data protection impact assessment before processing begins.', summary: 'DPIA before processing.' }],
    affected: [{ policy_id: 'POL-PRIV-01', policy_version: '4.2', control_ids: ['CTL-DPIA'], obligation_ids: ['O1'], gap: 'DPIA trigger list omits telematics.', proposed_change: 'Add telematics to triggers.' }],
    plan: [{ step_id: 'S1', action: 'Update DPIA trigger list.', policy_ids: ['POL-PRIV-01'], control_ids: ['CTL-DPIA'], owner: 'privacy-engineering', due_date: days(60) }],
    not_applicable_reason: '', confidence: 0.85, rationale: 'r', questions_for_human: [],
  });
  const agent = (o = {}) => ({ output: { ...base(), ...o } });
  const step = (patch) => agent({ plan: [{ ...base().plan[0], ...patch }] });
  const g = (json = lib(), a = agent(), r = req()) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize change notice': r, 'Compliance agent': a } });

  test('grounded mapping and plan go to the compliance lead', () => {
    const out = g();
    assert.equal(out.route, 'draft', out.guardrail_reasons.join('; '));
    assert.equal(out.draft.policy_library_changed, false);
    assert.equal(out.draft.compliance_lead, 'compliance-lead');
    assert.match(out.draft_summary, /1 policies and 1 controls affected/);
  });
  test('Slack summary carries no policy content', () => assert.doesNotMatch(g().draft_summary, /telematics|DPIA/));
  test('obligation quote not in the notice escalates', () => {
    const out = g(lib(), agent({ obligations: [{ obligation_id: 'O1', quote: 'Controllers must appoint a vehicle data officer.', summary: 's' }] }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /does not appear in the notice/);
  });
  test('policy not in the library escalates', () => assert.equal(g(lib(), agent({ affected: [{ ...base().affected[0], policy_id: 'POL-X' }], plan: [{ ...base().plan[0], policy_ids: ['POL-X'] }] })).route, 'escalate'));
  test('mapping against a stale policy version escalates', () => assert.equal(g(lib({ version: '4.3' })).route, 'escalate'));
  test('control not linked to the policy escalates', () => assert.equal(g(lib(), agent({ affected: [{ ...base().affected[0], control_ids: ['CTL-OTHER'] }] })).route, 'escalate'));
  test('owner not on record escalates', () => assert.equal(g(lib(), step({ owner: 'jane-doe' })).route, 'escalate'));
  test('due date after the regulation takes effect escalates', () => {
    const out = g(lib(), step({ due_date: days(200) }));
    assert.equal(out.route, 'escalate');
    assert.match(out.guardrail_reasons.join(';'), /after the regulation takes effect/);
  });
  test('due date in the past escalates', () => assert.equal(g(lib(), step({ due_date: days(-3) })).route, 'escalate'));
  test('affected policy with no plan step escalates', () => assert.equal(g(lib(), agent({ plan: [] })).route, 'escalate'));
  test('regulation already in force escalates', () => assert.equal(g(lib(), agent(), req({ effective_on: days(-10) })).route, 'escalate'));
  test('not applicable with a reason still goes to the lead to confirm', () => {
    const out = g(lib(), agent({ applicable: false, affected: [], plan: [], not_applicable_reason: 'We process no vehicle data; checked POL-PRIV-01.' }));
    assert.equal(out.route, 'draft', out.guardrail_reasons.join('; '));
    assert.match(out.draft_summary, /not applicable/);
  });
  test('not applicable without a reason escalates', () => assert.equal(g(lib(), agent({ applicable: false, affected: [], plan: [], not_applicable_reason: '' })).route, 'escalate'));
}

done();
