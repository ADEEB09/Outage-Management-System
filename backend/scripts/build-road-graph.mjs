// Builds the road graph used for road routing (online via GET /api/route,
// offline on the crew phone) from a free OpenStreetMap extract.
//
// Output: <TILES_DIR>/roads.json (format "oms-roads-1", see
// src/domain/roadRouter.js), and a `roads` entry in <TILES_DIR>/manifest.json
// so phones download it together with the offline map pack.
//
// Usage (from backend/):
//   curl -L -o tile-server/uttarakhand.osm.pbf https://download.openstreetmap.fr/extracts/asia/india/uttarakhand-latest.osm.pbf
//   npm run roads:build
//
// Env:
//   OSM_PBF    default tile-server/uttarakhand.osm.pbf
//   TILES_DIR  default backend/tiles (must match the backend's TILES_DIR)
//
// Map data © OpenStreetMap contributors (ODbL).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONS } from './fetch-tiles.mjs';
import { GRAPH_FORMAT, createRouter } from '../src/domain/roadRouter.js';

const require = createRequire(import.meta.url);
const parseOsm = require('osm-pbf-parser');

const here = dirname(fileURLToPath(import.meta.url));
// Comma-separated list. By default the Uttarakhand extract plus the extract
// of each enabled test region (PACK_TEST_REGIONS, see fetch-tiles.mjs).
const PBFS = process.env.OSM_PBF
  ? process.env.OSM_PBF.split(',').map((p) => p.trim()).filter(Boolean)
  : [...new Set(['uttarakhand.osm.pbf', ...REGIONS.filter((r) => r.pbf).map((r) => r.pbf)])].map((f) => join(here, '..', 'tile-server', f));
const OUT = process.env.TILES_DIR || join(here, '..', 'tiles');
const E = 1e5;

// Typical speeds (km/h) for a service vehicle on Uttarakhand roads, by OSM
// road class. Deliberately below legal limits: they drive the ETA.
const SPEEDS = {
  motorway: 80, motorway_link: 45,
  trunk: 55, trunk_link: 35,
  primary: 45, primary_link: 30,
  secondary: 38, secondary_link: 28,
  tertiary: 32, tertiary_link: 25,
  unclassified: 28, road: 25,
  residential: 22, living_street: 10,
  service: 15, track: 12,
};

// Each region the pack covers, plus a margin so routes can leave and
// re-enter it without being cut off at the edge. Regions are kept separate,
// so a far-away test region doesn't pull in every road in between.
const MARGIN = 0.05;
const AREAS = REGIONS.map((r) => [r.bbox[0] - MARGIN, r.bbox[1] - MARGIN, r.bbox[2] + MARGIN, r.bbox[3] + MARGIN]);
const BBOX = [
  Math.min(...AREAS.map((b) => b[0])),
  Math.min(...AREAS.map((b) => b[1])),
  Math.max(...AREAS.map((b) => b[2])),
  Math.max(...AREAS.map((b) => b[3])),
];
const inArea = (b, lat, lon) => lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3];
const inBbox = (lat, lon) => AREAS.some((b) => inArea(b, lat, lon));

function drivable(tags) {
  const speed = SPEEDS[tags.highway];
  if (!speed || tags.area === 'yes') return null;
  const no = (v) => v === 'no' || v === 'private';
  const yes = (v) => v === 'yes' || v === 'designated' || v === 'permissive' || v === 'destination';
  if (no(tags.motor_vehicle) || no(tags.vehicle)) return null;
  if (no(tags.access) && !yes(tags.motor_vehicle) && !yes(tags.vehicle)) return null;
  const limit = parseInt(tags.maxspeed, 10);
  return Number.isFinite(limit) && limit > 0 ? Math.min(speed, limit) : speed;
}

function onewayOf(tags) {
  const v = tags.oneway;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === 'no' || v === 'false' || v === '0') return 0;
  return tags.junction === 'roundabout' || tags.junction === 'circular' || tags.highway === 'motorway' ? 1 : 0;
}

function readOnePbf(path, onItem) {
  return new Promise((resolve, reject) => {
    const parser = parseOsm();
    createReadStream(path).on('error', reject).pipe(parser);
    parser.on('data', (items) => {
      for (const item of items) onItem(item);
    });
    parser.on('end', resolve);
    parser.on('error', reject);
  });
}

// Extracts may overlap at their edges; a way seen twice is kept once.
async function readPbf(onItem) {
  for (const path of PBFS) await readOnePbf(path, onItem);
}

