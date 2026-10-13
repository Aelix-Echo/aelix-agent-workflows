// Logistics: deterministic Code nodes from workflows/04-logistics-shipment-exceptions.json, run against fixed scenarios.

import assert from 'node:assert/strict';
import { load, run, test } from '../helpers.mjs';

const wf = load('04-logistics-shipment-exceptions.json');
console.log('Logistics · Shipment exceptions');
const Config = { max_rebook_cost_delta: 300, min_confidence: 0.85 };
const req = { business_key: 'S-1:E-1', shipment_id: 'S-1', event_code: 'DELAYED' };
// One clock for the whole file: two separate Date.now() calls can differ by a millisecond,
// which made exact ETA comparisons flaky.
const NOW = Date.now();
const inDays = (n) => new Date(NOW + n * 86400000).toISOString();
const promised = inDays(3);
const agent = (o = {}) => ({ output: {
  root_cause: 'weather', recommend_escalate: false, promised_delivery: promised, recommended_option_id: 'opt-2',
  options: [
    // A wait whose ETA meets the promise (the old fixture used a 5 day ETA, which misses it).
    { option_id: 'opt-1', type: 'wait', quote_id: null, cost_delta: 0, eta: inDays(2.5), carrier: 'A' },
    { option_id: 'opt-2', type: 'rebook', quote_id: 'Q-9', cost_delta: 180, eta: inDays(2), carrier: 'B' },
  ], confidence: 0.9, ...o } });
// Fresh TMS read of the shipment.
const shp = {
  shipment_id: 'S-1', status: 'in_transit', promised_delivery: promised, eta: inDays(2.5), hazmat: false, currency: 'USD',
  carrier: 'A', current_booking: { quote_id: 'BKG-ORIG', carrier: 'A', cost: 2000, currency: 'USD' },
  customer: { email: 'c@example.com' },
};
// Fresh TMS read of the quotes it issues for the shipment.
const tq = (o = {}) => ({ quote_id: 'Q-9', type: 'rebook', carrier: 'TMS Carrier B', service: 'Team', cost: 2180, cost_delta: 180, currency: 'USD', eta: inDays(2), valid_until: inDays(0.25), ...o });
const quotes = (list = [tq()], o = {}) => ({ shipment_id: 'S-1', current_cost: 2000, currency: 'USD', quotes: list, booked: false, ...o });
const g = (a, { s = shp, q = quotes(), r = req } = {}) => run(wf, 'Guardrails', {
  json: q,
  nodes: { Config, 'Normalize event': r, 'Shipment exception agent': a, 'Re-read shipment (TMS)': s },
});
const why = (out) => out.guardrail_reasons.join('; ');
const escalates = (out, re) => {
  assert.equal(out.route, 'escalate');
  assert.deepEqual(out.planned_actions, []);
  if (re) assert.ok(out.guardrail_reasons.some((x) => re.test(x)), why(out));
};

// ---------- existing behaviour ----------
test('rebook within budget routes auto', () => {
  const out = g(agent());
  assert.equal(out.route, 'auto', why(out));
  assert.equal(out.plan.quote_id, 'Q-9');
});
test('rebook over budget escalates', () => escalates(g(
  agent({ options: agent().output.options.map((o) => ({ ...o, cost_delta: 900 })) }),
  { q: quotes([tq({ cost: 2900, cost_delta: 900 })]) },
), /above 300/));
test('damage always escalates', () => escalates(g(agent(), { r: { ...req, event_code: 'DAMAGED' } }), /event code DAMAGED/));
test('wait option routes auto', () => assert.equal(g(agent({ recommended_option_id: 'opt-1' })).route, 'auto'));
test('delivered shipment escalates', () => escalates(g(agent(), { s: { ...shp, status: 'delivered' } }), /delivered/));

