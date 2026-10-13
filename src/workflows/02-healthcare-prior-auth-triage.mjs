import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  webhook, config, code, ifTrue, http, postgres, slack, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

export default function build() {
  const wf = new Workflow('Healthcare · Prior-auth triage agent', 'healthcare-prior-auth-triage');
  const AGENT = 'Prior-auth agent';
  const INTAKE = 'Normalize request';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const fhir = { kind: 'header' };

  // ---------- intake ----------
  wf.add(webhook('Prior-auth request received', [0, 0], 'aelix/healthcare/prior-auth', wf.slug));
  wf.add(config('Config', [220, 0], {
    fhir_base_url: 'https://fhir.YOUR-EHR.example/R4',
    payer_rules_url: 'https://payer-rules.internal.example/api',
    min_confidence: 0.8,
    slack_channel_exceptions: '#pa-intake-exceptions',
    slack_channel_expedited: '#um-expedited',
  }));
  wf.add(code(INTAKE, [440, 0], `
// Only identifiers and codes travel into the prompt. Clinical detail is fetched
// by the agent from the EHR, so nothing extra is copied around.
// The webhook has already answered 202, so this node never throws: a malformed request
// is marked invalid with a handoff_reason and routed to the hand-off, where a person sees it.
const b = ($json.body && typeof $json.body === 'object' ? $json.body : $json) ?? {};
const svc = b.service && typeof b.service === 'object' ? b.service : {};
const problems = [];
const missing = ['request_id', 'patient_id', 'coverage_id'].filter((k) => b[k] == null || String(b[k]).trim() === '');
if (missing.length) problems.push('missing fields: ' + missing.join(', '));
const cpt = Array.isArray(svc.cpt_codes) ? svc.cpt_codes.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
if (!cpt.length) problems.push('no CPT codes');

// Urgency is never downgraded. Case and spacing are ignored, and known urgent synonyms
// count as expedited. Missing or empty means the office did not ask for expedited review.
// Any other value is treated as expedited (never lower) and the guardrails send the case
// to a person to confirm, because guessing "standard" could delay an urgent patient.
const URGENT = ['expedited', 'urgent', 'stat', 'emergent', 'emergency', 'asap', 'expedite'];
const STANDARD = ['standard', 'routine', 'normal', 'non-urgent', 'nonurgent', 'elective'];
const rawUrgency = b.urgency == null ? '' : String(b.urgency).trim().toLowerCase().replace(/[\\s_]+/g, ' ');
let requested_urgency = 'standard';
let urgency_unrecognised = null;
if (URGENT.includes(rawUrgency)) requested_urgency = 'expedited';
else if (rawUrgency && !STANDARD.includes(rawUrgency.replace(/ /g, '-'))) {
  requested_urgency = 'expedited';
  urgency_unrecognised = String(b.urgency).slice(0, 50);
}

const id = (k) => (b[k] == null ? '' : String(b[k]).trim());
return {
  json: {
    valid: problems.length === 0,
    handoff_reason: problems.length ? 'intake_rejected: prior-auth request ' + problems.join('; ') : null,
    business_key: id('request_id') || null,
    request_id: id('request_id'),
    patient_id: id('patient_id'),
    coverage_id: id('coverage_id'),
    ordering_provider_npi: String(b.ordering_provider?.npi ?? ''),
    cpt_codes: cpt,
    icd10_codes: (Array.isArray(svc.icd10_codes) ? svc.icd10_codes : []).map(String),
    service_description: String(svc.description ?? '').slice(0, 500),
    requested_date: svc.requested_date ?? null,
    requested_urgency,
    urgency_unrecognised,
    documents: (Array.isArray(b.documents) ? b.documents : []).filter((d) => d && typeof d === 'object')
      .map((d) => ({ type: String(d.type ?? 'unknown'), url: String(d.url ?? '') })),
  },
};
`));
  wf.add(ifTrue('Request complete?', [660, 0], '={{ $json.valid }}'));
  wf.chain('Prior-auth request received', 'Config', INTAKE, 'Request complete?');

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 920,
    prompt: `=Prior-authorization request {{ $json.request_id }}
Patient id (FHIR): {{ $json.patient_id }}
Coverage id (FHIR): {{ $json.coverage_id }}
Ordering provider NPI: {{ $json.ordering_provider_npi }}
CPT codes: {{ $json.cpt_codes.join(', ') }}
ICD-10 codes on the order: {{ $json.icd10_codes.join(', ') || 'none given' }}
Service: {{ $json.service_description }}
Requested date: {{ $json.requested_date ?? 'not given' }}
Urgency requested by the ordering office: {{ $json.requested_urgency }}
Documents attached to the request: {{ JSON.stringify($json.documents) }}

Work out whether prior authorization is needed, assemble the packet checklist against the payer's criteria, and say which worklist queue this belongs in.`,
    system: `
You triage prior-authorization requests for a hospital utilization management team. You do not submit anything to a payer and you do not make clinical judgments about whether the service is appropriate. You assemble what a PA coordinator needs and route the request to the right queue.

What a good triage looks like:
- Confirm the patient and coverage exist and the coverage is active on the requested date.
- Use the payer criteria for each CPT code to learn whether PA is required and which documents the payer expects (for example, recent clinical notes, imaging, prior conservative treatment, lab results).
- Build the packet checklist from those criteria. Mark an item "present" only when you found it in the EHR or in the attached documents, and name where (FHIR resource reference or document URL). Mark "unclear" when something related exists but may not satisfy the criterion.
- Assess urgency. Expedited review is for cases where the standard timeframe could seriously jeopardize the patient's life, health or ability to regain maximum function. Say why in expedite_reason. If your assessment differs from what the office requested, keep your own assessment and explain the difference.

Queues:
- ready_for_submission_review: PA required and every required item is present.
- needs_documents: PA required and one or more items are missing.
- clinical_review: the criteria turn on clinical judgment you should not make, or the documents conflict.
- no_pa_required_confirm: payer criteria say PA is not required; a coordinator confirms before the order proceeds.

Minimum necessary: reviewer_summary should say what the reviewer needs to act, in two to four sentences, without restating the full record.

Tools:
- "Get patient (FHIR)", "Get coverage (FHIR)", "List active conditions (FHIR)", "List clinical documents (FHIR)": read the EHR.
- "Get payer criteria": PA requirement and documentation criteria for one payer and one CPT code.
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Get patient (FHIR)',
        description: 'Read a FHIR Patient resource by id. Returns demographics needed to confirm identity.',
        url: `={{ ${cfg}.fhir_base_url }}/Patient/{{ $fromAI('patient_id', 'FHIR Patient id', 'string') }}`,
        auth: fhir,
      },
      {
        name: 'Get coverage (FHIR)',
        description: 'Read a FHIR Coverage resource by id. Returns payer, plan, status and period.',
        url: `={{ ${cfg}.fhir_base_url }}/Coverage/{{ $fromAI('coverage_id', 'FHIR Coverage id', 'string') }}`,
        auth: fhir,
      },
      {
        name: 'List active conditions (FHIR)',
        description: 'Search active FHIR Condition resources for a patient.',
        url: `={{ ${cfg}.fhir_base_url }}/Condition`,
        auth: fhir,
        query: { patient: `={{ $fromAI('patient_id', 'FHIR Patient id', 'string') }}`, 'clinical-status': 'active', _count: '50' },
      },
      {
        name: 'List clinical documents (FHIR)',
        description: 'Search FHIR DocumentReference resources for a patient, newest first. Use the type filter (LOINC code) when looking for something specific, or leave it empty for all recent documents.',
        url: `={{ ${cfg}.fhir_base_url }}/DocumentReference`,
        auth: fhir,
        query: {
          patient: `={{ $fromAI('patient_id', 'FHIR Patient id', 'string') }}`,
          type: `={{ $fromAI('loinc_type', 'Optional LOINC document type code, empty string for all', 'string') }}`,
          _sort: '-date',
          _count: '25',
        },
      },
      {
        name: 'Get payer criteria',
        description: 'Get prior-authorization requirement and documentation criteria for one payer and one CPT code. Call once per CPT code.',
        url: `={{ ${cfg}.payer_rules_url }}/criteria`,
        auth: { kind: 'header' },
        query: {
          payer_id: `={{ $fromAI('payer_id', 'Payer identifier from the Coverage resource', 'string') }}`,
          cpt: `={{ $fromAI('cpt_code', 'One CPT code', 'string') }}`,
        },
      },
    ],
    schema: S.obj({
      patient_found: S.bool('The patient record exists.'),
      coverage_active: S.bool('Coverage is active on the requested date.'),
      payer_name: S.nullable(S.str('Payer name from coverage.')),
      pa_required: S.enum(['yes', 'no', 'unknown'], 'Whether the payer requires PA for these codes.'),
      packet: S.arr(S.obj({
        item: S.str('What the payer expects, for example "PT notes covering 6 weeks of conservative treatment".'),
        required_by: S.str('Which payer criterion asks for it.'),
        status: S.enum(['present', 'missing', 'unclear'], 'Whether you found it.'),
        source: S.str('Exactly one FHIR reference as a tool returned it, such as DocumentReference/123, or one document URL from the request. Nothing else in this field. Empty when missing.'),
      }), 'Packet checklist built from payer criteria.'),
      missing_items: S.arr(S.str(), 'Plain-language list of items still needed.'),
      urgency_assessment: S.enum(['standard', 'expedited'], 'Your urgency assessment.'),
      expedite_reason: S.str('Why expedited, or empty.'),
      route_queue: S.enum(['ready_for_submission_review', 'needs_documents', 'clinical_review', 'no_pa_required_confirm'], 'Worklist queue.'),
      reviewer_summary: S.str('Two to four sentences for the coordinator. Minimum necessary.'),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link('Request complete?', AGENT, 0);

  // ---------- guardrails ----------
  const gx = block.right + 140;
  // Fresh reads of the Patient and Coverage the request names (same URLs as the agent's tools),
  // so the guardrails never take the agent's word that they exist or are active.
  const RP = 'Re-read patient (FHIR)';
  const RC = 'Re-read coverage (FHIR)';
  wf.add(http(RP, [gx, 0], {
    url: `={{ ${cfg}.fhir_base_url }}/Patient/{{ encodeURIComponent($('${INTAKE}').item.json.patient_id) }}`,
    auth: fhir,
    errorOutput: true,
  }));
  wf.add(http(RC, [gx + 220, 0], {
    url: `={{ ${cfg}.fhir_base_url }}/Coverage/{{ encodeURIComponent($('${INTAKE}').item.json.coverage_id) }}`,
    auth: fhir,
    errorOutput: true,
  }));
  wf.add(code(GUARD, [gx + 440, 0], `
${guardPreamble(AGENT)}
const req = $('${INTAKE}').item.json;
const patient = $('${RP}').item.json ?? {}; // fresh read, not what the agent saw
const cov = $json ?? {};                         // fresh read of the Coverage
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const packet = Array.isArray(out?.packet) ? out.packet : [];

// Patient and coverage, checked against the EHR rather than the agent's booleans.
if (patient.resourceType !== 'Patient' || String(patient.id ?? '') !== req.patient_id) reasons.push('patient ' + req.patient_id + ' not found in the EHR');
if (cov.resourceType !== 'Coverage' || String(cov.id ?? '') !== req.coverage_id) reasons.push('coverage ' + req.coverage_id + ' not found in the EHR');
else {
  if (cov.status !== 'active') reasons.push('coverage status is ' + (cov.status ?? 'missing') + ', not active');
  const on = String(req.requested_date ?? new Date().toISOString()).slice(0, 10);
  const start = cov.period?.start ? String(cov.period.start).slice(0, 10) : null;
  const end = cov.period?.end ? String(cov.period.end).slice(0, 10) : null;
  if ((start && on < start) || (end && on > end)) reasons.push('coverage period ' + (start ?? '?') + ' to ' + (end ?? '?') + ' does not include ' + on);
  const beneficiary = String(cov.beneficiary?.reference ?? '').replace(/^.*Patient\\//, '');
  if (beneficiary !== req.patient_id) reasons.push('coverage does not belong to patient ' + req.patient_id);
  // Payer: the agent's payer must be one the Coverage names (display, payer id or Organization id).
  const payers = (Array.isArray(cov.payor) ? cov.payor : []).flatMap((p) => [
    p?.display, String(p?.display ?? '').replace(/\\s*\\([^)]*\\)\\s*$/, ''), p?.identifier?.value, String(p?.reference ?? '').replace(/^.*Organization\\//, ''),
  ]).map(norm).filter(Boolean);
  if (!payers.length) reasons.push('coverage names no payer');
  else if (out && !payers.includes(norm(out.payer_name))) reasons.push('payer: agent said ' + (out.payer_name ?? 'none') + ', coverage does not name that payer');
}

if (req.urgency_unrecognised) reasons.push('urgency: office sent unrecognised value "' + req.urgency_unrecognised + '", treated as expedited until a person confirms');

if (out) {
  if (out.patient_found !== true) reasons.push('agent could not confirm the patient');
  if (out.coverage_active !== true) reasons.push('agent could not confirm active coverage');
  if (out.pa_required === 'unknown') reasons.push('could not determine whether PA is required');
  if (out.urgency_assessment !== req.requested_urgency) {
    reasons.push('urgency: office asked ' + req.requested_urgency + ', agent assessed ' + out.urgency_assessment);
  }

  // A "present" item must name a recognisable source: a FHIR reference (ResourceType/id, relative
  // or under the configured FHIR base URL, optionally followed by a note in brackets) or one of the
  // document URLs on the request. The referenced id must also appear in what the agent's tools
  // returned, so an invented reference fails. Free text fails.
  const FHIR_TYPES = ['DocumentReference', 'Binary', 'Observation', 'DiagnosticReport', 'Condition', 'Procedure', 'ServiceRequest',
    'Encounter', 'ImagingStudy', 'MedicationRequest', 'MedicationStatement', 'CarePlan', 'Composition', 'QuestionnaireResponse',
    'Patient', 'Coverage', 'AllergyIntolerance', 'Immunization', 'Media'];
  const base = String(cfg.fhir_base_url ?? '').replace(/\\/+$/, '');
  const docUrls = new Set((req.documents ?? []).map((d) => String(d.url ?? '').trim()).filter(Boolean));
  let seen = '';
  try { seen = JSON.stringify(($('${AGENT}').item.json.intermediateSteps ?? []).map((st) => st.observation)); } catch (e) {}
  const leadingRef = (s) => {
    const m = /^([A-Za-z]+)\\/([A-Za-z0-9.-]{1,64})(\\/_history\\/[A-Za-z0-9.-]{1,64})?(?=$|\\s|\\()/.exec(s);
    return m && FHIR_TYPES.includes(m[1]) ? m : null;
  };
  const recognisable = (src) => {
    let s = String(src ?? '').trim();
    if (!s) return false;
    if (docUrls.has(s)) return true;
    if (base && s.startsWith(base + '/')) s = s.slice(base.length + 1);
    const m = leadingRef(s);
    return !!m && seen.includes(m[2]);
  };
  const unsourced = packet.filter((p) => p?.status === 'present' && !recognisable(p.source));
  if (unsourced.length) reasons.push(unsourced.length + ' packet items marked present without a recognisable FHIR reference or request document URL');

  // Queue must agree with the packet and with the PA requirement.
  if (out.route_queue === 'ready_for_submission_review') {
    if (!packet.length) reasons.push('marked ready but the packet is empty');
    else if (packet.some((p) => p?.status !== 'present')) reasons.push('marked ready but packet has missing or unclear items');
  }
  if (out.pa_required === 'no' && !['no_pa_required_confirm', 'clinical_review'].includes(out.route_queue)) {
    reasons.push('PA not required but queued as ' + out.route_queue);
  }
  if (out.pa_required !== 'no' && out.route_queue === 'no_pa_required_confirm') {
    reasons.push('queued as no PA required but pa_required is ' + out.pa_required);
  }
}

const ok = reasons.length === 0;
return {
  json: {
    business_key: req.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    planned_actions: ok ? [{ action: 'worklist.insert', queue: out.route_queue, urgency: out.urgency_assessment }] : [],
  },
};
`));
  wf.add(ifTrue('Route automatically?', [gx + 660, 0], `={{ $json.route === 'auto' }}`));
  wf.chain(AGENT, RP, RC, GUARD, 'Route automatically?');

  // ---------- act & verify ----------
  const ax = gx + 920;
  const o = `$('${AGENT}').item.json.output`;
  wf.add(postgres('Add to PA worklist', [ax, 0], `
INSERT INTO pa_worklist (request_id, queue, urgency, payer_name, packet, missing_items, reviewer_summary, confidence, n8n_execution_id)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
ON CONFLICT (request_id) DO UPDATE SET
  queue = EXCLUDED.queue, urgency = EXCLUDED.urgency, payer_name = EXCLUDED.payer_name,
  packet = EXCLUDED.packet, missing_items = EXCLUDED.missing_items,
  reviewer_summary = EXCLUDED.reviewer_summary, confidence = EXCLUDED.confidence,
  n8n_execution_id = EXCLUDED.n8n_execution_id, updated_at = now()
RETURNING id;`,
    `={{ [ $('${INTAKE}').item.json.request_id, ${o}.route_queue, ${o}.urgency_assessment, ${o}.payer_name ?? null, JSON.stringify(${o}.packet ?? []), JSON.stringify(${o}.missing_items ?? []), ${o}.reviewer_summary ?? '', ${o}.confidence ?? null, $execution.id ] }}`,
    { errorOutput: true },
  ));
  wf.add(postgres('Read back worklist item', [ax + 220, 0],
    'SELECT id, queue, urgency FROM pa_worklist WHERE request_id = $1;',
    `={{ [ $('${INTAKE}').item.json.request_id ] }}`,
    { errorOutput: true, alwaysOutput: true },
  ));
  wf.add(code('Verify worklist item', [ax + 440, 0], `
const planned = $('${AGENT}').item.json.output;
const ok = !!$json.id && $json.queue === planned.route_queue && $json.urgency === planned.urgency_assessment;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'worklist row does not match the planned queue and urgency',
    worklist_id: $json.id,
    queue: $json.queue,
    urgency: $json.urgency,
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 660, 0], '={{ $json.verified }}'));
  wf.add(ifTrue('Expedited?', [ax + 880, 0], `={{ $json.urgency === 'expedited' }}`));
  wf.add(slack('Alert UM nurses', [ax + 1100, -140], `={{ ${cfg}.slack_channel_expedited }}`,
    `={{ ':rotating_light: Expedited prior-auth ' + $('${INTAKE}').item.json.request_id + ' is in ' + $json.queue + ' (worklist #' + $json.worklist_id + '). Open the worklist for details.' }}`));
  wf.add(setFields('Mark completed', [ax + 1320, 0], { outcome: 'completed' }));
  wf.link('Route automatically?', 'Add to PA worklist', 0);
  wf.link('Add to PA worklist', 'Read back worklist item', 0);
  wf.link('Read back worklist item', 'Verify worklist item', 0);
  wf.link('Verify worklist item', 'Verified?');
  wf.link('Verified?', 'Expedited?', 0);
  wf.link('Expedited?', 'Alert UM nurses', 0);
  wf.link('Expedited?', 'Mark completed', 1);
  wf.link('Alert UM nurses', 'Mark completed');

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax, y: 560, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'PA intake coordinators', channel: `={{ ${cfg}.slack_channel_exceptions }}`,
    summary: `'PA request ' + intake.request_id + ' · proposed queue: ' + (agent?.output?.route_queue ?? 'none') + ' · urgency: ' + (agent?.output?.urgency_assessment ?? intake.requested_urgency)`,
  });
  wf.link('Request complete?', h.first, 1);   // malformed request: missing ids or CPT codes
  wf.link(AGENT, h.first, 1);                 // agent failed
  wf.link(RP, h.first, 1);                    // patient re-read failed (not found or EHR error)
  wf.link(RC, h.first, 1);                    // coverage re-read failed (not found or EHR error)
  wf.link('Route automatically?', h.first, 1);
  wf.link('Add to PA worklist', h.first, 1);
  wf.link('Read back worklist item', h.first, 1);
  wf.link('Verified?', h.first, 1);

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1580, y: 280, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: ['Prior-auth request received', 'Config', INTAKE, 'Request complete?'], body: `
The EHR or scheduling system posts a PA request with patient, coverage, CPT and ICD-10 codes, urgency and attached document links.
Only identifiers and codes go into the prompt. The agent fetches clinical detail itself.
A request missing its ids or CPT codes goes straight to hand-off. Urgency ignores case, and urgent, stat, emergent and asap count as expedited. An unrecognised urgency is treated as expedited and sent to a person to confirm.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Observe and plan (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude reads Patient, Coverage, Conditions and DocumentReferences over FHIR, pulls the payer's criteria per CPT code, and builds the packet checklist: present, missing or unclear, each with its source.
It proposes a worklist queue and an urgency. **It never submits to a payer and never makes the medical-necessity call.**` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: [RP, RC, GUARD, 'Route automatically?'], body: `
Patient and Coverage are **read again** from FHIR. Escalate when the patient isn't found, the coverage isn't active on the requested date, belongs to someone else or names a different payer, or PA need is unknown.
Also escalate when the agent's urgency differs from the office's, a "present" item lacks a FHIR reference or request document URL, a "ready" packet is empty or has gaps, or the queue contradicts the PA requirement.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Packet assembly and routing', color: COLOR.act, nodes: ['Add to PA worklist', 'Read back worklist item', 'Verify worklist item', 'Verified?', 'Expedited?', 'Alert UM nurses', 'Mark completed'], body: `
Upserts the packet into **pa_worklist** keyed on request id (safe to re-run), reads it back, checks queue and urgency.
Expedited cases page the UM nurses. **Slack messages carry ids only, no PHI.**` });
  wf.group({ name: 'Stage: hand off', title: '5 · Hand off', color: COLOR.handoff, nodes: h.nodes, body: `
