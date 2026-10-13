// Echo Optima · Replenishment Agent
// Catalogue: "Spots reorder needs and proposes changes with rationale. Planners approve above set limits."
// Pattern: envelope. Small, ordinary reorders go through on their own; anything above the limits waits for the planner.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

export const sample = {
  signals: [
    { signal_id: 'RS-90211', sku: 'CTN-3340-BLK', location: 'DC-DAL', signal: 'projected_stockout', projected_stockout_date: '2026-10-24' },
    { signal_id: 'RS-90212', sku: 'PAL-WRAP-18', location: 'DC-ATL', signal: 'demand_spike', projected_stockout_date: '2026-10-19' },
  ],
};

export default () => productAgent({
  industry: 'Logistics',
  product: 'Echo Optima',
  agent: 'Replenishment Agent',
  slug: 'logistics-optima-replenishment',
  dir: 'logistics',
  file: 'optima-replenishment',
  mode: 'envelope',
  job: 'take routine reorder decisions off the planning desk. For each replenishment signal, check stock, demand, lead time and open orders, and propose a new order, an expedite, a reduction or no change, with the reasoning.',
  approves: 'the inventory planner approves anything above the order value or quantity limits, any expedite or reduction, and any non-preferred supplier',
  never: [
    'Places an order above the value or quantity limits without the planner',
    'Orders from a supplier that is not approved for the item',
    'Changes or cancels an existing purchase order without the planner',
  ],
  team: 'inventory planning',
  trigger: {
    kind: 'schedule',
    minutes: 60,
    fetch: { url: `={{ $('Config').first().json.gateway_url }}/replenishment/signals`, query: { status: 'open', limit: '50' }, field: 'signals' },
  },
  config: {
    gateway_url: 'https://optima-gateway.YOUR-COMPANY.example/api/v1',
    auto_order_max_value: 15000,
    max_weeks_of_cover: 8,
    min_confidence: 0.85,
    approver_slack_user: 'inventory-planner',
    approval_timeout_hours: 8,
    slack_channel: '#replenishment',
  },
  intake: {
    name: 'Normalize signal',
    js: `
const s = $json;
return {
  json: {
    business_key: String(s.signal_id),
    signal_id: String(s.signal_id),
    sku: String(s.sku),
    location: String(s.location),
    signal: String(s.signal ?? 'unspecified'),
    projected_stockout_date: s.projected_stockout_date ?? null,
  },
};
`,
  },
  agentSpec: {
    name: 'Replenishment agent',
    effort: 'medium',
    prompt: `=Replenishment signal {{ $json.signal_id }}: {{ $json.signal }}
SKU {{ $json.sku }} at {{ $json.location }}
Projected stockout: {{ $json.projected_stockout_date ?? 'not given' }}

Decide whether this item needs a new order, an expedite, a reduction, or no change, and size it.`,
    system: `
You are the replenishment agent in Echo Optima for a logistics operator. You turn replenishment signals into concrete proposals. Small, ordinary reorders run automatically inside limits the planner set; everything else goes to the planner.

How to size a proposal:
- Read the position (on hand, allocated, in transit, on order) and the demand forecast for the next twelve weeks.
- Read the supplier terms: lead time, minimum order quantity, case pack, unit cost, whether the supplier is approved for this item.
- Order enough to cover demand through lead time plus safety stock, rounded up to the case pack and at least the MOQ. Do not order beyond the weeks of cover the planner allows.
- If an open purchase order already covers the need, propose expedite or no change instead of a new order.

Proposal types: new_order, expedite_existing, reduce_existing, no_change.

Tools:
- "Get item position", "Get demand forecast", "Get supplier terms", "List open purchase orders".
`,
    tools: [
      { name: 'Get item position', description: 'Get inventory position for one SKU at one location: on hand, allocated, in transit, on order, average weekly demand over 8 weeks.', url: `={{ $('Config').first().json.gateway_url }}/positions/{{ $fromAI('location', 'Location code', 'string') }}/{{ $fromAI('sku', 'SKU', 'string') }}` },
      { name: 'Get demand forecast', description: 'Get the weekly demand forecast for one SKU at one location for the next 12 weeks, with forecast error.', url: `={{ $('Config').first().json.gateway_url }}/forecasts/{{ $fromAI('location', 'Location code', 'string') }}/{{ $fromAI('sku', 'SKU', 'string') }}` },
      { name: 'Get supplier terms', description: 'Get the supplier options for a SKU: supplier id, approved flag, lead time in days, MOQ, case pack, unit cost.', url: `={{ $('Config').first().json.gateway_url }}/items/{{ $fromAI('sku', 'SKU', 'string') }}/suppliers` },
      { name: 'List open purchase orders', description: 'List open purchase orders for a SKU at a location, with quantities, dates and status.', url: `={{ $('Config').first().json.gateway_url }}/purchase-orders`, query: { sku: `={{ $fromAI('sku', 'SKU', 'string') }}`, location: `={{ $fromAI('location', 'Location code', 'string') }}`, status: 'open' } },
    ],
    schema: S.obj({
      proposal_type: S.enum(['new_order', 'expedite_existing', 'reduce_existing', 'no_change'], 'What to do.'),
      supplier_id: S.nullable(S.str('Supplier for a new order, or null.')),
      order_qty: S.int('Units to order. 0 unless new_order.'),
      unit_cost: S.num('Unit cost used, 0 if not ordering.'),
      purchase_order_id: S.nullable(S.str('Existing PO to expedite or reduce, or null.')),
      needed_by: S.nullable(S.str('ISO date the stock is needed by.')),
      weeks_of_cover_after: S.num('Weeks of cover after the proposal lands.'),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read supplier terms',
    url: `={{ $('Config').first().json.gateway_url }}/items/{{ $('Normalize signal').item.json.sku }}/suppliers`,
  },
  guard: `
const suppliers = $json.suppliers ?? [];
const t = out?.proposal_type;
const sup = suppliers.find((s) => s.supplier_id === out?.supplier_id);
const qty = Number(out?.order_qty ?? 0);
const value = sup ? qty * Number(sup.unit_cost) : Infinity;
const noop = t === 'no_change';

if (t === 'new_order') {
  if (!sup) reasons.push('supplier ' + out?.supplier_id + ' not found for ' + req.sku);
  else {
    if (!sup.approved) reasons.push('supplier ' + sup.supplier_id + ' is not approved for this item');
    if (qty < sup.moq) reasons.push('quantity ' + qty + ' below MOQ ' + sup.moq);
    if (sup.case_pack && qty % sup.case_pack !== 0) reasons.push('quantity ' + qty + ' is not a multiple of case pack ' + sup.case_pack);
    if (Math.abs(Number(sup.unit_cost) - Number(out.unit_cost)) > 0.01) reasons.push('agent unit cost ' + out.unit_cost + ' differs from supplier terms ' + sup.unit_cost);
  }
  if (!(qty > 0)) reasons.push('new order with no quantity');
}
if ((t === 'expedite_existing' || t === 'reduce_existing') && !out?.purchase_order_id) reasons.push(t + ' without a purchase order id');
if ((out?.weeks_of_cover_after ?? 0) > cfg.max_weeks_of_cover) reasons.push('cover after proposal ' + out.weeks_of_cover_after + ' weeks exceeds ' + cfg.max_weeks_of_cover);

// The envelope: a new order, preferred approved supplier, under the value limit.
const withinEnvelope = t === 'new_order' && !!sup?.approved && !!sup?.preferred && value <= cfg.auto_order_max_value;

const action = { type: t, sku: req.sku, location: req.location, supplier_id: out?.supplier_id ?? null, qty, value: Number.isFinite(value) ? Math.round(value * 100) / 100 : null, purchase_order_id: out?.purchase_order_id ?? null, needed_by: out?.needed_by ?? null };
const summary = req.sku + ' at ' + req.location + ': *' + t + '*'
  + (t === 'new_order' ? ' of ' + qty + ' units from ' + out.supplier_id + ' (value ' + action.value + ')' : '')
  + (out?.purchase_order_id ? ' on PO ' + out.purchase_order_id : '') + '.\\n' + (out?.rationale ?? '');
`,
  act: {
    write: {
      name: 'Submit replenishment change',
      method: 'POST',
      url: `={{ $('Config').first().json.gateway_url }}/replenishment/proposals`,
      headers: { 'Idempotency-Key': `=repl-{{ $('Normalize signal').item.json.signal_id }}` },
      json: `={{ JSON.stringify({ signal_id: $('Normalize signal').item.json.signal_id, ...$('Guardrails').item.json.action, approved_by: $('Guardrails').item.json.route === 'auto' ? 'envelope:auto_order_max_value' : $('Record approval').item.json.approver, source: 'aelix-replenishment-agent' }) }}`,
    },
    readBack: {
      name: 'Read back signal',
      url: `={{ $('Config').first().json.gateway_url }}/replenishment/signals/{{ $('Normalize signal').item.json.signal_id }}`,
    },
    verify: `
const ok = $json.status === 'actioned' && $json.action?.type === planned.type && Number($json.action?.qty ?? 0) === Number(planned.qty);
const detail = 'signal shows ' + $json.status + ' with ' + JSON.stringify($json.action ?? null);
`,
  },
  handoffSummary: `intake.sku + ' at ' + intake.location + ' · ' + intake.signal + ' · proposed ' + (agent?.output?.proposal_type ?? 'none')`,
  stickies: {
    intake: 'Every hour, open replenishment signals (projected stockouts, demand spikes) are pulled and handled one at a time. **Config** holds the auto-order value limit, weeks-of-cover cap and the named planner.',
    plan: 'Claude reads position, forecast, supplier terms and open POs, then proposes a new order, an expedite, a reduction or no change, sized to MOQ and case pack. Effort is **medium**: high volume, bounded reasoning.',
    guard: 'Supplier terms are **re-read**. Code checks supplier approval, MOQ, case pack, unit cost and cover. **Inside the envelope** (new order, preferred approved supplier, under the value limit) it goes straight to act; otherwise the planner is asked. "No change" is recorded, not escalated.',
    act: 'One idempotent submission per signal, then the signal is read back. It counts only if it shows the change that was planned.',
  },
  setup: [
    '**Gateway contract**: replenishment signals and proposals, positions, forecasts, item suppliers, purchase orders. Map to your WMS/ERP (Blue Yonder, Manhattan, SAP EWM, NetSuite).',
    'Set **auto_order_max_value** with the planning lead. Start low and raise it once the first weeks of audit rows look right.',
  ],
});
