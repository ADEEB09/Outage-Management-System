// Sectionalizing trace -- the capability the network.* schema was built for
// (2026-09-29 decision: scope in FPI-depth sectionalizing). Given a tripped
// device, walks the REAL ConnectivityNode/Terminal graph outward and reports
// which equipment is electrically within the same section, and which
// switching devices / protection assets bound that section.
//
// Honest scope, stated up front because the real imported data has two gaps
// that shape what this can promise today:
//
//  1. No equipment in any file we have populates Switch.normalOpen (found
//     during the earlier profile-conformance comparison -- it's a
//     profile-mandatory field, but genuinely absent from every instance).
//     So this trace cannot know whether a given switch is actually OPEN or
//     CLOSED right now. What it CAN do, correctly: treat every switch-class
//     device as a section BOUNDARY -- the edge of "how far this outage
//     could plausibly extend" -- without claiming to know whether that
//     specific switch is the one actually isolating it. That's a structural
//     fact from the topology, not a live-state fact SCADA would need to
//     supply.
//  2. No FaultIndicator/ProtectionEquipment data exists in any file we have
//     (also confirmed earlier). protection_assets is queried anyway and
//     will simply return none until real FPI data is imported -- the trace
//     doesn't need to change when that happens.
//
// SWITCH_CLASSES is deliberately explicit rather than inferred from a CIM
// abstract-class hierarchy this codebase doesn't model -- easy to extend
// when a new switch-like class shows up in a future import.
const SWITCH_CLASSES = ['Breaker', 'Fuse', 'LoadBreakSwitch', 'ProtectedSwitch', 'Recloser', 'Switch', 'Disconnector', 'Jumper'];

import { db } from '../infra/db.js';

/**
 * @param {string} cimMrid - the tripped device's CIM mRID (network.conducting_equipment.cim_mrid)
 * @param {object} opts
 * @param {number} [opts.maxHops=1000]  safety limit on graph depth
 * @param {number} [opts.maxNodes=20000] safety limit on section size
 * @param {number} [opts.protectionRadiusM=2000] how close a protection asset must be to count as "nearby"
 *
 * Breadth-first search, one query per hop, with an in-memory visited set.
 * An earlier version used a recursive SQL query with a 25-hop cap; that had
 * two real defects, both found by tracing from two different lines of the
 * same feeder and getting different sections (55 vs 76): (1) the cap
 * silently truncated the walk, so the result depended on where you started;
 * (2) it enumerated every PATH rather than every NODE, which explodes on a
 * ring feeder. BFS visits each device exactly once, terminates on loops, and
 * gives true shortest hop counts. If a safety limit is ever hit, the result
 * says so (truncated: true) instead of quietly returning a partial section.
 */
export async function traceSection(cimMrid, { maxHops = 1000, maxNodes = 20000, protectionRadiusM = 2000 } = {}) {
  const origin = await db.oneOrNone(
    `SELECT id, cim_mrid, cim_class, name FROM network.conducting_equipment WHERE cim_mrid = $1`,
    [cimMrid]
  );
  if (!origin) return { found: false, reason: `no equipment with cim_mrid '${cimMrid}'` };

  const isSwitch = (cls) => SWITCH_CLASSES.includes(cls);
  const seen = new Map(); // equipment id -> { equipment_id, cim_mrid, cim_class, name, depth, is_switch }
  seen.set(String(origin.id), { equipment_id: origin.id, cim_mrid: origin.cim_mrid, cim_class: origin.cim_class, name: origin.name, depth: 0, is_switch: isSwitch(origin.cim_class) });

  let frontier = [origin.id];
  let depth = 0;
  let truncated = false;
  while (frontier.length) {
    if (depth >= maxHops || seen.size >= maxNodes) { truncated = true; break; }
    // One hop: every device sharing a connectivity node with anything in the frontier.
    const neighbours = await db.any(
      `SELECT DISTINCT ce2.id, ce2.cim_mrid, ce2.cim_class, ce2.name
       FROM network.terminals t1
       JOIN network.terminals t2 ON t2.connectivity_node_id = t1.connectivity_node_id AND t2.id <> t1.id
       JOIN network.conducting_equipment ce2 ON ce2.id = t2.equipment_id
       WHERE t1.equipment_id = ANY($1::bigint[])`,
      [frontier]
    );
    const next = [];
    for (const r of neighbours) {
      const key = String(r.id);
      if (seen.has(key)) continue;
      const sw = isSwitch(r.cim_class);
      seen.set(key, { equipment_id: r.id, cim_mrid: r.cim_mrid, cim_class: r.cim_class, name: r.name, depth: depth + 1, is_switch: sw });
      // A switch found AFTER the origin bounds the section: it is recorded but not expanded past.
      // (The origin's own class never blocks its first hop -- we trace away from it, not through it.)
      if (!sw) next.push(r.id);
    }
    frontier = next;
    depth++;
  }

  const rows = [...seen.values()];
  const withinSection = rows.filter((r) => !r.is_switch || r.equipment_id === origin.id);
  const boundarySwitches = rows.filter((r) => r.is_switch && r.equipment_id !== origin.id);

  // Nearest protection assets by real distance from every device found in
  // the section, not just the origin -- a boundary switch or a piece of
  // line equipment may have an FPI closer to it than the origin device does.
  // Returns [] today (no FPI/ProtectionEquipment data exists anywhere yet;
  // see module header) -- kept in the same query shape so nothing here
  // changes when that data arrives.
  const nearbyProtection = await db.any(
    `SELECT DISTINCT pa.cim_mrid, pa.kind, pa.name,
            ROUND((MIN(ST_Distance(pa.geog, ce.geog)) OVER (PARTITION BY pa.id) / 1000)::numeric, 3) AS km
     FROM network.protection_assets pa
     JOIN network.conducting_equipment ce ON ce.id = ANY($/ids/::bigint[])
     WHERE pa.geog IS NOT NULL AND ce.geog IS NOT NULL
       AND ST_DWithin(pa.geog, ce.geog, $/radiusM/)   -- 'nearby' means nearby: without a cap, an RMU 37 km away in another city was reported
     ORDER BY km ASC
     LIMIT 5`,
    { ids: rows.map((r) => r.equipment_id), radiusM: protectionRadiusM }
  );

  return {
    found: true,
    origin: { cim_mrid: origin.cim_mrid, cim_class: origin.cim_class, name: origin.name },
    sectionEquipment: withinSection.map((r) => ({ cim_mrid: r.cim_mrid, cim_class: r.cim_class, name: r.name, hops: r.depth })),
    boundarySwitches: boundarySwitches.map((r) => ({ cim_mrid: r.cim_mrid, cim_class: r.cim_class, name: r.name, hops: r.depth })),
    nearbyProtectionAssets: nearbyProtection, // [] today -- see module header
    truncated,                                 // true only if a safety limit stopped the walk early
    caveat: 'Switch open/closed state is not known (Switch.normalOpen is unpopulated in every source file seen so far) -- switches are reported as section BOUNDARIES, not as confirmed isolation points. No FaultIndicator data exists yet in any imported file.',
  };
}
