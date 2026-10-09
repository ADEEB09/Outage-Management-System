// The OMS's own idea of "regions", turned into map areas for the in-house map server.
//
// The map server holds all of India and knows nothing about the OMS. The OMS decides WHICH part is needed, from its own
// GIS data: substations (areas drawn around each one's feeder lines), plus the named zones / divisions listed in
// map-regions.json. Both apps then ask for a region by id; neither has to know coordinates.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const readJson = (name, fallback) => {
  try { return JSON.parse(readFileSync(join(here, name), 'utf8')); } catch { return fallback; }
};

const R = Math.PI / 180;
const round5 = (n) => Number(n.toFixed(5));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// bbox = [minLon, minLat, maxLon, maxLat]
export function bboxAround(lat, lon, radiusKm) {
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.cos(lat * R));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}
export function padBbox([x0, y0, x1, y1], km) {
  const lat = (y0 + y1) / 2;
  const dLat = km / 110.574;
  const dLon = km / (111.32 * Math.cos(lat * R));
  return [x0 - dLon, y0 - dLat, x1 + dLon, y1 + dLat];
}
// Make sure an area is at least `km` wide and tall (a substation with one short feeder would otherwise be a speck).
function atLeast([x0, y0, x1, y1], km) {
  const lat = (y0 + y1) / 2;
  const wKm = (x1 - x0) * 111.32 * Math.cos(lat * R);
  const hKm = (y1 - y0) * 110.574;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const halfLon = Math.max(wKm, km) / 2 / (111.32 * Math.cos(lat * R));
  const halfLat = Math.max(hKm, km) / 2 / 110.574;
  return [cx - halfLon, cy - halfLat, cx + halfLon, cy + halfLat];
}
export const areaKm2 = ([x0, y0, x1, y1]) =>
  (x1 - x0) * 111.32 * Math.cos(((y0 + y1) / 2) * R) * (y1 - y0) * 110.574;
export const distanceKm = (lat1, lon1, lat2, lon2) => {
  const dLat = (lat2 - lat1) * R, dLon = (lon2 - lon1) * R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * R) * Math.cos(lat2 * R) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};

function finish(r) {
  const bbox = r.bbox.map(round5);
  const center = [round5((bbox[1] + bbox[3]) / 2), round5((bbox[0] + bbox[2]) / 2)]; // [lat, lon]
  return { forCrews: false, ...r, bbox, center, areaKm2: Math.round(areaKm2(bbox)) };
}

// network = the parsed network.json; config = map-regions.json. Later entries override earlier ones with the same id.
export function buildCatalogue({ network, config }) {
  const out = new Map();
  const add = (r) => out.set(r.id, finish(r));

  const b = network?.bounds;
  if (b && [b.minLon, b.minLat, b.maxLon, b.maxLat].every(Number.isFinite)) {
    add({ id: 'network', name: 'Whole GIS network', kind: 'network', bbox: padBbox([b.minLon, b.minLat, b.maxLon, b.maxLat], 2) });
  }
  for (const ss of network?.substations || []) {
    if (!Number.isFinite(ss.lat) || !Number.isFinite(ss.lon)) continue;
    let x0 = ss.lon, x1 = ss.lon, y0 = ss.lat, y1 = ss.lat;
    for (const line of network.feederLines || []) {
      if (line.ss !== ss.name) continue;
      for (const [lat, lon] of line.path || []) {
        if (lon < x0) x0 = lon; if (lon > x1) x1 = lon; if (lat < y0) y0 = lat; if (lat > y1) y1 = lat;
      }
    }
    add({ id: `ss-${slug(ss.code || ss.id)}`, name: ss.name, kind: 'substation', substationId: ss.id, bbox: atLeast(padBbox([x0, y0, x1, y1], 1.5), 3) });
  }
  for (const r of config?.regions || []) {
    const bbox = Array.isArray(r.bbox) && r.bbox.length === 4 ? r.bbox : bboxAround(r.lat, r.lon, r.radiusKm);
    if (!r.id || bbox.some((v) => !Number.isFinite(v))) continue; // skip a malformed entry rather than break everything
    add({ ...r, bbox });
  }
  return [...out.values()];
}

// Which region should this crew's phone download?  override > the smallest crew-region containing the crew > nearest > default
export function pickCrewRegion(catalogue, config, { crewId, lat, lon } = {}) {
  const byId = new Map(catalogue.map((r) => [r.id, r]));
  const pinned = config?.crewOverrides?.[crewId];
  if (pinned && byId.has(pinned)) return { region: byId.get(pinned), reason: 'override' };

  const candidates = catalogue.filter((r) => r.forCrews);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const inside = candidates
      .filter((r) => lon >= r.bbox[0] && lon <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3])
      .sort((a, b) => a.areaKm2 - b.areaKm2);
    if (inside.length) return { region: inside[0], reason: 'position' };
    const near = candidates
      .map((r) => ({ r, d: distanceKm(lat, lon, r.center[0], r.center[1]) }))
      .sort((a, b) => a.d - b.d)[0];
    if (near && near.d <= (config?.nearestMaxKm ?? 40)) return { region: near.r, reason: 'nearest' };
  }
  const fallback = byId.get(config?.defaultCrewRegion) || candidates[0] || catalogue[0] || null;
  return { region: fallback, reason: 'default' };
}