// ---------- 1: cost and ETA come from the TMS quote, not the agent ----------
test('plan carries the TMS quote carrier, ETA and cost, not the agent figures', () => {
  const out = g(agent());
  assert.equal(out.route, 'auto', why(out));
  assert.equal(out.plan.carrier, 'TMS Carrier B');
  assert.equal(out.plan.new_eta, tq().eta);
  assert.equal(out.plan.cost_delta, 180);
  assert.equal(out.planned_actions[0].eta, tq().eta);
});
test('injected cost_delta 0 on an over-limit TMS quote escalates', () => {
  const a = agent({ options: [{ option_id: 'opt-2', type: 'rebook', quote_id: 'Q-9', cost_delta: 0, eta: inDays(1), carrier: 'Air' }] });
  escalates(g(a, { q: quotes([tq({ cost: 3650, cost_delta: 1650 })]) }), /TMS cost delta 1650 above 300/);
});
test('agent cost delta that disagrees with the TMS escalates even under the limit', () => {
  const a = agent({ options: [{ option_id: 'opt-2', type: 'rebook', quote_id: 'Q-9', cost_delta: 0, eta: inDays(2), carrier: 'B' }] });
  escalates(g(a), /TMS quote says 180/);
});
test('quote cost minus current booking cost above the limit escalates even if cost_delta is low', () => {
  const a = agent({ options: [{ option_id: 'opt-2', type: 'rebook', quote_id: 'Q-9', cost_delta: 180, eta: inDays(2), carrier: 'B' }] });
  escalates(g(a, { q: quotes([tq({ cost: 2900, cost_delta: 180 })]) }), /TMS cost delta 900 above 300/);
});
test('TMS quote with no cost delta escalates', () => escalates(g(agent(), { q: quotes([tq({ cost_delta: undefined, cost: undefined })]) }), /no usable cost delta/));
test('agent ETA in time but TMS quote ETA misses the promise escalates', () => escalates(g(agent(), { q: quotes([tq({ eta: inDays(4) })]) }), /TMS quote ETA/));
test('quote id the TMS did not issue escalates', () => escalates(g(agent(), { q: quotes([tq({ quote_id: 'Q-OTHER' })]) }), /not among the quotes/));
test('empty TMS quote list escalates', () => escalates(g(agent(), { q: { shipment_id: 'S-1' } }), /not among the quotes/));
test('quotes for another shipment escalate', () => escalates(g(agent(), { q: quotes([tq()], { shipment_id: 'S-2' }) }), /different shipment/));
test('expired TMS quote escalates', () => escalates(g(agent(), { q: quotes([tq({ valid_until: inDays(-0.1) })]) }), /expired/));
test('TMS quote type differing from the option escalates', () => escalates(g(agent(), { q: quotes([tq({ type: 'expedite' })]) }), /not a rebook/));
test('TMS quote currency differing from the shipment escalates', () => escalates(g(agent(), { q: quotes([tq({ currency: 'EUR' })]) }), /currency/));

// ---------- 2: a wait must meet the promise on the TMS carrier ETA ----------
test('wait whose TMS carrier ETA misses the promise escalates', () => escalates(
  g(agent({ recommended_option_id: 'opt-1' }), { s: { ...shp, eta: inDays(5) } }),
  /carrier ETA in the TMS/,
));
test('wait whose agent ETA misses the promise escalates', () => {
  const a = agent({ recommended_option_id: 'opt-1', options: [{ option_id: 'opt-1', type: 'wait', quote_id: null, cost_delta: 0, eta: inDays(5), carrier: 'A' }] });
  escalates(g(a), /agent ETA misses/);
});
test('wait with no carrier ETA in the TMS escalates', () => escalates(g(agent({ recommended_option_id: 'opt-1' }), { s: { ...shp, eta: null } }), /no valid current ETA/));
test('wait plan uses the later ETA and the TMS carrier', () => {
  const a = agent({ recommended_option_id: 'opt-1', options: [{ option_id: 'opt-1', type: 'wait', quote_id: null, cost_delta: 0, eta: inDays(1), carrier: 'Model text' }] });
  const out = g(a);
  assert.equal(out.route, 'auto', why(out));
  assert.equal(out.plan.new_eta, shp.eta);
  assert.equal(out.plan.carrier, 'A');
  assert.equal(out.plan.booking_quote_id, 'BKG-ORIG');
});

// ---------- 4: hazmat flag and defensive event code matching ----------
for (const c of ['DAMAGE', 'damaged', 'Customs', 'CUSTOMS_HOLD', 'customs-hold', 'HAZMAT', 'haz_mat', 'DANGEROUS_GOODS', 'address issue', 'ADDRESS_CORRECTION']) {
  test(`event code ${c} escalates`, () => escalates(g(agent(), { r: { ...req, event_code: c } }), /always goes to a person/));
}
test('ordinary delay code does not trip the person-only rule', () => assert.equal(g(agent(), { r: { ...req, event_code: 'delayed' } }).route, 'auto'));
test('TMS hazmat flag escalates on a plain delay', () => escalates(g(agent(), { s: { ...shp, hazmat: true } }), /flagged hazmat/));
test('TMS hazmat flag as text escalates', () => escalates(g(agent(), { s: { ...shp, hazmat: 'UN1203' } }), /flagged hazmat/));
test('missing TMS hazmat flag escalates', () => {
  const { hazmat, ...s } = shp;
  escalates(g(agent(), { s }), /no hazmat flag/);
});

