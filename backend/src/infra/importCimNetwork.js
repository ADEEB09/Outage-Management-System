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
// declares EPSG:4326 (WGS84) for every DiagramObject, but that is not
// actually true for every point -- some DiagramObjectPoints are UTM
// easting/northing in metres (large 6-7 digit values), not lon/lat degrees.
// PostGIS's geography cast does not reject an out-of-range value; it
// silently normalizes it into something that still looks like a valid
// coordinate but is geographic nonsense. Every point is therefore validated
// against the WGS84 range (|lon|<=180, |lat|<=90) BEFORE it is ever used to
// build a geography value; anything failing that check is dropped, and the
// affected equipment is left with geog = NULL rather than a wrong location.
// Counted and reported in the import stats every run (pointsSkippedOutOfRange,
// equipmentWithNoGeog), not hidden.
//
// Run: node src/infra/importCimNetwork.js <path-to-cim.xml>
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { db, migrate } from './db.js';
import { pathToFileURL } from 'node:url';


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
  const pointsByDiagramObj = new Map(); // DiagramObject id -> [{seq,x,y}]
  let skippedOutOfRange = 0;
  for (const pt of byTag(elements, 'cim:DiagramObjectPoint')) {
    const ref = pt.attrs['cim:DiagramObjectPoint.DiagramObject'];
    if (!ref?.resource) continue;
    const seq = Number(pt.attrs['cim:DiagramObjectPoint.sequenceNumber'] ?? 0);
    const x = Number(pt.attrs['cim:DiagramObjectPoint.xPosition']); // longitude, IF this point is really WGS84
    const y = Number(pt.attrs['cim:DiagramObjectPoint.yPosition']); // latitude, IF this point is really WGS84
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // The file's own single Diagram element declares EPSG:4326 (WGS84) for
    // every DiagramObject -- but real data shows this is FALSE for a subset:
    // some points are UTM easting/northing in metres (e.g. x=218768.11,
    // y=3356263.45 for ACLineSegment 1380139840), not lon/lat in degrees.
    // Found by testing: PostGIS's geography cast does NOT reject an
    // out-of-range value, it silently wraps/normalizes it into something
    // that LOOKS like a valid coordinate but is geographic nonsense (that
    // specific point stored as lat=-16.55, lon=-111.89 -- mid-Pacific,
    // nowhere near this substation). So this check MUST run on the raw
    // parsed value, before any point ever reaches ST_MakePoint -- a check
    // against the already-stored geography would find nothing wrong.
    if (Math.abs(x) > 180 || Math.abs(y) > 90) {
      skippedOutOfRange++;
      continue;
    }
    const list = pointsByDiagramObj.get(ref.resource) || [];
    list.push({ seq, x, y });
    pointsByDiagramObj.set(ref.resource, list);
  }
  const assetPoint = new Map(); // asset mRID -> {lat, lon} (lowest-sequence point; good enough for a map marker, not a full path)
  for (const [diagObjId, assetId] of diagramObjToAsset) {
    const pts = (pointsByDiagramObj.get(diagObjId) || []).sort((a, b) => a.seq - b.seq);
    if (pts.length) assetPoint.set(assetId, { lat: pts[0].y, lon: pts[0].x });
  }
  const geogSql = (mrid) => {
    const p = assetPoint.get(mrid);
    return p ? { rawtext: `ST_SetSRID(ST_MakePoint(${p.lon},${p.lat}),4326)::geography` } : null;
  };

  const stats = { substations: 0, feeders: 0, equipment: 0, terminals: 0, connectivityNodes: 0, protectionAssets: 0, pointsSkippedOutOfRange: skippedOutOfRange };

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
    await db.none(
      `INSERT INTO network.conducting_equipment (cim_mrid, cim_class, name, feeder_id, geog, raw_attrs)
       VALUES ($/mrid/, $/cls/, $/name/,
         (SELECT id FROM network.feeders WHERE cim_mrid=$/feederMrid/),
         ${geog ? geog.rawtext : 'NULL'}, $/attrs/)
       ON CONFLICT (cim_mrid) DO UPDATE SET cim_class=EXCLUDED.cim_class, name=EXCLUDED.name,
         feeder_id=EXCLUDED.feeder_id, geog=COALESCE(EXCLUDED.geog, network.conducting_equipment.geog),
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
