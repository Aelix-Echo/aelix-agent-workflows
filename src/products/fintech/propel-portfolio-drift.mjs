// Aelix Propel · Portfolio Drift Agent
// Catalogue: "Finds drift and tax-loss options and drafts rebalancing. An advisor approves each trade."
// Pattern: approve. The advisor sees every order line and approves the set; only those orders are
// submitted to the order management system, marked advisor-approved.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

export const sample = {
  reviews: [
    { review_id: 'RV-20261013-00981', account_id: 'ACC-55710231', model_id: 'MDL-GROWTH-80-20', trigger: 'scheduled_review', as_of: '2026-10-12' },
    { review_id: 'RV-20261013-00982', account_id: 'ACC-55710488', model_id: 'MDL-BALANCED-60-40', trigger: 'market_move', as_of: '2026-10-12' },
  ],
};

export default () => productAgent({
  industry: 'FinTech',
  product: 'Aelix Propel',
  agent: 'Portfolio Drift Agent',
  slug: 'fintech-propel-portfolio-drift',
  dir: 'fintech',
  file: 'propel-portfolio-drift',
  mode: 'approve',
  job: 'take routine drift reviews off the advisory desk. For each account due for review, compare holdings with the target model, look for tax-loss harvesting options in taxable accounts, and draft the rebalancing orders for the advisor.',
  approves: 'the advisor on the account approves the listed orders before any of them reaches the order management system',
  never: [
    'Submits an order the advisor has not seen and approved',
    'Sells more than the account holds, or sells lots that do not exist',
    'Harvests a loss that a recent or proposed purchase would wash',
    'Trades a restricted security',
    'Contacts the client',
  ],
  team: 'advisory operations',
  trigger: {
    kind: 'schedule',
    minutes: 60,
    fetch: { url: `={{ $('Config').first().json.gateway_url }}/reviews`, query: { status: 'due', limit: '25' }, field: 'reviews' },
  },
  config: {
    gateway_url: 'https://propel-gateway.YOUR-FIRM.example/api/v1',
    // Days either side of a loss sale in which a purchase of a substantially identical security washes the loss.
    wash_sale_days: 30,
    // Smallest total loss worth harvesting, in account currency. Set with your advisory policy.
    min_harvest_loss: 500,
    // Cash the account keeps after trading, as a fraction of account value.
    min_cash_weight: 0.01,
    max_orders: 20,
    min_confidence: 0.85,
    approver_slack_user: 'account-advisor',
    approval_timeout_hours: 24,
    slack_channel: '#portfolio-drift',
  },
  intake: {
    name: 'Normalize review',
    js: `
const r = $json;
if (!r.review_id || !r.account_id) throw new Error('Review item missing review_id or account_id');
return {
  json: {
    business_key: String(r.review_id),
    review_id: String(r.review_id),
    account_id: String(r.account_id),
    model_id: String(r.model_id ?? ''),
    trigger: String(r.trigger ?? 'scheduled_review'),
    as_of: r.as_of ? String(r.as_of).slice(0, 10) : null,
  },
};
`,
  },
  agentSpec: {
    name: 'Portfolio drift agent',
    prompt: `=Account review {{ $json.review_id }} for account {{ $json.account_id }}
Target model: {{ $json.model_id || 'as on the account' }} · Trigger: {{ $json.trigger }} · Holdings as of {{ $json.as_of ?? 'latest' }}

Limits the guardrails enforce: wash-sale window {{ $('Config').first().json.wash_sale_days }} days, smallest harvest {{ $('Config').first().json.min_harvest_loss }}, cash kept after trading {{ $('Config').first().json.min_cash_weight }} of account value, at most {{ $('Config').first().json.max_orders }} orders.

Find drift and tax-loss options and draft the rebalancing orders.`,
    system: `
You are the portfolio drift agent in Aelix Propel for a wealth management firm. You compare an account with its target model, look for tax-loss harvesting options, and draft orders. The advisor approves every order before anything is submitted. You never contact the client.

How to review:
- Read the holdings with prices and tax lots, the cash balance, the target model with each security's weight and tolerance band, recent trades, restrictions and the substitute list.
- Current weight = market value / (total market value + cash). Drift = current weight - target weight. A position is out of band when the absolute drift is larger than its band.
- Rebalance only positions that are out of band, and size the trades so they land back inside their bands while keeping the minimum cash.
- In taxable accounts only, look for lots trading below cost. A harvest sells those lots and buys an approved substitute that is not substantially identical, to keep the exposure.
- Wash sales: do not harvest a loss on a security if it, or anything in its substantially identical group, was bought in the window before today, and do not buy it back in the same order set. Do not buy anything that was sold at a loss in the window.
- Sells name the lot ids they draw from. Never sell more than a lot or a position holds.

Proposals: rebalance, tax_loss_harvest, rebalance_and_harvest, no_action, refer.

Tools:
- "Get holdings", "Get target model", "List recent trades", "Get account restrictions", "Get approved substitutes".
`,
    tools: [
      { name: 'Get holdings', description: 'Get an account\'s holdings: symbol, quantity, last price, market value, and tax lots (lot id, quantity, cost per share, acquired date), plus cash and account type (taxable or tax-deferred).', url: `={{ $('Config').first().json.gateway_url }}/accounts/{{ $fromAI('account_id', 'Account id', 'string') }}/holdings` },
      { name: 'Get target model', description: 'Get the target model on an account: each symbol with target weight and tolerance band.', url: `={{ $('Config').first().json.gateway_url }}/accounts/{{ $fromAI('account_id', 'Account id', 'string') }}/model` },
      { name: 'List recent trades', description: 'List trades on the account and linked household accounts in the last 61 days: symbol, side, date, quantity, realized gain or loss.', url: `={{ $('Config').first().json.gateway_url }}/accounts/{{ $fromAI('account_id', 'Account id', 'string') }}/trades`, query: { days: '61' } },
      { name: 'Get account restrictions', description: 'Get restrictions on an account: restricted symbols, client instructions on trading, pending cash withdrawals.', url: `={{ $('Config').first().json.gateway_url }}/accounts/{{ $fromAI('account_id', 'Account id', 'string') }}/restrictions` },
      { name: 'Get approved substitutes', description: 'Get the firm\'s approved substitute securities for a symbol and its substantially identical group, for tax-loss harvesting.', url: `={{ $('Config').first().json.gateway_url }}/securities/{{ $fromAI('symbol', 'Ticker symbol', 'string') }}/substitutes` },
    ],
    schema: S.obj({
      proposal: S.enum(['rebalance', 'tax_loss_harvest', 'rebalance_and_harvest', 'no_action', 'refer'], 'What to do.'),
      drift: S.arr(S.obj({ symbol: S.str('Symbol in the model.'), current_weight: S.num('Current weight as a fraction.'), target_weight: S.num('Target weight as a fraction.') }), 'Drift per model position.'),
      orders: S.arr(S.obj({
        symbol: S.str('Ticker symbol.'),
        side: S.enum(['buy', 'sell'], 'Side.'),
        quantity: S.num('Shares.'),
        lot_ids: S.arr(S.str(), 'Lots a sell draws from. Empty for buys.'),
        purpose: S.enum(['rebalance', 'tax_loss', 'replacement'], 'Why this order exists.'),
      }), 'Draft orders. Empty for no_action or refer.'),
      estimated_harvested_loss: S.num('Total loss realized by tax_loss sells, as a positive number. 0 if none.'),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read holdings',
    url: `={{ $('Config').first().json.gateway_url }}/accounts/{{ $('Normalize review').item.json.account_id }}/rebalance-context`,
  },
  guard: `
const a = $json; // fresh holdings, cash, model, recent trades, restrictions, substitute groups
const p = out?.proposal;
const r4 = (v) => Math.round(v * 10000) / 10000;
const r2 = (v) => Math.round(v * 100) / 100;
const holdings = a.holdings ?? [];
const pos = Object.fromEntries(holdings.map((h) => [h.symbol, h]));
const price = (sym) => Number(pos[sym]?.price ?? a.prices?.[sym] ?? NaN);
const cash = Number(a.cash ?? 0);
const total = cash + holdings.reduce((s, h) => s + Number(h.quantity) * Number(h.price), 0);
const targets = a.targets ?? [];
const orders = out?.orders ?? [];
const groups = a.identical_groups ?? [];
const groupOf = (sym) => groups.find((g) => g.includes(sym)) ?? [sym];
const today = Date.now();
const inWindow = (d) => Math.abs(today - Date.parse(d)) <= cfg.wash_sale_days * 86400000;

// Recompute drift from the fresh read.
const weightOf = (qty) => Object.fromEntries(Object.entries(qty).map(([s, q]) => [s, total > 0 ? r4((q * price(s)) / total) : 0]));
const qtyNow = Object.fromEntries(holdings.map((h) => [h.symbol, Number(h.quantity)]));
const wNow = weightOf(qtyNow);
const outOfBand = targets.filter((t) => Math.abs((wNow[t.symbol] ?? 0) - t.weight) > t.band).map((t) => t.symbol);
const noop = p === 'no_action' && outOfBand.length === 0;

if (a.status && a.status !== 'active') reasons.push('account status is ' + a.status);
if (!(total > 0)) reasons.push('account has no value on record');
if (p === 'refer') reasons.push('agent referred the account: ' + ((out?.questions_for_human ?? []).join('; ') || 'no questions given'));
if (p === 'no_action' && outOfBand.length) reasons.push('no action proposed but out of band: ' + outOfBand.join(', '));
if ((p === 'rebalance' || p === 'rebalance_and_harvest') && !outOfBand.length) reasons.push('rebalance proposed but no position is outside its band');
for (const d of out?.drift ?? []) {
  if (Math.abs(Number(d.current_weight) - (wNow[d.symbol] ?? 0)) > 0.005) reasons.push('agent weight for ' + d.symbol + ' is ' + d.current_weight + ', recomputed ' + (wNow[d.symbol] ?? 0));
}
if (orders.length > cfg.max_orders) reasons.push(orders.length + ' orders exceeds ' + cfg.max_orders);
if ((p === 'rebalance' || p === 'tax_loss_harvest' || p === 'rebalance_and_harvest') && !orders.length) reasons.push(p + ' proposed with no orders');

// Sells never exceed holdings or lots.
const sells = {};
const buys = {};
let harvested = 0;
for (const o of orders) {
  const q = Number(o.quantity);
  if (!(q > 0)) { reasons.push('order for ' + o.symbol + ' has quantity ' + o.quantity); continue; }
  if ((a.restricted_symbols ?? []).includes(o.symbol)) reasons.push(o.symbol + ' is restricted on this account');
  if (!Number.isFinite(price(o.symbol))) reasons.push('no current price for ' + o.symbol);
  if (o.side === 'sell') {
    sells[o.symbol] = (sells[o.symbol] ?? 0) + q;
    const lots = (pos[o.symbol]?.lots ?? []).filter((l) => (o.lot_ids ?? []).includes(l.lot_id));
    if (lots.length !== (o.lot_ids ?? []).length || !lots.length) reasons.push('sell of ' + o.symbol + ' cites lots not held: ' + (o.lot_ids ?? []).join(', '));
    const lotQty = lots.reduce((s, l) => s + Number(l.quantity), 0);
    if (q > lotQty + 1e-9) reasons.push('sell of ' + q + ' ' + o.symbol + ' exceeds the ' + lotQty + ' shares in the cited lots');
    if (o.purpose === 'tax_loss') {
      if (a.account_type !== 'taxable') reasons.push('tax-loss sell in a non-taxable account (' + a.account_type + ')');
      const gainLots = lots.filter((l) => Number(l.cost_per_share) <= price(o.symbol));
      if (gainLots.length) reasons.push('tax-loss sell of ' + o.symbol + ' includes lots at a gain: ' + gainLots.map((l) => l.lot_id).join(', '));
      let left = q;
      for (const l of lots) { const take = Math.min(left, Number(l.quantity)); harvested += take * (Number(l.cost_per_share) - price(o.symbol)); left -= take; }
      const g = groupOf(o.symbol);
      const recentBuy = (a.recent_trades ?? []).find((t) => t.side === 'buy' && g.includes(t.symbol) && inWindow(t.trade_date));
      if (recentBuy) reasons.push('wash sale: ' + recentBuy.symbol + ' bought ' + recentBuy.trade_date + ', within ' + cfg.wash_sale_days + ' days of the loss sale of ' + o.symbol);
      const buyBack = orders.find((b) => b.side === 'buy' && g.includes(b.symbol));
      if (buyBack) reasons.push('wash sale: the same order set buys ' + buyBack.symbol + ' while harvesting ' + o.symbol);
    }
  } else {
    buys[o.symbol] = (buys[o.symbol] ?? 0) + q;
    const g = groupOf(o.symbol);
    const lossSale = (a.recent_trades ?? []).find((t) => t.side === 'sell' && g.includes(t.symbol) && Number(t.realized_gain) < 0 && inWindow(t.trade_date));
    if (lossSale) reasons.push('wash sale: buying ' + o.symbol + ' within ' + cfg.wash_sale_days + ' days of a loss sale of ' + lossSale.symbol + ' on ' + lossSale.trade_date);
    if (o.purpose === 'replacement' && !(a.approved_substitutes ?? []).includes(o.symbol)) reasons.push(o.symbol + ' is not an approved substitute');
    if (o.purpose !== 'replacement' && !targets.some((t) => t.symbol === o.symbol)) reasons.push('buy of ' + o.symbol + ', which is not in the target model');
  }
}
for (const [sym, q] of Object.entries(sells)) {
  if (q > (qtyNow[sym] ?? 0) + 1e-9) reasons.push('sells of ' + q + ' ' + sym + ' exceed the ' + (qtyNow[sym] ?? 0) + ' held');
}
harvested = r2(harvested);
if (orders.some((o) => o.purpose === 'tax_loss')) {
  if (harvested < cfg.min_harvest_loss) reasons.push('harvested loss ' + harvested + ' below the minimum ' + cfg.min_harvest_loss);
  if (Math.abs(Number(out?.estimated_harvested_loss ?? 0) - harvested) > 1) reasons.push('agent harvested loss ' + out?.estimated_harvested_loss + ' differs from recomputed ' + harvested);
}

// Cash and bands after the trades, at current prices.
const proceeds = Object.entries(sells).reduce((s, [sym, q]) => s + q * price(sym), 0);
const spend = Object.entries(buys).reduce((s, [sym, q]) => s + q * price(sym), 0);
const cashAfter = r2(cash + proceeds - spend);
if (orders.length && cashAfter < cfg.min_cash_weight * total) reasons.push('cash after trading ' + cashAfter + ' below the minimum ' + r2(cfg.min_cash_weight * total));
const qtyAfter = { ...qtyNow };
for (const [s, q] of Object.entries(sells)) qtyAfter[s] = (qtyAfter[s] ?? 0) - q;
for (const [s, q] of Object.entries(buys)) qtyAfter[s] = (qtyAfter[s] ?? 0) + q;
const wAfter = weightOf(qtyAfter);
if (p === 'rebalance' || p === 'rebalance_and_harvest') {
  const still = targets.filter((t) => Math.abs((wAfter[t.symbol] ?? 0) - t.weight) > t.band).map((t) => t.symbol);
  if (still.length) reasons.push('still out of band after the orders: ' + still.join(', '));
}

const blocks = orders.filter((o) => o.side === 'sell' && o.purpose === 'tax_loss')
  .map((o) => ({ symbols: groupOf(o.symbol), no_buy_until: new Date(today + cfg.wash_sale_days * 86400000).toISOString().slice(0, 10) }));
const action = {
  type: 'submit_orders',
  review_id: req.review_id,
  account_id: req.account_id,
  orders: orders.map((o) => ({ symbol: o.symbol, side: o.side, quantity: Number(o.quantity), lot_ids: o.lot_ids ?? [], purpose: o.purpose })),
  harvested_loss: harvested,
  wash_sale_blocks: blocks,
};
// Account id and each order line so the advisor approves every trade. No balances or values.
const summary = 'Account ' + req.account_id + ' · review ' + req.review_id + ' · out of band: ' + (outOfBand.join(', ') || 'none') + '.\\n'
  + 'Proposed: *' + p + '*, ' + orders.length + ' orders. Approving approves exactly these:\\n'
  + orders.map((o) => '- ' + o.side.toUpperCase() + ' ' + o.quantity + ' ' + o.symbol + ' (' + o.purpose + ')').join('\\n')
  + (blocks.length ? '\\nWash-sale block on ' + blocks.flatMap((b) => b.symbols).join(', ') + ' until ' + blocks[0].no_buy_until + '.' : '');
`,
  act: {
    write: {
      name: 'Submit approved orders',
      method: 'POST',
      url: `={{ $('Config').first().json.gateway_url }}/oms/order-batches`,
      headers: { 'Idempotency-Key': `=propel-{{ $('Guardrails').item.json.action.review_id }}` },
      json: `={{ JSON.stringify({ ...$('Guardrails').item.json.action, approval_status: 'advisor_approved', approved_by: $('Record approval').item.json.approver, approved_at: $('Record approval').item.json.decided_at, source: 'aelix-propel-portfolio-drift' }) }}`,
    },
    readBack: {
      name: 'Read back order batch',
      url: `={{ $('Config').first().json.gateway_url }}/oms/order-batches/{{ $('Submit approved orders').item.json.batch_id }}`,
    },
    verify: `
const key = (o) => o.symbol + ':' + o.side + ':' + Number(o.quantity);
const got = ($json.orders ?? []).map(key).sort();
const want = (planned.orders ?? []).map(key).sort();
const ok = ['accepted', 'working', 'partially_filled', 'filled'].includes($json.status) && $json.approval_status === 'advisor_approved' && JSON.stringify(got) === JSON.stringify(want);
const detail = 'OMS batch shows status ' + $json.status + ', approval ' + $json.approval_status + ', orders ' + got.join(', ') + '; expected ' + want.join(', ');
`,
  },
  handoffSummary: `'Account ' + intake.account_id + ' · review ' + intake.review_id + ' · proposed ' + (agent?.output?.proposal ?? 'none')`,
  stickies: {
    intake: 'Every hour, account reviews that are due (scheduled, market move, cash flow) are pulled and handled one at a time. **Config** holds the wash-sale window, the smallest harvest, the cash floor, the order limit and the named advisor.',
    plan: 'Claude reads holdings and tax lots, the target model, recent trades, restrictions and approved substitutes, then drafts **rebalance**, **tax-loss harvest**, both, **no action** or **refer** with every order line.',
    guard: 'Holdings are **re-read**. Code **recomputes drift** and bands before and after the orders, checks **sells never exceed lots or holdings**, the **wash-sale window** both ways, harvests only lots at a loss in taxable accounts, restrictions and the cash floor. "No action" with nothing out of band is recorded, not escalated.',
    act: 'After the advisor approves the listed orders: one idempotent submission to the order management system marked **advisor-approved**, then the batch is read back. It counts only if the OMS holds exactly the approved orders.',
  },
  setup: [
    '**Gateway contract**: reviews due, account holdings, model, trades, restrictions, rebalance context, substitutes, OMS order batches. Map to your portfolio and order systems (Orion, Envestnet, Black Diamond, InvestCloud, your custodian OMS).',
    'Confirm the substantially identical groups and the approved substitute list with compliance before enabling harvesting.',
  ],
});
