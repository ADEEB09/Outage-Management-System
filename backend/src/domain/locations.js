// Validation for crew GPS points uploaded by the mobile app. Shared by the
// real API route and the standalone map test server so both accept and
// reject exactly the same input.
export const MAX_LOCATION_BATCH = 500;
export const MAX_BACKFILL_MS = 14 * 24 * 3600 * 1000; // two weeks offline, at most
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const LIVE_POSITION_MAX_ACCURACY_M = 200;
const POINT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const optNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// Returns a DB-ready row, or null if the point is invalid.
export function parseLocationPoint(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !POINT_ID_RE.test(raw.id ?? '')) return null;
  const { lat, lon } = raw;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const recordedMs = typeof raw.recordedAt === 'number' ? raw.recordedAt : Date.parse(raw.recordedAt);
  if (!Number.isFinite(recordedMs) || recordedMs > now + MAX_CLOCK_SKEW_MS || recordedMs < now - MAX_BACKFILL_MS) return null;
  return {
    id: raw.id,
    lat,
    lon,
    accuracy: optNum(raw.accuracy),
    speed: optNum(raw.speed),
    heading: optNum(raw.heading),
    recorded_at: new Date(recordedMs).toISOString(),
  };
}

// Splits an uploaded batch into valid rows and the ids to acknowledge.
// Every string id is acked — stored, duplicate or rejected — so the phone
// deletes exactly those and never retries garbage forever.
export function parseLocationBatch(input, now = Date.now()) {
  const valid = [];
  const ack = [];
  for (const raw of input) {
    const point = parseLocationPoint(raw, now);
    if (point) valid.push(point);
    if (typeof raw?.id === 'string') ack.push(raw.id);
  }
  return { valid, ack };
}

// Newest reasonably-accurate fix in the batch — the one that should become
// the crew's live position.
export function newestLivePoint(points) {
  return points
    .filter((p) => p.accuracy == null || p.accuracy <= LIVE_POSITION_MAX_ACCURACY_M)
    .reduce((best, p) => (!best || p.recorded_at > best.recorded_at ? p : best), null);
}

// Tile coordinates from a /tiles/:z/:x/:y.png request, or null if invalid.
export function parseTileParams({ z, x, y }) {
  const [zn, xn, yn] = [z, x, y].map((v) => (/^\d{1,7}$/.test(v) ? Number(v) : NaN));
  if (!(zn <= 20) || !(xn < 2 ** zn) || !(yn < 2 ** zn)) return null;
  return { z: zn, x: xn, y: yn };
}
