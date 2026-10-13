// LegalTech: deterministic Code nodes from workflows/05-legaltech-contract-intake.json, run against fixed scenarios.

import assert from 'node:assert/strict';
import { load, run, test } from '../helpers.mjs';

const wf = load('05-legaltech-contract-intake.json');
console.log('LegalTech · Contract intake');
const Config = { min_confidence: 0.8, min_text_chars: 800, max_text_chars: 200000, queue_by_type: { nda: 'commercial', dpa: 'privacy' } };
const req = { business_key: 'CI-1', counterparty_stated: 'Northwind Traders' };
const agent = (o = {}) => ({ output: { contract_type: 'nda', suggested_queue: 'commercial', counterparty_name: 'Northwind Traders, Inc.', risk_tier: 'low', confidence: 0.9, ...o } });
const g = (a, r = req) => run(wf, 'Guardrails', { json: a, nodes: { Config, 'Normalize intake': r, 'Contract intake agent': a } });
test('mapped type and matching counterparty routes auto', () => {
  const out = g(agent());
  assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
  assert.equal(out.queue, 'commercial');
});
test('queue disagreement escalates', () => assert.equal(g(agent({ suggested_queue: 'privacy' })).route, 'escalate'));
test('different counterparty escalates', () => assert.equal(g(agent({ counterparty_name: 'Contoso Ltd' })).route, 'escalate'));
test('high risk still routes, high priority', () => assert.equal(g(agent({ risk_tier: 'high' })).priority, 'high'));
test('scanned PDF is flagged for OCR', () => {
  const q = run(wf, 'Check text quality', { json: { text: 'Page 1' }, nodes: { Config } });
  assert.equal(q.readable, false);
  assert.match(q.handoff_reason, /OCR/);
});

