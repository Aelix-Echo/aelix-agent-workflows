// Aelix Nexus · EMPI Resolution Steward
// Catalogue: "Scores candidate patient matches with cited evidence. Merges are human-approved."
// Pattern: approve. No two records are merged until the named data steward approves.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

export const sample = {
  task_id: 'EMPI-TASK-SYNTH-40219',
  record_a: 'EMPI-SYNTH-1000231',
  record_b: 'EMPI-SYNTH-1007754',
  engine_score: 0.91,
  reason: 'probable_duplicate',
};

const ATTRS = ['name', 'birth_date', 'sex', 'ssn', 'address', 'phone', 'email', 'mrn', 'insurance_member_id', 'other'];

export default () => productAgent({
  industry: 'Healthcare',
  product: 'Aelix Nexus',
  agent: 'EMPI Resolution Steward',
  slug: 'healthcare-nexus-empi-resolution',
  dir: 'healthcare',
  file: 'nexus-empi-resolution',
  mode: 'approve',
  job: 'work the EMPI duplicate queue for the health information management team. For each candidate pair, compare the two patient records attribute by attribute, score the match with cited evidence, and propose a merge only when the evidence supports it, for a data steward to approve.',
  approves: 'the HIM data steward approves every merge',
  never: [
    'Merges records without the named data steward clicking Approve',
    'Proposes a merge when a hard identifier (date of birth, sex, SSN) conflicts without cited evidence explaining it',
    'Touches a record that has already been merged or retired',
    'Makes clinical decisions; it compares identity data only',
    'Puts patient names, MRNs, dates of birth or other identifiers in Slack (EMPI ids only)',
  ],
  team: 'HIM data integrity',
  trigger: { kind: 'webhook', path: 'aelix/nexus/empi-resolution' },
  config: {
    gateway_url: 'https://nexus-gateway.YOUR-HOSPITAL.example/api/v1',
    min_match_score: 0.95,
    // Identifier systems that are one per person. A different value on the two records is a hard conflict.
    hard_identifier_systems: ['http://hl7.org/fhir/sid/us-ssn', 'http://hl7.org/fhir/sid/us-mbi'],
    min_confidence: 0.9,
    approver_slack_user: 'him-data-steward',
    approval_timeout_hours: 48,
    slack_channel: '#nexus-empi',
  },
  intake: {
    name: 'Normalize match task',
    js: `
const b = $json.body ?? $json;
const missing = ['task_id', 'record_a', 'record_b'].filter((k) => !b[k]);
if (missing.length) throw new Error('EMPI task missing fields: ' + missing.join(', '));
if (String(b.record_a) === String(b.record_b)) throw new Error('EMPI task compares a record with itself');
return {
  json: {
    business_key: String(b.task_id),
    task_id: String(b.task_id),
    record_a: String(b.record_a),
    record_b: String(b.record_b),
    engine_score: b.engine_score == null ? null : Number(b.engine_score),
    reason: String(b.reason ?? 'probable_duplicate'),
  },
};
`,
  },
  agentSpec: {
    name: 'EMPI resolution agent',
    prompt: `=EMPI task {{ $json.task_id }} ({{ $json.reason }})
Record A: {{ $json.record_a }} · Record B: {{ $json.record_b }}
Matching engine score: {{ $json.engine_score ?? 'not given' }}

Decide whether these two records are the same person, with evidence for every attribute you compared.`,
    system: `
You are the EMPI resolution steward in Aelix Nexus for a hospital's health information management team. You review candidate duplicate patient records and say whether they are the same person. You compare identity data only. A data steward approves every merge; a wrong merge mixes two people's medical records, so when in doubt, say uncertain.

How to compare:
- Read both records in full: names (including previous names), date of birth, administrative sex, identifiers (SSN, Medicare MBI, MRNs per facility, insurance member ids), addresses, phones and emails, and their status.
- Read each record's history. Corrections (for example a date of birth fixed at registration) and name changes explain differences; cite the history entry id when you rely on one.
- Look at encounter overlap: two records with overlapping inpatient stays at different facilities are very unlikely to be the same person.
- Use "Compare records" for the engine's field-level comparison as one input, not the answer.

Evidence: one entry per attribute you compared, with match, partial, conflict or missing, and a source that names the record and field (for example "EMPI-123.birth_date") or a history entry id. For every conflict you believe is explained, add an entry to conflicts_explained citing the history entry or document that explains it.

Decisions: same_person (propose a merge and choose the surviving record, normally the older active record with more history), different_people, or uncertain.

Tools:
- "Get EMPI record", "Get record history", "List encounters for record", "Compare records".
`,
    tools: [
      { name: 'Get EMPI record', description: 'Get an EMPI record: status (active, merged, retired), merged_into, names, birth date, administrative sex, identifiers with system, addresses, telecom, linked source records.', url: `={{ $('Config').first().json.gateway_url }}/records/{{ $fromAI('record_id', 'EMPI record id', 'string') }}`, auth: { kind: 'header' } },
      { name: 'Get record history', description: 'Get the change history of an EMPI record: entry id, date, field, old and new value, source system, reason.', url: `={{ $('Config').first().json.gateway_url }}/records/{{ $fromAI('record_id', 'EMPI record id', 'string') }}/history`, auth: { kind: 'header' } },
      { name: 'List encounters for record', description: 'List encounter dates, class and facility for an EMPI record (no clinical content), to check for overlapping stays.', url: `={{ $('Config').first().json.gateway_url }}/records/{{ $fromAI('record_id', 'EMPI record id', 'string') }}/encounters`, auth: { kind: 'header' } },
      { name: 'Compare records', description: 'Get the matching engine\'s field-level comparison and weights for two records. Read-only.', url: `={{ $('Config').first().json.gateway_url }}/records/compare`, auth: { kind: 'header' }, query: { a: `={{ $fromAI('record_a', 'First EMPI record id', 'string') }}`, b: `={{ $fromAI('record_b', 'Second EMPI record id', 'string') }}` } },
    ],
    schema: S.obj({
      decision: S.enum(['same_person', 'different_people', 'uncertain'], 'Your decision.'),
      match_score: S.num('0 to 1. Your score that the two records are the same person.'),
      surviving_record: S.enum(['a', 'b'], 'Which record survives a merge.'),
      evidence: S.arr(S.obj({
        attribute: S.enum(ATTRS, 'Attribute compared.'),
        comparison: S.enum(['match', 'partial', 'conflict', 'missing'], 'Result of the comparison.'),
        source: S.str('Record and field, for example "EMPI-123.birth_date", or a history entry id.'),
        note: S.str('Short note, without the identifier values.'),
      }), 'One entry per attribute compared.'),
      conflicts_explained: S.arr(S.obj({
        attribute: S.enum(ATTRS, 'Conflicting attribute.'),
        explanation: S.str('Why the conflict does not mean two people.'),
        supporting_source: S.str('History entry id or document id that shows it.'),
      }), 'Conflicts you believe are explained. Empty when there are none.'),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read both records',
    url: `={{ $('Config').first().json.gateway_url }}/records/pair`,
    query: { a: `={{ $('Normalize match task').item.json.record_a }}`, b: `={{ $('Normalize match task').item.json.record_b }}`, include: 'history' },
  },
  guard: String.raw`
// Fresh read of both records: { a: {...}, b: {...} }, each with its history entry ids.
const A = $json.a ?? {};
const B = $json.b ?? {};
const d = out?.decision;
const noop = d === 'different_people';
const historyIds = new Set([...(A.history ?? []), ...(B.history ?? [])].map((h) => String(h.id)));
const explained = (attr) => (out?.conflicts_explained ?? []).some((c) => c.attribute === attr && historyIds.has(String(c.supporting_source)));
const agentSays = (attr) => (out?.evidence ?? []).find((e) => e.attribute === attr)?.comparison;
const day = (v) => (v ? String(v).slice(0, 10) : null);

for (const [label, r, id] of [['A', A, req.record_a], ['B', B, req.record_b]]) {
  if (String(r.record_id) !== id) reasons.push('record ' + label + ' could not be re-read');
  else if (r.status !== 'active' || r.merged_into) reasons.push('record ' + id + ' is ' + (r.merged_into ? 'already merged into ' + r.merged_into : r.status));
}
if (d === 'uncertain') reasons.push('agent is uncertain; a data steward decides');
if (d === 'same_person') {
  if (!(out.match_score >= cfg.min_match_score)) reasons.push('match score ' + out.match_score + ' below ' + cfg.min_match_score);
  // Hard identifiers, recomputed from the records. A conflict blocks the merge unless a cited history entry explains it.
  const dobA = day(A.birth_date), dobB = day(B.birth_date);
  const dobConflict = dobA && dobB && dobA !== dobB;
  if (dobConflict && !explained('birth_date')) reasons.push('dates of birth differ with no cited history entry explaining it');
  if (dobConflict && agentSays('birth_date') === 'match') reasons.push('agent says dates of birth match, the records differ');
  const sexConflict = A.sex && B.sex && !['unknown', 'other'].includes(A.sex) && !['unknown', 'other'].includes(B.sex) && A.sex !== B.sex;
  if (sexConflict && !explained('sex')) reasons.push('administrative sex differs with no cited history entry explaining it');
  if (sexConflict && agentSays('sex') === 'match') reasons.push('agent says sex matches, the records differ');
  for (const sys of cfg.hard_identifier_systems) {
    const va = (A.identifiers ?? []).find((i) => i.system === sys)?.value;
    const vb = (B.identifiers ?? []).find((i) => i.system === sys)?.value;
    if (va && vb && va !== vb) reasons.push('records carry different ' + sys.split('/').pop() + ' values; never merged');
  }
  if ((A.encounter_overlaps ?? []).includes(req.record_b) || (B.encounter_overlaps ?? []).includes(req.record_a)) reasons.push('the records have overlapping inpatient stays');
  const ev = out.evidence ?? [];
  if (!ev.some((e) => e.comparison === 'match')) reasons.push('no matching attribute cited');
  const bad = ev.filter((e) => !String(e.source).startsWith(req.record_a) && !String(e.source).startsWith(req.record_b) && !historyIds.has(String(e.source)));
  if (bad.length) reasons.push(bad.length + ' evidence entries cite something other than these two records or their history');
}

const survivor = out?.surviving_record === 'b' ? req.record_b : req.record_a;
const retired = survivor === req.record_a ? req.record_b : req.record_a;
const action = { type: 'merge', task_id: req.task_id, survivor_id: survivor, retired_id: retired, match_score: out?.match_score ?? null, evidence: out?.evidence ?? [], conflicts_explained: out?.conflicts_explained ?? [] };
// EMPI ids and attribute names only: no identifier values in Slack.
const allEv = out?.evidence ?? [];
const summary = noop
  ? 'EMPI task ' + req.task_id + ': ' + req.record_a + ' and ' + req.record_b + ' are different people. No merge.'
  : 'EMPI task ' + req.task_id + ': merge *' + retired + '* into *' + survivor + '*\n'
    + 'Score ' + out?.match_score + ' · ' + allEv.filter((e) => e.comparison === 'match').length + ' attributes match, '
    + allEv.filter((e) => e.comparison === 'conflict').length + ' conflict (' + (out?.conflicts_explained ?? []).length + ' explained with cited history). Review the evidence in the EMPI task before approving.';
`,
  act: {
    write: {
      name: 'Merge records in EMPI',
      method: 'POST',
      url: `={{ $('Config').first().json.gateway_url }}/merges`,
      headers: { 'Idempotency-Key': `=empi-merge-{{ $('Guardrails').item.json.action.retired_id }}-into-{{ $('Guardrails').item.json.action.survivor_id }}` },
      json: `={{ JSON.stringify({ ...$('Guardrails').item.json.action, approved_by: $('Record approval').item.json.approver, source: 'aelix-nexus-empi-resolution' }) }}`,
    },
    readBack: {
      name: 'Read back retired record',
      url: `={{ $('Config').first().json.gateway_url }}/records/{{ $('Guardrails').item.json.action.retired_id }}`,
    },
    verify: `
const ok = $json.status === 'merged' && $json.merged_into === planned.survivor_id;
const detail = 'record ' + planned.retired_id + ' shows status ' + $json.status + ', merged into ' + ($json.merged_into ?? 'nothing') + ', expected ' + planned.survivor_id;
`,
  },
  handoffSummary: `'EMPI task ' + intake.task_id + ' · ' + intake.record_a + ' / ' + intake.record_b + ' · ' + (agent?.output?.decision ?? 'no decision')`,
  stickies: {
    intake: 'The EMPI posts each candidate duplicate pair from its review queue: task id, two record ids and the engine score. **Config** holds the minimum match score, the hard identifier systems and the named data steward.',
    plan: 'Claude reads both records, their history and encounter dates, compares **attribute by attribute with a cited source**, explains any conflict with a cited history entry, and decides same person, different people or uncertain.',
    guard: 'Both records are **re-read**. Code blocks the merge if either record is already merged or retired, if **date of birth or sex differ without a cited history entry**, if a one-per-person identifier differs, if stays overlap, or if the score is under the floor. "Different people" is recorded, not escalated.',
    act: 'After the steward approves: one idempotent merge call, then the retired record is read back. It counts only if it shows merged into the surviving record.',
  },
  setup: [
    '**PHI**: run on self-hosted n8n, and only send PHI to Claude under a signed BAA with Anthropic.',
    '**Gateway contract**: EMPI records, record pair, history, encounter dates, engine comparison, and merges at **gateway_url**. Map to your EMPI (Verato, IBM Initiate/InfoSphere MDM, NextGate, Epic Identity, Oracle Health EMPI).',
    'Agree **hard_identifier_systems** and **min_match_score** with HIM. Unmerge stays a manual EMPI procedure.',
  ],
});
