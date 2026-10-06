// Helpers for the crew trail overlay on the Network Map.
//
// Pure functions only (no DOM, no Leaflet) so they can be unit-tested with
// plain node. A "trail" is the list of GPS fixes a crew's phone reported,
// from GET /api/mobile/crews/:id/track.

export const TRAIL_WINDOWS = [['1h', 1], ['4h', 4], ['12h', 12], ['24h', 24]]; // [key, hours]
export const DEFAULT_WINDOW = '4h';
export const GAP_MS = 10 * 60 * 1000; // no fix for 10 min -> shown as a gap, not a straight line of travel
export const LATE_MS = 2 * 60 * 1000; // received > 2 min after it was recorded -> recorded offline, uploaded later
export const MAX_DOTS = 300;          // dots drawn per crew (the line itself always uses every point)
export const MAX_POINTS = 5000;       // how many of the newest fixes we ask the server for

export const windowMs = (key) => (TRAIL_WINDOWS.find(([k]) => k === key)?.[1] ?? 4) * 3600 * 1000;

// Rows from the API -> clean, time-sorted points. Bad rows are dropped, exact repeats collapsed.
export function normalizeTrack(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const lat = Number(r?.lat), lon = Number(r?.lon);
    const t = Date.parse(r?.recorded_at);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const received = r?.received_at ? Date.parse(r.received_at) : NaN;
    out.push({
      lat, lon, t,
      accuracy: Number.isFinite(Number(r?.accuracy)) && r.accuracy !== null ? Number(r.accuracy) : null,
      received: Number.isFinite(received) ? received : null,
      late: Number.isFinite(received) && received - t > LATE_MS,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((p, i) => !i || p.t !== out[i - 1].t || p.lat !== out[i - 1].lat || p.lon !== out[i - 1].lon);
}

// Great-circle distance in metres between two {lat, lon} points.
export function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Split into continuous legs; two fixes more than gapMs apart start a new leg and
// the hop between them is returned as a gap (drawn dashed: we do NOT know the route).
export function splitTrail(points, gapMs = GAP_MS) {
  const legs = [], gaps = [];
  let leg = [];
  points.forEach((p, i) => {
    if (i && p.t - points[i - 1].t > gapMs) {
      legs.push(leg);
      gaps.push([points[i - 1], p]);
      leg = [];
    }
    leg.push(p);
  });
  if (leg.length) legs.push(leg);
  return { legs, gaps };
}

// Totals for the side panel. Distance counts only continuous legs, so a gap
// (unknown route) never inflates it.
export function summarize(points) {
  if (!points.length) return { count: 0, distanceM: 0, firstT: null, lastT: null, lateCount: 0, gapCount: 0 };
  const { legs, gaps } = splitTrail(points);
  let d = 0;
  legs.forEach((leg) => { for (let i = 1; i < leg.length; i++) d += distanceM(leg[i - 1], leg[i]); });
  return {
    count: points.length,
    distanceM: d,
    firstT: points[0].t,
    lastT: points[points.length - 1].t,
    lateCount: points.filter((p) => p.late).length,
    gapCount: gaps.length,
  };
}

// At most `max` points for drawing dots, always keeping the first and the last.
export function thinDots(points, max = MAX_DOTS) {
  if (points.length <= max) return points;
  const out = [], step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
export const fmtClock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export function fmtDur(ms) {
  if (ms < 60000) return `${Math.max(1, Math.floor(ms / 1000))} s`;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return `${h} h${r ? ` ${r} min` : ''}`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}
export function fmtAgo(isoOrMs, now = Date.now()) {
  const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(t)) return 'never';
  return `${fmtDur(Math.max(0, now - t))} ago`;
}