// ---------- document link allowlist (SSRF) ----------
const CfgHosts = { ...Config, allowed_document_hosts: { 'files.yourco.example': 'https://files.yourco.example' } };
const intake = (document_url) => run(wf, 'Normalize intake', {
  json: { body: { intake_id: 'CI-9', document_url, submitted_by: { name: 'A B', email: 'A@x.example' } } },
  nodes: { Config: CfgHosts },
});
test('allowed https host is fetched from the configured base plus the path', () => {
  const i = intake('https://files.yourco.example/contracts/CI-9.pdf');
  assert.equal(i.document_allowed, true, i.handoff_reason);
  assert.equal(i.document_fetch_url, 'https://files.yourco.example/contracts/CI-9.pdf');
  assert.equal(i.handoff_reason, '');
});
test('fetch URL comes from Config, not the caller (base can point elsewhere)', () => {
  const i = run(wf, 'Normalize intake', {
    json: { intake_id: 'CI-9', document_url: 'https://FILES.yourco.example/a/b.pdf?sig=1', submitted_by: { name: 'A' } },
    nodes: { Config: { allowed_document_hosts: { 'files.yourco.example': 'http://mock:4010/files.yourco.example/' } } },
  });
  assert.equal(i.document_fetch_url, 'http://mock:4010/files.yourco.example/a/b.pdf?sig=1');
});
test('a mixed-case host in Config matches (host names are case-insensitive)', () => {
  // Seen live: the placeholder key files.YOUR-COMPANY.example never matched the lower-cased link host.
  const i = run(wf, 'Normalize intake', {
    json: { intake_id: 'CI-9', document_url: 'https://files.YOUR-COMPANY.example/c/x.pdf', submitted_by: { name: 'A' } },
    nodes: { Config: { allowed_document_hosts: { 'files.YOUR-COMPANY.example': 'https://files.YOUR-COMPANY.example' } } },
  });
  assert.equal(i.document_allowed, true, i.handoff_reason);
});
for (const [label, url, why] of [
  ['internal host', 'https://169.254.169.254/latest/meta-data/', /IP address|not on allowed/],
  ['metadata host name', 'https://metadata.google.internal/computeMetadata/v1/', /not on allowed_document_hosts/],
  ['plain http', 'http://files.yourco.example/contracts/CI-9.pdf', /not an https link/],
  ['userinfo trick', 'https://files.yourco.example@10.0.0.5/x.pdf', /credentials/],
  ['port', 'https://files.yourco.example:8443/x.pdf', /port/],
  ['IPv6 literal', 'https://[::1]/x.pdf', /port or an IPv6/],
  ['suffix lookalike', 'https://files.yourco.example.attacker.example/x.pdf', /not on allowed_document_hosts/],
  ['subdomain of allowed', 'https://evil.files.yourco.example/x.pdf', /not on allowed_document_hosts/],
  ['trailing dot', 'https://files.yourco.example./x.pdf', /not a plain domain|not on allowed/],
  ['backslash', 'https://files.yourco.example\\@evil.example/x.pdf', /not a plain domain|characters/],
  ['dot segments', 'https://files.yourco.example/contracts/../../admin', /dot segments/],
  ['encoded dot segments', 'https://files.yourco.example/contracts/%2e%2e/admin', /dot segments|encoded/],
  ['fragment', 'https://files.yourco.example/x.pdf#frag', /characters/],
  ['no path', 'https://files.yourco.example', /characters/],
  ['other scheme', 'file:///etc/passwd', /not an https link/],
]) {
  test(`document link refused, never fetched: ${label}`, () => {
    const i = intake(url);
    assert.equal(i.document_allowed, false);
    assert.equal(i.document_fetch_url, null);
    assert.match(i.handoff_reason, /^document link not downloaded: /);
    assert.match(i.handoff_reason, why);
  });
}
test('empty allowlist refuses every link', () => {
  const i = run(wf, 'Normalize intake', { json: { intake_id: 'CI-9', document_url: 'https://files.yourco.example/x.pdf', submitted_by: { name: 'A' } }, nodes: { Config } });
  assert.equal(i.document_allowed, false);
});
test('refused link is wired to the hand-off, allowed link to the download', () => {
  const c = wf.connections['Document link allowed?'].main;
  assert.deepEqual(c[0].map((x) => x.node), ['Download contract']);
  assert.deepEqual(c[1].map((x) => x.node), ['Build exception']);
  assert.equal(wf.connections['Normalize intake'].main[0][0].node, 'Document link allowed?');
  assert.equal(wf.nodes.find((n) => n.name === 'Download contract').parameters.url, '={{ $json.document_fetch_url }}');
});
test('hand-off records the refused-link reason', () => {
  const i = intake('https://10.0.0.5/x.pdf');
  const x = run(wf, 'Build exception', { json: i, nodes: { 'Normalize intake': i } });
  assert.ok(x.reasons.some((r) => r.startsWith('document link not downloaded')), x.reasons.join('; '));
});

// ---------- counterparty cross-check ----------
test('empty counterparty from the agent escalates (fail closed)', () => {
  const out = g(agent({ counterparty_name: '' }));
  assert.equal(out.route, 'escalate');
  assert.ok(out.guardrail_reasons.includes('agent returned no counterparty name'));
});
test('empty agent counterparty escalates even when the requester named none', () => {
  assert.equal(g(agent({ counterparty_name: '  ' }), { ...req, counterparty_stated: '' }).route, 'escalate');
});
test('suffix-only agent counterparty does not match a real name', () => {
  assert.equal(g(agent({ counterparty_name: 'Inc.' })).route, 'escalate');
});
test('suffix stripping keeps names that merely end in a suffix ("Zinc" is not "Z")', () => {
  assert.equal(g(agent({ counterparty_name: 'Zinc' }), { ...req, counterparty_stated: 'Z' }).route, 'escalate');
  assert.equal(g(agent({ counterparty_name: 'Zinc Ltd' }), { ...req, counterparty_stated: 'Zinc' }).route, 'auto');
  assert.equal(g(agent({ counterparty_name: 'Acmeco' }), { ...req, counterparty_stated: 'Acme Co' }).route, 'escalate');
});
test('whole trailing suffix words and punctuation are ignored', () => {
  assert.equal(g(agent({ counterparty_name: 'NORTHWIND TRADERS LIMITED' })).route, 'auto');
  assert.equal(g(agent({ counterparty_name: 'Northwind Traders Co., Ltd.' })).route, 'auto');
});
test('mismatch reason escapes Slack markup from the contract', () => {
  const out = g(agent({ counterparty_name: '<!channel> Evil & Co' }));
  const r = out.guardrail_reasons.find((x) => x.startsWith('requester named'));
  assert.ok(r && !r.includes('<') && r.includes('&lt;!channel&gt;') && r.includes('&amp;'), r);
});
test('guardrails carry the planned type and counterparty for the read-back', () => {
  const out = g(agent());
  assert.equal(out.contract_type, 'nda');
  assert.equal(out.counterparty, 'Northwind Traders, Inc.');
});

