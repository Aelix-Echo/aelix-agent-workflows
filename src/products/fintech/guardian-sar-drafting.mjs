// Aelix Guardian · SAR Drafting Agent
// Catalogue: "Drafts the SAR narrative and maps FinCEN fields. The BSA officer signs; it never files."
// Pattern: draft. Nothing is filed or sent; the draft goes to the named BSA officer.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

export const sample = {
  case_id: 'AML-2026-04417',
  decision: 'file',
  decided_by: 'aml-investigator-3',
  detected_on: '2026-10-06',
};

export default () => productAgent({
  industry: 'FinTech',
  product: 'Aelix Guardian',
  agent: 'SAR Drafting Agent',
  slug: 'fintech-guardian-sar-drafting',
  dir: 'fintech',
  file: 'guardian-sar-drafting',
  mode: 'draft',
  job: 'take the first draft of a Suspicious Activity Report off the BSA desk. When an investigation is decided as "file", assemble the facts, write the narrative and map the FinCEN SAR fields, ready for the BSA officer to edit and sign.',
  approves: 'the BSA officer edits, signs and files every SAR',
  never: [
    'Files a SAR or contacts FinCEN',
    'Contacts the subject or anyone outside the BSA team (no tipping off)',
    'Puts the subject\'s name or account details in Slack',
  ],
  team: 'BSA compliance',
  trigger: { kind: 'webhook', path: 'aelix/guardian/sar-drafting' },
  config: {
    gateway_url: 'https://guardian-gateway.YOUR-BANK.example/api/v1',
    filing_days_from_detection: 30,
    // Check the current BSA E-Filing narrative limit before relying on this number.
    max_narrative_chars: 17000,
    min_confidence: 0.75,
    reviewer_slack_user: 'bsa-officer',
    slack_channel: '#bsa-drafts',
  },
  intake: {
    name: 'Normalize case decision',
    js: `
const b = $json.body ?? $json;
if (!b.case_id) throw new Error('SAR request missing case_id');
if (b.decision !== 'file') throw new Error('SAR drafting runs only on cases decided as file, got ' + b.decision);
if (!b.detected_on) throw new Error('SAR request missing detected_on');
return {
  json: {
    business_key: String(b.case_id),
    case_id: String(b.case_id),
    decided_by: String(b.decided_by ?? ''),
    detected_on: String(b.detected_on).slice(0, 10),
  },
};
`,
  },
  agentSpec: {
    name: 'SAR drafting agent',
    prompt: `=Investigation case {{ $json.case_id }} was decided as "file" by {{ $json.decided_by || 'an investigator' }}.
Suspicious activity first detected on {{ $json.detected_on }}.

Draft the SAR narrative and map the FinCEN SAR fields from the case record.`,
    system: `
You draft Suspicious Activity Reports for a bank's BSA team using Aelix Guardian. You write the first draft only. The BSA officer edits, decides, signs and files. You never file and you never contact anyone.

The narrative:
- Follow the who, what, when, where, why and how structure. Open with a one-paragraph summary of the activity and why it is suspicious.
- Use only facts in the case record, the alerts and the transactions. Every amount and date must come from a record. Name the record ids you relied on in the rationale.
- Describe what the subject did, not conclusions about guilt. Do not speculate about crimes the records do not support.
- Keep it under the character limit in the request context.

The FinCEN fields: suspicious activity categories and subtypes, the activity date range, the total amount involved, subject type, and the instruments or products involved. If a field cannot be supported by the records, leave it empty and list it in missing_information.

Tools:
- "Get case", "List case transactions", "Get subject profile", "List prior SARs for subject".
`,
    tools: [
      { name: 'Get case', description: 'Get an AML investigation case: alerts, investigator notes, decision, detection date.', url: `={{ $('Config').first().json.gateway_url }}/cases/{{ $fromAI('case_id', 'Case id', 'string') }}` },
      { name: 'List case transactions', description: 'List the transactions flagged in a case: id, date, amount, direction, counterparty, channel.', url: `={{ $('Config').first().json.gateway_url }}/cases/{{ $fromAI('case_id', 'Case id', 'string') }}/transactions` },
      { name: 'Get subject profile', description: 'Get the KYC profile of the case subject: type, occupation or business, onboarding date, expected activity, risk rating.', url: `={{ $('Config').first().json.gateway_url }}/cases/{{ $fromAI('case_id', 'Case id', 'string') }}/subject` },
      { name: 'List prior SARs for subject', description: 'List SARs previously filed on the case subject: filing date, BSA id, date range, categories.', url: `={{ $('Config').first().json.gateway_url }}/cases/{{ $fromAI('case_id', 'Case id', 'string') }}/prior-sars` },
    ],
    schema: S.obj({
      narrative: S.str('The SAR narrative draft.'),
      categories: S.arr(S.obj({ category: S.str('FinCEN suspicious activity category.'), subtype: S.str('Subtype.') }), 'Suspicious activity categories.'),
      activity_from: S.str('ISO date of the first suspicious transaction.'),
      activity_to: S.str('ISO date of the last suspicious transaction.'),
      amount_involved: S.num('Total amount involved, from the flagged transactions.'),
      subject_type: S.enum(['individual', 'entity', 'unknown'], 'Subject type.'),
      instruments: S.arr(S.str(), 'Instruments or products involved.'),
      continuing_activity: S.bool('Prior SARs exist on this subject for related activity.'),
      missing_information: S.arr(S.str(), 'Fields or facts the records could not support.'),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read case transactions',
    url: `={{ $('Config').first().json.gateway_url }}/cases/{{ $('Normalize case decision').item.json.case_id }}/transactions`,
  },
  guard: `
const txns = $json.transactions ?? [];
const total = Math.round(txns.reduce((sum, t) => sum + Number(t.amount ?? 0), 0) * 100) / 100;
const dates = txns.map((t) => String(t.date).slice(0, 10)).sort();
const deadline = new Date(Date.parse(req.detected_on) + cfg.filing_days_from_detection * 86400000).toISOString().slice(0, 10);

if (!txns.length) reasons.push('case has no flagged transactions');
if (out) {
  if (Math.abs(Number(out.amount_involved) - total) > 0.01) reasons.push('draft amount ' + out.amount_involved + ' differs from flagged transactions ' + total);
  if (dates.length && (out.activity_from !== dates[0] || out.activity_to !== dates[dates.length - 1])) reasons.push('draft date range ' + out.activity_from + ' to ' + out.activity_to + ' differs from transactions ' + dates[0] + ' to ' + dates[dates.length - 1]);
  if (!out.narrative || out.narrative.length < 200) reasons.push('narrative missing or too short');
  if (out.narrative && out.narrative.length > cfg.max_narrative_chars) reasons.push('narrative ' + out.narrative.length + ' chars exceeds ' + cfg.max_narrative_chars);
  if (!(out.categories ?? []).length) reasons.push('no suspicious activity category');
}

// Missing facts do not stop the draft; they travel with it for the officer.
const draft = {
  case_id: req.case_id,
  filing_deadline: deadline,
  narrative: out?.narrative ?? '',
  fields: { categories: out?.categories ?? [], activity_from: out?.activity_from, activity_to: out?.activity_to, amount_involved: total, subject_type: out?.subject_type, instruments: out?.instruments ?? [], continuing_activity: !!out?.continuing_activity },
  missing_information: out?.missing_information ?? [],
  flagged_transaction_ids: txns.map((t) => t.id),
};
// Case id and deadline only: Slack never carries subject details.
const summary = 'Case ' + req.case_id + ' · filing deadline ' + deadline + ' · ' + txns.length + ' flagged transactions'
  + (draft.missing_information.length ? ' · ' + draft.missing_information.length + ' facts still missing' : '');
`,
  handoffSummary: `'Case ' + intake.case_id + ' · SAR draft could not be prepared'`,
  stickies: {
    intake: 'The case management system posts each investigation decided as **file**, with the detection date. **Config** holds the filing window, the narrative limit and the named BSA officer.',
    plan: 'Claude reads the case, flagged transactions, subject profile and prior SARs, writes the narrative (who, what, when, where, why, how) and maps the FinCEN fields, listing anything the records cannot support.',
    guard: 'Flagged transactions are **re-read**. The total amount and date range are **recomputed in code** and must match the draft. The filing deadline is computed from the detection date, not by the model.',
    act: 'The draft is saved to **agent_drafts** and the named BSA officer gets a direct message with the case id and deadline only. **Nothing is filed. No subject details go to Slack.**',
  },
  setup: [
    '**Gateway contract**: cases, case transactions, subject profile, prior SARs. Map to your case manager (Actimize, Verafin, SAS AML, Hummingbird).',
    'Restrict access to **agent_drafts** and **agent_runs** to the BSA team: SAR existence is confidential.',
  ],
});
