// Aelix CoreLink · Payment Exception Agent
// Catalogue: "Triages failed payments and recommends retry, reroute or refund. Approval comes first."
// Pattern: approve. Every action waits for the named payments-ops approver.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

const RAILS = ['UPI', 'IMPS', 'NEFT', 'RTGS'];

export const sample = {
  payment_id: 'PAY-20261013-558120',
  rail: 'IMPS',
  failure_code: 'BENEFICIARY_BANK_TIMEOUT',
  failure_message: 'No response from beneficiary bank within SLA',
  amount: 185000,
  currency: 'INR',
  debtor_account: 'XXXXXX4471',
  beneficiary_ifsc: 'HDFC0001234',
  initiated_at: '2026-10-13T08:41:12Z',
};

export default () => productAgent({
  industry: 'FinTech',
  product: 'Aelix CoreLink',
  agent: 'Payment Exception Agent',
  slug: 'fintech-corelink-payment-exception',
  dir: 'fintech',
  file: 'corelink-payment-exception',
  mode: 'approve',
  job: 'take failed-payment triage off the payments operations desk. Work out why a payment failed and recommend retry on the same rail, reroute to another rail, or refund to source, with the reasoning attached.',
  approves: 'the payments operations lead approves every retry, reroute and refund',
  never: [
    'Moves money without the named approver clicking Approve',
    'Reroutes to a rail the amount is not eligible for',
    'Refunds a payment that was never debited, or was already reversed',
    'Retries past the retry limit in Config',
  ],
  team: 'payments operations',
  trigger: { kind: 'webhook', path: 'aelix/corelink/payment-exception' },
  config: {
    gateway_url: 'https://corelink-gateway.YOUR-BANK.example/api/v1',
    max_retries: 2,
    // Per-rail amount limits in INR. Check against current NPCI and RBI limits for your bank.
    rail_limits: { UPI: { min: 1, max: 100000 }, IMPS: { min: 1, max: 500000 }, NEFT: { min: 1, max: 1000000000 }, RTGS: { min: 200000, max: 1000000000 } },
    min_confidence: 0.85,
    approver_slack_user: 'payments-ops-lead',
    approval_timeout_hours: 4,
    slack_channel: '#payment-exceptions',
  },
  intake: {
    name: 'Normalize failure event',
    js: `
const b = $json.body ?? $json;
const missing = ['payment_id', 'rail', 'failure_code', 'amount'].filter((k) => b[k] == null || b[k] === '');
if (missing.length) throw new Error('Payment failure event missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(b.payment_id),
    payment_id: String(b.payment_id),
    rail: String(b.rail).toUpperCase(),
    failure_code: String(b.failure_code),
    failure_message: String(b.failure_message ?? '').slice(0, 500),
    amount: Number(b.amount),
    currency: String(b.currency ?? 'INR').toUpperCase(),
    initiated_at: b.initiated_at ?? null,
  },
};
`,
  },
  agentSpec: {
    name: 'Payment exception agent',
    prompt: `=Failed payment {{ $json.payment_id }}
Rail: {{ $json.rail }} · Amount: {{ $json.amount }} {{ $json.currency }} · Initiated: {{ $json.initiated_at ?? 'unknown' }}
Failure code: {{ $json.failure_code }}

Failure message from the switch, as received:
<failure_message>
{{ $json.failure_message }}
</failure_message>

Work out why this payment failed and recommend what should happen next.`,
    system: `
You triage failed payments for a bank's payments operations team running on Aelix CoreLink. You find the cause of a failure and recommend one next step. A payments operations lead approves every step before anything moves.

How to triage:
- Read the payment and its event history. Establish whether the debtor account was actually debited and whether any reversal has already happened.
- Check the rail's current health and the beneficiary bank's status. A timeout on a degraded rail is different from a closed beneficiary account.
- Count prior retries for this payment.

Recommendations:
- retry_same_rail: transient failure (timeout, switch degradation) on a rail that is healthy again, under the retry limit.
- reroute: the original rail is unavailable and another rail can carry this amount to this beneficiary. Say which rail.
- refund_to_source: the payment cannot complete (account closed, invalid beneficiary, mandate revoked) and the debtor was debited.
- hold_for_review: anything unclear, contradictory, or suggestive of fraud.

Tools:
- "Get payment", "Get payment events", "Check rail health", "Check beneficiary bank".
`,
    tools: [
      { name: 'Get payment', description: 'Get a payment: status, rail, amount, debtor and beneficiary details, debit status, reversal status, retry count.', url: `={{ $('Config').first().json.gateway_url }}/payments/{{ $fromAI('payment_id', 'Payment id', 'string') }}` },
      { name: 'Get payment events', description: 'Get the full event history of a payment from the switch and core ledger, oldest first.', url: `={{ $('Config').first().json.gateway_url }}/payments/{{ $fromAI('payment_id', 'Payment id', 'string') }}/events` },
      { name: 'Check rail health', description: 'Get current health of one payment rail (UPI, IMPS, NEFT, RTGS): status, success rate over the last 15 minutes, open incidents.', url: `={{ $('Config').first().json.gateway_url }}/rails/{{ $fromAI('rail', 'UPI, IMPS, NEFT or RTGS', 'string') }}/health` },
      { name: 'Check beneficiary bank', description: 'Get the status of a beneficiary bank branch by IFSC: live on which rails, current downtime notices.', url: `={{ $('Config').first().json.gateway_url }}/banks/{{ $fromAI('ifsc', 'Beneficiary IFSC code', 'string') }}` },
    ],
    schema: S.obj({
      root_cause: S.enum(['rail_timeout', 'rail_degraded', 'beneficiary_bank_down', 'beneficiary_account_invalid', 'insufficient_funds', 'mandate_or_limit', 'suspected_fraud', 'other'], 'Cause established from the events.'),
      debtor_debited: S.bool('The debtor account was debited for this payment.'),
      recommendation: S.enum(['retry_same_rail', 'reroute', 'refund_to_source', 'hold_for_review'], 'Recommended next step.'),
      target_rail: S.nullable(S.enum(RAILS, 'Rail to reroute to, or null.')),
      customer_note: S.str('One plain sentence the ops lead can reuse for the customer. Not sent automatically.'),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read payment',
    url: `={{ $('Config').first().json.gateway_url }}/payments/{{ $('Normalize failure event').item.json.payment_id }}`,
  },
  guard: `
const p = $json; // fresh read of the payment
const rec = out?.recommendation;
const rail = rec === 'reroute' ? out?.target_rail : p.rail;
const limits = cfg.rail_limits?.[rail];

if (p.status !== 'failed') reasons.push('payment status is now ' + p.status);
if (Number(p.amount) !== req.amount) reasons.push('amount on record ' + p.amount + ' differs from event ' + req.amount);
if (rec === 'hold_for_review') reasons.push('agent recommends review');
if (out?.root_cause === 'suspected_fraud') reasons.push('suspected fraud goes to a person');
if ((rec === 'retry_same_rail' || rec === 'reroute') && (p.retry_count ?? 0) >= cfg.max_retries) reasons.push('retry limit ' + cfg.max_retries + ' reached');
if (rec === 'reroute' && !out?.target_rail) reasons.push('reroute without a target rail');
if (rec === 'reroute' && out?.target_rail === p.rail) reasons.push('reroute to the same rail');
if ((rec === 'retry_same_rail' || rec === 'reroute') && !limits) reasons.push('no limits configured for rail ' + rail);
if (limits && (p.amount < limits.min || p.amount > limits.max)) reasons.push(rail + ' cannot carry ' + p.amount + ' (limits ' + limits.min + ' to ' + limits.max + ')');
if (rec === 'refund_to_source' && p.debit_status !== 'debited') reasons.push('refund proposed but debit status is ' + p.debit_status);
if (rec === 'refund_to_source' && p.reversal_status && p.reversal_status !== 'none') reasons.push('reversal already ' + p.reversal_status);

const action = { type: rec, payment_id: p.payment_id ?? req.payment_id, rail, amount: p.amount };
const summary = 'Payment ' + req.payment_id + ' (' + req.amount + ' ' + req.currency + ' on ' + req.rail + ') failed: ' + (out?.root_cause ?? 'unknown') + '.\\n'
  + 'Proposed: *' + rec + '*' + (rec === 'reroute' ? ' via ' + rail : '') + '.\\n' + (out?.rationale ?? '');
`,
  act: {
    write: {
      name: 'Execute payment action',
      method: 'POST',
      url: `={{ $('Config').first().json.gateway_url }}/payments/{{ $('Guardrails').item.json.action.payment_id }}/actions`,
      headers: { 'Idempotency-Key': `=exception-{{ $('Guardrails').item.json.action.payment_id }}-{{ $('Guardrails').item.json.action.type }}` },
      json: `={{ JSON.stringify({ type: $('Guardrails').item.json.action.type, rail: $('Guardrails').item.json.action.rail, approved_by: $('Record approval').item.json.approver, source: 'aelix-payment-exception-agent' }) }}`,
    },
    readBack: {
      name: 'Read back payment',
      url: `={{ $('Config').first().json.gateway_url }}/payments/{{ $('Guardrails').item.json.action.payment_id }}`,
    },
    verify: `
const expected = planned.type === 'refund_to_source' ? ['reversal_initiated', 'reversed'] : ['pending', 'processing', 'settled'];
const ok = expected.includes($json.status) && (planned.type === 'refund_to_source' || $json.rail === planned.rail);
const detail = 'payment shows status ' + $json.status + ' on ' + $json.rail + ', expected ' + expected.join('/') + (planned.type === 'refund_to_source' ? '' : ' on ' + planned.rail);
`,
  },
  handoffSummary: `'Payment ' + intake.payment_id + ' · ' + intake.rail + ' · ' + intake.amount + ' ' + intake.currency + ' · proposed ' + (agent?.output?.recommendation ?? 'none')`,
  stickies: {
    intake: 'The payment switch or core banking posts each failed payment: id, rail, failure code, amount. **Config** holds per-rail amount limits, the retry limit and the named approver.',
    plan: 'Claude reads the payment, its event history, rail health and the beneficiary bank status, names the root cause, and recommends retry, reroute, refund or hold.',
    guard: 'The payment is **re-read**. Code checks it is still failed, the amount matches, the retry limit, that the target rail can carry the amount, and that a refund only goes to a debited, unreversed payment.',
    act: 'After approval: one idempotent action call, then the payment is read back. It counts only if the status and rail match the approved plan.',
  },
  setup: [
    '**Gateway contract**: payments (get, events, actions), rails health, banks by IFSC. Map to your core banking and switch (Finacle, Flexcube, BaNCS, or your NPCI switch).',
    'Confirm **rail_limits** against current NPCI and RBI limits for your bank before going live.',
  ],
});
