import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  schedule, config, code, ifTrue, http, splitOut, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

// Phrases that mean a person, not a model, looks at the ticket first. Regex sources, matched
// case-insensitively on whole words against the full description, so "fired" or "spark plug
// shop" style false hits are rarer and "line on the ground" style reports are caught.
const HAZARD_PATTERNS = [
  '\\b(?:wires?|lines?|cables?|power ?lines?) (?:is |are )?down\\b', '\\bdowned\\b',
  '\\b(?:wires?|lines?|cables?) (?:(?:is|are) )?(?:lying |hanging )?(?:on|across|over) the (?:ground|road|street|yard|car|house|roof|sidewalk|pavement)\\b',
  '\\blive wires?\\b', '\\bspark(?:s|ing|ed)?\\b', '\\barcing\\b', '\\bfire\\b', '\\bon fire\\b', '\\bsmoke\\b', '\\bsmoking\\b',
  '\\bburning\\b', '\\bexplo(?:sion|ded|de|ding)\\b', '\\bgas (?:smell|leak)\\b', '\\bsmell(?:s|ing)? (?:of )?gas\\b',
  '\\bpoles? (?:is |are )?(?:down|broken|snapped|leaning)\\b', '\\btree (?:is )?(?:on|against|across|through) (?:the )?(?:power ?)?lines?\\b',
  '\\btransformer (?:blew|exploded|is on fire|is smoking|is sparking)\\b',
  '\\bshock(?:ed)?\\b', '\\belectrocut', '\\binjur', '\\bhurt\\b', '\\btrapped\\b',
  '\\blife support\\b', '\\boxygen\\b', '\\bventilator\\b', '\\bdialysis\\b',
];

const execTrigger = (name, position) => ({
  parameters: { inputSource: 'passthrough' },
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  typeVersion: 1.1,
  position,
  name,
});

// One sub-workflow execution per ticket, not waiting: each ticket is triaged on its own.
const executeEach = (name, position, workflowId, cachedResultName) => ({
  parameters: {
    source: 'database',
    workflowId: { __rl: true, value: workflowId, mode: 'id', cachedResultName },
    mode: 'each',
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    options: { waitForSubWorkflow: false },
  },
  type: 'n8n-nodes-base.executeWorkflow',
  typeVersion: 1.2,
  position,
  name,
});

export default function build() {
  const triage = buildTriage();
  return [triage, buildPoller(triage)];
}

