// Serves the network.* topology as GeoJSON for the Network Map's "Topology
// (CIM)" layers. Reads the PostGIS schema directly -- the Haridwar layers on
// the same map still come from network.json; this is the first map layer
// backed by real connectivity data.
//
// Lines come from path_geog (full ordered path, recovered from UTM by the
// importer); everything else is a Point from geog. Equipment with no
// geometry at all is left out rather than drawn at a made-up location.
import { db } from '../infra/db.js';

export async function topologyGeoJSON() {
  const rows = await db.any(`
    SELECT ce.cim_mrid, ce.cim_class, ce.name,
           f.name AS feeder,
           ST_AsGeoJSON(COALESCE(ce.path_geog, ce.geog)::geometry, 7)::json AS geometry,
           ce.raw_attrs->>'sedms:ConductingEquipment.ratedVoltage' AS rated_voltage
    FROM network.conducting_equipment ce
    LEFT JOIN network.feeders f ON f.id = ce.feeder_id
    WHERE COALESCE(ce.path_geog, ce.geog) IS NOT NULL
    ORDER BY ce.cim_class, ce.cim_mrid`);

  const subs = await db.any(`
    SELECT cim_mrid, name, code, ST_AsGeoJSON(geog::geometry, 7)::json AS geometry
    FROM network.substations`);

  const features = rows.map((r) => ({
    type: 'Feature',
    geometry: r.geometry,
    properties: { mrid: r.cim_mrid, cls: r.cim_class, name: r.name, feeder: r.feeder, ratedVoltage: r.rated_voltage },
  }));
  return {
    type: 'FeatureCollection',
    features,
    meta: {
      equipment: rows.length,
      lines: rows.filter((r) => r.geometry.type === 'LineString').length,
      substations: subs.map((s) => ({ mrid: s.cim_mrid, name: s.name, code: s.code, hasLocation: !!s.geometry })),
    },
  };
}
