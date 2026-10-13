import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  webhook, config, code, ifTrue, http, gmail, slack, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

const DOCS = ['w9', 'coi', 'license', 'safety_program', 'bank_letter'];

// Masked as [redacted] in the tool-call trace stored with an exception: the agent reads W-9s
// and bank letters, and TINs and bank account numbers must never be stored. Digit runs are
// bounded by non-digits rather than \b, because observations are JSON text where a value can
// follow an escaped newline ("\n123456789"). ISO dates (4-2-2) and comma-grouped amounts do
// not match.
const ci = (w) => w.replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
export const REDACT = [
  '(?<!\\d)\\d{2}[- ]\\d{7}(?!\\d)', // EIN: 12-3456789
  '(?<!\\d)\\d{3}[- ]\\d{2}[- ]\\d{4}(?!\\d)', // SSN or ITIN: 123-45-6789
  '(?<!\\d)\\d{9,17}(?!\\d)', // undashed TIN, routing number or account number
  // Any number of 4+ digits (with spaces or dashes) shortly after an account or routing label.
  `(?<=\\b(?:${['account', 'acct', 'routing', 'aba', 'rtn', 'iban'].map(ci).join('|')})[^0-9]{0,25})\\d[\\d -]{2,}\\d`,
];

export default function build() {
  const wf = new Workflow('Real Estate & Construction · Vendor onboarding agent', 'realestate-vendor-onboarding');
  const AGENT = 'Vendor onboarding agent';
  const INTAKE = 'Normalize application';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const api = { kind: 'header' };

  // ---------- intake ----------
  wf.add(webhook('Vendor application submitted', [0, 0], 'aelix/realestate/vendor-onboarding', wf.slug));
  wf.add(config('Config', [220, 0], {
    portal_base_url: 'https://vendors.YOUR-COMPANY.example/api/v1',
    document_service_url: 'https://docs.YOUR-COMPANY.example/api',
    license_api_url: 'https://license-lookup.YOUR-COMPANY.example/api',
    screening_api_url: 'https://screening.YOUR-COMPANY.example/api',
    required_docs_by_trade: {
      default: ['w9', 'coi'],
      electrical: ['w9', 'coi', 'license', 'safety_program'],
      plumbing: ['w9', 'coi', 'license', 'safety_program'],
      hvac: ['w9', 'coi', 'license', 'safety_program'],
      roofing: ['w9', 'coi', 'license', 'safety_program'],
      general_contractor: ['w9', 'coi', 'license', 'safety_program'],
    },
    min_gl_each_occurrence: 1000000,
    coi_min_days_valid: 30,
    // The agent only writes to applications in one of these portal statuses. Anything else
    // (approved, rejected, closed, or a status this list does not know) goes to a person.
    portal_writable_statuses: ['submitted', 'resubmitted', 'action_required', 'pending_approval'],
    min_confidence: 0.85,
    slack_channel_approvals: '#vendor-approvals',
    slack_channel_exceptions: '#vendor-onboarding-exceptions',
  }));
  wf.add(code(INTAKE, [440, 0], `
// An incomplete application goes to the hand-off with a reason instead of failing the run:
// without a contact email the document request would go nowhere and the run would still
// record documents_requested.
const b = $json.body ?? $json;
const email = String(b.contact?.email ?? '').trim().toLowerCase();
const missing = ['vendor_application_id', 'legal_name', 'contact'].filter((k) => !b[k]);
if (b.contact && !email) missing.push('contact.email');
const problems = [];
if (missing.length) problems.push('missing ' + missing.join(', '));
if (email && !/^[^\\s@<>,;:"]+@[^\\s@<>,;:"]+\\.[a-z]{2,}$/.test(email)) problems.push('contact.email is not a valid address');
return {
  json: {
    business_key: b.vendor_application_id ? String(b.vendor_application_id) : null,
    application_id: b.vendor_application_id ? String(b.vendor_application_id) : null,
    legal_name: String(b.legal_name ?? ''),
    trade: String(b.trade ?? 'default').toLowerCase().replace(/[^a-z_]/g, '_'),
    state: String(b.state ?? '').toUpperCase(),
    license_number: String(b.license_number ?? ''),
    contact_name: String(b.contact?.name ?? ''),
    contact_email: email,
    project_id: b.project_id ? String(b.project_id) : null,
    documents: (b.documents ?? []).map((d) => ({ type: String(d.type ?? 'unknown'), url: String(d.url ?? '') })),
    intake_ok: problems.length === 0,
    handoff_reason: problems.length ? 'intake_incomplete: vendor application ' + problems.join('; ') + '; nothing was checked or sent' : null,
  },
};
`));
  wf.add(ifTrue('Intake complete?', [660, 0], '={{ $json.intake_ok }}'));
  wf.chain('Vendor application submitted', 'Config', INTAKE, 'Intake complete?');

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 920,
    prompt: `=Vendor application {{ $json.application_id }}
Legal name: {{ $json.legal_name }}
Trade: {{ $json.trade }} · State: {{ $json.state }} · License number given: {{ $json.license_number || 'none' }}
Project: {{ $json.project_id ?? 'none (general vendor list)' }}
Documents required for this trade: {{ (${cfg}.required_docs_by_trade[$json.trade] ?? ${cfg}.required_docs_by_trade.default).join(', ') }}
Documents uploaded: {{ JSON.stringify($json.documents) }}
Today: {{ $now.toISODate() }}

Check every uploaded document, verify the license and screen the company, and report what is valid, missing or needs fixing.`,
    system: `
You run document collection for vendor onboarding at a real estate and construction company. You check what a vendor uploaded against what their trade and project require, verify their license, screen them against sanctions lists, and report precisely what is valid and what the vendor still needs to provide. Procurement approves every vendor; you never approve one.

For each document:
- W-9 (w9): legal name matches the application, a TIN is present, it is signed and dated. Never repeat the full TIN in your output.
- Certificate of insurance (coi): named insured matches the legal name; record general liability each-occurrence and aggregate limits, auto liability limit, umbrella each-occurrence limit, employers' liability each-accident limit, whether workers' compensation is shown, whether the certificate holder is named as additional insured, whether a waiver of subrogation and primary and non-contributory wording are shown in the holder's favour, and the earliest policy expiration date across all policies. Whenever the certificate is readable, fill in the coi object.
- Contractor license (license): compare with the state license lookup, which is the source of truth. The uploaded copy alone is not enough.
- Safety program (safety_program): a written program specific to this company, not a blank template.
- Bank letter (bank_letter): note only that it is present and on bank letterhead. Do not extract account numbers.

Status per document: valid, missing, expired, insufficient (present but does not meet a requirement, say which), or unreadable. Use the project's insurance requirements when a project is given.

Sanctions: screen the legal name. Report clear, possible_match or match, and the list name for any hit.

Tools:
- "Read document": extracted text of an uploaded file.
- "Get project requirements": insurance limits and endorsements for a project.
- "Verify contractor license": state license lookup.
- "Screen sanctions": sanctions and denied-party screening.
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Read document',
        description: 'Get the extracted text of one uploaded vendor document by its URL.',
        url: `={{ ${cfg}.document_service_url }}/extract`,
        auth: api,
        query: { url: `={{ $fromAI('document_url', 'URL of the uploaded document, from the application', 'string') }}` },
      },
      {
        name: 'Get project requirements',
        description: 'Get insurance requirements for a project: minimum limits by coverage and required endorsements (additional insured, waiver of subrogation).',
        url: `={{ ${cfg}.portal_base_url }}/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/requirements`,
        auth: api,
      },
      {
        name: 'Verify contractor license',
        description: 'Look up a contractor license with the state licensing board. Returns holder name, classification, status and expiration.',
        url: `={{ ${cfg}.license_api_url }}/licenses`,
        auth: api,
        query: {
          state: `={{ $fromAI('state', 'Two-letter state code', 'string') }}`,
          number: `={{ $fromAI('license_number', 'License number', 'string') }}`,
        },
      },
      {
        name: 'Screen sanctions',
        description: 'Screen a company name against sanctions and denied-party lists (OFAC SDN and others). Returns matches with list name and score.',
        url: `={{ ${cfg}.screening_api_url }}/screen`,
        auth: api,
        query: { name: `={{ $fromAI('legal_name', 'Company legal name', 'string') }}`, type: 'organization' },
      },
    ],
    schema: S.obj({
      documents: S.arr(S.obj({
        document: S.enum(DOCS, 'Document type.'),
        status: S.enum(['valid', 'missing', 'expired', 'insufficient', 'unreadable'], 'Status.'),
        expires_on: S.nullable(S.str('ISO date, or null.')),
        detail: S.str('One sentence on what you checked or what is wrong.'),
      }), 'One entry for every required document and every uploaded one.'),
      coi: S.nullable(S.obj({
        gl_each_occurrence: S.num('General liability each occurrence.'),
        gl_aggregate: S.num('General liability aggregate.'),
        auto_limit: S.num('Auto liability combined single limit, 0 if none.'),
        umbrella_each_occurrence: S.num('Umbrella or excess liability each occurrence, 0 if none.'),
        employers_liability_each_accident: S.num("Employers' liability each accident, 0 if none."),
        workers_comp: S.bool('Workers compensation shown.'),
        additional_insured: S.bool('Certificate holder named as additional insured.'),
        waiver_of_subrogation: S.bool('Waiver of subrogation in favour of the certificate holder shown.'),
        primary_non_contributory: S.bool('Primary and non-contributory wording shown.'),
        expires_on: S.str('Earliest policy expiration, ISO date.'),
      })),
      license: S.obj({
        status: S.enum(['active', 'inactive', 'expired', 'not_found', 'not_required'], 'Per the state lookup.'),
        expires_on: S.nullable(S.str('ISO date, or null.')),
        holder_matches: S.bool('License holder name matches the legal name.'),
      }),
      sanctions: S.enum(['clear', 'possible_match', 'match'], 'Screening result.'),
      sanctions_detail: S.str('List name and matched entity, or empty.'),
      ready_for_approval: S.bool('Every required document is valid and screening is clear.'),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link('Intake complete?', AGENT, 0);

  // ---------- guardrails ----------
  // Fresh reads of the sources of truth, so the guardrail never takes the agent's word for
  // screening, the license or the portal status. Same endpoints as the agent's tools.
  const gx = block.right + 140;
  const req = `$('${INTAKE}').item.json`;
  wf.add(http('Re-screen sanctions', [gx, 0], {
    url: `={{ ${cfg}.screening_api_url }}/screen`,
    auth: api,
    query: { name: `={{ ${req}.legal_name }}`, type: 'organization' },
    errorOutput: true,
  }));
  wf.add(ifTrue('License required?', [gx + 220, 0],
    `={{ (${cfg}.required_docs_by_trade[${req}.trade] ?? ${cfg}.required_docs_by_trade.default).includes('license') }}`));
  wf.add(http('Re-check license', [gx + 440, -160], {
    url: `={{ ${cfg}.license_api_url }}/licenses`,
    auth: api,
    query: { state: `={{ ${req}.state }}`, number: `={{ ${req}.license_number }}` },
    errorOutput: true,
  }));
  wf.add(ifTrue('Project given?', [gx + 660, 0], `={{ !!${req}.project_id }}`));
  wf.add(http('Read project requirements', [gx + 880, -160], {
    url: `={{ ${cfg}.portal_base_url }}/projects/{{ ${req}.project_id }}/requirements`,
    auth: api,
    errorOutput: true,
  }));
  wf.add(http('Read current application', [gx + 1100, 0], {
    url: `={{ ${cfg}.portal_base_url }}/applications/{{ ${req}.application_id }}`,
    auth: api,
    errorOutput: true,
  }));
  wf.add(code(GUARD, [gx + 1320, 0], `
${guardPreamble(AGENT)}
const req = $('${INTAKE}').item.json;
// Fresh reads. A node that did not run (or whose output cannot be linked) reads as null.
const fresh = (name) => { try { return $(name).item.json ?? null; } catch (e) { return null; } };
const screen = fresh('Re-screen sanctions');
const lookup = fresh('Re-check license');
const project = fresh('Read project requirements');
const app = fresh('Read current application');

const LABEL = { w9: 'W-9', coi: 'Certificate of insurance', license: 'Contractor license', safety_program: 'Safety program', bank_letter: 'Bank letter' };
const required = cfg.required_docs_by_trade[req.trade] ?? cfg.required_docs_by_trade.default;
const byType = Object.fromEntries((out?.documents ?? []).map((d) => [d.document, d]));
const items = []; // what the vendor must fix, built from fixed labels and numbers only
const money = (n) => Number(n).toLocaleString('en-US');
const normName = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const normNo = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 1. Portal status: only write to an application that is still open for document collection.
const portalStatus = String(app?.status ?? '').toLowerCase();
if (!app) reasons.push('current portal application could not be read, so it was not changed');
else {
  if (app.id != null && String(app.id) !== req.application_id) reasons.push('portal returned application ' + app.id + ' for ' + req.application_id);
  if (!(cfg.portal_writable_statuses ?? []).includes(portalStatus)) reasons.push('portal status is ' + (portalStatus || 'missing') + '; the agent only updates applications that are ' + (cfg.portal_writable_statuses ?? []).join(', ') + ', so it was not changed');
}

// 2. Project requirements, read fresh. Unknown or unreadable requirements go to a person.
const ins = project?.insurance ?? {};
const end = project?.endorsements ?? {};
const need = (v, what) => {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) { reasons.push('project requirement ' + what + ' is not a number: ' + JSON.stringify(v)); return 0; }
  return n;
};
if (req.project_id) {
  if (!project) reasons.push('project requirements for ' + req.project_id + ' could not be read');
  else {
    if (String(project.project_id ?? '') !== req.project_id) reasons.push('requirements returned for project ' + project.project_id + ', expected ' + req.project_id);
    const KNOWN_INS = ['general_liability', 'auto_liability', 'workers_compensation', 'employers_liability', 'umbrella'];
    const KNOWN_END = ['additional_insured', 'waiver_of_subrogation', 'primary_non_contributory'];
    for (const [k, v] of Object.entries(ins)) if (!KNOWN_INS.includes(k) && v && v.required !== false) reasons.push('project requirement insurance.' + k + ' is not checked automatically');
    for (const [k, v] of Object.entries(end)) if (!KNOWN_END.includes(k) && v) reasons.push('project requirement endorsement ' + k + ' is not checked automatically');
  }
}
const minDays = Math.max(cfg.coi_min_days_valid, need(project?.min_days_of_cover_remaining, 'min_days_of_cover_remaining'));
const minValid = Date.now() + minDays * 86400000;
// Expiry dates are re-formatted from the parsed date, so no model text reaches the vendor.
const checkExpiry = (label, iso) => {
  if (!iso) return;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) reasons.push(label + ' expiry date could not be read: ' + String(iso).slice(0, 40));
  else if (t < minValid) items.push(label + ': expires ' + new Date(t).toISOString().slice(0, 10) + ', we need at least ' + minDays + ' days of cover');
};

