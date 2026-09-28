// src/lib/roadRouting.js
// Road route from the crew to a site: the real path along roads, with road
// distance and an ETA, for drawing on the offline map.
//
//  - Online: asks the OMS backend (GET /api/route). Works before the road
//    graph has been downloaded to the phone.
//  - Offline, or if the server can't be reached: routes on the phone from
//    the road graph downloaded with the offline map pack.
//
// Both use the same graph and the same routing code
// (backend/src/domain/roadRouter.js), so they give the same route.
import { File } from "expo-file-system";
import { createRouter } from "../../backend/src/domain/roadRouter.js";
import { mapApiBase, mapServerHeaders } from "./mapServer";

const SERVER_TIMEOUT_MS = 8000;

let loaded = { uri: null, router: null, promise: null };

// Parses and indexes the on-device graph once per file (about a second on
// a mid-range phone), then reuses it for every route.
function deviceRouter(roadsUri) {
  if (!roadsUri) return Promise.resolve(null);
  if (loaded.uri === roadsUri) return loaded.router ? Promise.resolve(loaded.router) : loaded.promise;
  const promise = new File(roadsUri)
    .text()
    .then((text) => createRouter(JSON.parse(text)))
    .then((router) => {
      if (loaded.uri === roadsUri) loaded.router = router;
      return router;
    })
    .catch((err) => {
      if (loaded.uri === roadsUri) loaded = { uri: null, router: null, promise: null };
      console.warn("[roadRouting] could not load road graph:", err?.message);
      return null;
    });
  loaded = { uri: roadsUri, router: null, promise };
  return promise;
}

// Start loading the graph early (e.g. when the Map tab opens) so the first
// offline route is instant.
export function preloadRoadGraph(roadsUri) {
  deviceRouter(roadsUri);
}

async function serverRoute(from, to) {
  const headers = await mapServerHeaders();
  if (!headers) return null; // no session to authenticate with
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS);
  try {
    const query = `from=${from.lat},${from.lon}&to=${to.lat},${to.lon}`;
    const response = await fetch(`${mapApiBase()}/route?${query}`, { headers, signal: controller.signal });
    if (!response.ok) return null;
    const route = await response.json();
    return Array.isArray(route?.coords) && route.coords.length >= 2 ? { ...route, source: "server" } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves to { meters, seconds, coords: [[lat, lon], ...], source } where
// source is "server" or "device", or null if neither can route (no graph
// yet and no signal, or a point far outside the mapped area).
export async function getRoadRoute(from, to, { online, roadsUri }) {
  if (![from?.lat, from?.lon, to?.lat, to?.lon].every(Number.isFinite)) return null;
  if (online) {
    const route = await serverRoute(from, to);
    if (route) return route;
  }
  const router = await deviceRouter(roadsUri);
  const route = router?.route(from, to);
  return route ? { ...route, source: "device" } : null;
}

// "6.0 km", "850 m"
export function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

// "11 min", "1 h 5 min"
export function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
