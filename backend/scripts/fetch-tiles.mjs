// One-time (or occasional) seeding of the crew app's offline map tile pack.
//
// Downloads raster tiles for the service areas onto the OMS server; crew
// phones then download the pack from the OMS backend (GET /api/tiles/*).
//
// The source must be a tile server you are allowed to bulk-download from —
// normally one you run yourself on free OpenStreetMap data. The public
// tile.openstreetmap.org servers forbid bulk/offline downloading and block
// it (they answer every tile with an "Access blocked" image), so they are
// refused here.
//
// Usage (from backend/):
//   TILE_SOURCE_URL="http://localhost:8080/tile/{z}/{x}/{y}.png" npm run tiles:fetch
//   npm run tiles:fetch -- --dry-run      # just count tiles
//
// Env:
//   TILE_SOURCE_URL   required — {z}/{x}/{y} PNG tile URL of your tile server.
//   TILE_CONTACT      optional — email/URL added to the User-Agent.
//   TILE_CONCURRENCY  default 4 parallel downloads.
//   TILE_ATTRIBUTION  default "© OpenStreetMap contributors" (legally required
//                     for OSM data; shown on the map).
//   TILES_DIR         default backend/tiles (must match the backend's TILES_DIR).
//   TILE_FORMAT       png (default, stored as served) or webp (re-encoded with
//                     sharp; about half the size — use it for the 2x HD pack).
//   TILE_QUALITY      WebP quality, default 75.
//
// HD pack for phone screens (renderer at 2x, see tile-server/docker-compose.yml):
//   TILE_SOURCE_URL="http://localhost:8091/tile/{z}/{x}/{y}.png" TILE_FORMAT=webp npm run tiles:fetch
//
// Safe to re-run: existing tiles are skipped (resume), files are written
// atomically, and the pack version is a content hash, so phones only
// re-download when tiles actually changed.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// [west, south, east, north]. City regions get street-level detail; the
// corridor covers the highways between the cities (to zoom 15, enough to
// read junctions and village roads on the way to a site).
const SERVICE_REGIONS = [
  { id: 'dehradun', name: 'Dehradun', bbox: [77.92, 30.22, 78.13, 30.42], minZoom: 10, maxZoom: 16 },
  { id: 'rishikesh', name: 'Rishikesh', bbox: [78.22, 30.03, 78.36, 30.16], minZoom: 10, maxZoom: 16 },
  { id: 'haridwar', name: 'Haridwar', bbox: [78.0, 29.86, 78.22, 30.0], minZoom: 10, maxZoom: 16 },
  { id: 'corridor', name: 'Dehradun–Rishikesh–Haridwar corridor', bbox: [77.85, 29.8, 78.45, 30.5], minZoom: 8, maxZoom: 15 },
];

// Extra areas for testing the app away from the service area, opt-in with
// PACK_TEST_REGIONS=delhi-ncr (set it for tiles:fetch AND roads:build). Each
// names the OSM extract in tile-server/ its roads come from; its tiles need a
// renderer loaded with that extract (see tile-server/docker-compose.yml).
const TEST_REGIONS = [
  // BBBike "NewDelhi" extract: Delhi, Noida, most of Gurgaon.
  //   curl -L -o tile-server/ncr.osm.pbf https://download.bbbike.org/osm/bbbike/NewDelhi/NewDelhi.osm.pbf
  { id: 'delhi-ncr', name: 'Delhi NCR (test)', bbox: [76.98, 28.44, 77.49, 28.73], minZoom: 8, maxZoom: 16, pbf: 'ncr.osm.pbf' },
];

const testIds = (process.env.PACK_TEST_REGIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const id of testIds) {
  if (!TEST_REGIONS.some((r) => r.id === id)) throw new Error(`Unknown PACK_TEST_REGIONS entry "${id}"`);
}
export const REGIONS = [...SERVICE_REGIONS, ...TEST_REGIONS.filter((r) => testIds.includes(r.id))];

const SOURCE = process.env.TILE_SOURCE_URL || '';
const ATTRIBUTION = process.env.TILE_ATTRIBUTION || '© OpenStreetMap contributors';
const CONTACT = process.env.TILE_CONTACT;
const OUT = process.env.TILES_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'tiles');
const CONCURRENCY = Number(process.env.TILE_CONCURRENCY || 4);
// A blocked/misconfigured source typically answers every tile with the same
// error image. Real map tiles across a city are never all identical.
const IDENTICAL_TILE_LIMIT = 25;
const DRY_RUN = process.argv.includes('--dry-run');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FORMAT = process.env.TILE_FORMAT === 'webp' ? 'webp' : 'png';
const QUALITY = Number(process.env.TILE_QUALITY || 75);
let tilePixels = null; // source tile width: 256 standard, 512 for the 2x HD renderer

