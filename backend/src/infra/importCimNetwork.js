// Imports a real CIM RDF/XML network export (IEC 61970-301/61968, as used by
// GridQ ADMS and Schneider Electric SEDMS exports) into the network.* Postgres
// schema (db/migrations/network_topology_schema.sql).
//
// This replaces the flat network.json + in-memory haversine search
// (backend/src/infra/geo.js) with real PostGIS tables and genuine
// ConnectivityNode/Terminal topology, so a future sectionalizing trace (down
// to FPI level) can walk a real graph instead of a list of points.
//
// Scope, stated plainly: this script imports the network MODEL only. It does
// NOT yet rewire geo.js/the app to read from these tables instead of
// network.json -- that's the next step, deliberately kept separate so this
// change can be verified on its own first.
//
// Idempotent: every insert is ON CONFLICT (cim_mrid) DO UPDATE, so re-running
// against the same or an updated file is always safe.
//
// HONEST FINDING FROM TESTING: this source file's single Diagram element
// declares EPSG:4326 (WGS84) for every DiagramObject, but that is not true
// for every point -- all ACLineSegment geometry is UTM easting/northing in
// metres, not lon/lat degrees. PostGIS's geography cast does not reject an
// out-of-range value; it silently normalizes it into a coordinate that looks
// valid but is geographic nonsense (one line landed mid-Pacific), so every
// point is classified on its RAW parsed value before it reaches PostGIS.
//
// Recovery, and why it is safe: metre-valued points are converted from UTM
// only when the zone can be PROVEN from the file itself -- the candidate zone
// (derived from the file's own lon/lat points) must place >=99% of them inside
// the area those points cover. For the Dehradun file that is zone 44N: all 232
// line endpoints land within 30 m of a pole (median 4.1 m), while zone 43N puts
// them ~570 km away. If no single zone can be proven, nothing is converted;
// the points are dropped and counted, never guessed.
//
// Reported every run: pointsConvertedFromUtm, utmZoneUsed,
// pointsSkippedOutOfRange, equipmentWithNoGeog.
//
// Run: node src/infra/importCimNetwork.js <path-to-cim.xml>
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { db, migrate } from './db.js';
import { pathToFileURL } from 'node:url';
import { utmToLonLat, zoneOfLon } from './utm.js';


const RDF_ID = '@_rdf:ID';
const RDF_RESOURCE = '@_rdf:resource';

