import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _dir = dirname(fileURLToPath(import.meta.url));
let NET = { substations: [], distTx: [] };
try { NET = JSON.parse(readFileSync(join(_dir, 'network.json'), 'utf8')); } catch { /* served empty */ }

const codeToSub = new Map(NET.substations.map((s) => [s.code, s]));

const hav = (aLat, aLon, bLat, bLon) => {
  const R = 6371, dLat = (bLat - aLat) * Math.PI / 180, dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

function nearest(list, lat, lon) {
  let best = null, bd = Infinity;
  for (const a of list) { const d = hav(lat, lon, a.lat, a.lon); if (d < bd) { bd = d; best = a; } }
  return best ? { asset: best, km: bd } : null;
}

// Resolve a customer complaint's location to the network asset chain:
// complaint (lat,lon) -> nearest distribution transformer -> its feeder -> substation.
export function resolve(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return { dt_id: null, feeder: null, substation: null, substation_code: null };
  const dt = nearest(NET.distTx, lat, lon);
  let sub = null, subCode = null, feeder = null;
  if (dt) {
    feeder = dt.asset.feeder || null;
    const s = codeToSub.get(dt.asset.ss);
    if (s) { sub = s.name; subCode = s.code; }
  }
  if (!sub) { const ns = nearest(NET.substations, lat, lon); if (ns) { sub = ns.asset.name; subCode = ns.asset.code; } } // geographic fallback
  return {
    dt_id: dt ? dt.asset.id : null,
    dt_name: dt ? dt.asset.name : null,
    feeder,
    substation: sub,
    substation_code: subCode,
    distance_km: dt ? Number(dt.km.toFixed(3)) : null,
  };
}

export const substations = NET.substations;
export const distTx = NET.distTx;
