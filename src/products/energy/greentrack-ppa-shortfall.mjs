// Aelix GreenTrack · PPA Shortfall Agent
// Catalogue: "Compares metered generation with PPA obligations and alerts before the period closes, with a replacement-power recommendation."
// Pattern: draft. The alert and replacement-power recommendation go to the named energy trader; nothing is bought or nominated.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

const PRODUCTS = ['forward_block', 'day_ahead', 'real_time', 'portfolio_transfer', 'none'];

export const sample = {
  contracts: [
    { contract_id: 'PPA-WND-0217', project_id: 'PRJ-HIGHRIDGE-WIND', offtaker: 'Offtaker A', period_id: '2026-Q4', period_start: '2026-10-01', period_end: '2026-12-31', delivery_node: 'HUB-NORTH' },
    { contract_id: 'PPA-SOL-0388', project_id: 'PRJ-MESA-SOLAR', offtaker: 'Offtaker B', period_id: '2026-10', period_start: '2026-10-01', period_end: '2026-10-31', delivery_node: 'HUB-SOUTH' },
  ],
};

export default () => productAgent({
  industry: 'Energy and Utilities',
  product: 'Aelix GreenTrack',
  agent: 'PPA Shortfall Agent',
  slug: 'energy-greentrack-ppa-shortfall',
  dir: 'energy',
  file: 'greentrack-ppa-shortfall',
  mode: 'draft',
  job: 'take PPA position monitoring off the commercial desk of a utility-scale IPP. For each active contract period, compare metered generation and the remaining forecast with the delivery obligation, and alert the energy trader before the period closes with a sized replacement-power recommendation.',
  approves: 'the energy trader or commercial lead decides on, buys and nominates any replacement power',
  never: [
    'Buys, sells or nominates power, or books a trade in the ETRM',
    'Contacts the offtaker',
    'Reports a delivered or shortfall volume that has not been recomputed from metered generation and the contract',
    'Alerts on a period that has already closed',
  ],
  team: 'commercial operations',
  trigger: {
    kind: 'schedule',
    minutes: 360,
    fetch: {
      url: `={{ $('Config').first().json.gateway_url }}/greentrack/ppa/contracts`,
      // The gateway screens positions; contracts on track are only fetched when "no shortfall" drafts are wanted.
      query: { status: 'active', period: 'open', include_on_track: `={{ $('Config').first().json.send_no_shortfall_drafts }}` },
      field: 'contracts',
    },
  },
  config: {
    gateway_url: 'https://greentrack-gateway.YOUR-IPP.example/api/v1',
    send_no_shortfall_drafts: false,
    shortfall_tolerance_mwh: 5,
    // Replacement volume may exceed the projected shortfall by this fraction (forecast error cover).
    max_replacement_headroom: 0.2,
    urgent_days_to_close: 10,
    min_confidence: 0.8,
    reviewer_slack_user: 'energy-trader',
    slack_channel: '#ppa-positions',
  },
  intake: {
    name: 'Normalize contract period',
    js: `
const c = $json;
const missing = ['contract_id', 'project_id', 'period_id', 'period_end'].filter((k) => c[k] == null || c[k] === '');
if (missing.length) throw new Error('PPA contract period missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(c.contract_id) + ':' + String(c.period_id),
    contract_id: String(c.contract_id),
    project_id: String(c.project_id),
    offtaker: String(c.offtaker ?? ''),
    period_id: String(c.period_id),
    period_start: String(c.period_start ?? '').slice(0, 10),
    period_end: String(c.period_end).slice(0, 10),
    delivery_node: String(c.delivery_node ?? ''),
  },
};
`,
  },
  agentSpec: {
    name: 'PPA shortfall agent',
    effort: 'medium',
    prompt: `=PPA {{ $json.contract_id }} · project {{ $json.project_id }} · offtaker {{ $json.offtaker || 'not given' }}
Period {{ $json.period_id }}: {{ $json.period_start }} to {{ $json.period_end }} · delivery node {{ $json.delivery_node || 'not given' }}

Compare metered generation and the remaining forecast with the delivery obligation for this period, and recommend replacement power if a shortfall is projected.`,
    system: `
You monitor power purchase agreement positions for a utility-scale independent power producer on Aelix GreenTrack. You compare what a project has delivered and is forecast to deliver with what the contract requires for the period, and alert the energy trader early. You recommend; the trader decides, buys and nominates. You never trade.

How to assess:
- Read the contract terms for the period: contracted volume, minimum delivery obligation (after any tolerance band), shortfall remedy and price, delivery node.
- Sum metered generation from the period start to date. Use the settlement-quality meter data, not SCADA estimates.
- Read the remaining-period forecast (P50 and P90) and planned outages or curtailment that the forecast may not include.
- projected_shortfall_mwh = max(0, minimum obligation minus (delivered to date plus P50 forecast remaining)).

Replacement power, when a shortfall is projected:
- Choose forward_block, day_ahead, real_time or portfolio_transfer (surplus from another project in the portfolio delivered at the same node). Size the volume to the shortfall, with modest cover for forecast error.
- Delivery must fall inside the contract period. Give the indicative price from the forward price tool for the product and window, or null for a portfolio transfer.
- Compare the indicative replacement cost with the contract shortfall remedy in the rationale.
- When no shortfall is projected, set product to none and volume to 0.

Tools:
- "Get PPA terms (ETRM)", "Get metered generation", "Get generation forecast", "List planned outages and curtailment", "Get forward prices (ETRM)".
`,
    tools: [
      { name: 'Get PPA terms (ETRM)', description: 'Get a PPA and its period terms from the ETRM: contracted MWh, minimum delivery obligation, tolerance band, shortfall remedy and price per MWh, delivery node, period dates.', url: `={{ $('Config').first().json.gateway_url }}/etrm/contracts/{{ $fromAI('contract_id', 'Contract id', 'string') }}`, query: { period_id: `={{ $fromAI('period_id', 'Period id', 'string') }}` } },
      { name: 'Get metered generation', description: 'Get settlement-quality daily metered generation in MWh for a project between two dates.', url: `={{ $('Config').first().json.gateway_url }}/greentrack/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/generation`, query: { from: `={{ $fromAI('from', 'ISO date', 'string') }}`, to: `={{ $fromAI('to', 'ISO date', 'string') }}` } },
      { name: 'Get generation forecast', description: 'Get the P50 and P90 generation forecast in MWh for a project from tomorrow to a date.', url: `={{ $('Config').first().json.gateway_url }}/greentrack/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/forecast`, query: { to: `={{ $fromAI('to', 'ISO date', 'string') }}` } },
      { name: 'List planned outages and curtailment', description: 'List planned maintenance outages and expected curtailment for a project up to a date, with MWh impact where known.', url: `={{ $('Config').first().json.gateway_url }}/greentrack/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/availability`, query: { to: `={{ $fromAI('to', 'ISO date', 'string') }}` } },
      { name: 'Get forward prices (ETRM)', description: 'Get current forward and day-ahead prices per MWh at a node for delivery windows up to a date, by product.', url: `={{ $('Config').first().json.gateway_url }}/etrm/prices`, query: { node: `={{ $fromAI('node', 'Delivery node', 'string') }}`, to: `={{ $fromAI('to', 'ISO date', 'string') }}` } },
    ],
    schema: S.obj({
      delivered_to_date_mwh: S.num('Metered generation in the period to date.'),
      forecast_remaining_mwh: S.num('P50 forecast for the rest of the period.'),
      min_obligation_mwh: S.num('Minimum delivery obligation for the period.'),
      projected_shortfall_mwh: S.num('max(0, obligation minus delivered plus forecast).'),
      shortfall_drivers: S.arr(S.str(), 'Why delivery is short: resource, outages, curtailment.'),
      replacement: S.obj({
        product: S.enum(PRODUCTS, 'Replacement product, or none.'),
        volume_mwh: S.num('Replacement volume, 0 for none.'),
        delivery_from: S.nullable(S.str('ISO date.')),
        delivery_to: S.nullable(S.str('ISO date.')),
        indicative_price_per_mwh: S.nullable(S.num('From the forward price tool, or null.')),
      }),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read contract position',
    url: `={{ $('Config').first().json.gateway_url }}/greentrack/ppa/contracts/{{ $('Normalize contract period').item.json.contract_id }}/position`,
    query: { period_id: `={{ $('Normalize contract period').item.json.period_id }}` },
  },
  guard: `
const p = $json; // fresh contract terms, metered generation, forecast and prices for the period
const r1 = (n) => Math.round(n * 10) / 10;
const start = String(p.period_start ?? req.period_start).slice(0, 10);
const end = String(p.period_end ?? req.period_end).slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const daysToClose = Math.ceil((Date.parse(end) - Date.parse(today)) / 86400000);

// Recompute the position from metered generation and the contract.
const delivered = r1((p.metered ?? []).filter((m) => { const d = String(m.date).slice(0, 10); return d >= start && d <= end; }).reduce((s, m) => s + Number(m.mwh ?? 0), 0));
const forecast = r1(Number(p.forecast_remaining_mwh_p50 ?? 0));
const obligation = Number(p.min_delivery_mwh);
const shortfall = r1(Math.max(0, obligation - (delivered + forecast)));
const exposure = Math.round(shortfall * Number(p.shortfall_price_per_mwh ?? 0) * 100) / 100;
const rep = out?.replacement ?? { product: 'none', volume_mwh: 0 };

if (p.contract_id && p.contract_id !== req.contract_id) reasons.push('position read returned ' + p.contract_id + ', not ' + req.contract_id);
if (!(obligation > 0)) reasons.push('contract has no minimum delivery obligation for ' + req.period_id);
if (daysToClose < 0) reasons.push('period ' + req.period_id + ' closed on ' + end);
if (out && Math.abs(Number(out.delivered_to_date_mwh) - delivered) > 1) reasons.push('agent delivered ' + out.delivered_to_date_mwh + ' MWh, metered data gives ' + delivered + ' MWh');
if (out && Math.abs(Number(out.projected_shortfall_mwh) - shortfall) > cfg.shortfall_tolerance_mwh) reasons.push('agent shortfall ' + out.projected_shortfall_mwh + ' MWh, recomputed ' + shortfall + ' MWh');

if (shortfall > 0 && out) {
  if (rep.product === 'none') reasons.push('shortfall of ' + shortfall + ' MWh projected but no replacement recommended');
  else {
    const vol = Number(rep.volume_mwh);
    if (vol < shortfall) reasons.push('replacement ' + vol + ' MWh does not cover the shortfall of ' + shortfall + ' MWh');
    if (vol > shortfall * (1 + cfg.max_replacement_headroom)) reasons.push('replacement ' + vol + ' MWh is more than the shortfall plus ' + Math.round(cfg.max_replacement_headroom * 100) + ' percent headroom');
    if (!rep.delivery_from || !rep.delivery_to || rep.delivery_from < today || rep.delivery_to > end || rep.delivery_from > rep.delivery_to) reasons.push('replacement delivery ' + rep.delivery_from + ' to ' + rep.delivery_to + ' is not inside ' + today + ' to ' + end);
    if (rep.product !== 'portfolio_transfer') {
      const quote = (p.forward_prices ?? []).find((q) => q.product === rep.product && String(q.delivery_from).slice(0, 10) <= rep.delivery_from && String(q.delivery_to).slice(0, 10) >= rep.delivery_to);
      if (!quote) reasons.push('no ' + rep.product + ' price in the fresh read covers ' + rep.delivery_from + ' to ' + rep.delivery_to);
      else if (Math.abs(Number(quote.price_per_mwh) - Number(rep.indicative_price_per_mwh)) > 0.01) reasons.push('indicative price ' + rep.indicative_price_per_mwh + ' differs from the ETRM price ' + quote.price_per_mwh);
    }
  }
}
if (shortfall === 0 && out && rep.product !== 'none') reasons.push('replacement recommended but no shortfall is projected');

const urgent = shortfall > 0 && daysToClose <= cfg.urgent_days_to_close;
const draft = {
  status: 'draft_no_trade',
  contract_id: req.contract_id,
  project_id: req.project_id,
  period_id: req.period_id,
  period_end: end,
  days_to_close: daysToClose,
  position: { min_obligation_mwh: obligation, delivered_to_date_mwh: delivered, forecast_remaining_mwh_p50: forecast, projected_shortfall_mwh: shortfall, shortfall_remedy_exposure: exposure },
  shortfall_projected: shortfall > 0,
  shortfall_drivers: out?.shortfall_drivers ?? [],
  replacement: shortfall > 0 ? rep : null,
  rationale: out?.rationale ?? '',
};
const summary = shortfall > 0
  ? (urgent ? ':warning: *' + daysToClose + ' days to period close.* ' : '') + 'PPA ' + req.contract_id + ' · ' + req.period_id + ': projected shortfall *' + shortfall + ' MWh* (obligation ' + obligation + ', delivered ' + delivered + ', forecast ' + forecast + '). Remedy exposure ' + exposure + '.\\n'
    + 'Recommended replacement: ' + rep.product + ' ' + rep.volume_mwh + ' MWh, ' + rep.delivery_from + ' to ' + rep.delivery_to + (rep.indicative_price_per_mwh != null ? ' at about ' + rep.indicative_price_per_mwh + ' per MWh' : '') + '.\\nNothing has been bought or nominated.'
  : 'PPA ' + req.contract_id + ' · ' + req.period_id + ': no shortfall projected (obligation ' + obligation + ', delivered ' + delivered + ', forecast ' + forecast + ' MWh). No action needed.';
`,
  handoffSummary: `'PPA ' + intake.contract_id + ' · ' + intake.period_id + ' · position could not be confirmed'`,
  stickies: {
    intake: 'Every six hours, open PPA contract periods are pulled and handled one at a time. Contracts on track are only fetched when **send_no_shortfall_drafts** is on. **Config** holds the shortfall tolerance, replacement headroom, urgency window and the named trader.',
    plan: 'Claude reads the PPA terms, metered generation, the remaining forecast, planned outages and forward prices, works out the projected shortfall and sizes a replacement-power recommendation. Effort is **medium**: routine, bounded reasoning.',
    guard: 'The contract position is **re-read**. Delivered volume, projected shortfall and remedy exposure are **recomputed in code** from metered generation and the contract. The replacement must cover the shortfall without excess, deliver inside the period, and carry a price the ETRM returned. Closed periods go to a person.',
    act: 'The alert and recommendation are saved to **agent_drafts** and the named energy trader gets a direct message. **Nothing is bought, sold or nominated.**',
  },
  setup: [
    '**Gateway contract**: open PPA contract periods (list, with an on-track filter), etrm contracts and prices, project generation, forecast and availability, a combined contract position read. Map to your ETRM (Allegro, Endur, Enverus), revenue-grade meter data and forecasting service.',
    'With **send_no_shortfall_drafts** off, the gateway should leave on-track contracts out of the list. If one still arrives, the trader gets a short "no shortfall projected" draft.',
  ],
});
