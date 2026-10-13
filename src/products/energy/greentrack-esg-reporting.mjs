// Aelix GreenTrack · ESG Reporting Agent
// Catalogue: "Assembles Scope 1, 2 and 3 data with lineage and drafts the disclosure package. Signing stays gated."
// Pattern: draft. The package goes to the named sustainability reporting lead; nothing is filed or signed.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

const SCOPES = ['scope_1', 'scope_2_location', 'scope_2_market', 'scope_3'];

export const sample = {
  request_id: 'ESG-2026-FY-0007',
  reporting_entity_id: 'ENT-IPP-HOLDCO',
  period: 'FY2026',
  frameworks: ['SEC', 'CSRD'],
  requested_by: 'sustainability-reporting-lead',
};

export default () => productAgent({
  industry: 'Energy and Utilities',
  product: 'Aelix GreenTrack',
  agent: 'ESG Reporting Agent',
  slug: 'energy-greentrack-esg-reporting',
  dir: 'energy',
  file: 'greentrack-esg-reporting',
  mode: 'draft',
  job: 'take the assembly of greenhouse gas disclosures off the sustainability reporting team of a utility-scale IPP. Gather Scope 1, 2 and 3 emissions from the ESG data platform with lineage to every source record, and draft the disclosure package for the reporting lead to review, assure and sign.',
  approves: 'the sustainability reporting lead reviews the package; signing and filing stay with the people accountable for them',
  never: [
    'Files, submits or signs a disclosure',
    'Reports a figure without lineage to source records',
    'Reports a total that has not been recomputed from the source rows',
    'Mixes reporting periods or emission factor versions',
    'States what a regulation requires as settled fact',
  ],
  team: 'sustainability reporting',
  trigger: { kind: 'webhook', path: 'aelix/greentrack/esg-reporting' },
  config: {
    gateway_url: 'https://greentrack-gateway.YOUR-IPP.example/api/v1',
    // The emission factor set the reporting lead has approved for this cycle.
    approved_factor_set_version: 'EF-2026.1',
    rounding_tolerance_tco2e: 0.5,
    min_confidence: 0.8,
    reviewer_slack_user: 'sustainability-reporting-lead',
    slack_channel: '#esg-reporting',
  },
  intake: {
    name: 'Normalize reporting request',
    js: `
const b = $json.body ?? $json;
const missing = ['request_id', 'reporting_entity_id', 'period'].filter((k) => b[k] == null || b[k] === '');
if (missing.length) throw new Error('ESG reporting request missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(b.request_id),
    request_id: String(b.request_id),
    reporting_entity_id: String(b.reporting_entity_id),
    period: String(b.period),
    frameworks: (Array.isArray(b.frameworks) ? b.frameworks : []).map((f) => String(f).toUpperCase()).filter((f) => ['SEC', 'CSRD'].includes(f)),
    requested_by: String(b.requested_by ?? ''),
  },
};
`,
  },
  agentSpec: {
    name: 'ESG reporting agent',
    prompt: `=Disclosure request {{ $json.request_id }} for entity {{ $json.reporting_entity_id }}
Reporting period: {{ $json.period }} · Frameworks in view: {{ $json.frameworks.join(', ') || 'not given' }}

Assemble Scope 1, 2 and 3 emissions with lineage to source records and draft the disclosure package.`,
    system: `
You assemble greenhouse gas disclosure packages for a utility-scale independent power producer on Aelix GreenTrack. You gather emissions data, keep lineage to every source record and draft the disclosure text. The sustainability reporting lead reviews the package. Signing, assurance and filing stay with people.

How to assemble:
- Read the reporting boundary for the period: entities, facilities, consolidation approach.
- List the emissions source rows for each scope: scope_1 (stationary and mobile combustion, SF6 and other fugitive releases), scope_2_location and scope_2_market (purchased electricity, including station auxiliary load drawn from the grid), scope_3 (by category).
- Every row carries a record id, scope, category, tCO2e, period and emission factor version. Use only rows for the requested period and the approved factor set version. Flag any row that does not match in missing_information instead of using it.
- figures: one entry per scope and category. tco2e is the sum of the rows listed in source_record_ids. Every row belongs to exactly one figure.
- totals: the sum of figures for each scope.
- Read data quality issues and the prior period's disclosure. Explain material changes from the prior period in methodology_notes.

The draft text:
- Write plain, factual sections: boundary and approach, emissions by scope, methodology and factors, data quality and estimates, changes from the prior period.
- Refer to SEC and CSRD in general terms (for example "prepared with the SEC climate disclosure and CSRD ESRS E1 structure in view"). Do not state what either regime currently requires, which entities are in scope, or deadlines. Those are for the reporting lead and counsel to confirm.
- Do not add targets, commitments or claims that are not in the records.

Tools:
- "Get reporting boundary", "List emissions source rows", "Get emission factor set", "List data quality issues", "Get prior period disclosure".
`,
    tools: [
      { name: 'Get reporting boundary', description: 'Get the reporting boundary for an entity and period from the ESG data platform: entities, facilities, ownership share, consolidation approach.', url: `={{ $('Config').first().json.gateway_url }}/esg/entities/{{ $fromAI('entity_id', 'Reporting entity id', 'string') }}/boundary`, query: { period: `={{ $fromAI('period', 'Reporting period', 'string') }}` } },
      { name: 'List emissions source rows', description: 'List emissions source rows for an entity, period and scope: record id, scope, category, facility, activity data, unit, emission factor id and version, tCO2e, period, source system.', url: `={{ $('Config').first().json.gateway_url }}/esg/entities/{{ $fromAI('entity_id', 'Reporting entity id', 'string') }}/emissions-rows`, query: { period: `={{ $fromAI('period', 'Reporting period', 'string') }}`, scope: `={{ $fromAI('scope', 'scope_1, scope_2_location, scope_2_market or scope_3', 'string') }}` } },
      { name: 'Get emission factor set', description: 'Get an emission factor set by version: factors, sources and publication dates.', url: `={{ $('Config').first().json.gateway_url }}/esg/emission-factors/{{ $fromAI('version', 'Factor set version', 'string') }}` },
      { name: 'List data quality issues', description: 'List open and resolved data quality issues for an entity and period: record ids affected, issue, estimate method used.', url: `={{ $('Config').first().json.gateway_url }}/esg/entities/{{ $fromAI('entity_id', 'Reporting entity id', 'string') }}/dq-issues`, query: { period: `={{ $fromAI('period', 'Reporting period', 'string') }}` } },
      { name: 'Get prior period disclosure', description: 'Get the disclosure filed for the prior period: totals by scope, methodology notes, factor set version.', url: `={{ $('Config').first().json.gateway_url }}/esg/entities/{{ $fromAI('entity_id', 'Reporting entity id', 'string') }}/disclosures/prior`, query: { period: `={{ $fromAI('period', 'Current reporting period', 'string') }}` } },
    ],
    schema: S.obj({
      period: S.str('Reporting period the figures cover.'),
      factor_set_version: S.str('Emission factor set version used.'),
      figures: S.arr(S.obj({
        scope: S.enum(SCOPES, 'Scope.'),
        category: S.str('Category within the scope.'),
        tco2e: S.num('Sum of the source rows, tCO2e.'),
        source_record_ids: S.arr(S.str(), 'Source row record ids behind this figure.'),
      }), 'Reported figures with lineage.'),
      totals: S.obj({
        scope_1: S.num('tCO2e.'), scope_2_location: S.num('tCO2e.'), scope_2_market: S.num('tCO2e.'), scope_3: S.num('tCO2e.'),
      }),
      sections: S.arr(S.obj({ heading: S.str('Section heading.'), text: S.str('Section text.') }), 'Draft disclosure sections.'),
      methodology_notes: S.str('Boundary, factors, estimates and changes from the prior period.'),
      missing_information: S.arr(S.str(), 'Data the records could not support, rows excluded and why.'),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read source rows',
    url: `={{ $('Config').first().json.gateway_url }}/esg/entities/{{ $('Normalize reporting request').item.json.reporting_entity_id }}/emissions-rows`,
    query: { period: `={{ $('Normalize reporting request').item.json.period }}`, scope: 'all' },
  },
  guard: `
const rows = $json.rows ?? []; // fresh source rows for the entity and period, all scopes
const SCOPES = ${JSON.stringify(SCOPES)};
const r2 = (n) => Math.round(n * 100) / 100;
const tol = cfg.rounding_tolerance_tco2e;
const byId = new Map(rows.map((r) => [r.record_id, r]));
const figures = out?.figures ?? [];

if (!rows.length) reasons.push('no source rows for ' + req.reporting_entity_id + ' in ' + req.period);

// Period and emission factor version.
if (out && out.period !== req.period) reasons.push('draft covers ' + out.period + ', request is for ' + req.period);
if (out && out.factor_set_version !== cfg.approved_factor_set_version) reasons.push('draft uses factor set ' + out.factor_set_version + ', approved set is ' + cfg.approved_factor_set_version);
const wrongPeriod = rows.filter((r) => r.period !== req.period).map((r) => r.record_id);
if (wrongPeriod.length) reasons.push(wrongPeriod.length + ' source rows are from another period: ' + wrongPeriod.slice(0, 10).join(', '));
const wrongFactor = rows.filter((r) => r.factor_version !== cfg.approved_factor_set_version).map((r) => r.record_id);
if (wrongFactor.length) reasons.push(wrongFactor.length + ' source rows use a factor set other than ' + cfg.approved_factor_set_version + ': ' + wrongFactor.slice(0, 10).join(', '));

// Lineage: every figure traces to real rows of its scope and equals their sum; no row used twice or left out.
const used = new Map();
for (const f of figures) {
  const ids = f.source_record_ids ?? [];
  if (!ids.length) { reasons.push(f.scope + ' ' + f.category + ' has no lineage to source records'); continue; }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) reasons.push(f.scope + ' ' + f.category + ' cites records not in the source: ' + missing.join(', '));
  const wrongScope = ids.filter((id) => byId.has(id) && byId.get(id).scope !== f.scope);
  if (wrongScope.length) reasons.push(f.scope + ' ' + f.category + ' cites rows from another scope: ' + wrongScope.join(', '));
  const sum = r2(ids.filter((id) => byId.has(id)).reduce((s, id) => s + Number(byId.get(id).tco2e ?? 0), 0));
  if (Math.abs(sum - Number(f.tco2e)) > tol) reasons.push(f.scope + ' ' + f.category + ' reports ' + f.tco2e + ' tCO2e, its source rows sum to ' + sum);
  for (const id of ids) used.set(id, (used.get(id) ?? 0) + 1);
}
const twice = [...used].filter(([, n]) => n > 1).map(([id]) => id);
if (twice.length) reasons.push('source rows counted in more than one figure: ' + twice.join(', '));
const unused = rows.filter((r) => !used.has(r.record_id)).map((r) => r.record_id);
if (out && unused.length) reasons.push(unused.length + ' source rows are in no reported figure: ' + unused.slice(0, 10).join(', '));

// Totals by scope, recomputed from the source rows.
const totals = {};
for (const s of SCOPES) totals[s] = r2(rows.filter((r) => r.scope === s).reduce((acc, r) => acc + Number(r.tco2e ?? 0), 0));
if (out) for (const s of SCOPES) if (Math.abs(Number(out.totals?.[s] ?? 0) - totals[s]) > tol) reasons.push(s + ' total ' + out.totals?.[s] + ' tCO2e differs from source rows ' + totals[s]);
if (out && !(out.sections ?? []).length) reasons.push('no draft disclosure text');

const draft = {
  status: 'draft_not_filed_not_signed',
  request_id: req.request_id,
  reporting_entity_id: req.reporting_entity_id,
  period: req.period,
  frameworks: req.frameworks,
  factor_set_version: cfg.approved_factor_set_version,
  totals_tco2e: totals,
  figures: figures.map((f) => ({ ...f, source_records: (f.source_record_ids ?? []).map((id) => ({ record_id: id, source_system: byId.get(id)?.source_system ?? null, tco2e: byId.get(id)?.tco2e ?? null })) })),
  sections: out?.sections ?? [],
  methodology_notes: out?.methodology_notes ?? '',
  missing_information: out?.missing_information ?? [],
  legal_note: 'Framework references are general. Confirm current SEC and CSRD obligations with counsel before relying on this package.',
};
const summary = 'Entity ' + req.reporting_entity_id + ' · ' + req.period + ' · factor set ' + cfg.approved_factor_set_version + '\\n'
  + 'Scope 1: ' + totals.scope_1 + ' tCO2e · Scope 2 (location): ' + totals.scope_2_location + ' · Scope 2 (market): ' + totals.scope_2_market + ' · Scope 3: ' + totals.scope_3 + '\\n'
  + figures.length + ' figures traced to ' + rows.length + ' source rows. Totals recomputed from source.'
  + (draft.missing_information.length ? '\\n' + draft.missing_information.length + ' items still open.' : '')
  + '\\nNothing has been filed or signed.';
`,
  handoffSummary: `'ESG package ' + intake.request_id + ' · ' + intake.reporting_entity_id + ' · ' + intake.period + ' · could not be assembled'`,
  stickies: {
    intake: 'The reporting calendar or the reporting lead posts a request: entity, period and the frameworks in view. **Config** holds the approved emission factor set, the rounding tolerance and the named reporting lead.',
    plan: 'Claude reads the reporting boundary, emissions source rows for each scope, the factor set, data quality issues and the prior disclosure. It builds figures with lineage to every source record, and drafts plain disclosure sections that refer to SEC and CSRD in general terms only.',
    guard: 'Source rows are **re-read**. Totals by scope are **recomputed in code** from the rows. Every figure must trace to rows of its own scope and equal their sum; no row may be counted twice or left out. The reporting period and the **emission factor set version** must match on the draft and on every row.',
    act: 'The package is saved to **agent_drafts** and the named sustainability reporting lead gets a direct message with totals only. **Nothing is filed, submitted or signed.**',
  },
  setup: [
    '**Gateway contract**: esg entities boundary, emissions rows (by scope and all scopes), emission factor sets, data quality issues, prior disclosures. Map to your ESG data platform (Workiva, Persefoni, Watershed, Sphera or similar) and its links to plant historians, fuel and procurement records.',
    'Set **approved_factor_set_version** each reporting cycle with the reporting lead.',
    'Framework references in the draft are general. **Confirm current SEC and CSRD obligations with counsel**; requirements and timing have changed and may change again.',
  ],
});