function parseCimXml(path) {
  const xml = readFileSync(path, 'utf8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false, // keep every value as a string; we cast explicitly where it matters
  });
  const doc = parser.parse(xml);
  const root = doc['rdf:RDF'];

  // Every "cim:X" or "sedms:X" key at the root is one class of elements;
  // fast-xml-parser gives a single object (not an array) when there's only
  // one instance of a tag, so normalize everything to an array up front.
  const elements = []; // { tag, id, attrs: { fullQualName: value | {resource} } }
  for (const [tag, val] of Object.entries(root)) {
    if (tag.startsWith('@_') || tag === '#text') continue;
    const list = Array.isArray(val) ? val : [val];
    for (const node of list) {
      const id = node?.[RDF_ID];
      const attrs = {};
      for (const [k, v] of Object.entries(node || {})) {
        if (k === RDF_ID || k.startsWith('@_')) continue;
        if (v && typeof v === 'object' && RDF_RESOURCE in v) {
          attrs[k] = { resource: v[RDF_RESOURCE].replace(/^#/, '') };
        } else {
          attrs[k] = typeof v === 'object' ? (v['#text'] ?? '') : v;
        }
      }
      elements.push({ tag, id, attrs });
    }
  }
  return elements;
}

function byTag(elements, tag) {
  return elements.filter((e) => e.tag === tag);
}

// Every CIM equipment class we might encounter maps into ONE table
// (network.conducting_equipment), so a class this importer has never seen
// before still imports correctly -- it just gets cim_class = its own tag
// name and every attribute preserved in raw_attrs. Classes that get their
// OWN dedicated table (Substation, Feeder, ConnectivityNode, Terminal) are
// excluded here; everything else, cim: or sedms:, is "equipment".
const NON_EQUIPMENT_TAGS = new Set([
  'cim:Substation', 'cim:Feeder', 'cim:ConnectivityNode', 'cim:Terminal',
  'cim:GeographicalRegion', 'cim:SubGeographicalRegion', 'cim:VoltageLevel',
  'cim:PSRType', 'cim:Diagram', 'cim:DiagramObject', 'cim:DiagramObjectPoint',
]);
// Protection/asset-layer classes (Level 10) land in network.protection_assets
// instead of conducting_equipment -- scoped in now per the FPI decision, even
// though no source file we have today populates FaultIndicator/
// ProtectionEquipment. Whenever one appears, it's already routed correctly.
const PROTECTION_TAGS = { 'cim:FaultIndicator': 'FaultIndicator', 'cim:ProtectionEquipment': 'ProtectionEquipment', 'cim:RemoteUnit': 'RTU' };

async function importCim(path) {
  await migrate(); // ensure the base app schema exists; network_topology_schema.sql is applied separately (see README note at bottom)

  const elements = parseCimXml(path);
  const byId = new Map(elements.filter((e) => e.id).map((e) => [e.id, e]));

  // ---- Diagram geometry: DiagramObject -> asset mRID, and its point(s) ----
  const diagramObjToAsset = new Map();   // DiagramObject id -> asset mRID
  for (const dObj of byTag(elements, 'cim:DiagramObject')) {
    const ref = dObj.attrs['cim:DiagramObject.IdentifiedObject'];
    if (ref?.resource) diagramObjToAsset.set(dObj.id, ref.resource);
  }
  // Collect EVERY raw point first (no filtering yet) -- whether a point is
  // lon/lat degrees or UTM metres can only be judged against the rest of the
  // file, so classification happens in a second pass below.
  const rawPoints = []; // { diagObj, seq, x, y }
  for (const pt of byTag(elements, 'cim:DiagramObjectPoint')) {
    const ref = pt.attrs['cim:DiagramObjectPoint.DiagramObject'];
    if (!ref?.resource) continue;
    const seq = Number(pt.attrs['cim:DiagramObjectPoint.sequenceNumber'] ?? 0);
    const x = Number(pt.attrs['cim:DiagramObjectPoint.xPosition']);
    const y = Number(pt.attrs['cim:DiagramObjectPoint.yPosition']);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    rawPoints.push({ diagObj: ref.resource, seq, x, y });
  }

  // FINDINGS FROM TESTING (see header): the file declares EPSG:4326 for every
  // DiagramObject, but line geometry is really UTM easting/northing in metres.
  // Classification:
  //   * |x|<=180 and |y|<=90  -> lon/lat degrees, used as-is ("valid")
  //   * anything else          -> projected metres; converted from UTM ONLY if
  //     a zone can be proven from the file itself (below), else dropped.
  const isDegrees = (p) => Math.abs(p.x) <= 180 && Math.abs(p.y) <= 90;
  const valid = rawPoints.filter(isDegrees);
  const projected = rawPoints.filter((p) => !isDegrees(p));

  let utmZone = null;
  let utmNorth = true;
  let pointsConvertedFromUtm = 0;
  let skippedOutOfRange = 0;
  if (projected.length) {
    // The zone is NOT assumed. It is derived from where the file's own valid
    // lon/lat points are, then PROVEN: a candidate zone is accepted only if
    // (nearly) every projected point, once converted, lands inside the area
    // covered by the valid points (plus a ~10 km margin). Zones 43 vs 44 are
    // 570 km apart for this file, so a wrong zone cannot pass this test.
    // If the file has no valid points to compare against, or zero or more
    // than one zone passes, NOTHING is converted -- points are dropped and
    // reported, exactly as before, rather than guessed.
    if (valid.length) {
      const lons = valid.map((p) => p.x).sort((a, b) => a - b);
      const lats = valid.map((p) => p.y).sort((a, b) => a - b);
      const MARGIN = 0.1; // degrees, ~10 km
      const box = { w: lons[0] - MARGIN, e: lons[lons.length - 1] + MARGIN, s: lats[0] - MARGIN, n: lats[lats.length - 1] + MARGIN };
      const medianLat = lats[Math.floor(lats.length / 2)];
      const north = medianLat >= 0;
      utmNorth = north;
      const z0 = zoneOfLon(lons[Math.floor(lons.length / 2)]);
      const passing = [];
      for (const z of [z0 - 1, z0, z0 + 1].filter((z) => z >= 1 && z <= 60)) {
        const inside = projected.filter((p) => {
          const [lo, la] = utmToLonLat(p.x, p.y, z, north);
          return lo >= box.w && lo <= box.e && la >= box.s && la <= box.n;
        }).length;
        if (inside / projected.length >= 0.99) passing.push(z);
      }
      if (passing.length === 1) utmZone = passing[0];
      else console.warn(`WARNING: could not prove a single UTM zone for ${projected.length} projected points (candidates passing: ${JSON.stringify(passing)}) -- they will be skipped, not guessed.`);
    } else {
      console.warn(`WARNING: ${projected.length} projected points but no lon/lat points to verify a UTM zone against -- skipped, not guessed.`);
    }
  }

  const pointsByDiagramObj = new Map(); // DiagramObject id -> [{seq, lon, lat}]
  const addPoint = (diagObj, seq, lon, lat) => {
    const list = pointsByDiagramObj.get(diagObj) || [];
    list.push({ seq, lon, lat });
    pointsByDiagramObj.set(diagObj, list);
  };
  for (const p of valid) addPoint(p.diagObj, p.seq, p.x, p.y);
  for (const p of projected) {
    if (utmZone == null) { skippedOutOfRange++; continue; }
    const [lon, lat] = utmToLonLat(p.x, p.y, utmZone, utmNorth);
    addPoint(p.diagObj, p.seq, lon, lat);
    pointsConvertedFromUtm++;
  }

  // Per asset: a representative point (lowest sequence) for the marker /
  // distance queries, and -- when the asset has 2+ points -- the full ordered
  // path so line equipment can actually be DRAWN on the map.
  const assetPoint = new Map(); // asset mRID -> {lat, lon}
  const assetPath = new Map();  // asset mRID -> [[lon, lat], ...]
  for (const [diagObjId, assetId] of diagramObjToAsset) {
    const pts = (pointsByDiagramObj.get(diagObjId) || []).sort((a, b) => a.seq - b.seq);
    if (!pts.length) continue;
    assetPoint.set(assetId, { lat: pts[0].lat, lon: pts[0].lon });
    if (pts.length >= 2) assetPath.set(assetId, pts.map((q) => [q.lon, q.lat]));
  }
  const geogSql = (mrid) => {
    const p = assetPoint.get(mrid);
    return p ? { rawtext: `ST_SetSRID(ST_MakePoint(${p.lon},${p.lat}),4326)::geography` } : null;
  };
  const pathSql = (mrid) => {
    const path = assetPath.get(mrid);
    if (!path) return null;
    return { rawtext: `ST_GeogFromText('SRID=4326;LINESTRING(${path.map(([lo, la]) => `${lo} ${la}`).join(',')})')` };
  };

  const stats = { substations: 0, feeders: 0, equipment: 0, terminals: 0, connectivityNodes: 0, protectionAssets: 0, pointsConvertedFromUtm, utmZoneUsed: utmZone, pointsSkippedOutOfRange: skippedOutOfRange };

  // ---- Substations ----
  const substations = byTag(elements, 'cim:Substation');
  for (const s of substations) {
    const geog = geogSql(s.id);
    await db.none(
      `INSERT INTO network.substations (cim_mrid, name, code, geog, raw_attrs)
       VALUES ($/mrid/, $/name/, $/code/, ${geog ? geog.rawtext : 'NULL'}, $/attrs/)
       ON CONFLICT (cim_mrid) DO UPDATE SET name=EXCLUDED.name, code=EXCLUDED.code,
         geog=COALESCE(EXCLUDED.geog, network.substations.geog), raw_attrs=EXCLUDED.raw_attrs`,
      {
        mrid: s.id,
        name: s.attrs['cim:IdentifiedObject.name'] || null,
        // Real source data has no single "code" field on Substation -- the
        // profile's own aliasName/localName split (localName is the short
        // operational code, e.g. "RRD") is the closest equivalent; both are
        // still kept verbatim in raw_attrs regardless of this choice.
        code: s.attrs['cim:IdentifiedObject.localName'] || s.attrs['cim:IdentifiedObject.aliasName'] || null,
        attrs: s.attrs,
      }
    );
    stats.substations++;
  }
  // This file has exactly one substation and its Feeder carries no explicit
  // substation link at all -- documented assumption, not silently guessed:
  // with exactly one substation present, every feeder in the file belongs to
  // it. With more than one substation and no explicit link, this default is
  // wrong and must not be applied -- flagged loudly instead of guessing.
  const singleSubstationId = substations.length === 1 ? substations[0].id : null;
  if (substations.length > 1) {
    console.warn(`WARNING: ${substations.length} substations present with no explicit Feeder->Substation link in the source -- feeders will NOT be auto-linked; set feeder_id manually.`);
  }

  // ---- Feeders ----
  for (const f of byTag(elements, 'cim:Feeder')) {
    await db.none(
      `INSERT INTO network.feeders (cim_mrid, name, code, substation_id, raw_attrs)
       VALUES ($/mrid/, $/name/, $/code/,
         (SELECT id FROM network.substations WHERE cim_mrid=$/subMrid/), $/attrs/)
       ON CONFLICT (cim_mrid) DO UPDATE SET name=EXCLUDED.name, code=EXCLUDED.code,
         substation_id=EXCLUDED.substation_id, raw_attrs=EXCLUDED.raw_attrs`,
      {
        mrid: f.id,
        name: f.attrs['cim:IdentifiedObject.name'] || null,
        code: f.attrs['cim:IdentifiedObject.localName'] || f.attrs['cim:IdentifiedObject.aliasName'] || null,
        subMrid: singleSubstationId,
        attrs: f.attrs,
      }
    );
    stats.feeders++;
  }

  // ---- Equipment (every other cim:/sedms: class not handled above) ----
  const equipmentElements = elements.filter((e) => !NON_EQUIPMENT_TAGS.has(e.tag) && !PROTECTION_TAGS[e.tag] && e.id);
  for (const eq of equipmentElements) {
    const feederRef = eq.attrs['cim:Equipment.Feeder'];
    const geog = geogSql(eq.id);
    const pathG = pathSql(eq.id);
    await db.none(
      `INSERT INTO network.conducting_equipment (cim_mrid, cim_class, name, feeder_id, geog, path_geog, raw_attrs)
       VALUES ($/mrid/, $/cls/, $/name/,
         (SELECT id FROM network.feeders WHERE cim_mrid=$/feederMrid/),
         ${geog ? geog.rawtext : 'NULL'}, ${pathG ? pathG.rawtext : 'NULL'}, $/attrs/)
       ON CONFLICT (cim_mrid) DO UPDATE SET cim_class=EXCLUDED.cim_class, name=EXCLUDED.name,
         feeder_id=EXCLUDED.feeder_id,
         -- the latest file is the truth: a re-import must be able to CLEAR a stale or
         -- wrong coordinate (an earlier COALESCE here preserved bad values through re-imports)
         geog=EXCLUDED.geog, path_geog=EXCLUDED.path_geog,
         raw_attrs=EXCLUDED.raw_attrs`,
      {
        mrid: eq.id,
        cls: eq.tag.split(':')[1],
        name: eq.attrs['cim:IdentifiedObject.name'] || null,
        feederMrid: feederRef?.resource || null,
        attrs: eq.attrs,
      }
    );
    stats.equipment++;
  }

  // ---- Connectivity nodes ----
  for (const cn of byTag(elements, 'cim:ConnectivityNode')) {
    const containerRef = cn.attrs['cim:ConnectivityNode.ConnectivityNodeContainer'];
    await db.none(
      `INSERT INTO network.connectivity_nodes (cim_mrid, feeder_id)
       VALUES ($/mrid/, (SELECT id FROM network.feeders WHERE cim_mrid=$/feederMrid/))
       ON CONFLICT (cim_mrid) DO UPDATE SET feeder_id=EXCLUDED.feeder_id`,
      { mrid: cn.id, feederMrid: containerRef?.resource || null }
    );
    stats.connectivityNodes++;
  }

  // ---- Terminals (the actual graph edges) ----
  for (const t of byTag(elements, 'cim:Terminal')) {
    const eqRef = t.attrs['cim:Terminal.ConductingEquipment'];
    const cnRef = t.attrs['cim:Terminal.ConnectivityNode'];
    await db.none(
      `INSERT INTO network.terminals (cim_mrid, equipment_id, connectivity_node_id, sequence_number)
       VALUES ($/mrid/,
         (SELECT id FROM network.conducting_equipment WHERE cim_mrid=$/eqMrid/),
         (SELECT id FROM network.connectivity_nodes WHERE cim_mrid=$/cnMrid/),
         $/seq/)
       ON CONFLICT (cim_mrid) DO UPDATE SET equipment_id=EXCLUDED.equipment_id,
         connectivity_node_id=EXCLUDED.connectivity_node_id, sequence_number=EXCLUDED.sequence_number`,
      {
        mrid: t.id,
        eqMrid: eqRef?.resource || null,
        cnMrid: cnRef?.resource || null,
        seq: Number(t.attrs['cim:ACDCTerminal.sequenceNumber'] ?? 0) || null,
      }
    );
    stats.terminals++;
  }

  // ---- Protection/asset layer (RTU/FRTU, ProtectionEquipment, FaultIndicator) ----
  // None of these tags appear in the Dehradun sample -- this loop runs 0
  // times against it today, and that's the point: it costs nothing to have
  // ready, and needs no changes when a file that DOES contain FPIs arrives.
  for (const [tag, kind] of Object.entries(PROTECTION_TAGS)) {
    for (const pa of byTag(elements, tag)) {
      const termRef = pa.attrs['cim:AuxiliaryEquipment.Terminal'];
      const geog = geogSql(pa.id);
      await db.none(
        `INSERT INTO network.protection_assets (cim_mrid, kind, name, terminal_id, geog, raw_attrs)
         VALUES ($/mrid/, $/kind/, $/name/,
           (SELECT id FROM network.terminals WHERE cim_mrid=$/termMrid/),
           ${geog ? geog.rawtext : 'NULL'}, $/attrs/)
         ON CONFLICT (cim_mrid) DO UPDATE SET kind=EXCLUDED.kind, name=EXCLUDED.name,
           terminal_id=EXCLUDED.terminal_id, geog=COALESCE(EXCLUDED.geog, network.protection_assets.geog),
           raw_attrs=EXCLUDED.raw_attrs`,
        { mrid: pa.id, kind, name: pa.attrs['cim:IdentifiedObject.name'] || null, termMrid: termRef?.resource || null, attrs: pa.attrs }
      );
      stats.protectionAssets++;
    }
  }

  const noGeogCount = await db.one(
    `SELECT count(*)::int n FROM network.conducting_equipment WHERE geog IS NULL`
  );
  stats.equipmentWithNoGeog = noGeogCount.n;
  return stats;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node src/infra/importCimNetwork.js <path-to-cim.xml>');
    process.exit(1);
  }
  const stats = await importCim(path);
  console.log('[importCimNetwork]', stats);
  process.exit(0);
}

export { importCim, parseCimXml };
