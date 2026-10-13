import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  webhook, config, code, ifTrue, http, gmail, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

export default function build() {
  const wf = new Workflow('Logistics · Shipment exception agent', 'logistics-shipment-exceptions');
  const AGENT = 'Shipment exception agent';
  const INTAKE = 'Normalize event';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const tms = { kind: 'header' };

  // ---------- intake ----------
  wf.add(webhook('Carrier exception event', [0, 0], 'aelix/logistics/shipment-exception', wf.slug));
  wf.add(config('Config', [220, 0], {
    tms_base_url: 'https://tms.YOUR-COMPANY.example/api/v2',
    max_rebook_cost_delta: 300,
    min_confidence: 0.85,
    slack_channel: '#shipment-exceptions',
  }));
  wf.add(code(INTAKE, [440, 0], `
const b = $json.body ?? $json;
const missing = ['event_id', 'shipment_id', 'event_code'].filter((k) => !b[k]);
if (missing.length) throw new Error('Carrier event missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(b.shipment_id) + ':' + String(b.event_id),
    event_id: String(b.event_id),
    shipment_id: String(b.shipment_id),
    carrier: String(b.carrier ?? ''),
    tracking_number: String(b.tracking_number ?? ''),
    event_code: String(b.event_code).toUpperCase(),
    event_description: String(b.event_description ?? '').slice(0, 1000),
    event_time: b.event_time ?? null,
    location: String(b.location ?? ''),
  },
};
`));
  wf.chain('Carrier exception event', 'Config', INTAKE);

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 700,
    prompt: `=Carrier exception on shipment {{ $json.shipment_id }}
Carrier: {{ $json.carrier }} · tracking {{ $json.tracking_number }}
Event code: {{ $json.event_code }} at {{ $json.event_time ?? 'unknown time' }}, {{ $json.location || 'unknown location' }}
Rebooking cost limit for this run: {{ ${cfg}.max_rebook_cost_delta }} (in the shipment's currency)

Carrier's description, as sent by the carrier:
<carrier_event>
{{ $json.event_description }}
</carrier_event>

Trace what happened, decide whether the delivery promise is at risk, and re-plan.`,
    system: `
You handle shipment exceptions for a logistics operations team. A carrier reported an exception. You trace what happened, work out whether the customer's delivery promise is at risk, and propose a re-plan.

How to work it:
- Read the shipment (lane, service level, promised delivery, customer) and its tracking history. Establish the root cause from the events, not from the event code alone.
- Read the order to see the SLA and whether the customer is flagged as priority.
- Estimate a realistic new ETA on the current carrier.
- If the new ETA misses the promise, get quotes for alternatives (rebook on another carrier or expedite on the same one). Keep the options that recover the promise, with their cost difference against the current booking.

Options you can propose:
- wait: stay with the current carrier, update the ETA, tell the customer.
- rebook: move to another carrier using a quote you obtained.
- expedite: upgrade service on the current carrier using a quote you obtained.
Every rebook or expedite option must carry the quote_id from the quote tool.

Damage, customs holds, hazmat and address problems need a person: say so and recommend escalate. Draft the customer notice in plain words, with the new ETA. A person reviews it when the case escalates.

Tools:
- "Get shipment (TMS)", "Get tracking history (TMS)", "Get order and SLA (TMS)": read records.
- "Quote alternatives (TMS)": returns priced options with quote ids. Quoting books nothing.
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Get shipment (TMS)',
        description: 'Get a shipment: lane, carrier, service level, current booking and cost, promised delivery date, current ETA, customer contact.',
        url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $fromAI('shipment_id', 'TMS shipment id', 'string') }}`,
        auth: tms,
      },
      {
        name: 'Get tracking history (TMS)',
        description: 'Get all tracking events for a shipment, oldest first, with codes, descriptions, times and locations.',
        url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $fromAI('shipment_id', 'TMS shipment id', 'string') }}/events`,
        auth: tms,
      },
      {
        name: 'Get order and SLA (TMS)',
        description: 'Get the customer order behind a shipment: SLA, priority flag, delivery window, penalties.',
        url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $fromAI('shipment_id', 'TMS shipment id', 'string') }}/order`,
        auth: tms,
      },
      {
        name: 'Quote alternatives (TMS)',
        description: 'Get priced alternatives for moving a shipment from its current location: other carriers and faster services. Returns quote_id, carrier, service, cost, cost_delta vs the current booking, and ETA for each. Read-only; nothing is booked.',
        method: 'POST',
        url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $fromAI('shipment_id', 'TMS shipment id', 'string') }}/quotes`,
        auth: tms,
        json: `={{ JSON.stringify({ deliver_by: $fromAI('deliver_by', 'ISO date the shipment must arrive by', 'string') }) }}`,
      },
    ],
    schema: S.obj({
      root_cause: S.enum(['weather', 'carrier_capacity', 'missed_pickup', 'mechanical', 'address_issue', 'customs_hold', 'damage', 'other'], 'Cause established from tracking.'),
      sla_at_risk: S.bool('Current ETA misses the promised delivery.'),
      promised_delivery: S.str('ISO date promised to the customer.'),
      options: S.arr(S.obj({
        option_id: S.str('Short id, for example opt-1.'),
        type: S.enum(['wait', 'rebook', 'expedite'], 'Kind of re-plan.'),
        carrier: S.str('Carrier.'),
        service: S.str('Service level.'),
        quote_id: S.nullable(S.str('Quote id for rebook or expedite. Null for wait.')),
        cost_delta: S.num('Extra cost against current booking. 0 for wait.'),
        eta: S.str('ISO date-time of expected delivery.'),
      }), 'Options considered.'),
      recommended_option_id: S.nullable(S.str('option_id to take, or null when recommending escalate.')),
      recommend_escalate: S.bool('A person must handle this case.'),
      customer_notice: S.str('Plain-language draft for the customer.'),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link(INTAKE, AGENT);

  // ---------- guardrails ----------
  const gx = block.right + 140;
  wf.add(http('Re-read shipment (TMS)', [gx, 0], {
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}`,
    auth: tms,
    errorOutput: true,
  }));
  // The quotes the TMS issues for this shipment, read by the workflow itself. The cost and ETA
  // checks use these, never the figures the agent reported.
  wf.add(http('Re-read quotes (TMS)', [gx + 220, 0], {
    method: 'POST',
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}/quotes`,
    auth: tms,
    json: `={{ JSON.stringify({ deliver_by: $json.promised_delivery ?? null }) }}`,
    errorOutput: true,
  }));
  wf.add(code(GUARD, [gx + 440, 0], `
${guardPreamble(AGENT)}
const req = $('${INTAKE}').item.json;
const shp = $('Re-read shipment (TMS)').item.json; // fresh read of the shipment
const issued = $json; // fresh read of the quotes the TMS issues for it
const pick = (out?.options ?? []).find((o) => o.option_id === out?.recommended_option_id) ?? null;
const promised = Date.parse(shp.promised_delivery ?? ''); // TMS only, never the agent's value
const tmsEta = Date.parse(shp.eta ?? '');
const agentEta = Date.parse(pick?.eta ?? '');
const email = String(shp.customer?.email ?? '').trim();
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

if (out?.recommend_escalate) reasons.push('agent recommends a person handles it');
if (['damage', 'customs_hold', 'address_issue'].includes(out?.root_cause)) reasons.push('root cause ' + out.root_cause + ' always goes to a person');
// Event codes vary by carrier (DAMAGE, DAMAGED, CUSTOMS, CUSTOMS_HOLD, hazmat...), so match by stem.
const code = String(req.event_code ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
if ([/DAMAG/, /CUSTOM/, /HAZ/, /DANGEROUS/, /ADDRESS/].some((r) => r.test(code))) reasons.push('event code ' + req.event_code + ' always goes to a person');
// Hazmat comes from the TMS record. A missing flag is treated as unknown, and unknown goes to a person.
const haz = shp.hazmat;
if (haz === undefined || haz === null || haz === '') reasons.push('TMS shipment has no hazmat flag');
else if (!(haz === false || haz === 0 || /^(false|no|n|0)$/i.test(String(haz)))) reasons.push('TMS shipment is flagged hazmat');
if (String(shp.shipment_id ?? '') !== String(req.shipment_id ?? '')) reasons.push('TMS returned a different shipment');
if (!pick) reasons.push('no recommended option');
if (shp.status === 'delivered' || shp.status === 'cancelled') reasons.push('shipment is now ' + shp.status);
if (!Number.isFinite(promised)) reasons.push('TMS shipment has no valid promised delivery date');
if (!/^[^\\s@<>,;]+@[^\\s@<>,;]+\\.[^\\s@<>,;]+$/.test(email)) reasons.push('TMS shipment has no usable customer email, so nobody would be told');
if (pick && !Number.isFinite(agentEta)) reasons.push('option ETA is not a valid date');

let quote = null;
let costDelta = null;
if (pick && pick.type === 'wait') {
  // The carrier's own ETA, from the TMS, must meet the promise. The agent's estimate must too.
  if (!Number.isFinite(tmsEta)) reasons.push('TMS shipment has no valid current ETA');
  else if (Number.isFinite(promised) && tmsEta > promised) reasons.push('wait: the carrier ETA in the TMS (' + shp.eta + ') misses the promised date');
  if (Number.isFinite(agentEta) && Number.isFinite(promised) && agentEta > promised) reasons.push('wait: the agent ETA misses the promised date');
} else if (pick) {
  if (!pick.quote_id) reasons.push('rebook/expedite without a quote id');
  else {
    if (String(issued.shipment_id ?? '') !== String(req.shipment_id ?? '')) reasons.push('TMS quotes are for a different shipment');
    quote = (Array.isArray(issued.quotes) ? issued.quotes : []).find((q) => q && String(q.quote_id) === String(pick.quote_id)) ?? null;
    if (!quote) reasons.push('quote ' + pick.quote_id + ' is not among the quotes the TMS issues for this shipment');
  }
  if (quote) {
    if (quote.type != null && quote.type !== pick.type) reasons.push('TMS quote is a ' + quote.type + ', not a ' + pick.type);
    if (typeof quote.carrier !== 'string' || !quote.carrier.trim()) reasons.push('TMS quote has no carrier');
    // Cost: the TMS cost delta, cross-checked against quote cost minus the current booking cost. The larger counts.
    const deltas = [Number(quote.cost_delta ?? NaN)];
    const base = Number(shp.current_booking?.cost ?? NaN);
    if (quote.cost != null && Number.isFinite(base)) deltas.push(Number(quote.cost) - base);
    costDelta = deltas.every(Number.isFinite) ? Math.max(...deltas) : null;
    if (costDelta === null) reasons.push('TMS quote has no usable cost delta');
    else if (costDelta > cfg.max_rebook_cost_delta) reasons.push('TMS cost delta ' + costDelta + ' above ' + cfg.max_rebook_cost_delta);
    if (costDelta !== null && !(Math.abs(Number(pick.cost_delta) - costDelta) <= 1)) reasons.push('agent reported cost delta ' + pick.cost_delta + ' but the TMS quote says ' + costDelta);
    if (quote.currency && shp.currency && quote.currency !== shp.currency) reasons.push('TMS quote currency ' + quote.currency + ' differs from the shipment currency ' + shp.currency);
    if (quote.valid_until != null && !(Date.parse(quote.valid_until) > Date.now())) reasons.push('TMS quote has expired');
    const quoteEta = Date.parse(quote.eta ?? '');
    if (!Number.isFinite(quoteEta)) reasons.push('TMS quote ETA is not a valid date');
    else if (Number.isFinite(promised) && quoteEta > promised) reasons.push('paid option still misses the promised date (TMS quote ETA ' + quote.eta + ')');
  }
}

// The plan carries TMS values only. A wait writes the later of the carrier ETA and the agent's estimate.
const plan = !pick ? null : pick.type === 'wait'
  ? { type: 'wait', quote_id: null, new_eta: iso(Math.max(tmsEta, agentEta)), carrier: shp.current_booking?.carrier ?? shp.carrier ?? null, booking_quote_id: shp.current_booking?.quote_id ?? null }
  : { type: pick.type, quote_id: pick.quote_id ?? null, new_eta: quote ? iso(Date.parse(quote.eta ?? '')) : null, carrier: quote?.carrier ?? null, service: quote?.service ?? null, cost_delta: costDelta };
if (plan && !plan.new_eta && !reasons.length) reasons.push('no valid ETA to plan with');

const ok = reasons.length === 0;
return {
  json: {
    business_key: req.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    plan,
    customer_email: email || null,
    planned_actions: ok ? [{ action: plan.type === 'wait' ? 'tms.update_eta' : 'tms.rebook', quote_id: plan.quote_id, eta: plan.new_eta, carrier: plan.carrier, cost_delta: plan.type === 'wait' ? 0 : plan.cost_delta }] : [],
  },
};
`));
  wf.add(ifTrue('Auto re-plan?', [gx + 660, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, 'Re-read shipment (TMS)');
  wf.link('Re-read shipment (TMS)', 'Re-read quotes (TMS)', 0);
  wf.link('Re-read quotes (TMS)', GUARD, 0);
  wf.link(GUARD, 'Auto re-plan?');

  // ---------- act & verify ----------
  const ax = gx + 920;
  const plan = `$('${GUARD}').item.json.plan`;
  wf.add(ifTrue('Rebooking needed?', [ax, 0], `={{ $json.plan.type !== 'wait' }}`));
  wf.add(http('Book alternative (TMS)', [ax + 220, -130], {
    method: 'POST',
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}/rebook`,
    auth: tms,
    headers: { 'Idempotency-Key': `=rebook-{{ $('${INTAKE}').item.json.business_key }}` },
    json: `={{ JSON.stringify({ quote_id: $json.plan.quote_id, reason: 'carrier_exception', source_event_id: $('${INTAKE}').item.json.event_id, requested_by: 'aelix-shipment-agent' }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Update ETA (TMS)', [ax + 220, 130], {
    method: 'PATCH',
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}`,
    auth: tms,
    json: `={{ JSON.stringify({ eta: $json.plan.new_eta, exception_note: 'Carrier exception ' + $('${INTAKE}').item.json.event_code + ', ETA updated by aelix-shipment-agent' }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Read back shipment (TMS)', [ax + 440, 0], {
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}`,
    auth: tms,
    errorOutput: true,
  }));
  wf.add(code('Verify re-plan', [ax + 660, 0], `
// The read-back must match the plan built from TMS values. The customer notice then uses the
// carrier and ETA from this read-back, never text the agent wrote.
const plan = ${plan};
const s = $json;
const booking = s.current_booking ?? {};
const sameTime = (a, b) => {
  const x = Date.parse(a ?? '');
  const y = Date.parse(b ?? '');
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 60 * 1000;
};
const clean = (t) => String(t ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80);
const misses = [];
if (!sameTime(s.eta, plan.new_eta)) misses.push('ETA ' + plan.new_eta);
if (plan.type === 'wait') {
  if (plan.booking_quote_id != null && booking.quote_id !== plan.booking_quote_id) misses.push('unchanged booking ' + plan.booking_quote_id);
} else {
  if (booking.quote_id !== plan.quote_id) misses.push('booking ' + plan.quote_id);
  if (!clean(booking.carrier) || booking.carrier !== plan.carrier) misses.push('carrier ' + plan.carrier);
}
const ok = misses.length === 0;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'TMS does not show the planned ' + misses.join(', '),
    notice_type: plan.type,
    notice_eta: ok ? new Date(Date.parse(s.eta)).toISOString() : null,
    notice_carrier: ok ? clean(booking.carrier) : null,
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 880, 0], '={{ $json.verified }}'));
  wf.add(gmail('Notify customer', [ax + 1100, 0], {
    to: `={{ $('${GUARD}').item.json.customer_email }}`,
    subject: `=Update on your shipment {{ $('${INTAKE}').item.json.tracking_number }}`,
    message: `=Hello,

Your shipment {{ $('${INTAKE}').item.json.tracking_number }} ran into a delay in transit. It is now expected to arrive on {{ new Date($('Verify re-plan').item.json.notice_eta).toUTCString().slice(0, 16) }}.{{ $('Verify re-plan').item.json.notice_type !== 'wait' ? ' We have moved it to ' + $('Verify re-plan').item.json.notice_carrier + ' to keep it on schedule, at no cost to you.' : '' }}

We will let you know if anything changes. Reply to this email if you need to talk to someone.`,
  }));
  wf.add(setFields('Mark completed', [ax + 1320, 0], { outcome: 'completed' }));
  wf.link('Auto re-plan?', 'Rebooking needed?', 0);
  wf.link('Rebooking needed?', 'Book alternative (TMS)', 0);
  wf.link('Rebooking needed?', 'Update ETA (TMS)', 1);
  wf.link('Book alternative (TMS)', 'Read back shipment (TMS)', 0);
  wf.link('Update ETA (TMS)', 'Read back shipment (TMS)', 0);
  wf.link('Read back shipment (TMS)', 'Verify re-plan', 0);
  wf.link('Verify re-plan', 'Verified?');
  wf.link('Verified?', 'Notify customer', 0);
  wf.link('Notify customer', 'Mark completed');

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax + 220, y: 600, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'logistics ops', channel: `={{ ${cfg}.slack_channel }}`,
    summary: `'Shipment ' + intake.shipment_id + ' · ' + intake.event_code + ' · cause: ' + (agent?.output?.root_cause ?? 'unknown') + (agent?.output?.sla_at_risk ? ' · SLA at risk' : '')`,
  });
  wf.link(AGENT, h.first, 1);
  wf.link('Re-read shipment (TMS)', h.first, 1);
  wf.link('Re-read quotes (TMS)', h.first, 1);
  wf.link('Auto re-plan?', h.first, 1);
  wf.link('Book alternative (TMS)', h.first, 1);
  wf.link('Update ETA (TMS)', h.first, 1);
  wf.link('Read back shipment (TMS)', h.first, 1);
  wf.link('Verified?', h.first, 1);

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1580, y: 300, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: ['Carrier exception event', 'Config', INTAKE], body: `
Your visibility platform or carrier integration posts exception events (delay, missed pickup, damage, customs hold). One event is one run.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Trace and re-plan (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude reads the shipment, tracking history and SLA, names the root cause, estimates a new ETA, and when the promise is at risk gets **quotes** (quoting books nothing).
It recommends wait, rebook or expedite, and drafts the customer notice.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: ['Re-read shipment (TMS)', 'Re-read quotes (TMS)', GUARD, 'Auto re-plan?'], body: `
The shipment and its quotes are **re-read** from the TMS. Damage, customs, hazmat (event code or TMS flag) and address issues always go to a person, as does a shipment with no promised date or no customer email.
A paid option needs a quote the TMS issued, with a TMS cost under the limit and a TMS ETA that recovers the promise. A wait needs a carrier ETA in the TMS that meets the promise.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Act and verify', color: COLOR.act, nodes: ['Rebooking needed?', 'Book alternative (TMS)', 'Update ETA (TMS)', 'Read back shipment (TMS)', 'Verify re-plan', 'Verified?', 'Notify customer', 'Mark completed'], body: `
Rebooks on the quoted option (idempotent), or just updates the ETA. The TMS is read back and must show the planned booking, carrier and ETA before the customer gets the **templated** notice, filled from that read-back.` });
  wf.group({ name: 'Stage: hand off', title: '5 · Escalate', color: COLOR.handoff, nodes: h.nodes, body: `
Ops gets the root cause, the options with quotes, the drafted customer notice and the tool trace. They pick an option or open a claim.` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per carrier event.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    overview: `## Logistics · Shipment exception agent
**Job:** take carrier exceptions off the ops desk. Trace what happened, re-plan when the delivery promise is at risk, carry out small re-plans, and escalate the rest with options already priced.

**Flow:** carrier event → agent traces and quotes (read-only) → guardrails re-read and check → rebook or update ETA, read back, notify the customer → escalate the rest → audit.

**Never does**
- Books above the cost limit, or an option that still misses the promise
- Handles damage, customs, hazmat or address problems
- Re-plans when nobody can be told (no customer email in the TMS)
- Sends model-written text to customers

**Model:** Claude Opus 5, adaptive thinking, effort high.`,
    setup: `## Setup
1. Run **sql/schema.sql**. Select the Postgres credential on *Queue exception* and *Write audit record*.
2. Credentials: **Anthropic**, **Header Auth** for the TMS API, **Gmail**, **Slack**.
3. **TMS endpoints are a gateway contract**: shipments, events, order, quotes, rebook. The shipment record must carry promised_delivery, eta, hazmat, current_booking and customer.email; quotes must return the issued quote ids. Map them to your TMS (Oracle OTM, Blue Yonder, MercuryGate, e2open) or to project44 / FourKites for tracking.
4. Edit **Config**: TMS URL, cost limit, confidence floor, channel.
5. Test: \`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/logistics-shipment-exception.json\``,
  });

  return wf;
}
