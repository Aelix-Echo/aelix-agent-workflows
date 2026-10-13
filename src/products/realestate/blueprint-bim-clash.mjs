// Aelix Blueprint · BIM Agent
// Catalogue: "Ranks clashes and drafts assignments. Nothing is pushed until the coordinator signs off."
// Pattern: approve. The BIM coordinator signs off before any issue is pushed to the coordination platform.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

const DISCIPLINES = ['architectural', 'structural', 'mechanical', 'electrical', 'plumbing', 'fire_protection', 'civil', 'other'];

export const sample = {
  project_id: 'PRJ-HUDSON-YARD-B',
  clash_test_id: 'CT-L04-MEP-VS-STR',
  run_id: 'RUN-2026-10-13-0612',
  test_name: 'Level 4 MEP vs structure',
  model_version: 'federated-v57',
  ran_at: '2026-10-13T06:12:00Z',
  clash_count: 143,
};

export default () => productAgent({
  industry: 'Real Estate and Construction',
  product: 'Aelix Blueprint',
  agent: 'BIM Agent',
  slug: 'realestate-blueprint-bim-clash',
  dir: 'realestate',
  file: 'blueprint-bim-clash',
  mode: 'approve',
  job: 'take clash triage off the BIM coordination desk. After each clash test run, rank the clashes that matter, work out which element should move, and draft an issue assigned to the trade responsible for that element.',
  approves: 'the BIM coordinator signs off every batch of issues before anything is pushed to the coordination platform',
  never: [
    'Pushes an issue without the BIM coordinator clicking Approve',
    'References a clash that is not in a fresh read of the clash test',
    'Assigns an issue to a trade other than the one the responsibility matrix names for that element\'s discipline',
    'Opens a duplicate of an issue that is already open',
    'Edits or moves model elements',
  ],
  team: 'BIM coordination',
  trigger: { kind: 'webhook', path: 'aelix/blueprint/bim-clash' },
  config: {
    gateway_url: 'https://blueprint-gateway.YOUR-COMPANY.example/api/v1',
    // A clash test older than this is stale for pushing issues: rerun it first.
    max_clash_test_age_hours: 24,
    max_issues_per_push: 25,
    min_confidence: 0.8,
    approver_slack_user: 'bim-coordinator',
    approval_timeout_hours: 24,
    slack_channel: '#bim-coordination',
  },
  intake: {
    name: 'Normalize clash test run',
    js: `
const b = $json.body ?? $json;
const missing = ['project_id', 'clash_test_id', 'run_id'].filter((k) => b[k] == null || b[k] === '');
if (missing.length) throw new Error('Clash test run event missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(b.clash_test_id) + ':' + String(b.run_id),
    project_id: String(b.project_id),
    clash_test_id: String(b.clash_test_id),
    run_id: String(b.run_id),
    test_name: String(b.test_name ?? '').slice(0, 200),
    model_version: String(b.model_version ?? ''),
    ran_at: b.ran_at ?? null,
    clash_count: Number(b.clash_count ?? 0),
  },
};
`,
  },
  agentSpec: {
    name: 'BIM clash agent',
    prompt: `=Clash test {{ $json.clash_test_id }} ({{ $json.test_name || 'unnamed' }}) on project {{ $json.project_id }}
Run {{ $json.run_id }} on model {{ $json.model_version || 'unknown' }} at {{ $json.ran_at ?? 'unknown' }} · {{ $json.clash_count }} clashes reported

Rank the clashes that need an issue, decide which element should move for each, and draft one issue per clash assigned to the responsible trade.`,
    system: `
You triage clash detection results for a BIM coordination team using Aelix Blueprint. You rank clashes, decide which element should move, and draft issues for the responsible trade. The BIM coordinator signs off every batch before anything is pushed. You never push issues or change the model.

How to triage:
- Read the clash test results for this run. Group repeats of the same physical problem (the same two elements, or one element clashing along its run) and draft one issue for the group, citing the clash id that best represents it.
- Skip clashes that are already resolved, approved as acceptable, or covered by an open issue (check the open issues list for the same clash id or the same pair of elements).
- For each remaining clash, read both elements. Decide which one should move: usually the more flexible system moves (small pipes and conduit before ductwork, ductwork before structure), unless element data says otherwise. Name that element as responsible_element_id.
- Look up the responsible trade for that element's discipline in the project's responsibility matrix and assign the issue to exactly that trade.
- Rank by impact: life safety and structure first, then clashes that block installation on the current schedule, then large systems, then the rest. Priority: critical, high, medium, low.
- Titles are short and factual (level, gridline, the two systems). Descriptions say what clashes, where, and the proposed resolution, using element ids from the tool results.

Tools:
- "Get clash test results", "Get model element", "Get responsibility matrix", "List open issues".
`,
    tools: [
      { name: 'Get clash test results', description: 'Get the latest results of a clash test: run id, run time, and each clash with id, status (new, active, reviewed, approved, resolved), the two element ids, distance, location (level, gridline, coordinates).', url: `={{ $('Config').first().json.gateway_url }}/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/clash-tests/{{ $fromAI('clash_test_id', 'Clash test id', 'string') }}/results` },
      { name: 'Get model element', description: 'Get one model element: discipline, category, system, size, level, host model and owner.', url: `={{ $('Config').first().json.gateway_url }}/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/elements/{{ $fromAI('element_id', 'Element id', 'string') }}` },
      { name: 'Get responsibility matrix', description: 'Get the project responsibility matrix: which trade is responsible for elements of each discipline (architectural, structural, mechanical, electrical, plumbing, fire_protection, civil).', url: `={{ $('Config').first().json.gateway_url }}/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/responsibility-matrix` },
      { name: 'List open issues', description: 'List open coordination issues on the project: issue id, linked clash id, linked element ids, assignee, status.', url: `={{ $('Config').first().json.gateway_url }}/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/issues`, query: { status: 'open' } },
    ],
    schema: S.obj({
      issues: S.arr(S.obj({
        clash_id: S.str('Clash id from the clash test results.'),
        rank: S.int('1 is the most important.'),
        priority: S.enum(['critical', 'high', 'medium', 'low'], 'Priority of the issue.'),
        responsible_element_id: S.str('The clashing element that should move.'),
        discipline: S.enum(DISCIPLINES, 'Discipline of the responsible element.'),
        assigned_trade: S.str('Trade the responsibility matrix names for that discipline.'),
        title: S.str('Short factual title.'),
        description: S.str('What clashes, where, and the proposed resolution.'),
      }), 'Issues to raise, one per distinct clash.'),
      skipped_count: S.int('Clashes you left out as repeats, resolved, approved or already covered.'),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read clash test and open issues',
    url: `={{ $('Config').first().json.gateway_url }}/projects/{{ $('Normalize clash test run').item.json.project_id }}/clash-tests/{{ $('Normalize clash test run').item.json.clash_test_id }}/coordination-snapshot`,
  },
  guard: `
const snap = $json; // fresh read: { clash_test: { run_id, ran_at, clashes }, open_issues, responsibility }
const ct = snap.clash_test ?? {};
const clashes = new Map((ct.clashes ?? []).map((c) => [c.clash_id, c]));
const open = snap.open_issues ?? [];
const matrix = snap.responsibility ?? {};
const pairKey = (a, b) => [String(a), String(b)].sort().join('|');
const ACTIVE = ['new', 'active', 'reviewed'];

// The clash test must be fresh enough to push issues from.
const ranAt = Date.parse(ct.ran_at);
const ageHours = (Date.now() - ranAt) / 3600000;
if (!Number.isFinite(ranAt)) reasons.push('clash test has no run time on re-read');
else if (ageHours > cfg.max_clash_test_age_hours) reasons.push('clash test last ran ' + ct.ran_at + ', more than ' + cfg.max_clash_test_age_hours + ' hours ago: rerun it before pushing issues');

const openClashIds = new Set(open.map((i) => i.clash_id).filter(Boolean));
const openPairs = new Set(open.filter((i) => (i.element_ids ?? []).length === 2).map((i) => pairKey(i.element_ids[0], i.element_ids[1])));
const seenPairs = new Set();
const topics = [];
const dropped = [];

for (const it of out?.issues ?? []) {
  const c = clashes.get(it.clash_id);
  if (!c) { reasons.push('clash ' + it.clash_id + ' is not in the fresh clash test read'); continue; }
  const ea = c.element_a ?? {};
  const eb = c.element_b ?? {};
  const pk = pairKey(ea.element_id, eb.element_id);
  // Duplicates and closed clashes are dropped, not escalated.
  if (!ACTIVE.includes(c.status)) { dropped.push({ clash_id: it.clash_id, reason: 'clash is ' + c.status }); continue; }
  if (openClashIds.has(it.clash_id) || openPairs.has(pk)) { dropped.push({ clash_id: it.clash_id, reason: 'already has an open issue' }); continue; }
  if (seenPairs.has(pk)) { dropped.push({ clash_id: it.clash_id, reason: 'same elements as another issue in this batch' }); continue; }
  seenPairs.add(pk);
  const el = [ea, eb].find((e) => e.element_id === it.responsible_element_id);
  if (!el) { reasons.push('clash ' + it.clash_id + ': responsible element ' + it.responsible_element_id + ' is not one of its two elements'); continue; }
  const trade = matrix[el.discipline];
  if (!trade) { reasons.push('clash ' + it.clash_id + ': the responsibility matrix has no trade for ' + el.discipline); continue; }
  if (it.assigned_trade !== trade) { reasons.push('clash ' + it.clash_id + ': assigned to ' + it.assigned_trade + ' but ' + el.discipline + ' elements belong to ' + trade); continue; }
  if (!String(it.title ?? '').trim()) { reasons.push('clash ' + it.clash_id + ': issue has no title'); continue; }
  topics.push({
    clash_id: it.clash_id, rank: Number(it.rank), priority: it.priority,
    responsible_element_id: el.element_id, discipline: el.discipline, assigned_trade: trade,
    element_ids: [ea.element_id, eb.element_id], location: c.location ?? null,
    title: it.title, description: it.description,
  });
}
topics.sort((a, b) => a.rank - b.rank);
topics.forEach((t, i) => { t.rank = i + 1; });
if (topics.length > cfg.max_issues_per_push) reasons.push(topics.length + ' issues exceeds the ' + cfg.max_issues_per_push + ' per push limit: split the batch');

// Nothing left after dropping duplicates and closed clashes: recorded, not escalated.
const noop = out !== null && topics.length === 0;

const action = {
  type: 'push_bcf_topics',
  project_id: req.project_id,
  clash_test_id: req.clash_test_id,
  run_id: ct.run_id ?? req.run_id,
  topics,
  dropped,
};
const summary = 'Clash test ' + req.clash_test_id + ' (' + (req.test_name || 'unnamed') + ') run ' + action.run_id + ' on project ' + req.project_id + '\\n'
  + topics.length + ' issues to push, ' + dropped.length + ' dropped as duplicates or closed, ' + (out?.skipped_count ?? 0) + ' clashes left out by the agent.\\n'
  + topics.slice(0, 10).map((t) => t.rank + '. [' + t.priority + '] ' + t.clash_id + ' to ' + t.assigned_trade + ': ' + t.title).join('\\n')
  + (topics.length > 10 ? '\\n(and ' + (topics.length - 10) + ' more in the audit log)' : '') + '\\n' + (out?.rationale ?? '');
`,
  act: {
    write: {
      name: 'Push BCF topics',
      method: 'POST',
      url: `={{ $('Config').first().json.gateway_url }}/projects/{{ $('Guardrails').item.json.action.project_id }}/coordination/bcf-topics`,
      headers: { 'Idempotency-Key': `=bim-{{ $('Guardrails').item.json.action.clash_test_id }}-{{ $('Guardrails').item.json.action.run_id }}` },
      json: `={{ JSON.stringify({ clash_test_id: $('Guardrails').item.json.action.clash_test_id, run_id: $('Guardrails').item.json.action.run_id, topics: $('Guardrails').item.json.action.topics, approved_by: $('Record approval').item.json.approver, source: 'aelix-blueprint-bim-agent' }) }}`,
    },
    readBack: {
      name: 'Read back BCF topics',
      url: `={{ $('Config').first().json.gateway_url }}/projects/{{ $('Guardrails').item.json.action.project_id }}/coordination/bcf-topics`,
      query: { clash_test_id: `={{ $('Guardrails').item.json.action.clash_test_id }}`, run_id: `={{ $('Guardrails').item.json.action.run_id }}` },
    },
    verify: `
const got = new Map(($json.topics ?? []).map((t) => [t.clash_id, t]));
const missing = planned.topics.filter((t) => !got.has(t.clash_id)).map((t) => t.clash_id);
const wrong = planned.topics.filter((t) => got.has(t.clash_id) && got.get(t.clash_id).assigned_trade !== t.assigned_trade).map((t) => t.clash_id);
const ok = planned.topics.length > 0 && missing.length === 0 && wrong.length === 0;
const detail = 'platform shows ' + got.size + ' topics for this run; missing ' + (missing.join(', ') || 'none') + '; wrong assignee on ' + (wrong.join(', ') || 'none');
`,
  },
  handoffSummary: `'Clash test ' + intake.clash_test_id + ' run ' + intake.run_id + ' · project ' + intake.project_id + ' · ' + (agent?.output?.issues?.length ?? 0) + ' issues proposed'`,
  stickies: {
    intake: 'The model coordination platform posts each completed clash test run: project, test, run id, model version. **Config** holds the freshness limit, the batch size limit and the named BIM coordinator.',
    plan: 'Claude reads the clash results, both elements of each clash, the responsibility matrix and open issues. It groups repeats, decides which element should move, ranks by impact and drafts one issue per clash for the responsible trade.',
    guard: 'The clash test, open issues and responsibility matrix are **re-read** in one snapshot. Code checks the test is **fresh**, every clash the agent cites **exists** in that read, the responsible element is one of the two clashing elements, and the assignee is **the trade the matrix names** for its discipline. **Duplicates** of open issues, repeats within the batch and closed clashes are dropped. If nothing is left, the run is recorded as no action.',
    act: 'After sign-off: the batch is pushed as BCF topics in one idempotent call, then read back. It counts only if every approved clash shows up with the approved assignee.',
  },
  setup: [
    '**Gateway contract**: clash tests (results, coordination-snapshot with clash test, open issues and responsibility matrix in one read), model elements, responsibility matrix, issues, BCF topics (push, list by run). Map to your coordination platform (Autodesk Construction Cloud, Revizto, Navisworks with a BCF server, Procore).',
    'Keep the **responsibility matrix** current per project: assignments come only from it.',
  ],
});
