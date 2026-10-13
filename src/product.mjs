// Builder for the product agent workflows (the 38 agents in the agent catalogue).
//
// Each product agent is one spec: intake, a read-only Claude agent, deterministic
// guardrails, and one of three ways to finish:
//
//   approve   the agent drafts an action, a named person approves it in Slack,
//             then the workflow acts and reads the result back
//   envelope  inside a pre-approved envelope the workflow acts on its own;
//             outside it, it asks the named approver first
//   draft     nothing is written anywhere; the draft goes to a named reviewer
//
// Every stop goes to the shared hand-off, and every run ends in the audit log.

import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble, uid,
  webhook, schedule, config, code, http, splitOut, switchOn, ifTrue, setFields, postgres,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from './lib.mjs';

export { S, COMMON_OUTPUT, SYSTEM_TAIL };

const GAP = 220;

// Slack message that pauses the run until the named approver clicks Approve or Decline.
export function slackApproval(name, position, { user, message, timeoutHours }) {
  return {
    parameters: {
      resource: 'message',
      operation: 'sendAndWait',
      select: 'user',
      user: { __rl: true, value: user, mode: 'username' },
      message,
      responseType: 'approval',
      approvalOptions: { values: { approvalType: 'double', approveLabel: 'Approve', disapproveLabel: 'Decline' } },
      options: {
        limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: timeoutHours, resumeUnit: 'hours' } },
        appendAttribution: false,
      },
    },
    type: 'n8n-nodes-base.slack',
    typeVersion: 2.7,
    position,
    name,
    webhookId: uid(`approval:${name}:${position.join(',')}`),
  };
}

// Direct message to a named person (used for draft-for-review).
function slackDm(name, position, user, text) {
  return {
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'user',
      user: { __rl: true, value: user, mode: 'username' },
      text,
      otherOptions: { includeLinkToWorkflow: false },
    },
    type: 'n8n-nodes-base.slack',
    typeVersion: 2.7,
    position,
    name,
    onError: 'continueRegularOutput',
  };
}

/**
 * spec = {
 *   industry, product, agent, slug, mode: 'approve' | 'envelope' | 'draft',
 *   job, never: [..], approves: 'who approves, in words',
 *   trigger: { kind: 'webhook', path } | { kind: 'schedule', minutes, fetch: { url, query, field } },
 *   config: { ...tunables },                     // min_confidence plus approver/reviewer/channel keys below
 *   intake: { name, js },                        // Code body; must return { json: { business_key, ... } }
 *   agentSpec: { name, prompt, system, tools, schema, effort },
 *   reread: { name, ...httpSpec },               // optional fresh read before the guardrails
 *   guard: 'js',                                 // runs after guardPreamble; has cfg, out, reasons, req.
 *                                                // approve/envelope: must define `action` (object) and `summary` (string).
 *                                                // envelope: must also define `withinEnvelope` (boolean).
 *                                                // approve/envelope: may define `noop = true` when nothing needs doing.
 *                                                // draft: must define `draft` (object) and `summary` (string).
 *   act: { write: httpSpec, readBack: httpSpec, verify: 'js', after: [(pos) => node] },
 *                                                // verify: defines `ok` and `detail`; has planned (= action) and $json (read-back)
 *   setup: [..strings], sample: {...}, sampleName,
 * }
 */