// 3. Documents.
for (const r of required) {
  const d = byType[r];
  if (!d || d.status === 'missing') items.push(LABEL[r] + ': not received');
  else if (d.status !== 'valid') items.push(LABEL[r] + ': ' + d.status);
  else checkExpiry(LABEL[r], d.expires_on);
}

// 4. Insurance limits. A certificate marked valid without coverage details fails closed to a
// person: the limits were never checked, and telling the vendor their certificate is wrong
// would be a guess.
if (required.includes('coi') && byType.coi?.status === 'valid') {
  const c = out?.coi;
  const L = 'Certificate of insurance: ';
  if (!c) reasons.push('certificate of insurance marked valid but no coverage details were returned, so the limits could not be checked');
  else {
    if (!c.expires_on) reasons.push('certificate of insurance has no policy expiration date');
    else checkExpiry('Certificate of insurance', c.expires_on);
    const glOcc = Math.max(cfg.min_gl_each_occurrence, need(ins.general_liability?.each_occurrence, 'general liability each occurrence'));
    if (!(Number(c.gl_each_occurrence) >= glOcc)) items.push(L + 'general liability must be at least ' + money(glOcc) + ' per occurrence');
    const glAgg = need(ins.general_liability?.aggregate, 'general liability aggregate');
    if (glAgg && !(Number(c.gl_aggregate) >= glAgg)) items.push(L + 'general liability aggregate must be at least ' + money(glAgg));
    const auto = need(ins.auto_liability?.combined_single_limit, 'auto liability combined single limit');
    if (auto && !(Number(c.auto_limit) >= auto)) items.push(L + 'auto liability must be at least ' + money(auto) + ' combined single limit');
    const umb = ins.umbrella?.required ? need(ins.umbrella?.each_occurrence, 'umbrella each occurrence') : 0;
    if (ins.umbrella?.required && !(Number(c.umbrella_each_occurrence) >= umb && Number(c.umbrella_each_occurrence) > 0)) items.push(L + 'umbrella liability must be at least ' + money(umb) + ' per occurrence');
    const el = need(ins.employers_liability?.each_accident, "employers' liability each accident");
    if (el && !(Number(c.employers_liability_each_accident) >= el)) items.push(L + "employers' liability must be at least " + money(el) + ' each accident');
    if (!c.workers_comp) items.push(L + 'workers compensation coverage not shown');
    if (!c.additional_insured) items.push(L + 'add us as additional insured');
    if (end.waiver_of_subrogation && !c.waiver_of_subrogation) items.push(L + 'add a waiver of subrogation in our favour');
    if (end.primary_non_contributory && !c.primary_non_contributory) items.push(L + 'make the cover primary and non-contributory');
  }
}