// Stored tile bytes for a fetched PNG: as-is, or re-encoded to WebP.
async function encodeTile(png) {
  if (!tilePixels) tilePixels = png.readUInt32BE(16);
  if (FORMAT === 'png') return png;
  const { default: sharp } = await import('sharp');
  return sharp(png).webp({ quality: QUALITY, effort: 5 }).toBuffer();
}

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function* tilesFor({ bbox: [w, s, e, n], minZoom, maxZoom }) {
  for (let z = minZoom; z <= maxZoom; z++) {
    const [x0, x1, y0, y1] = [lon2x(w, z), lon2x(e, z), lat2y(n, z), lat2y(s, z)];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield { z, x, y };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

async function fetchTile({ z, x, y }) {
  const url = SOURCE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': `OMS-Crew-OfflineTileSeeder/1.0${CONTACT ? ` (+${CONTACT})` : ''}` },
      signal: AbortSignal.timeout(30000),
    }).catch((err) => ({ ok: false, status: 0, err }));
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw Object.assign(new Error(`${url} did not return a PNG`), { fatal: true });
      return buf;
    }
    if (res.status === 404) return null;
    if (res.status === 403) {
      throw Object.assign(new Error(`${url} -> 403 Forbidden; the provider is refusing this client, stop and check its usage policy`), { fatal: true });
    }
    if (attempt >= 5) throw new Error(`${url} -> ${res.status || res.err?.message}`);
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
  }
}

async function writeAtomic(path, buf) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, path);
}

// Content hash over every tile (sorted), so the version only changes when
// the pack's contents do.
async function hashPack(tiles) {
  const hash = createHash('sha256');
  let count = 0;
  let bytes = 0;
  for (const { z, x, y } of tiles) {
    const buf = await readFile(join(OUT, `${z}/${x}/${y}.${FORMAT}`)).catch(() => null);
    if (!buf) continue;
    hash.update(`${z}/${x}/${y}:`).update(buf);
    count++;
    bytes += buf.length;
  }
  return { version: hash.digest('hex').slice(0, 16), count, bytes };
}

async function main() {
  const regions = REGIONS;
  const seen = new Set();
  const tiles = [];
  for (const region of regions) {
    for (const t of tilesFor(region)) {
      const key = `${t.z}/${t.x}/${t.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        tiles.push(t);
      }
    }
  }
  tiles.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
  console.log(`Offline pack: ${tiles.length} unique tiles across ${regions.map((r) => r.name).join(', ')}`);
  if (DRY_RUN) return;
  if (!SOURCE) throw new Error('Set TILE_SOURCE_URL to your tile server, e.g. http://localhost:8080/tile/{z}/{x}/{y}.png');
  if (/(^|\.)openstreetmap\.org$/.test(new URL(SOURCE.replace(/[{}]/g, '')).hostname)) {
    throw new Error('tile.openstreetmap.org forbids bulk downloading for offline use (and blocks it). Use your own tile server.');
  }

  let done = 0;
  let fetched = 0;
  let missing = 0;
  const failed = [];
  const firstHashes = new Set();
  let hashed = 0;
  const queue = [...tiles];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const path = join(OUT, `${t.z}/${t.x}/${t.y}.${FORMAT}`);
      if (!(await exists(path))) {
        try {
          const buf = await fetchTile(t);
          if (buf) {
            if (hashed < IDENTICAL_TILE_LIMIT) {
              hashed++;
              firstHashes.add(createHash('sha1').update(buf).digest('hex'));
              if (hashed === IDENTICAL_TILE_LIMIT && firstHashes.size === 1) {
                throw Object.assign(
                  new Error(`The first ${IDENTICAL_TILE_LIMIT} tiles are byte-identical — the source is returning an error/blocked image, not map tiles. Aborting.`),
                  { fatal: true }
                );
              }
            }
            await writeAtomic(path, await encodeTile(buf));
            fetched++;
          } else missing++;
        } catch (err) {
          if (err.fatal) throw err; // the provider refused us — stop immediately
          // A flaky connection shouldn't abort thousands of good tiles;
          // note it and keep going. A re-run retries just these.
          failed.push(`${t.z}/${t.x}/${t.y}`);
          console.warn(`\n  ${err.message}`);
        }
      }
      if (++done % 250 === 0 || done === tiles.length) {
        process.stdout.write(`\r  ${done}/${tiles.length} (${fetched} downloaded, ${missing} missing upstream, ${failed.length} failed)`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
  if (failed.length) {
    // No manifest for an incomplete pack, so phones never install a pack with holes.
    throw new Error(`${failed.length} tile(s) failed (network errors). Re-run the same command — it resumes and retries only those.`);
  }

  const { version, count, bytes } = await hashPack(tiles);
  // A resumed run may fetch nothing new; keep what the previous run recorded.
  const previous = await readFile(join(OUT, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
  const all = regions.map((r) => r.bbox);
  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    source: new URL(SOURCE.replace(/[{}]/g, '')).hostname,
    attribution: ATTRIBUTION,
    format: FORMAT,
    // 512 = rendered at 2x for high-density screens (shown at 256 CSS px).
    tilePixels: tilePixels || (previous?.format === FORMAT ? previous.tilePixels : null) || 256,
    minZoom: Math.min(...regions.map((r) => r.minZoom)),
    maxZoom: Math.max(...regions.map((r) => r.maxZoom)),
    bounds: [
      Math.min(...all.map((b) => b[0])),
      Math.min(...all.map((b) => b[1])),
      Math.max(...all.map((b) => b[2])),
      Math.max(...all.map((b) => b[3])),
    ],
    regions: regions.map(({ pbf, ...region }) => region),
    tileCount: count,
    totalBytes: bytes,
  };
  // Keep the road graph entry written by build-road-graph.mjs.
  if (previous?.roads) manifest.roads = previous.roads;
  await writeAtomic(join(OUT, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
  console.log(`Pack ${version}: ${count} tiles, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}`);
}

// Only when run directly: build-road-graph.mjs imports REGIONS from here.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  });
}