// ---------- read-back verification and the legal queue message ----------
const plan = { queue: 'real_estate', priority: 'high', contract_type: 'lease', counterparty: 'Harbor <!channel> & Sons', route: 'auto' };
const matter = { id: 'MAT-CI-1', external_ref: 'CI-1', queue: 'real_estate', priority: 'high', contract_type: 'lease', counterparty: 'Harbor <!channel> & Sons' };
const verify = (m, o = {}) => run(wf, 'Verify matter', {
  json: m,
  nodes: { Guardrails: plan, 'Normalize intake': { intake_id: 'CI-1' }, 'Contract intake agent': { output: { risk_tier: 'high', clause_flags: [{}, {}], ...o } } },
});
test('read-back matching the plan verifies', () => {
  const v = verify(matter);
  assert.equal(v.verified, true, v.verify_detail);
});
for (const [field, value] of [['priority', 'normal'], ['contract_type', 'nda'], ['counterparty', 'Someone Else'], ['queue', 'commercial'], ['external_ref', 'CI-2'], ['id', '']]) {
  test(`read-back with a different ${field} fails verification`, () => {
    const v = verify({ ...matter, [field]: value });
    assert.equal(v.verified, false);
    assert.equal(v.verify_failed, true);
    assert.match(v.verify_detail, new RegExp(field));
  });
}
test('legal queue Slack message escapes contract and model text', () => {
  const v = verify(matter, { risk_tier: '<https://evil.example|click>' });
  assert.ok(!/[<>]/.test(v.slack_text), v.slack_text);
  assert.ok(v.slack_text.includes('&lt;!channel&gt; &amp; Sons'), v.slack_text);
  assert.ok(v.slack_text.startsWith(':red_circle: New LEASE with Harbor '), v.slack_text);
  assert.ok(v.slack_text.includes('in *real_estate* · matter MAT-CI-1 · '), v.slack_text);
  assert.ok(v.slack_text.endsWith(' · 2 clause flags'), v.slack_text);
});
test('Slack node posts only the precomputed message', () => {
  assert.equal(wf.nodes.find((n) => n.name === 'Notify legal queue').parameters.text, "={{ $('Verify matter').item.json.slack_text }}");
});
test('queue label replaces every underscore', () => {
  assert.equal(verify({ ...matter, queue: 'a_b_c' }).queue_label, 'a b c');
  assert.equal(verify(matter).queue_label, 'real estate');
  assert.match(wf.nodes.find((n) => n.name === 'Acknowledge requester').parameters.message, /queue_label/);
});
test('hand-off Slack text escapes markup; the stored summary keeps the original', () => {
  const x = run(wf, 'Build exception', {
    json: { handoff_reason: 'reason with <!channel>' },
    nodes: { 'Normalize intake': { business_key: 'CI-1', intake_id: 'CI-1', requester_name: 'A', counterparty_stated: '' }, 'Contract intake agent': { output: { contract_type: 'nda', counterparty_name: '<!here>' } } },
  });
  assert.ok(!/[<>]/.test(x.slack.summary), x.slack.summary);
  assert.ok(!/[<>]/.test(x.slack.reasons), x.slack.reasons);
  assert.match(x.summary, /<!here>/);
});
test('the Slack notice posts only the escaped fields', () => {
  const text = wf.nodes.find((n) => n.type === 'n8n-nodes-base.slack' && /needs a decision/.test(n.parameters.text)).parameters.text;
  assert.match(text, /slack\.summary/);
  assert.match(text, /slack\.reasons/);
  assert.doesNotMatch(text, /json\.summary|reasons\.join/);
});