// ---------- 5: no customer email ----------
test('no customer email in the TMS escalates before acting', () => escalates(g(agent(), { s: { ...shp, customer: {} } }), /no usable customer email/));
test('malformed customer email escalates', () => escalates(g(agent(), { s: { ...shp, customer: { email: 'not an email' } } }), /no usable customer email/));

// ---------- 6: promised date from the TMS only ----------
test('no TMS promised date escalates even when the agent gives one', () => {
  const out = g(agent(), { s: { ...shp, promised_delivery: null } });
  escalates(out, /no valid promised delivery/);
});
test('TMS returning a different shipment escalates', () => escalates(g(agent(), { s: { ...shp, shipment_id: 'S-2' } }), /different shipment/));

// ---------- 3: verify compares the booking with the TMS quote; the notice uses the read-back ----------
const rebookPlan = { type: 'rebook', quote_id: 'Q-9', new_eta: tq().eta, carrier: 'TMS Carrier B' };
const readBack = (o = {}) => ({ ...shp, eta: tq().eta, current_booking: { quote_id: 'Q-9', carrier: 'TMS Carrier B', cost: 2180 }, ...o });
const v = (plan, json) => run(wf, 'Verify re-plan', { json, nodes: { Guardrails: { plan } } });
test('verify passes when booking, carrier and ETA match the TMS quote', () => {
  const out = v(rebookPlan, readBack());
  assert.equal(out.verified, true, out.verify_detail);
  assert.equal(out.notice_carrier, 'TMS Carrier B');
  assert.equal(out.notice_eta, tq().eta);
});
test('verify fails when the booked carrier differs from the quote', () => {
  const out = v(rebookPlan, readBack({ current_booking: { quote_id: 'Q-9', carrier: 'Someone Else' } }));
  assert.equal(out.verify_failed, true);
  assert.match(out.verify_detail, /carrier/);
  assert.equal(out.notice_carrier, null);
});
test('verify fails when the booked ETA differs from the quote', () => {
  const out = v(rebookPlan, readBack({ eta: inDays(4) }));
  assert.equal(out.verify_failed, true);
  assert.match(out.verify_detail, /ETA/);
});
test('verify fails when the booking is not the quoted one', () => assert.equal(v(rebookPlan, readBack({ current_booking: { quote_id: 'Q-1', carrier: 'TMS Carrier B' } })).verify_failed, true));
test('verify wait passes on matching ETA with the booking unchanged', () => {
  const plan = { type: 'wait', quote_id: null, new_eta: shp.eta, carrier: 'A', booking_quote_id: 'BKG-ORIG' };
  const out = v(plan, shp);
  assert.equal(out.verified, true, out.verify_detail);
  assert.equal(out.notice_type, 'wait');
});
test('verify wait fails if the booking changed', () => {
  const plan = { type: 'wait', quote_id: null, new_eta: shp.eta, carrier: 'A', booking_quote_id: 'BKG-ORIG' };
  assert.equal(v(plan, { ...shp, current_booking: { quote_id: 'Q-X', carrier: 'Z' } }).verify_failed, true);
});
test('customer email uses the TMS read-back, not the model plan', () => {
  const body = JSON.stringify(wf.nodes.find((n) => n.name === 'Notify customer').parameters);
  assert.ok(body.includes('notice_carrier') && body.includes('notice_eta'));
  assert.ok(!body.includes('.plan.carrier') && !body.includes('.plan.new_eta'));
});

// ---------- wiring ----------
test('quotes are re-read from the TMS before the guardrail, failures go to the hand-off', () => {
  const n = wf.nodes.find((x) => x.name === 'Re-read quotes (TMS)');
  assert.ok(n, 're-read quotes node exists');
  assert.equal(n.parameters.method, 'POST');
  assert.match(n.parameters.url, /\/shipments\/.*\/quotes$/);
  assert.equal(n.onError, 'continueErrorOutput');
  const outs = wf.connections['Re-read quotes (TMS)'].main;
  assert.equal(outs[0][0].node, 'Guardrails');
  assert.equal(outs[1][0].node, 'Build exception');
  assert.equal(wf.connections['Re-read shipment (TMS)'].main[0][0].node, 'Re-read quotes (TMS)');
});