export function productAgent(spec) {
  const wf = new Workflow(`${spec.industry} · ${spec.product} · ${spec.agent}`, spec.slug);
  wf.spec = spec;
  const AGENT = spec.agentSpec.name;
  const INTAKE = spec.intake.name;
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const mode = spec.mode;
  const intakeNodes = [];

  // ---------- 1 intake ----------
  let x = 0;
  if (spec.trigger.kind === 'webhook') {
    intakeNodes.push(wf.add(webhook('Request received', [x, 0], spec.trigger.path, spec.slug)));
    x += GAP;
    intakeNodes.push(wf.add(config('Config', [x, 0], spec.config)));
  } else {
    intakeNodes.push(wf.add(schedule(`Every ${spec.trigger.minutes} minutes`, [x, 0], spec.trigger.minutes)));
    x += GAP;
    intakeNodes.push(wf.add(config('Config', [x, 0], spec.config)));
    x += GAP;
    intakeNodes.push(wf.add(http('Fetch work items', [x, 0], { auth: { kind: 'header' }, ...spec.trigger.fetch })));
    x += GAP;
    intakeNodes.push(wf.add(splitOut('One item each', [x, 0], spec.trigger.fetch.field)));
  }
  x += GAP;
  intakeNodes.push(wf.add(code(INTAKE, [x, 0], spec.intake.js)));
  wf.chain(...intakeNodes);

  // ---------- 2 observe and plan ----------
  const block = agentBlock(wf, { ...spec.agentSpec, system: `${spec.agentSpec.system.trim()}\n${SYSTEM_TAIL}`, left: x + 260 });
  wf.link(INTAKE, AGENT);

  // ---------- 3 guardrails ----------
  x = block.right + 140;
  const guardNodes = [];
  if (spec.reread) {
    guardNodes.push(wf.add(http(spec.reread.name, [x, 0], { auth: { kind: 'header' }, ...spec.reread, errorOutput: true })));
    wf.link(AGENT, spec.reread.name);
    x += GAP;
  }
  const finish = {
    approve: `
const ok = reasons.length === 0;
const isNoop = typeof noop !== 'undefined' && noop === true;
const route = !ok ? 'escalate' : isNoop ? 'none' : 'approve';
return { json: { business_key: req.business_key, route, guardrail_reasons: reasons, action, approval_summary: summary, planned_actions: ok && !isNoop ? [action] : [] } };`,
    envelope: `
const ok = reasons.length === 0;
const isNoop = typeof noop !== 'undefined' && noop === true;
const route = !ok ? 'escalate' : isNoop ? 'none' : withinEnvelope ? 'auto' : 'approve';
return { json: { business_key: req.business_key, route, within_envelope: withinEnvelope, guardrail_reasons: reasons, action, approval_summary: summary, planned_actions: ok && !isNoop ? [action] : [] } };`,
    draft: `
const ok = reasons.length === 0;
return { json: { business_key: req.business_key, route: ok ? 'draft' : 'escalate', guardrail_reasons: reasons, draft, draft_summary: summary, planned_actions: ok ? [{ action: 'draft_for_review' }] : [] } };`,
  }[mode];
  guardNodes.push(wf.add(code(GUARD, [x, 0], `
${guardPreamble(AGENT)}
const req = one('${INTAKE}'); // one(): defined by guardPreamble; survives a lost item link
${spec.guard.trim()}
${finish.trim()}
`)));
  wf.link(spec.reread ? spec.reread.name : AGENT, GUARD, 0);
  x += GAP;
  const ROUTE = 'Route';
  const routes = { approve: ['approve', 'none', 'escalate'], envelope: ['auto', 'approve', 'none', 'escalate'], draft: ['draft', 'escalate'] }[mode];
  guardNodes.push(wf.add(switchOn(ROUTE, [x, 0], '={{ $json.route }}', routes)));
  wf.link(GUARD, ROUTE);
  const routeOut = (r) => routes.indexOf(r);
  if (routes.includes('none')) {
    // The agent found nothing to do (e.g. no reorder needed). Recorded, not escalated.
    guardNodes.push(wf.add(setFields('Mark no action', [x, 300], { outcome: 'no_action' })));
    wf.link(ROUTE, 'Mark no action', routeOut('none'));
  }

  const handoffInputs = [[AGENT, 1]];
  if (spec.reread) handoffInputs.push([spec.reread.name, 1]);
  handoffInputs.push([ROUTE, routeOut('escalate')]);
  const finals = routes.includes('none') ? ['Mark no action'] : [];
  x += 260;
  const laneStart = x;

  // ---------- 4a approval ----------
  let approvalNodes = [];
  if (mode === 'approve' || mode === 'envelope') {
    const ASK = 'Ask named approver';
    wf.add(slackApproval(ASK, [x, 0], {
      user: `={{ ${cfg}.approver_slack_user }}`,
      timeoutHours: `={{ ${cfg}.approval_timeout_hours }}`,
      message: `={{ '*${spec.product} · ${spec.agent}* needs your approval\\n' + 'Ref: ' + $json.business_key + '\\n\\n' + $json.approval_summary + '\\n\\nConfidence ' + $('${AGENT}').item.json.output.confidence + '. Reasoning and tool trace are in the audit log for this run.' }}`,
    }));
    wf.add(code('Record approval', [x + GAP, 0], `
// The approval request goes to one named person, so the approver is that person.
// Slack returns { data: { approved, respondedAt } }; a timeout resumes without it.
const cfg = $('Config').first().json;
const approved = $json.data?.approved;
return {
  json: {
    decision: approved === true ? 'approved' : approved === false ? 'declined' : 'timed_out',
    approver: cfg.approver_slack_user,
    decided_at: $json.data?.respondedAt ?? new Date().toISOString(),
    handoff_reason: approved === true || approved === false ? '' : 'approval timed out after ' + cfg.approval_timeout_hours + ' hours',
  },
};
`));
    wf.add(switchOn('Decision', [x + 2 * GAP, 0], '={{ $json.decision }}', ['approved', 'declined', 'timed_out']));
    wf.add(setFields('Mark declined', [x + 3 * GAP, 300], { outcome: 'declined' }));
    wf.link(ROUTE, ASK, routeOut('approve'));
    wf.chain(ASK, 'Record approval', 'Decision');
    wf.link('Decision', 'Mark declined', 1);
    handoffInputs.push(['Decision', 2]);
    finals.push('Mark declined');
    approvalNodes = [ASK, 'Record approval', 'Decision', 'Mark declined'];
    x += 4 * GAP + 40;
  }

  // ---------- 4b act and verify ----------
  let actNodes = [];
  if (mode === 'approve' || mode === 'envelope') {
    const a = spec.act;
    const W = a.write.name;
    const R = a.readBack.name;
    wf.add(http(W, [x, 0], { auth: { kind: 'header' }, ...a.write, errorOutput: true }));
    wf.add(http(R, [x + GAP, 0], { auth: { kind: 'header' }, ...a.readBack, errorOutput: true }));
    wf.add(code('Verify', [x + 2 * GAP, 0], `
// Done only when the system of record shows what was planned.
// Read the plan even if n8n lost the item link (seen live after the AI Agent node).
const one = (name) => { try { return $(name).item.json; } catch (e) { const all = $(name).all(); if (all.length === 1) return all[0].json; throw e; } };
const planned = one('${GUARD}').action;
${a.verify.trim()}
return { json: { verified: ok, verify_failed: !ok, verify_detail: ok ? '' : detail } };
`));
    wf.add(ifTrue('Verified?', [x + 3 * GAP, 0], '={{ $json.verified }}'));
    if (mode === 'approve') wf.link('Decision', W, 0);
    else {
      wf.link('Decision', W, 0);
      wf.link(ROUTE, W, routeOut('auto'));
    }
    wf.link(W, R, 0);
    wf.link(R, 'Verify', 0);
    wf.link('Verify', 'Verified?');
    handoffInputs.push([W, 1], [R, 1], ['Verified?', 1]);
    actNodes = [W, R, 'Verify', 'Verified?'];
    let prev = 'Verified?';
    let ax = x + 4 * GAP;
    for (const make of a.after ?? []) {
      const n = wf.add(make([ax, 0]));
      wf.link(prev, n, 0);
      prev = n;
      actNodes.push(n);
      ax += GAP;
    }
    wf.add(setFields('Mark completed', [ax, 0], { outcome: 'completed' }));
    wf.link(prev, 'Mark completed', 0);
    actNodes.push('Mark completed');
    finals.push('Mark completed');
    x = ax + GAP;
  }

  // ---------- 4c draft for review ----------
  if (mode === 'draft') {
    wf.add(postgres('Save draft', [x, 0], `
INSERT INTO agent_drafts (workflow, business_key, reviewer, summary, draft, n8n_execution_id)
VALUES ($1, $2, $3, $4, $5::jsonb, $6)
RETURNING id;`,
    `={{ [ '${spec.slug}', $json.business_key ?? null, ${cfg}.reviewer_slack_user, $json.draft_summary ?? '', JSON.stringify($json.draft ?? null), $execution.id ] }}`,
    { errorOutput: true }));
    wf.add(slackDm('Send to named reviewer', [x + GAP, 0], `={{ ${cfg}.reviewer_slack_user }}`,
      `={{ ':memo: *${spec.product} · ${spec.agent}* has a draft for your review\\n' + 'Ref: ' + $('${GUARD}').item.json.business_key + ' · draft #' + $json.id + '\\n\\n' + $('${GUARD}').item.json.draft_summary + '\\n\\nNothing has been filed, sent or changed. Open the draft queue to edit and sign off.' }}`));
    wf.add(setFields('Mark draft ready', [x + 2 * GAP, 0], { outcome: 'draft_ready' }));
    wf.link(ROUTE, 'Save draft', routeOut('draft'));
    wf.chain('Save draft', 'Send to named reviewer', 'Mark draft ready');
    handoffInputs.push(['Save draft', 1]);
    actNodes = ['Save draft', 'Send to named reviewer', 'Mark draft ready'];
    finals.push('Mark draft ready');
    x += 3 * GAP;
  }

  // ---------- 5 hand off ----------
  const h = handoffTail(wf, {
    x: laneStart, y: 680, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: spec.team, channel: `={{ ${cfg}.slack_channel }}`,
    summary: spec.handoffSummary ?? `'${spec.agent} · ' + intake.business_key`,
  });
  for (const [from, out] of handoffInputs) wf.link(from, h.first, out);

  // ---------- 6 audit ----------
  const auditX = Math.max(x + 60, laneStart + 4 * GAP + 200);
  const a = auditTail(wf, { x: auditX, y: 340, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  for (const f of finals) wf.link(f, a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: intakeNodes, body: spec.stickies.intake });
  wf.group({ name: 'Stage: observe and plan', title: `2 · Observe and plan (${spec.agent})`, color: COLOR.plan, nodes: block.nodes, body: `${spec.stickies.plan}\n**Read-only tools.** It proposes; it cannot change any system.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails (deterministic)', color: COLOR.guard, nodes: guardNodes, body: spec.stickies.guard });
  const top = ['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails'];
  if (approvalNodes.length) {
    wf.group({ name: 'Stage: approval', title: '4 · Named approver', color: COLOR.overview, nodes: approvalNodes, body: `
${mode === 'envelope' ? 'Outside the pre-approved envelope, the run' : 'The run'} **pauses** and sends the proposal to one named person in Slack (**approver_slack_user** in Config): ${spec.approves}.
Approve continues. Decline ends the run as declined. No answer within **approval_timeout_hours** goes to hand-off.` });
    top.push('Stage: approval');
  }
  wf.group({ name: 'Stage: act', title: mode === 'draft' ? '5 · Draft for review' : '5 · Act and verify', color: COLOR.act, nodes: actNodes, body: spec.stickies.act });
  top.push('Stage: act');
  wf.group({ name: 'Stage: hand off', title: '6 · Hand off', color: COLOR.handoff, nodes: h.nodes, body: `
Agent errors, guardrail stops, approval timeouts, failed writes and failed verification all land here: an **agent_exceptions** row with the reasons, the proposal, the agent's questions and its full tool trace, plus a post to **${spec.team}**.` });
  wf.group({ name: 'Stage: audit', title: '7 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One row per run in **agent_runs**, including who approved or declined. The table is **append-only and hash-chained** (see sql/schema.sql).` });
  wf.alignTops(top);

  const modeLine = {
    approve: `**Approval:** every action waits for a named person: ${spec.approves}.`,
    envelope: `**Approval:** acts on its own only inside the pre-approved envelope set in Config. Everything outside it waits for a named person: ${spec.approves}.`,
    draft: `**Approval:** nothing is written, filed or sent. The draft goes to a named reviewer: ${spec.approves}.`,
  }[mode];
  overviewStickies(wf, {
    overview: `## ${spec.product} · ${spec.agent}
**Suite:** ${spec.industry}
**Job:** ${spec.job}

${modeLine}

**Never does**
${spec.never.map((n) => `- ${n}`).join('\n')}

**Model:** Claude Opus 5, adaptive thinking, effort ${spec.agentSpec.effort ?? 'high'}.`,
    setup: `## Setup
1. Run **sql/schema.sql**. Select the Postgres credential on every Postgres node.
2. Credentials: **Anthropic**, **Header Auth** for the ${spec.product} gateway, **Slack** (the approval and reviewer messages need a bot that can DM users).
${spec.setup.map((s, i) => `${i + 3}. ${s}`).join('\n')}
${spec.setup.length + 3}. Edit **Config**: ${mode === 'draft' ? 'reviewer_slack_user' : 'approver_slack_user, approval_timeout_hours'}, confidence floor, channel and the limits listed there.
${spec.setup.length + 4}. Test: ${spec.trigger.kind === 'webhook' ? `\`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/products/${spec.dir}/${spec.file}.json\`` : `*Execute workflow* against a staging gateway; sample response in **samples/products/${spec.dir}/${spec.file}.json**`}`,
  });

  return wf;
}