Anything the guardrails stop, a malformed request, a failed FHIR re-read or any failed write goes to a PA intake coordinator with the agent's checklist, its questions and its full tool trace.` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per request: outcome, queue, guardrail reasons, tool-call count, model, execution id.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    overview: `## Healthcare · Prior-auth triage agent
**Job:** take prior-authorization intake off the UM desk. Check coverage, match the order against payer criteria, assemble the packet checklist, and put the request in the right worklist queue with a short reviewer summary.

**Flow:** intake → agent reads the EHR and payer criteria (read-only) → guardrails → upsert to PA worklist, read back, page on expedited → hand off anything unclear → audit.

**Never does**
- Submits to a payer
- Decides medical necessity
- Downgrades urgency on its own. Any disagreement goes to a person.
- Puts PHI in Slack

**Model:** Claude Opus 5, adaptive thinking, effort high.`,
    setup: `## Setup
1. **PHI:** only send PHI to Claude under a signed BAA with Anthropic, on a self-hosted n8n you control. Set execution-data retention to match your policy (Settings → Executions pruning).
2. Run **sql/schema.sql** (creates **pa_worklist**, **agent_exceptions**, **agent_runs**). Select the Postgres credential on every Postgres node.
3. Credentials: **Anthropic**, **Header Auth** for FHIR (Bearer token from your EHR's SMART backend-services flow), **Header Auth** for the payer-rules service, **Slack**.
4. Edit **Config**: FHIR base URL, payer-rules URL, confidence floor, Slack channels.
5. Test: \`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/healthcare-prior-auth.json\``,
  });

  return wf;
}