// 5. License, from the fresh state lookup. Every problem goes to a person.
if (required.includes('license')) {
  if (out?.license?.status === 'not_required') reasons.push('agent marked the license not_required, but the ' + req.trade + ' trade requires one');
  const recs = lookup?.found === true && Array.isArray(lookup.results)
    ? lookup.results.filter((r) => normNo(r.license_number) !== '' && normNo(r.license_number) === normNo(req.license_number))
    : [];
  if (!lookup) reasons.push('state license lookup did not run, so the license was not verified');
  else if (recs.length !== 1) reasons.push('license not found in state lookup' + (recs.length > 1 ? ' (more than one record for ' + req.license_number + ')' : ''));
  else {
    const lic = recs[0];
    const st = String(lic.status ?? '').toLowerCase();
    if (st !== 'active') reasons.push('license status in state lookup is ' + (st || 'missing'));
    const exp = Date.parse(lic.expires_on);
    if (!lic.expires_on || Number.isNaN(exp)) reasons.push('license expiry date missing or unreadable in state lookup');
    else if (exp < Date.now()) reasons.push('license expired on ' + lic.expires_on + ' per state lookup');
    const holderOk = normName(lic.holder_name) !== '' && normName(lic.holder_name) === normName(req.legal_name);
    if (!holderOk) reasons.push('license holder name does not match the legal name (state board: ' + String(lic.holder_name ?? 'none').slice(0, 120) + ')');
    if (out?.license && out.license.holder_matches !== holderOk) reasons.push('agent holder_matches (' + out.license.holder_matches + ') disagrees with the state lookup (' + holderOk + ')');
    if (out?.license && out.license.status !== 'not_required' && out.license.status !== st) reasons.push('agent license status (' + out.license.status + ') disagrees with the state lookup (' + st + ')');
  }
}

