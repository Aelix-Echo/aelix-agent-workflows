// Aelix CX · Revenue Protection Agent
// Catalogue: "Runs theft sweeps and assembles investigation cases. An operator reviews before any dispatch."
// Pattern: approve. Sweep candidates are pulled on a schedule; a field investigation is dispatched only
// after the revenue protection operator approves. No customer contact, no accusation.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

// Case text is read by field staff and may reach the customer record. It describes meter data, not people.
const ACCUSATORY = ['theft', 'thief', 'steal', 'stole', 'fraud', 'illegal', 'criminal', 'guilty', 'tampered by', 'the customer is'];

export const sample = {
  candidates: [
    { candidate_id: 'RPC-2026-10-0193', sweep_id: 'SWEEP-2026-10-13-02', premise_id: 'PRM-4471029', meter_id: 'MTR-88120455', rule: 'tamper_event_with_consumption_drop', sweep_score: 0.82 },
    { candidate_id: 'RPC-2026-10-0194', sweep_id: 'SWEEP-2026-10-13-02', premise_id: 'PRM-3310874', meter_id: 'MTR-77019342', rule: 'reverse_energy_on_non_net_metered', sweep_score: 0.71 },
  ],
};

export default () => productAgent({
  industry: 'Energy and Utilities',
  product: 'Aelix CX',
  agent: 'Revenue Protection Agent',
  slug: 'energy-cx-revenue-protection',
  dir: 'energy',
  file: 'cx-revenue-protection',
  mode: 'approve',
  job: 'take case assembly off the revenue protection team. For each candidate from the meter-data sweeps, gather the meter events, consumption history and account context, decide whether there is enough for a field investigation, estimate the unbilled energy, and assemble a neutral case for the operator.',
  approves: 'the revenue protection operator approves every field investigation dispatch',
  never: [
    'Dispatches a field investigation without the named operator clicking Approve',
    'Contacts the customer, sends a notice or changes the account',
    'Accuses the customer: case text describes meter data, not people',
    'Builds a case on meter events the tools did not return',
    'Dispatches to a medical-baseline or life-support premise without that flag at the top of the approval and the dispatch',
  ],
  team: 'revenue protection',
  trigger: {
    kind: 'schedule',
    minutes: 120,
    fetch: { url: `={{ $('Config').first().json.gateway_url }}/rp/sweeps/candidates`, query: { status: 'new', limit: '40' }, field: 'candidates' },
  },
  config: {
    gateway_url: 'https://cx-gateway.YOUR-UTILITY.example/api/v1',
    baseline_days: 90,
    min_loss_amount: 250,
    // Agent loss estimate may differ from the recomputed one by this fraction before a person looks.
    loss_estimate_tolerance: 0.1,
    min_confidence: 0.8,
    approver_slack_user: 'revenue-protection-operator',
    approval_timeout_hours: 24,
    slack_channel: '#revenue-protection',
  },
  intake: {
    name: 'Normalize candidate',
    js: `
const c = $json;
const missing = ['candidate_id', 'premise_id', 'meter_id'].filter((k) => c[k] == null || c[k] === '');
if (missing.length) throw new Error('Sweep candidate missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(c.candidate_id),
    candidate_id: String(c.candidate_id),
    sweep_id: String(c.sweep_id ?? ''),
    premise_id: String(c.premise_id),
    meter_id: String(c.meter_id),
    rule: String(c.rule ?? 'unspecified'),
    sweep_score: Number(c.sweep_score ?? 0),
  },
};
`,
  },
  agentSpec: {
    name: 'Revenue protection agent',
    effort: 'medium',
    prompt: `=Sweep candidate {{ $json.candidate_id }} from sweep {{ $json.sweep_id }}
Premise {{ $json.premise_id }} · meter {{ $json.meter_id }}
Rule that flagged it: {{ $json.rule }} · sweep score {{ $json.sweep_score }}

Decide whether this warrants a field investigation and, if so, assemble the case.`,
    system: `
You assemble revenue protection cases for an electric utility's meter-to-cash team on Aelix CX. Sweeps over meter data flag premises where billed energy may not match energy used. You review each candidate and, where the data supports it, assemble a case for a field investigation. The revenue protection operator approves every dispatch.

How to assess:
- Read the meter events (tamper, cover open, magnetic interference, reverse energy, power outage, meter reprogramming) and the daily consumption history.
- Compare consumption before and after the first relevant event against the premise's own baseline and against similar premises. Rule out ordinary explanations: vacancy, new solar, seasonal use, a meter exchange, an estimated-read period, a known outage.
- Read the account context: rate class, occupancy, net metering, open service orders, and the medical-baseline and life-support flags.
- Check prior investigations at the premise.

The case:
- evidence_event_ids: the ids of the meter events the case rests on, exactly as the tools returned them.
- anomaly_start: ISO date of the first relevant event.
- estimated_loss_kwh and estimated_loss_amount: baseline daily kWh minus observed daily kWh since anomaly_start, times days since anomaly_start, times the tariff rate.
- case_summary: what the meter data shows, in neutral terms. Describe the meter and the readings, never the customer. Do not use words like theft, fraud, stealing or illegal. The field visit is an investigation; it has not found anything yet.
- If the premise is medical-baseline or life-support, say so in the case summary.

Recommendations: open_investigation, no_case (an ordinary explanation fits), hold_for_review (unclear, conflicting, or a prior case is open).

Tools:
- "List meter events (MDM)", "Get daily consumption (MDM)", "Get premise and account (CIS)", "Compare with similar premises", "List prior investigations".
`,
    tools: [
      { name: 'List meter events (MDM)', description: 'List events for a meter over a number of days: event id, type (tamper, cover_open, magnetic, reverse_energy, outage, reprogram, exchange), timestamp.', url: `={{ $('Config').first().json.gateway_url }}/mdm/meters/{{ $fromAI('meter_id', 'Meter id', 'string') }}/events`, query: { days: `={{ $fromAI('days', 'Days of history, up to 365', 'number') }}` } },
      { name: 'Get daily consumption (MDM)', description: 'Get validated daily kWh reads for a meter over a number of days, with a flag on estimated reads.', url: `={{ $('Config').first().json.gateway_url }}/mdm/meters/{{ $fromAI('meter_id', 'Meter id', 'string') }}/daily-reads`, query: { days: `={{ $fromAI('days', 'Days of history, up to 365', 'number') }}` } },
      { name: 'Get premise and account (CIS)', description: 'Get the premise and account: rate class, tariff rate per kWh, occupancy status, net metering, open service orders, medical-baseline and life-support flags.', url: `={{ $('Config').first().json.gateway_url }}/cis/premises/{{ $fromAI('premise_id', 'Premise id', 'string') }}` },
      { name: 'Compare with similar premises', description: 'Get average daily kWh for premises with the same rate class, size band and feeder over the same days.', url: `={{ $('Config').first().json.gateway_url }}/mdm/premises/{{ $fromAI('premise_id', 'Premise id', 'string') }}/peer-consumption`, query: { days: `={{ $fromAI('days', 'Days of history, up to 365', 'number') }}` } },
      { name: 'List prior investigations', description: 'List revenue protection investigations at a premise: id, opened, closed, outcome, status.', url: `={{ $('Config').first().json.gateway_url }}/rp/premises/{{ $fromAI('premise_id', 'Premise id', 'string') }}/investigations` },
    ],
    schema: S.obj({
      recommendation: S.enum(['open_investigation', 'no_case', 'hold_for_review'], 'Recommended next step.'),
      anomaly_type: S.enum(['meter_tamper_events', 'possible_bypass', 'reverse_energy', 'stopped_or_slow_meter', 'unbilled_consumption', 'other'], 'What the meter data shows.'),
      evidence_event_ids: S.arr(S.str(), 'Meter event ids the case rests on, from the tools.'),
      anomaly_start: S.nullable(S.str('ISO date of the first relevant event.')),
      baseline_kwh_per_day: S.num('Baseline daily kWh before anomaly_start.'),
      observed_kwh_per_day: S.num('Average daily kWh since anomaly_start.'),
      estimated_loss_kwh: S.num('Estimated unbilled kWh since anomaly_start.'),
      estimated_loss_amount: S.num('Estimated unbilled amount at the tariff rate.'),
      medical_flag: S.bool('The premise is medical-baseline or life-support.'),
      ordinary_explanations_checked: S.arr(S.str(), 'Ordinary explanations ruled out.'),
      case_summary: S.str('Neutral description of the meter data for the field investigator. No accusation.'),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read case data',
    url: `={{ $('Config').first().json.gateway_url }}/rp/premises/{{ $('Normalize candidate').item.json.premise_id }}/case-data`,
    query: { meter_id: `={{ $('Normalize candidate').item.json.meter_id }}`, days: `={{ $('Config').first().json.baseline_days + 365 }}` },
  },
  guard: `
const d = $json; // fresh meter events, daily reads, flags and tariff for the premise
const rec = out?.recommendation;
const noop = rec === 'no_case';
const events = d.meter_events ?? [];
const eventIds = new Set(events.map((e) => e.event_id));
const medical = d.flags?.medical_baseline === true || d.flags?.life_support === true;
const round2 = (n) => Math.round(n * 100) / 100;

// Estimated loss, recomputed from the daily reads (estimated reads left out).
const start = out?.anomaly_start ? String(out.anomaly_start).slice(0, 10) : null;
const reads = (d.daily_reads ?? []).filter((r) => !r.estimated).map((r) => ({ date: String(r.date).slice(0, 10), kwh: Number(r.kwh) }));
const startMs = start ? Date.parse(start) : NaN;
const before = reads.filter((r) => r.date < start && Date.parse(r.date) >= startMs - cfg.baseline_days * 86400000);
const after = reads.filter((r) => r.date >= start);
const avg = (rs) => (rs.length ? rs.reduce((s, r) => s + r.kwh, 0) / rs.length : 0);
const baseline = avg(before);
const observed = avg(after);
const lossKwh = round2(Math.max(0, baseline - observed) * after.length);
const lossAmount = round2(lossKwh * Number(d.tariff_rate_per_kwh ?? 0));

if (d.meter_id && d.meter_id !== req.meter_id) reasons.push('premise ' + req.premise_id + ' now has meter ' + d.meter_id + ', not ' + req.meter_id);
if (rec === 'hold_for_review') reasons.push('agent asks for review');
if (d.open_investigation_id) reasons.push('investigation ' + d.open_investigation_id + ' is already open at this premise');

if (rec === 'open_investigation') {
  const cited = out.evidence_event_ids ?? [];
  if (!cited.length) reasons.push('case cites no meter events');
  const unknown = cited.filter((id) => !eventIds.has(id));
  if (unknown.length) reasons.push('case cites meter events the system does not return: ' + unknown.join(', '));
  if (!start || Number.isNaN(startMs)) reasons.push('case has no anomaly start date');
  if (!before.length || !after.length) reasons.push('not enough actual reads either side of ' + start + ' to estimate a loss');
  if (!(Number(d.tariff_rate_per_kwh) > 0)) reasons.push('no tariff rate on the account');
  const diff = Math.abs(Number(out.estimated_loss_kwh) - lossKwh);
  if (diff > Math.max(1, lossKwh * cfg.loss_estimate_tolerance)) reasons.push('agent estimated ' + out.estimated_loss_kwh + ' kWh, meter data gives ' + lossKwh + ' kWh');
  if (lossAmount < cfg.min_loss_amount) reasons.push('recomputed loss ' + lossAmount + ' is below the case threshold of ' + cfg.min_loss_amount);
  const text = String(out.case_summary ?? '').toLowerCase();
  const words = ${JSON.stringify(ACCUSATORY)}.filter((w) => text.includes(w));
  if (words.length) reasons.push('case summary uses accusatory language (' + words.join(', ') + '). Rewrite in terms of the meter data');
}

const medicalLine = medical ? ':warning: *MEDICAL BASELINE / LIFE SUPPORT premise.* Field staff must not disconnect or interrupt supply.\\n' : '';
const action = {
  type: 'field_investigation',
  candidate_id: req.candidate_id,
  premise_id: req.premise_id,
  meter_id: req.meter_id,
  medical_flag: medical,
  anomaly_type: out?.anomaly_type ?? null,
  anomaly_start: start,
  evidence_event_ids: out?.evidence_event_ids ?? [],
  baseline_kwh_per_day: round2(baseline),
  observed_kwh_per_day: round2(observed),
  estimated_loss_kwh: lossKwh,
  estimated_loss_amount: lossAmount,
  case_summary: out?.case_summary ?? '',
  customer_contact: false,
};
const summary = medicalLine
  + 'Candidate ' + req.candidate_id + ' · premise ' + req.premise_id + ' · meter ' + req.meter_id + ' (' + req.rule + ')\\n'
  + 'Meter data: ' + action.anomaly_type + ' from ' + start + '. ' + action.evidence_event_ids.length + ' meter events cited.\\n'
  + 'Daily kWh ' + action.baseline_kwh_per_day + ' before, ' + action.observed_kwh_per_day + ' since. Estimated unbilled ' + lossKwh + ' kWh, ' + lossAmount + ' (recomputed).\\n'
  + 'Proposed: field investigation. No customer contact.\\n' + (out?.rationale ?? '');
`,
  act: {
    write: {
      name: 'Create field investigation',
      method: 'POST',
      url: `={{ $('Config').first().json.gateway_url }}/rp/investigations`,
      headers: { 'Idempotency-Key': `=rp-{{ $('Guardrails').item.json.action.candidate_id }}` },
      json: `={{ JSON.stringify({ ...$('Guardrails').item.json.action, approved_by: $('Record approval').item.json.approver, source: 'aelix-cx-revenue-protection-agent' }) }}`,
    },
    readBack: {
      name: 'Read back candidate',
      url: `={{ $('Config').first().json.gateway_url }}/rp/sweeps/candidates/{{ $('Guardrails').item.json.action.candidate_id }}`,
    },
    verify: `
const inv = $json.investigation ?? {};
const ok = $json.status === 'dispatched' && inv.premise_id === planned.premise_id && inv.type === 'field_investigation'
  && inv.medical_flag === planned.medical_flag && inv.customer_contact !== true;
const detail = 'candidate shows ' + $json.status + ', investigation ' + JSON.stringify({ premise_id: inv.premise_id, type: inv.type, medical_flag: inv.medical_flag, customer_contact: inv.customer_contact })
  + '; expected dispatched field_investigation at ' + planned.premise_id + ' with medical_flag ' + planned.medical_flag + ' and no customer contact';
`,
  },
  handoffSummary: `'Candidate ' + intake.candidate_id + ' · premise ' + intake.premise_id + ' · ' + intake.rule + ' · proposed ' + (agent?.output?.recommendation ?? 'none')`,
  stickies: {
    intake: 'Every two hours, new candidates from the meter-data sweeps are pulled and handled one at a time. **Config** holds the baseline window, the case threshold, the estimate tolerance and the named operator.',
    plan: 'Claude reads meter events, daily consumption, the account, similar premises and prior investigations, rules out ordinary explanations, and assembles a neutral case. Effort is **medium**: high volume, bounded reasoning.',
    guard: 'Case data is **re-read**. Every cited meter event must be in the fresh read. **Estimated loss is recomputed in code** from actual daily reads and the tariff. Accusatory wording, an open investigation, or a loss below the threshold stops the case. **Medical-baseline and life-support flags come from the fresh read** and head the approval. "No case" is recorded as no action.',
    act: 'After approval: one idempotent call creates the field investigation, carrying the medical flag and **no customer contact**. The candidate is read back; it counts only if it shows that dispatch.',
  },
  setup: [
    '**Gateway contract**: sweep candidates (list, read), mdm meter events, daily reads and peer consumption, cis premises, prior investigations, a combined case-data read (events, daily reads, flags, tariff, open investigation) and investigations (create). Map to your CIS and MDM (SAP IS-U, Oracle CC&B, Itron or Siemens EnergyIP) and your field work system.',
    'Agree the case wording rules and **min_loss_amount** with the revenue protection lead and legal team before going live.',
  ],
});
