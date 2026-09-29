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
 * @param {number} [opts.maxHops=25] - safety limit on graph depth, in case of a data cycle
 */
export async function traceSection(cimMrid, { maxHops = 25 } = {}) {
  const origin = await db.oneOrNone(
    `SELECT id, cim_mrid, cim_class, name FROM network.conducting_equipment WHERE cim_mrid = $1`,
    [cimMrid]
  );
  if (!origin) return { found: false, reason: `no equipment with cim_mrid '${cimMrid}'` };

  // Recursive walk: equipment -> terminal -> connectivity_node -> other
  // terminals on that node -> their equipment -> repeat. A switch-class
  // device is INCLUDED as a boundary but its OWN far-side terminal is not
  // expanded past -- that's what stops the walk at a switch instead of
  // crossing through it.
  const rows = await db.any(
    `
    WITH RECURSIVE walk AS (
      SELECT ce.id AS equipment_id, ce.cim_mrid, ce.cim_class, ce.name,
             0 AS depth,
             (ce.cim_class = ANY($/switchClasses/)) AS is_switch,
             false AS blocks_further,   -- the origin's own class never blocks its first hop -- we're tracing AWAY from it, not through it
             ARRAY[ce.id] AS visited
      FROM network.conducting_equipment ce
      WHERE ce.id = $/originId/

      UNION ALL

      SELECT ce2.id, ce2.cim_mrid, ce2.cim_class, ce2.name,
             w.depth + 1,
             (ce2.cim_class = ANY($/switchClasses/)),
             (ce2.cim_class = ANY($/switchClasses/)),  -- a switch reached ANYWHERE past the origin bounds the section beyond it
             w.visited || ce2.id
      FROM walk w
      JOIN network.terminals t1 ON t1.equipment_id = w.equipment_id
      JOIN network.connectivity_nodes cn ON cn.id = t1.connectivity_node_id
      JOIN network.terminals t2 ON t2.connectivity_node_id = cn.id AND t2.id <> t1.id
      JOIN network.conducting_equipment ce2 ON ce2.id = t2.equipment_id
      WHERE w.depth < $/maxHops/
        AND NOT w.blocks_further             -- don't expand PAST a switch found after the origin (it bounds the section)
        AND NOT (ce2.id = ANY(w.visited))     -- don't re-walk a loop back into where we came from
    )
    SELECT DISTINCT ON (equipment_id) equipment_id, cim_mrid, cim_class, name, depth, is_switch
    FROM walk
    ORDER BY equipment_id, depth
    `,
    { originId: origin.id, switchClasses: SWITCH_CLASSES, maxHops }
  );

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
     ORDER BY km ASC
     LIMIT 5`,
    { ids: rows.map((r) => r.equipment_id) }
  );

  return {
    found: true,
    origin: { cim_mrid: origin.cim_mrid, cim_class: origin.cim_class, name: origin.name },
    sectionEquipment: withinSection.map((r) => ({ cim_mrid: r.cim_mrid, cim_class: r.cim_class, name: r.name, hops: r.depth })),
    boundarySwitches: boundarySwitches.map((r) => ({ cim_mrid: r.cim_mrid, cim_class: r.cim_class, name: r.name, hops: r.depth })),
    nearbyProtectionAssets: nearbyProtection, // [] today -- see module header
    caveat: 'Switch open/closed state is not known (Switch.normalOpen is unpopulated in every source file seen so far) -- switches are reported as section BOUNDARIES, not as confirmed isolation points. No FaultIndicator data exists yet in any imported file.',
  };
}