// 6. Sanctions, from the fresh screen. Anything other than a clear result with no matches escalates.
if (!screen) reasons.push('sanctions screening did not run, so the vendor was not screened');
else {
  const st = String(screen.status ?? '').toLowerCase();
  const hits = Array.isArray(screen.matches) ? screen.matches : null;
  if (st !== 'clear') reasons.push('sanctions screening: ' + (st || 'no status') + ' ' + (hits ?? []).map((m) => (m.list ?? '') + ' ' + (m.entity_name ?? '')).join('; ').slice(0, 300));
  else if (!hits || hits.length) reasons.push('sanctions screening: clear status but ' + (hits ? hits.length + ' matches returned' : 'no match list returned'));
}
if (out && out.sanctions !== 'clear') reasons.push('agent reports sanctions screening ' + out.sanctions + ': ' + (out.sanctions_detail ?? ''));
if (out && out.ready_for_approval !== (items.length === 0)) reasons.push('agent readiness (' + out.ready_for_approval + ') disagrees with the checks (' + items.length + ' open items)');

const ok = reasons.length === 0;
return {
  json: {
    business_key: req.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    portal_status_before: portalStatus || null,
    portal_status: items.length ? 'action_required' : 'pending_approval',
    vendor_items: items,
    planned_actions: ok ? [{ action: 'portal.set_status', status: items.length ? 'action_required' : 'pending_approval', items }] : [],
  },
};
`));
  wf.add(ifTrue('Proceed automatically?', [gx + 1540, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, 'Re-screen sanctions');
  wf.link('Re-screen sanctions', 'License required?', 0);
  wf.link('License required?', 'Re-check license', 0);
  wf.link('License required?', 'Project given?', 1);
  wf.link('Re-check license', 'Project given?', 0);
  wf.link('Project given?', 'Read project requirements', 0);
  wf.link('Project given?', 'Read current application', 1);
  wf.link('Read project requirements', 'Read current application', 0);
  wf.link('Read current application', GUARD, 0);
  wf.link(GUARD, 'Proceed automatically?');
  const rereads = ['Re-screen sanctions', 'Re-check license', 'Read project requirements', 'Read current application'];

  // ---------- act & verify ----------
  const ax = gx + 1800;
  wf.add(http('Update application status', [ax, 0], {
    method: 'PATCH',
    url: `={{ ${cfg}.portal_base_url }}/applications/{{ $('${INTAKE}').item.json.application_id }}`,
    auth: api,
    json: `={{ JSON.stringify({ status: $json.portal_status, open_items: $json.vendor_items, checklist: $('${AGENT}').item.json.output.documents, reviewed_by: 'aelix-vendor-agent' }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Read back application', [ax + 220, 0], {
    url: `={{ ${cfg}.portal_base_url }}/applications/{{ $('${INTAKE}').item.json.application_id }}`,
    auth: api,
    errorOutput: true,
  }));
  wf.add(code('Verify status', [ax + 440, 0], `
const planned = $('${GUARD}').item.json.portal_status;
const ok = $json.status === planned;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'portal shows ' + $json.status + ', expected ' + planned,
    status: $json.status,
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 660, 0], '={{ $json.verified }}'));
  wf.add(ifTrue('Ready for approval?', [ax + 880, 0], `={{ $json.status === 'pending_approval' }}`));
  wf.add(slack('Ask procurement to approve', [ax + 1100, -130], `={{ ${cfg}.slack_channel_approvals }}`,
    `={{ ':white_check_mark: ' + $('${INTAKE}').item.json.legal_name + ' (' + $('${INTAKE}').item.json.trade + ') has every required document verified and screening clear. Application ' + $('${INTAKE}').item.json.application_id + ' is ready for your approval. Confirm bank details by callback before the first payment.' }}`));
  wf.add(gmail('Request documents from vendor', [ax + 1100, 130], {
    to: `={{ $('${INTAKE}').item.json.contact_email }}`,
    subject: `=Action needed on your vendor application ({{ $('${INTAKE}').item.json.application_id }})`,
    message: `=Hello {{ $('${INTAKE}').item.json.contact_name.split(' ')[0] || 'there' }},

Thanks for applying to work with us. We reviewed your documents and need the following before we can continue:

{{ $('${GUARD}').item.json.vendor_items.map((i) => '- ' + i).join('\\n') }}

You can upload them in the vendor portal. We'll review them as soon as they arrive.`,
  }));
  // A failed send must not be recorded as documents_requested: route it to the hand-off.
  wf.node('Request documents from vendor').onError = 'continueErrorOutput';
  wf.add(setFields('Mark completed', [ax + 1320, 0], { outcome: `={{ $('${GUARD}').item.json.portal_status === 'pending_approval' ? 'ready_for_approval' : 'documents_requested' }}` }));
  wf.link('Proceed automatically?', 'Update application status', 0);
  wf.link('Update application status', 'Read back application', 0);
  wf.link('Read back application', 'Verify status', 0);
  wf.link('Verify status', 'Verified?');
  wf.link('Verified?', 'Ready for approval?', 0);
  wf.link('Ready for approval?', 'Ask procurement to approve', 0);
  wf.link('Ready for approval?', 'Request documents from vendor', 1);
  wf.link('Ask procurement to approve', 'Mark completed');
  wf.link('Request documents from vendor', 'Mark completed');

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax, y: 600, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'vendor compliance', channel: `={{ ${cfg}.slack_channel_exceptions }}`,
    summary: `'Vendor ' + intake.legal_name + ' (' + intake.trade + ') · application ' + intake.application_id + ' · sanctions: ' + (agent?.output?.sanctions ?? 'not screened')`,
    redact: REDACT,
  });
  wf.link('Intake complete?', h.first, 1);
  wf.link(AGENT, h.first, 1);
  for (const r of rereads) wf.link(r, h.first, 1);
  wf.link('Proceed automatically?', h.first, 1);
  wf.link('Update application status', h.first, 1);
  wf.link('Read back application', h.first, 1);
  wf.link('Verified?', h.first, 1);
  wf.link('Request documents from vendor', h.first, 1);

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1580, y: 300, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: ['Vendor application submitted', 'Config', INTAKE, 'Intake complete?'], body: `
The vendor portal posts each submission or re-submission. An application without an id, legal name or a valid contact email goes straight to compliance. **Config** holds required documents by trade, the insurance minimums, how many days of cover a certificate must still have and which portal statuses the agent may update.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Check documents (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude reads each upload (W-9, insurance certificate, license, safety program, bank letter), checks it against project requirements, verifies the license with the state board and screens sanctions lists.
It never repeats a full TIN or bank details, and **never approves a vendor**.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: [...rereads, 'License required?', 'Project given?', GUARD, 'Proceed automatically?'], body: `
Code re-runs the sanctions screen, the state license lookup, the project's insurance requirements and the current portal application, and checks those fresh results instead of the agent's word.
It rebuilds the open-items list from the per-document statuses: expiry windows on every document and every policy, the liability, auto, umbrella and employers' liability minimums, additional insured, waiver of subrogation, workers' comp.
Anything but a clear screen, a license that is not found, not active or held by another name, a certificate marked valid without details, an application already approved, rejected or closed, and any disagreement with the agent go to compliance.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Collect documents', color: COLOR.act, nodes: ['Update application status', 'Read back application', 'Verify status', 'Verified?', 'Ready for approval?', 'Ask procurement to approve', 'Request documents from vendor', 'Mark completed'], body: `
Sets the portal status, reads it back, then either asks the vendor for exactly what's missing (**fixed wording**, items built in code) or asks procurement to approve. A failed email goes to compliance. Procurement confirms bank details by callback.` });
  wf.group({ name: 'Stage: hand off', title: '5 · Compliance review', color: COLOR.handoff, nodes: h.nodes, body: `
Incomplete applications, sanctions matches, license problems and failed reads or writes go to vendor compliance with the checklist and the tool trace. TINs and bank account numbers are masked in the stored trace.` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per submission.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    overview: `## Real Estate & Construction · Vendor onboarding agent
**Job:** take vendor document collection off the procurement desk. Check every upload against trade and project requirements, verify the license, screen sanctions, chase the vendor for exactly what's missing, and put complete files in front of procurement.

**Flow:** submission → agent checks documents (read-only) → guardrails re-read screening, license, project and portal status and rebuild the checklist → set portal status, read back → ask vendor or ask procurement → compliance for the rest → audit.

**Never does**
- Approves a vendor or creates one in the ERP
- Stores or repeats TINs or bank account numbers
- Handles sanctions matches

**Model:** Claude Opus 5, adaptive thinking, effort high.`,
    setup: `## Setup
1. Run **sql/schema.sql**. Select the Postgres credential on *Queue exception* and *Write audit record*.
2. Credentials: **Anthropic**, **Header Auth** for the portal, document service, license lookup and screening APIs, **Gmail**, **Slack**.
3. **Service contracts**: portal applications and projects, document text extraction, state license lookup, sanctions screening. Map to your vendor portal (Procore, Oracle Textura, a custom portal) and screening provider.
4. Edit **Config**: required documents by trade, insurance minimums, days of cover, channels.
5. Test: \`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/realestate-vendor-onboarding.json\``,
  });

  return wf;
}
