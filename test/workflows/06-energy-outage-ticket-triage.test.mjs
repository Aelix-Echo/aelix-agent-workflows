// Energy: deterministic Code nodes from workflows/06-energy-outage-ticket-triage.json, run against fixed scenarios.

import assert from 'node:assert/strict';
import { load, run, test } from '../helpers.mjs';

const wf = load('06-energy-outage-ticket-triage.json');
console.log('Energy & Utilities · Outage triage');
const Config = { min_confidence: 0.85 };
const t = { business_key: 'T-1', ticket_id: 'T-1', premise_id: 'P-1', description: 'Power out since 7pm, neighbours too' };
const screen = (description, extra = {}) => run(wf, 'Safety screen', { nodes: { 'Normalize ticket': { ...t, description, description_full: description, ...extra } } });

test('plain outage report passes the safety screen', () => assert.equal(screen(t.description).hazard, false));
test('wires down trips the safety screen', () => {
  const s = screen('Tree fell, wires down across the road, sparking');
  assert.equal(s.hazard, true);
  assert.match(s.handoff_reason, /SAFETY/);
});
test('the screen passes the ticket fields on', () => assert.equal(screen('Power out').ticket_id, 'T-1'));
test('a hazard after the first 1500 characters is still caught', () => {
  const long = 'No power. '.repeat(200) + 'There is a line on the ground by the gate.';
  const s = run(wf, 'Safety screen', { nodes: { 'Normalize ticket': { ...t, description: long.slice(0, 1500), description_full: long } } });
  assert.equal(s.hazard, true);
});
test('"line on the ground" and "live wire" are hazards', () => {
  assert.equal(screen('a cable is lying on the road outside').hazard, true);
  assert.equal(screen('there is a live wire by the fence').hazard, true);
});
test('"fired" or "spark plug" style words are not', () => assert.equal(screen('I fired up the generator, still no grid power').hazard, false));

const agent = (o = {}) => ({ output: { classification: 'part_of_known_outage', matched_outage_id: 'O-7', premise_feeder_id: 'F12', critical_customer: false, priority: 'P3', confidence: 0.9, ...o } });
const outage = (o = {}) => ({ outage_id: 'O-7', status: 'crew_assigned', device_id: 'FUSE-1', feeder_id: 'F12', etr: '2026-09-28T22:00:00Z', ...o });
const net = (o = {}) => ({ service_transformer: { id: 'XF-1' }, protective_devices: [{ id: 'FUSE-1' }, { id: 'RCL-1' }], feeder: { id: 'F12', breaker_id: 'BRK-12' }, ...o });
const flags = (o = {}) => ({ medical_baseline: false, life_support_registered: false, critical_facility_type: null, ...o });
const g = ({ a = agent(), o = outage(), n = net(), f = flags() } = {}) =>
  run(wf, 'Guardrails', { json: f, nodes: { Config, 'Normalize ticket': t, 'Outage triage agent': a, 'Re-read outage (OMS)': o, 'Re-read network (GIS)': n } });

test('known outage upstream of the premise links automatically', () => {
  const out = g();
  assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
});
test('outage on a different feeder escalates', () => assert.equal(g({ o: outage({ feeder_id: 'F99' }) }).route, 'escalate'));
test('outage device not upstream of the premise escalates', () => {
  // Same feeder, but the outage's fuse does not feed this premise: nearby is not downstream.
  const out = g({ o: outage({ device_id: 'FUSE-9' }) });
  assert.equal(out.route, 'escalate');
  assert.match(out.guardrail_reasons.join(' '), /not downstream/);
});
test('agent omitting the feeder no longer skips the check', () => assert.equal(g({ a: agent({ premise_feeder_id: null }), o: outage({ feeder_id: 'F99' }) }).route, 'escalate'));
test('life support on record escalates even if the agent missed it', () => {
  const out = g({ f: flags({ life_support_registered: true }) });
  assert.equal(out.route, 'escalate');
  assert.match(out.guardrail_reasons.join(' '), /CIS/);
});
test('medical baseline or a critical facility escalates', () => {
  assert.equal(g({ f: flags({ medical_baseline: true }) }).route, 'escalate');
  assert.equal(g({ f: flags({ critical_facility_type: 'hospital' }) }).route, 'escalate');
});
test('missing customer flags fail closed', () => assert.equal(g({ f: {} }).route, 'escalate'));
test('agent-flagged critical customer still escalates', () => assert.equal(g({ a: agent({ critical_customer: true }) }).route, 'escalate'));
test('restored outage escalates', () => assert.equal(g({ o: outage({ status: 'restored' }) }).route, 'escalate'));

// Poller: one sub-workflow execution per ticket, not waiting, so tickets never share an agent run.
const poller = load('06-energy-outage-ticket-poller.json');
test('poller starts the triage workflow once per ticket', () => {
  const ex = poller.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflow');
  assert.equal(ex.parameters.mode, 'each');
  assert.equal(ex.parameters.workflowId.value, wf.id);
});