// ---------------------------------------------------------------------------------------------
// Per-ticket triage. Called once per ticket by the poller, so the agent always handles exactly
// one item. (Run live in a batch, n8n 2.40's AI Agent node re-rendered later tool rounds against
// the wrong ticket; one ticket per execution removes that class of problem.) Because there is
// exactly one item, earlier nodes are read with .first(), which does not depend on n8n's item
// linking (also seen to break after the agent node).
// ---------------------------------------------------------------------------------------------
function buildTriage() {
  const wf = new Workflow('Energy & Utilities · Outage ticket triage agent', 'energy-outage-ticket-triage');
  const AGENT = 'Outage triage agent';
  const INTAKE = 'Normalize ticket';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const ops = { kind: 'header' };

  // ---------- intake ----------
  wf.add(execTrigger('Ticket from poller', [0, 0]));
  wf.add(config('Config', [220, 0], {
    ops_gateway_url: '={{ $json.ops_gateway_url }}',
    min_confidence: 0.85,
    slack_channel: '#dispatch-desk',
  }));
  wf.add(code(INTAKE, [440, 0], `
const t = $json;
const description = String(t.description ?? '');
return {
  json: {
    business_key: String(t.ticket_id),
    ticket_id: String(t.ticket_id),
    premise_id: String(t.premise_id ?? ''),
    meter_id: String(t.meter_id ?? ''),
    address: String(t.address ?? ''),
    lat: t.lat ?? null,
    lon: t.lon ?? null,
    reported_at: t.reported_at ?? null,
    channel: String(t.channel ?? ''),
    description: description.slice(0, 1500),     // what the model sees
    description_full: description.slice(0, 20000), // what the safety screen reads
  },
};
`));
  wf.add(http('Claim ticket', [660, 0], {
    method: 'PATCH',
    url: `={{ ${cfg}.ops_gateway_url }}/tickets/{{ $json.ticket_id }}`,
    auth: ops,
    json: `={{ JSON.stringify({ status: 'triaging', triaged_by: 'aelix-outage-agent', expected_status: 'new' }) }}`,
    errorOutput: true,
  }));
  wf.add(ifTrue('Claimed by another run?', [880, 260],
    `={{ ['409', 409].includes($json.error?.httpCode) || /\\b409\\b|conflict/i.test(String($json.error?.message ?? '') + ' ' + String($json.error?.description ?? '')) }}`));
  wf.add({ parameters: {}, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [1100, 260], name: 'Skip: already claimed' });
  wf.add(code('Safety screen', [880, 0], `
// Deterministic, runs before the model. Anything that sounds like a hazard or a
// medically dependent customer goes straight to a dispatcher. Reads the full description.
const PATTERNS = ${JSON.stringify(HAZARD_PATTERNS)}.map((p) => new RegExp(p, 'i'));
const t = $('${INTAKE}').first().json;
const text = t.description_full ?? t.description ?? '';
const hits = PATTERNS.map((r) => text.match(r)?.[0]).filter(Boolean);
return {
  json: {
    ...t,
    hazard: hits.length > 0,
    hazard_terms: hits,
    handoff_reason: hits.length ? 'SAFETY: customer report mentions ' + hits.join(', ') : '',
  },
};
`));
  wf.add(ifTrue('Hazard reported?', [1100, 0], '={{ $json.hazard }}'));
  wf.chain('Ticket from poller', 'Config', INTAKE, 'Claim ticket');
  wf.link('Claim ticket', 'Safety screen', 0);
  wf.link('Claim ticket', 'Claimed by another run?', 1);
  wf.link('Claimed by another run?', 'Skip: already claimed', 0);
  wf.link('Safety screen', 'Hazard reported?');

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 1340,
    effort: 'medium',
    prompt: `=Outage ticket {{ $('${INTAKE}').first().json.ticket_id }}
Premise: {{ $('${INTAKE}').first().json.premise_id }} · meter {{ $('${INTAKE}').first().json.meter_id }}
Address: {{ $('${INTAKE}').first().json.address }} ({{ $('${INTAKE}').first().json.lat }}, {{ $('${INTAKE}').first().json.lon }})
Reported: {{ $('${INTAKE}').first().json.reported_at }} via {{ $('${INTAKE}').first().json.channel }}

Customer's description, as written by the customer:
<customer_report>
{{ $('${INTAKE}').first().json.description }}
</customer_report>

Correlate this ticket with what the network shows, and recommend how it should be handled.`,
    system: `
You triage outage tickets for an electric utility's dispatch desk. A customer reported no power or partial power. You correlate the ticket with the outage management system, meter data and the network model, and recommend handling. Dispatchers make every crew decision; you prepare it.

How to correlate:
- Check active outages near the premise. A ticket belongs to a known outage when the premise is downstream of that outage's device on the network model, not merely nearby.
- Check the meter. A recent last-gasp event or failed ping supports a real outage at the premise; a meter that answers normally suggests a single-premise issue behind the meter or no outage.
- Use the network model to name the likely device (transformer, fuse, recloser, feeder breaker) and estimate customers affected when several nearby meters are dark on the same device.
- Check premise flags for critical customers (hospitals, medical-baseline, water and sewer, emergency services).

Classifications:
- part_of_known_outage: downstream of an active outage's device. Give matched_outage_id.
- new_outage_probable: meter evidence of loss and no active outage covers it.
- single_premise_issue: meter or neighbours suggest the problem is at this premise only.
- not_an_outage: meter healthy and nothing on the network.
- hazard_suspected: anything in the report or data that suggests danger.

Priority: P1 hazard or critical customer affected; P2 new outage over 50 customers; P3 other new outages; P4 single premise or no outage. If you recommend a crew, it must come from the crew tool.

Tools:
- "Find active outages nearby (OMS)", "Check meter status (AMI)", "Trace network (GIS)", "Get premise flags (CIS)", "Find available crews (WFM)".
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Find active outages nearby (OMS)',
        description: 'List active outages within a radius of a point: outage id, status, device id and type, feeder, customers out, ETR.',
        url: `={{ ${cfg}.ops_gateway_url }}/oms/outages`,
        auth: ops,
        query: {
          lat: `={{ $fromAI('lat', 'Latitude of the premise', 'number') }}`,
          lon: `={{ $fromAI('lon', 'Longitude of the premise', 'number') }}`,
          radius_m: `={{ $fromAI('radius_m', 'Search radius in metres, 300 to 3000', 'number') }}`,
          status: 'active',
        },
      },
      {
        name: 'Check meter status (AMI)',
        description: 'Get recent AMI events for a meter (last gasp, power restore, ping result) and its current connectivity.',
        url: `={{ ${cfg}.ops_gateway_url }}/ami/meters/{{ $fromAI('meter_id', 'Meter id', 'string') }}/status`,
        auth: ops,
        query: { lookback_minutes: '180' },
      },
      {
        name: 'Trace network (GIS)',
        description: 'Trace upstream from a premise: service transformer, protective devices, feeder and substation, with the meters that share each device.',
        url: `={{ ${cfg}.ops_gateway_url }}/gis/premises/{{ $fromAI('premise_id', 'Premise id', 'string') }}/upstream`,
        auth: ops,
      },
      {
        name: 'Get premise flags (CIS)',
        description: 'Get customer flags for a premise: medical baseline, critical facility type, life-support registration.',
        url: `={{ ${cfg}.ops_gateway_url }}/cis/premises/{{ $fromAI('premise_id', 'Premise id', 'string') }}/flags`,
        auth: ops,
      },
      {
        name: 'Find available crews (WFM)',
        description: 'List crews available now near a point, with crew id, type (troubleshooter, line, tree), distance and current assignment.',
        url: `={{ ${cfg}.ops_gateway_url }}/wfm/crews/available`,
        auth: ops,
        query: {
          lat: `={{ $fromAI('lat', 'Latitude', 'number') }}`,
          lon: `={{ $fromAI('lon', 'Longitude', 'number') }}`,
          crew_type: `={{ $fromAI('crew_type', 'troubleshooter, line or tree', 'string') }}`,
        },
      },
    ],
    schema: S.obj({
      classification: S.enum(['part_of_known_outage', 'new_outage_probable', 'single_premise_issue', 'not_an_outage', 'hazard_suspected'], 'Classification.'),
      matched_outage_id: S.nullable(S.str('Active outage this ticket belongs to, or null.')),
      suspected_device: S.nullable(S.obj({ type: S.str('Device type.'), id: S.str('Device id.') })),
      premise_feeder_id: S.nullable(S.str('Feeder serving the premise, from the network trace.')),
      affected_estimate: S.int('Estimated customers affected.'),
      critical_customer: S.bool('A critical or medically dependent customer is affected.'),
      priority: S.enum(['P1', 'P2', 'P3', 'P4'], 'Priority.'),
      ami_evidence: S.str('What the meter data showed, one or two sentences.'),
      recommended_crew_id: S.nullable(S.str('Crew from the crew tool, or null.')),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link('Hazard reported?', AGENT, 1);

  // ---------- guardrails ----------
  // Only "part of a known outage" can be automated. Everything the decision rests on is read
  // again from the systems of record: the outage (OMS), the premise's upstream network (GIS)
  // and the customer flags (CIS). The agent's own feeder and critical-customer answers are
  // never the only evidence.
  const gx = block.right + 140;
  const premise = `$('${INTAKE}').first().json.premise_id`;
  wf.add(ifTrue('Matches a known outage?', [gx, 0], `={{ $json.output?.classification === 'part_of_known_outage' && !!$json.output?.matched_outage_id }}`));
  wf.add(http('Re-read outage (OMS)', [gx + 220, 0], {
    url: `={{ ${cfg}.ops_gateway_url }}/oms/outages/{{ $('${AGENT}').first().json.output.matched_outage_id }}`,
    auth: ops,
    errorOutput: true,
  }));
  wf.add(http('Re-read network (GIS)', [gx + 440, 0], {
    url: `={{ ${cfg}.ops_gateway_url }}/gis/premises/{{ ${premise} }}/upstream`,
    auth: ops,
    errorOutput: true,
  }));
  wf.add(http('Re-read premise flags (CIS)', [gx + 660, 0], {
    url: `={{ ${cfg}.ops_gateway_url }}/cis/premises/{{ ${premise} }}/flags`,
    auth: ops,
    errorOutput: true,
  }));
  wf.add(code(GUARD, [gx + 880, 0], `
${guardPreamble(AGENT)}
const t = $('${INTAKE}').first().json;
const outage = $('Re-read outage (OMS)').first().json;
const net = $('Re-read network (GIS)').first().json;
const flags = $json; // fresh CIS read
const upstream = [
  net.service_transformer?.id,
  ...(net.protective_devices ?? []).map((d) => d.id),
  net.feeder?.id,
  net.feeder?.breaker_id,
].filter(Boolean);

if (!['active', 'assessing', 'crew_assigned', 'crew_on_site'].includes(outage.status)) reasons.push('outage ' + outage.outage_id + ' is ' + outage.status);
if (!net.feeder?.id) reasons.push('network trace returned no feeder for premise ' + t.premise_id);
else if (outage.feeder_id && net.feeder.id !== outage.feeder_id) reasons.push('premise feeder ' + net.feeder.id + ' differs from outage feeder ' + outage.feeder_id);
if (!outage.device_id || !upstream.includes(outage.device_id)) reasons.push('premise ' + t.premise_id + ' is not downstream of outage device ' + (outage.device_id ?? 'unknown') + ' on the network trace');
if (typeof flags.medical_baseline !== 'boolean' || typeof flags.life_support_registered !== 'boolean') reasons.push('customer flags unavailable for premise ' + t.premise_id);
if (flags.medical_baseline || flags.life_support_registered || flags.critical_facility_type) reasons.push('critical customer on record (CIS): dispatcher confirms');
if (out?.critical_customer) reasons.push('critical customer: dispatcher confirms');
if (out?.priority === 'P1') reasons.push('P1: dispatcher confirms');

const ok = reasons.length === 0;
return {
  json: {
    business_key: t.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    outage_id: outage.outage_id,
    etr: outage.etr ?? null,
    planned_actions: ok ? [{ action: 'ticket.link_outage', outage_id: outage.outage_id }, { action: 'notify.etr' }] : [],
  },
};
`));
  wf.add(ifTrue('Link automatically?', [gx + 1100, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, 'Matches a known outage?');
  wf.chain('Re-read outage (OMS)', 'Re-read network (GIS)', 'Re-read premise flags (CIS)', GUARD, 'Link automatically?');
  wf.link('Matches a known outage?', 'Re-read outage (OMS)', 0);

  // ---------- act & verify ----------
  const ax = gx + 1360;
  wf.add(http('Link ticket to outage', [ax, 0], {
    method: 'PATCH',
    url: `={{ ${cfg}.ops_gateway_url }}/tickets/{{ $('${INTAKE}').first().json.ticket_id }}`,
    auth: ops,
    // expected_status: a dispatcher who changed the ticket during triage is never overwritten.
    json: `={{ JSON.stringify({ status: 'linked', expected_status: 'triaging', outage_id: $json.outage_id, triage_note: 'Linked by aelix-outage-agent: ' + $('${AGENT}').first().json.output.ami_evidence }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Read back ticket', [ax + 220, 0], {
    url: `={{ ${cfg}.ops_gateway_url }}/tickets/{{ $('${INTAKE}').first().json.ticket_id }}`,
    auth: ops,
    errorOutput: true,
  }));
  wf.add(code('Verify link', [ax + 440, 0], `
const planned = $('${GUARD}').first().json.outage_id;
const ok = $json.status === 'linked' && $json.outage_id === planned;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'ticket shows status ' + $json.status + ' and outage ' + $json.outage_id,
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 660, 0], '={{ $json.verified }}'));
  wf.add(http('Send ETR notice', [ax + 880, 0], {
    method: 'POST',
    url: `={{ ${cfg}.ops_gateway_url }}/notifications`,
    auth: ops,
    headers: { 'Idempotency-Key': `=etr-{{ $('${INTAKE}').first().json.ticket_id }}` },
    json: `={{ JSON.stringify({ template: 'outage_known_etr', premise_id: $('${INTAKE}').first().json.premise_id, outage_id: $('${GUARD}').first().json.outage_id, ticket_id: $('${INTAKE}').first().json.ticket_id }) }}`,
    errorOutput: true,
  }));
  wf.add(setFields('Mark completed', [ax + 1100, 0], { outcome: 'completed' }));
  wf.link('Link automatically?', 'Link ticket to outage', 0);
  wf.link('Link ticket to outage', 'Read back ticket', 0);
  wf.link('Read back ticket', 'Verify link', 0);
  wf.link('Verify link', 'Verified?');
  wf.link('Verified?', 'Send ETR notice', 0);
  wf.link('Send ETR notice', 'Mark completed', 0);

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax, y: 600, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'dispatch desk', channel: `={{ ${cfg}.slack_channel }}`,
    summary: `(($json.hazard) ? ':warning: HAZARD · ' : '') + 'Ticket ' + intake.ticket_id + ' · ' + intake.address + ' · ' + (agent?.output?.classification ?? 'not triaged') + ' · ' + (agent?.output?.priority ?? 'P1') + (agent?.output?.recommended_crew_id ? ' · suggested crew ' + agent.output.recommended_crew_id : '')`,
  });
  wf.link('Claimed by another run?', h.first, 1); // claim failed for another reason
  wf.link('Hazard reported?', h.first, 0);
  wf.link(AGENT, h.first, 1);
  wf.link('Matches a known outage?', h.first, 1);
  wf.link('Re-read outage (OMS)', h.first, 1);
  wf.link('Re-read network (GIS)', h.first, 1);
  wf.link('Re-read premise flags (CIS)', h.first, 1);
  wf.link('Link automatically?', h.first, 1);
  wf.link('Link ticket to outage', h.first, 1);
  wf.link('Read back ticket', h.first, 1);
  wf.link('Verified?', h.first, 1);
  wf.link('Send ETR notice', h.first, 1); // linked, but the customer was not told

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1360, y: 300, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Claim and safety screen', color: COLOR.intake, nodes: ['Ticket from poller', 'Config', INTAKE, 'Claim ticket', 'Safety screen', 'Hazard reported?', 'Claimed by another run?', 'Skip: already claimed'], body: `
The poller starts this workflow once per ticket. The ticket is **claimed** (status new → triaging); a ticket another run already claimed is skipped quietly.
A **safety screen runs before the model** on the full description: wires down, sparking, fire, gas, injuries, life support. Any hit goes straight to a dispatcher.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Correlate (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude checks active outages, the premise meter (last gasp, ping), the upstream network trace and critical-customer flags. It classifies the ticket, names the likely device, sets a priority and suggests a crew.
Effort is **medium** here: high volume, well-bounded reasoning.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: ['Matches a known outage?', 'Re-read outage (OMS)', 'Re-read network (GIS)', 'Re-read premise flags (CIS)', GUARD, 'Link automatically?'], body: `
Only "part of a known outage" can be automated. The outage, the premise's **network trace** and its **customer flags** are re-read: the outage must still be open, its device must be upstream of the premise, and no critical or medically dependent customer may be on record. P1s always go to a dispatcher.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Link and notify', color: COLOR.act, nodes: ['Link ticket to outage', 'Read back ticket', 'Verify link', 'Verified?', 'Send ETR notice', 'Mark completed'], body: `
Links the ticket to the outage (only if it is still in triage), reads it back, then sends the customer the **templated ETR notice** (idempotent per ticket). A notice that fails goes to the dispatch desk.` });
  wf.group({ name: 'Stage: hand off', title: '5 · Dispatch desk', color: COLOR.handoff, nodes: h.nodes, body: `
Hazards, new outages, single-premise issues and anything stopped land here with classification, suspected device, priority, suggested crew and the tool trace. **A dispatcher makes every crew decision.**` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per ticket.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    x: -1000,
    overview: `## Energy & Utilities · Outage ticket triage agent
**Job:** take outage-ticket triage off the dispatch desk. Correlate each ticket with OMS, AMI and the network model, attach tickets to known outages automatically, and hand dispatchers a prepared recommendation for everything else.

**Flow:** started per ticket by the *Outage ticket poller* → claim → safety screen (no model) → agent correlates (read-only) → guardrails re-read OMS, GIS and CIS → link, read back, send ETR → dispatch desk for the rest → audit.

**Never does**
- Dispatches a crew
- Handles a hazard report without a person
- Auto-handles critical or medically dependent customers

**Model:** Claude Opus 5, adaptive thinking, effort medium.`,
    setup: `## Setup
1. Run **sql/schema.sql**. Select the Postgres credential on *Queue exception* and *Write audit record*.
2. Credentials: **Anthropic**, **Header Auth** for the ops gateway, **Slack**.
3. Import this workflow **and** *Energy & Utilities · Outage ticket poller*. Activate only the poller; it starts this one for each ticket and passes the gateway URL from its Config.
4. **Ops gateway contract**: tickets (list, patch, get), oms/outages, ami/meters, gis/premises upstream, cis/premises flags, wfm/crews, notifications. Map to your OMS/ADMS (Oracle NMS, GE ADMS), head-end, GIS and CIS.
5. *Claim ticket* and *Link ticket to outage* must fail (409) if the ticket is not in the expected status. That is what stops double processing.
6. Edit **Config**: confidence floor, channel. Review the hazard patterns in *Safety screen* with your safety team.`,
  });

  return wf;
}

// ---------------------------------------------------------------------------------------------
// Poller: fetch new outage tickets and start one triage execution per ticket.
// ---------------------------------------------------------------------------------------------
function buildPoller(triage) {
  const wf = new Workflow('Energy & Utilities · Outage ticket poller', 'energy-outage-ticket-poller');
  const cfg = `$('Config').first().json`;
  wf.add(schedule('Every 2 minutes', [0, 0], 2));
  wf.add(config('Config', [220, 0], {
    ops_gateway_url: 'https://ops-gateway.YOUR-UTILITY.example/api',
    batch_size: 25,
  }));
  wf.add(http('Fetch new outage tickets', [440, 0], {
    url: `={{ ${cfg}.ops_gateway_url }}/tickets`,
    auth: { kind: 'header' },
    query: { status: 'new', category: 'outage', limit: `={{ ${cfg}.batch_size }}` },
  }));
  wf.add(splitOut('One item per ticket', [660, 0], 'tickets'));
  wf.add(setFields('Attach gateway URL', [880, 0], { ops_gateway_url: `={{ ${cfg}.ops_gateway_url }}` }, true));
  wf.add(executeEach('Triage each ticket', [1100, 0], triage.id, triage.name));
  wf.chain('Every 2 minutes', 'Config', 'Fetch new outage tickets', 'One item per ticket', 'Attach gateway URL', 'Triage each ticket');

  wf.group({ name: 'Stage: poll', title: '1 · Poll and fan out', color: COLOR.intake, nodes: ['Every 2 minutes', 'Config', 'Fetch new outage tickets', 'One item per ticket', 'Attach gateway URL', 'Triage each ticket'], body: `
Every two minutes, new outage tickets are fetched and **each one is triaged in its own execution** of *Outage ticket triage agent*, so the agent always works on exactly one ticket. Claiming happens there, so overlapping polls cannot process a ticket twice.` });

  overviewStickies(wf, {
    x: -1000,
    overview: `## Energy & Utilities · Outage ticket poller
**Job:** find new outage tickets and hand each one to *Energy & Utilities · Outage ticket triage agent*, one execution per ticket.

**Why separate:** one ticket per agent run keeps each triage independent: a failure on one ticket never affects another, and the agent can never mix two tickets' data.`,
    setup: `## Setup
1. Import this workflow and *Energy & Utilities · Outage ticket triage agent*.
2. Credential: **Header Auth** for the ops gateway on *Fetch new outage tickets*.
3. Edit **Config**: gateway URL and batch size. The URL is passed to each triage run.
4. Activate this workflow only.`,
  });
  return wf;
}
