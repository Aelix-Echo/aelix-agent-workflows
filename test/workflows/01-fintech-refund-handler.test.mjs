// FinTech: deterministic Code nodes from workflows/01-fintech-refund-handler.json, run against fixed scenarios.

import assert from 'node:assert/strict';
import { load, run, test } from '../helpers.mjs';

const wf = load('01-fintech-refund-handler.json');
console.log('FinTech · Refund handler');
const Config = { refund_window_days: 30, auto_refund_max_cents: 25000, min_confidence: 0.85 };
const req = { business_key: 'RR-1', request_id: 'RR-1', order_number: 'ATX-44102', customer_email: 'jo@example.com', requested_amount: null, currency: 'usd' };
const agent = (o = {}) => ({ output: { decision: 'refund_full', payment_intent_id: 'pi_1', refund_amount_cents: 14820, currency: 'usd', confidence: 0.95, eligibility: { identity_match: true }, ...o }, intermediateSteps: [] });
const pi = (o = {}) => ({ id: 'pi_1', status: 'succeeded', currency: 'usd', created: Date.now() / 1000 - 4 * 86400, receipt_email: 'jo@example.com', latest_charge: { amount_captured: 14820, amount_refunded: 0, disputed: false }, ...o });
const g = (json, a = agent(), r = req) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize request': r, 'Refund agent': a } });

test('eligible refund routes auto', () => {
  const out = g(pi());
  assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
  assert.deepEqual(out.refund, { payment_intent: 'pi_1', amount_cents: 14820, currency: 'usd' });
});
test('over auto limit escalates', () => assert.equal(g(pi({ latest_charge: { amount_captured: 90000, amount_refunded: 0 } }), agent({ refund_amount_cents: 90000 })).route, 'escalate'));
test('more than refundable escalates', () => assert.equal(g(pi({ latest_charge: { amount_captured: 14820, amount_refunded: 10000 } })).route, 'escalate'));
test('disputed charge escalates', () => assert.equal(g(pi({ latest_charge: { amount_captured: 14820, amount_refunded: 0, disputed: true } })).route, 'escalate'));
test('outside window escalates', () => assert.equal(g(pi({ created: Date.now() / 1000 - 45 * 86400 })).route, 'escalate'));
test('email mismatch escalates', () => assert.equal(g(pi({ receipt_email: 'someone@else.com' })).route, 'escalate'));
test('low confidence escalates', () => assert.equal(g(pi(), agent({ confidence: 0.6 })).route, 'escalate'));
test('refund above requested amount escalates', () => assert.equal(g(pi(), agent(), { ...req, requested_amount: 50 }).route, 'escalate'));
test('verify accepts matching refund', () => {
  const v = run(wf, 'Verify refund', { json: { id: 're_1', status: 'succeeded', amount: 14820, payment_intent: 'pi_1' }, nodes: { Guardrails: { refund: { payment_intent: 'pi_1', amount_cents: 14820 } } } });
  assert.equal(v.verified, true);
});
test('verify rejects wrong amount', () => {
  const v = run(wf, 'Verify refund', { json: { id: 're_1', status: 'succeeded', amount: 100, payment_intent: 'pi_1' }, nodes: { Guardrails: { refund: { payment_intent: 'pi_1', amount_cents: 14820 } } } });
  assert.equal(v.verified, false);
});
test('hand-off explains a denial', () => {
  const ex = run(wf, 'Build exception', { json: { output: agent({ decision: 'deny' }).output }, nodes: { 'Normalize request': req, 'Refund agent': agent({ decision: 'deny' }) } });
  assert.match(ex.reasons.join(' '), /deny/);
  assert.match(ex.summary, /ATX-44102/);
});
test('hand-off carries a system error', () => {
  const ex = run(wf, 'Build exception', { json: { error: { message: 'Stripe 500' } }, nodes: { 'Normalize request': req } });
  assert.match(ex.reasons.join(' '), /Stripe 500/);
});
test('hand-off survives an item n8n cannot link back to its request', () => {
  // Seen live in a batch: the agent's error item lost its link to the request. The hand-off
  // must still produce an exception instead of failing and taking the batch with it.
  const ex = run(wf, 'Build exception', { json: { business_key: 'RR-9', error: { message: 'format' } }, nodes: {} });
  assert.equal(ex.business_key, 'RR-9');
  assert.match(ex.reasons.join(' '), /item_context_lost/);
});
test('audit row keeps the key when the request cannot be looked up', () => {
  const a = run(wf, 'Build audit record', { json: { outcome: 'escalated', business_key: 'RR-9' }, nodes: {} });
  assert.equal(a.business_key, 'RR-9');
  assert.equal(a.route, 'escalate');
});
test('when n8n loses the item link, a single-item node is still read', () => {
  // Seen live after the AI Agent node: $('Node').item throws. With one item there is no ambiguity.
  const node = wf.nodes.find((n) => n.name === 'Build exception');
  const data = { 'Normalize request': req };
  const $ = (name) => {
    if (!(name in data)) throw new Error('no node ' + name);
    return { get item() { throw new Error('paired item lost'); }, all: () => [{ json: data[name] }] };
  };
  const ex = new Function('$json', '$', '$execution', node.parameters.jsCode)({ error: { message: 'boom' } }, $, { id: 't' }).json;
  assert.equal(ex.business_key, req.business_key);
  assert.doesNotMatch(ex.reasons.join(' '), /item_context_lost/);
});