async function main() {
  const absent = PBFS.filter((p) => !existsSync(p));
  if (absent.length) {
    throw new Error(`OSM extract not found at ${absent.join(', ')}. Download it first, e.g.:\n  curl -L -o tile-server/uttarakhand.osm.pbf https://download.openstreetmap.fr/extracts/asia/india/uttarakhand-latest.osm.pbf`);
  }
  console.log(`Reading roads from ${PBFS.join(', ')}`);

  // Pass 1: drivable ways and the nodes they use.
  const ways = [];
  const needed = new Set();
  const seenWays = new Set();
  await readPbf((item) => {
    if (item.type !== 'way' || !item.tags?.highway || seenWays.has(item.id)) return;
    seenWays.add(item.id);
    const kmh = drivable(item.tags);
    if (!kmh || item.refs.length < 2) return;
    const oneway = onewayOf(item.tags);
    const refs = oneway === -1 ? [...item.refs].reverse() : item.refs;
    ways.push({ refs, kmh, oneway: oneway !== 0 ? 1 : 0 });
    for (const r of refs) needed.add(r);
  });
  console.log(`  ${ways.length} drivable ways`);

  // Pass 2: coordinates of those nodes.
  const coord = new Map();
  await readPbf((item) => {
    if (item.type === 'node' && needed.has(item.id)) coord.set(item.id, [item.lat, item.lon]);
  });
  needed.clear();

  // Keep ways that touch the service area (whole way, not clipped).
  const local = ways.filter((w) => w.refs.every((r) => coord.has(r)) && w.refs.some((r) => inBbox(...coord.get(r))));
  console.log(`  ${local.length} in the service area`);

  // Junctions: way ends, and nodes shared by more than one way occurrence.
  const uses = new Map();
  for (const w of local) for (const r of w.refs) uses.set(r, (uses.get(r) || 0) + 1);
  const isJunction = (w, i) => i === 0 || i === w.refs.length - 1 || uses.get(w.refs[i]) > 1;

  // Split ways into edges between junctions.
  const rawEdges = [];
  for (const w of local) {
    let start = 0;
    for (let i = 1; i < w.refs.length; i++) {
      if (!isJunction(w, i)) continue;
      rawEdges.push({ refs: w.refs.slice(start, i + 1), kmh: w.kmh, oneway: w.oneway });
      start = i;
    }
  }

  // Largest connected component of each region only: an isolated fragment
  // (a gated campus, a road cut off by the extract) would otherwise catch
  // GPS snaps and produce "no route". Per region, because a test region far
  // from the service area is a separate network of its own.
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const e of rawEdges) {
    for (const n of [e.refs[0], e.refs[e.refs.length - 1]]) if (!parent.has(n)) parent.set(n, n);
    const a = find(e.refs[0]), b = find(e.refs[e.refs.length - 1]);
    if (a !== b) parent.set(a, b);
  }
  const keep = new Set();
  for (const area of AREAS) {
    const size = new Map();
    for (const n of parent.keys()) {
      if (inArea(area, ...coord.get(n))) size.set(find(n), (size.get(find(n)) || 0) + 1);
    }
    const largest = [...size.entries()].sort((x, y) => y[1] - x[1])[0];
    if (largest) keep.add(largest[0]);
  }
  const kept = rawEdges.filter((e) => keep.has(find(e.refs[0])));
  console.log(`  ${kept.length} road segments in the connected network (${rawEdges.length - kept.length} isolated dropped)`);

  // Number junctions in a spatial order so the delta encoding stays small.
  const juncIds = [...new Set(kept.flatMap((e) => [e.refs[0], e.refs[e.refs.length - 1]]))];
  const q = (id) => coord.get(id).map((v) => Math.round(v * E));
  juncIds.sort((a, b) => {
    const [aLat, aLon] = q(a), [bLat, bLon] = q(b);
    const ca = Math.floor(aLon / 1000), cb = Math.floor(bLon / 1000);
    return ca - cb || aLat - bLat || aLon - bLon;
  });
  const juncIndex = new Map(juncIds.map((id, i) => [id, i]));
  kept.sort((a, b) => juncIndex.get(a.refs[0]) - juncIndex.get(b.refs[0]));

  const juncs = [];
  let pLat = 0, pLon = 0;
  for (const id of juncIds) {
    const [lat, lon] = q(id);
    juncs.push(lat - pLat, lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  const pts = [];
  const edges = [];
  pLat = 0;
  pLon = 0;
  for (const e of kept) {
    const interior = e.refs.slice(1, -1);
    for (const id of interior) {
      const [lat, lon] = q(id);
      pts.push(lat - pLat, lon - pLon);
      pLat = lat;
      pLon = lon;
    }
    edges.push(juncIndex.get(e.refs[0]), juncIndex.get(e.refs[e.refs.length - 1]), interior.length, e.kmh, e.oneway);
  }

  const graph = {
    format: GRAPH_FORMAT,
    generatedAt: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors',
    bbox: BBOX,
    juncs,
    pts,
    edges,
  };
  const router = createRouter(graph); // validates the graph decodes and indexes
  const body = JSON.stringify(graph);
  const version = createHash('sha256').update(body).digest('hex').slice(0, 16);

  const tmp = join(OUT, `roads.json.${process.pid}.tmp`);
  await writeFile(tmp, body);
  await rename(tmp, join(OUT, 'roads.json'));

  // Register it in the pack manifest (phones download it with the tiles).
  const manifestPath = join(OUT, 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.roads = { file: 'roads.json', version, bytes: Buffer.byteLength(body), ...router.stats };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  } else {
    console.warn('  no manifest.json yet (run tiles:fetch) — roads.json is written but phones will not download it');
  }
  console.log(`Road graph ${version}: ${router.stats.junctions} junctions, ${router.stats.edges} segments, ${(Buffer.byteLength(body) / 1048576).toFixed(1)} MB -> ${OUT}`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
