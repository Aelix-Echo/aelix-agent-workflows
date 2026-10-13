// Aelix Spaces · Building Agent
// Catalogue: "Drafts setpoint changes from energy drift. Acts alone only inside a pre-approved envelope."
// Pattern: envelope. A setpoint change inside the facilities manager's envelope (comfort band per zone
// type, maximum step, occupied-hours step, no excluded zones) is applied on its own; anything else waits.

import { productAgent, S, COMMON_OUTPUT } from '../../product.mjs';

const POINTS = ['cooling_setpoint', 'heating_setpoint'];

export const sample = {
  signals: [
    { signal_id: 'DRIFT-55102', building_id: 'BLD-ONE-MARKET', zone_id: 'L07-EAST-OPEN', point: 'cooling_setpoint', drift_type: 'energy_above_baseline', detected_at: '2026-10-13T05:30:00Z' },
    { signal_id: 'DRIFT-55107', building_id: 'BLD-ONE-MARKET', zone_id: 'L02-LAB-A', point: 'heating_setpoint', drift_type: 'simultaneous_heat_cool', detected_at: '2026-10-13T05:45:00Z' },
  ],
};

export default () => productAgent({
  industry: 'Real Estate and Construction',
  product: 'Aelix Spaces',
  agent: 'Building Agent',
  slug: 'realestate-spaces-setpoint',
  dir: 'realestate',
  file: 'spaces-setpoint',
  mode: 'envelope',
  job: 'take routine setpoint tuning off the building operations desk. For each energy drift signal from the building management system, work out whether a setpoint change will bring the zone back toward its energy baseline without hurting comfort, and propose the change.',
  approves: 'the facilities manager approves any change outside a comfort band or step limit, in an excluded zone, under a manual override or with an open comfort complaint',
  never: [
    'Changes a setpoint outside the comfort band for the zone type without the facilities manager',
    'Changes a setpoint by more than the step limit (smaller during occupied hours) without the facilities manager',
    'Touches labs, data rooms, healthcare spaces or any other excluded zone on its own',
    'Goes below the heating floor, above the cooling ceiling, or closes the deadband between heating and cooling',
    'Changes schedules, sequences or equipment modes: setpoints only',
  ],
  team: 'building operations',
  trigger: {
    kind: 'schedule',
    minutes: 30,
    fetch: { url: `={{ $('Config').first().json.gateway_url }}/bms/drift-signals`, query: { status: 'open', limit: '50' }, field: 'signals' },
  },
  config: {
    gateway_url: 'https://spaces-gateway.YOUR-COMPANY.example/api/v1',
    // The envelope. All temperatures in F. Agree these with the facilities manager.
    comfort_bands_f: {
      office: { cooling: { min: 74, max: 78 }, heating: { min: 68, max: 72 } },
      conference: { cooling: { min: 73, max: 77 }, heating: { min: 68, max: 72 } },
      lobby: { cooling: { min: 74, max: 79 }, heating: { min: 66, max: 71 } },
      retail: { cooling: { min: 73, max: 77 }, heating: { min: 67, max: 71 } },
      storage: { cooling: { min: 76, max: 82 }, heating: { min: 60, max: 66 } },
    },
    max_step_f: 2,
    max_step_occupied_f: 1,
    excluded_zone_types: ['lab', 'data_room', 'healthcare'],
    excluded_zone_ids: [],
    // Hard limits. A proposal past these is stopped, not sent for approval.
    heating_floor_f: 55,
    cooling_ceiling_f: 85,
    min_deadband_f: 2,
    min_confidence: 0.85,
    approver_slack_user: 'facilities-manager',
    approval_timeout_hours: 4,
    slack_channel: '#building-operations',
  },
  intake: {
    name: 'Normalize drift signal',
    js: `
const s = $json;
return {
  json: {
    business_key: String(s.signal_id),
    signal_id: String(s.signal_id),
    building_id: String(s.building_id),
    zone_id: String(s.zone_id),
    point: s.point ? String(s.point) : null,
    drift_type: String(s.drift_type ?? 'unspecified'),
    detected_at: s.detected_at ?? null,
  },
};
`,
  },
  agentSpec: {
    name: 'Building setpoint agent',
    effort: 'medium',
    prompt: `=Energy drift signal {{ $json.signal_id }}: {{ $json.drift_type }}
Building {{ $json.building_id }} · zone {{ $json.zone_id }} · point {{ $json.point ?? 'not given' }} · detected {{ $json.detected_at ?? 'unknown' }}

Decide whether a setpoint change will bring this zone back toward its energy baseline without hurting comfort, and size it.`,
    system: `
You tune zone setpoints for a building operations team using Aelix Spaces. From an energy drift signal you decide whether a setpoint change is the right fix and size it. Small changes inside the facilities manager's envelope are applied automatically; everything else goes to the facilities manager.

How to decide:
- Read the zone: type, current heating and cooling setpoints, space temperature, occupancy now and schedule, manual overrides.
- Read the 24 hour trend and the energy drift detail. Setpoints that were nudged by hand, a schedule that runs late, or heating and cooling fighting each other show up here.
- Check comfort complaints for the zone. Do not trade comfort for energy when people are already complaining.
- If the drift comes from equipment (stuck valve or damper, sensor fault, failed economizer), propose investigate_equipment: a setpoint change would hide the fault.
- If a setpoint change is right, change one point, in 0.5 F steps, by the smallest amount that addresses the drift. Report the current value exactly as the zone read shows it.

Proposal types: change_setpoint, investigate_equipment, no_change.

Tools:
- "Get zone", "Get zone trend", "Get energy drift", "List comfort complaints".
`,
    tools: [
      { name: 'Get zone', description: 'Get a zone from the BMS: zone type, current heating and cooling setpoints (F), space temperature, occupied now, occupancy schedule, manual override status.', url: `={{ $('Config').first().json.gateway_url }}/bms/buildings/{{ $fromAI('building_id', 'Building id', 'string') }}/zones/{{ $fromAI('zone_id', 'Zone id', 'string') }}` },
      { name: 'Get zone trend', description: 'Get 24 hours of 15 minute trend data for a zone: space temperature, setpoints, valve and damper positions, occupancy.', url: `={{ $('Config').first().json.gateway_url }}/bms/buildings/{{ $fromAI('building_id', 'Building id', 'string') }}/zones/{{ $fromAI('zone_id', 'Zone id', 'string') }}/trend`, query: { hours: '24' } },
      { name: 'Get energy drift', description: 'Get the detail behind a drift signal: metered energy against baseline for the zone or its air handler, by hour, with the weather-normalized expectation.', url: `={{ $('Config').first().json.gateway_url }}/bms/drift-signals/{{ $fromAI('signal_id', 'Drift signal id', 'string') }}` },
      { name: 'List comfort complaints', description: 'List hot and cold comfort complaints for a zone in the last 7 days, with time and status.', url: `={{ $('Config').first().json.gateway_url }}/bms/buildings/{{ $fromAI('building_id', 'Building id', 'string') }}/zones/{{ $fromAI('zone_id', 'Zone id', 'string') }}/comfort-complaints`, query: { days: '7' } },
    ],
    schema: S.obj({
      proposal_type: S.enum(['change_setpoint', 'investigate_equipment', 'no_change'], 'What to do.'),
      point: S.nullable(S.enum(POINTS, 'Setpoint to change, or null.')),
      current_setpoint_f: S.nullable(S.num('Current value of that point as the zone read shows it, or null.')),
      proposed_setpoint_f: S.nullable(S.num('Proposed value in 0.5 F steps, or null.')),
      ...COMMON_OUTPUT,
    }),
  },
  reread: {
    name: 'Re-read zone',
    url: `={{ $('Config').first().json.gateway_url }}/bms/buildings/{{ $('Normalize drift signal').item.json.building_id }}/zones/{{ $('Normalize drift signal').item.json.zone_id }}`,
  },
  guard: `
const z = $json; // fresh zone read
const t = out?.proposal_type;
const noop = t === 'no_change';
const pt = out?.point;
const key = pt === 'cooling_setpoint' ? 'cooling_setpoint_f' : pt === 'heating_setpoint' ? 'heating_setpoint_f' : null;
const bandKey = pt === 'cooling_setpoint' ? 'cooling' : 'heating';
const r1 = (n) => Math.round(n * 10) / 10;
const misses = []; // envelope misses: the facilities manager is asked, not escalated

if (t === 'investigate_equipment') reasons.push('agent points to an equipment fault, not a setpoint: ' + (out?.rationale ?? ''));

let current = null;
let proposed = null;
let step = null;
if (t === 'change_setpoint') {
  if (!z.zone_id) reasons.push('zone ' + req.zone_id + ' not found on re-read');
  if (!key) reasons.push('unknown setpoint ' + pt);
  else {
    // Recompute from the fresh read, never from the agent's numbers.
    current = Number(z[key]);
    proposed = Number(out.proposed_setpoint_f);
    if (!Number.isFinite(current)) reasons.push('zone read has no current ' + pt);
    if (!Number.isFinite(proposed)) reasons.push('no proposed value for ' + pt);
    if (Number.isFinite(current) && Number.isFinite(proposed)) {
      step = r1(proposed - current);
      if (out.current_setpoint_f == null || Math.abs(Number(out.current_setpoint_f) - current) > 0.05) reasons.push('agent read ' + pt + ' as ' + out.current_setpoint_f + ' but the zone now reads ' + current + ': it changed since the agent looked');
      if (step === 0) reasons.push('proposed ' + pt + ' equals the current value');
      if (Math.abs(proposed * 2 - Math.round(proposed * 2)) > 1e-9) reasons.push('proposed ' + proposed + ' F is not in 0.5 F steps');
      // Hard limits.
      if (pt === 'heating_setpoint' && proposed < cfg.heating_floor_f) reasons.push('heating setpoint ' + proposed + ' F is below the floor of ' + cfg.heating_floor_f + ' F');
      if (pt === 'cooling_setpoint' && proposed > cfg.cooling_ceiling_f) reasons.push('cooling setpoint ' + proposed + ' F is above the ceiling of ' + cfg.cooling_ceiling_f + ' F');
      const cool = pt === 'cooling_setpoint' ? proposed : Number(z.cooling_setpoint_f);
      const heat = pt === 'heating_setpoint' ? proposed : Number(z.heating_setpoint_f);
      if (Number.isFinite(cool) && Number.isFinite(heat) && cool - heat < cfg.min_deadband_f) reasons.push('cooling ' + cool + ' F and heating ' + heat + ' F leave less than the ' + cfg.min_deadband_f + ' F deadband');

      // The envelope.
      if ((cfg.excluded_zone_types ?? []).includes(z.zone_type)) misses.push(z.zone_type + ' zones are excluded from automatic changes');
      if ((cfg.excluded_zone_ids ?? []).includes(z.zone_id)) misses.push('zone ' + z.zone_id + ' is excluded from automatic changes');
      const band = cfg.comfort_bands_f?.[z.zone_type]?.[bandKey];
      if (!band) misses.push('no comfort band set for ' + z.zone_type + ' ' + bandKey);
      else if (proposed < band.min || proposed > band.max) misses.push(proposed + ' F is outside the ' + z.zone_type + ' ' + bandKey + ' band ' + band.min + ' to ' + band.max + ' F');
      const maxStep = z.occupied_now ? cfg.max_step_occupied_f : cfg.max_step_f;
      if (Math.abs(step) > maxStep) misses.push('step of ' + step + ' F is more than the ' + (z.occupied_now ? 'occupied-hours ' : '') + 'limit of ' + maxStep + ' F');
      if (z.override_active) misses.push('a manual override is active on the zone');
      if (Number(z.open_comfort_complaints ?? 0) > 0) misses.push(z.open_comfort_complaints + ' open comfort complaints on the zone');
    }
  }
}
const withinEnvelope = t === 'change_setpoint' && misses.length === 0;

const action = {
  type: t, building_id: req.building_id, zone_id: req.zone_id, zone_type: z.zone_type ?? null,
  point: pt ?? null, from_f: current, to_f: proposed, step_f: step, occupied_now: !!z.occupied_now,
};
const summary = 'Zone ' + req.zone_id + ' (' + (z.zone_type ?? 'unknown type') + ') in ' + req.building_id + ' · drift ' + req.drift_type + '\\n'
  + 'Proposed: *' + t + '*' + (t === 'change_setpoint' ? ' ' + pt + ' ' + current + ' to ' + proposed + ' F (step ' + step + ' F, ' + (z.occupied_now ? 'occupied' : 'unoccupied') + ')' : '') + '.\\n'
  + (misses.length ? 'Outside the envelope: ' + misses.join('; ') + '.\\n' : '') + (out?.rationale ?? '');
`,
  act: {
    write: {
      name: 'Write setpoint (BMS)',
      method: 'POST',
      url: `={{ $('Config').first().json.gateway_url }}/bms/buildings/{{ $('Guardrails').item.json.action.building_id }}/zones/{{ $('Guardrails').item.json.action.zone_id }}/setpoint-commands`,
      headers: { 'Idempotency-Key': `=setpoint-{{ $('Normalize drift signal').item.json.signal_id }}` },
      json: `={{ JSON.stringify({ signal_id: $('Normalize drift signal').item.json.signal_id, point: $('Guardrails').item.json.action.point, value_f: $('Guardrails').item.json.action.to_f, previous_value_f: $('Guardrails').item.json.action.from_f, approved_by: $('Guardrails').item.json.route === 'auto' ? 'envelope:comfort_bands_f,max_step_f,max_step_occupied_f,excluded_zones' : $('Record approval').item.json.approver, source: 'aelix-spaces-building-agent' }) }}`,
    },
    readBack: {
      name: 'Read back zone',
      url: `={{ $('Config').first().json.gateway_url }}/bms/buildings/{{ $('Guardrails').item.json.action.building_id }}/zones/{{ $('Guardrails').item.json.action.zone_id }}`,
    },
    verify: `
const key = planned.point === 'cooling_setpoint' ? 'cooling_setpoint_f' : 'heating_setpoint_f';
const ok = Math.abs(Number($json[key]) - Number(planned.to_f)) <= 0.05;
const detail = 'zone shows ' + planned.point + ' at ' + $json[key] + ' F, expected ' + planned.to_f + ' F';
`,
  },
  handoffSummary: `'Zone ' + intake.zone_id + ' in ' + intake.building_id + ' · ' + intake.drift_type + ' · proposed ' + (agent?.output?.proposal_type ?? 'none')`,
  stickies: {
    intake: 'Every 30 minutes, open energy drift signals are pulled from the BMS and handled one at a time. **Config** holds the envelope: comfort bands per zone type, step limits (smaller when occupied), excluded zone types and ids, plus the hard limits and the named facilities manager.',
    plan: 'Claude reads the zone, its 24 hour trend, the drift detail and comfort complaints, then proposes one setpoint change, an equipment investigation or no change. Effort is **medium**: high volume, bounded reasoning.',
    guard: 'The zone is **re-read** and the change is **recomputed in code** from the fresh setpoint. Hard limits (heating floor, cooling ceiling, deadband) and a stale current value stop the run. **Inside the envelope** (comfort band for the zone type, step limit for occupied or unoccupied, not an excluded zone, no override, no open complaint) it goes straight to act; anything else asks the facilities manager. No change is recorded, not escalated.',
    act: 'One idempotent setpoint command per signal, then the zone is read back. It counts only if the point shows the planned value. Automatic runs record the envelope rule as the approver.',
  },
  setup: [
    '**Gateway contract**: drift signals (list, get), zones (get, trend, comfort complaints, setpoint commands). Map to your BMS (Niagara, Metasys, Desigo) through its API or a BACnet gateway, with writes at a priority your controls contractor agrees.',
    'Set **comfort_bands_f**, **max_step_f**, **max_step_occupied_f** and the excluded zones with the facilities manager. Labs, data rooms and healthcare spaces stay excluded.',
  ],
});
