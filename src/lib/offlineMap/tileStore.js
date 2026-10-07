// src/lib/offlineMap/tileStore.js
// Downloads the offline map tile pack from the OMS backend onto the phone
// and tracks which pack is installed. Tiles land on disk as
// <documents>/offline-map/tiles-<version>/{z}/{x}/{y}.<png|webp>, which the Leaflet
// WebView then reads straight from the filesystem — no network, no JS
// bridge per tile.
//
//  - Resumable: tiles already on disk are skipped, so an interrupted
//    download just continues next time.
//  - Atomic per tile: each tile downloads to a .part file and is renamed
//    into place, so a crash never leaves a half-written tile that looks valid.
//  - Versioned: a new server pack downloads into its own folder while the
//    old one keeps serving the map; the switch happens only once complete.
//
// The download is a module-level singleton so it keeps running when the
// crew switches away from the Map tab.
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { mapApiBase, mapServerHeaders } from "../mapServer";

// The web build has no app storage to hold a pack: it shows live
// OpenStreetMap tiles instead (like the dashboard) and routes via the server.
const IS_WEB = Platform.OS === "web";
const WEB_PACK = {
  web: true,
  complete: true,
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  minZoom: 6,
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
  regions: [],
  roadsUri: null,
};

const STATE_KEY = "oms-offline-map-pack";
const CONCURRENCY = 6;
const MAX_ATTEMPTS = 3;
const MAX_TILES = 60000; // sanity cap against a bad manifest
const VERSION_RE = /^[a-f0-9]{8,64}$/;

export const mapRoot = () => new Directory(Paths.document, "offline-map");
const packDir = (version) => new Directory(mapRoot(), `tiles-${version}`);
// Tile file extension for a pack (packs from before WebP support are PNG).
const tileExt = (format) => (format === "webp" ? "webp" : "png");
const roadsFile = (version) => new File(mapRoot(), `roads-${version}.json`);
const withSlash = (uri) => (uri.endsWith("/") ? uri : uri + "/");

// ---- installed pack state -------------------------------------------------

async function readState() {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeState(state) {
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state)).catch(() => {});
}

// The pack the map should render, or null if nothing has been downloaded.
// `complete: false` means a first download is still in progress (the map
// shows whatever tiles have arrived so far).
export async function getInstalledPack() {
  if (IS_WEB) return WEB_PACK;
  const state = await readState();
  if (!state?.version || !VERSION_RE.test(state.version)) return null;
  const dir = packDir(state.version);
  if (!dir.exists) return null;
  const roads = state.roads?.version && VERSION_RE.test(state.roads.version) ? roadsFile(state.roads.version) : null;
  return {
    ...state,
    tileUrl: withSlash(dir.uri) + `{z}/{x}/{y}.${tileExt(state.format)}`,
    // Road graph for offline routing (lib/roadRouting.js), when downloaded.
    roadsUri: roads?.exists ? roads.uri : null,
  };
}

// ---- status broadcast -----------------------------------------------------

let status = { phase: "idle", done: 0, total: 0, error: null };
const listeners = new Set();

function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

export function getPackStatus() {
  return status;
}

export function subscribePackStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- manifest & tile math -------------------------------------------------

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function tilesForManifest(manifest) {
  const seen = new Set();
  const tiles = [];
  for (const region of manifest.regions || []) {
    const [w, s, e, n] = region.bbox || [];
    if (![w, s, e, n].every(Number.isFinite)) continue;
    const minZ = Math.max(0, region.minZoom | 0);
    const maxZ = Math.min(18, region.maxZoom | 0);
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = lon2x(w, z); x <= lon2x(e, z); x++) {
        for (let y = lat2y(n, z); y <= lat2y(s, z); y++) {
          const key = `${z}/${x}/${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tiles.push({ z, x, y });
          if (tiles.length > MAX_TILES) throw new Error("Offline map manifest is unexpectedly large");
        }
      }
    }
  }
  return tiles;
}

async function fetchManifest(headers) {
  const response = await fetch(`${mapApiBase()}/tiles/manifest`, { headers });
  if (response.status === 404) throw new Error("The server has no offline map pack yet (run tiles:fetch on the backend).");
  if (!response.ok) throw new Error(`Could not load the offline map manifest (HTTP ${response.status}).`);
  const manifest = await response.json();
  if (!VERSION_RE.test(manifest?.version ?? "")) throw new Error("Offline map manifest is invalid.");
  return manifest;
}

// ---- road graph -----------------------------------------------------------

// Downloads the pack's road graph (for offline routing) if the server has
// one and it isn't on the phone yet, then records it in the pack state and
// removes superseded copies. The file name carries the version, so an
// interrupted download never leaves a stale graph in use.
async function ensureRoads(manifest, headers, signal) {
  const want = manifest.roads;
  if (!want?.version || !VERSION_RE.test(want.version)) return;
  const dest = roadsFile(want.version);
  if (!dest.exists) {
    const part = new File(mapRoot(), `roads-${want.version}.json.part`);
    if (part.exists) part.delete();
    try {
      await File.downloadFileAsync(`${mapApiBase()}/tiles/roads.json`, part, { headers, idempotent: true, signal });
      part.moveSync(dest);
    } catch (err) {
      if (part.exists) part.delete();
      if (err?.name === "AbortError" || signal.aborted) throw err;
      throw new Error("The road network for offline directions failed to download — tap retry.");
    }
  }
  const state = await readState();
  if (state) await writeState({ ...state, roads: { version: want.version, bytes: want.bytes } });
  for (const entry of mapRoot().list()) {
    if (entry instanceof File && /^roads-[a-f0-9]+\.json$/.test(entry.name) && entry.name !== dest.name) {
      try {
        entry.delete();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// ---- download -------------------------------------------------------------

let running = null;
let abortController = null;

// Starts (or joins) the pack download. Resolves with the installed pack.
export function downloadPack() {
  if (IS_WEB) return Promise.resolve(WEB_PACK);
  if (!running) {
    abortController = new AbortController();
    running = doDownload(abortController.signal).finally(() => {
      running = null;
      abortController = null;
    });
  }
  return running;
}

export function cancelPackDownload() {
  abortController?.abort();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doDownload(signal) {
  setStatus({ phase: "checking", done: 0, total: 0, error: null });
  try {
    let headers = await mapServerHeaders();
    if (!headers) throw new Error("Sign in with a network connection to download the offline map.");

    const manifest = await fetchManifest(headers);
    const installed = await readState();
    if (installed?.version === manifest.version && installed.complete && packDir(manifest.version).exists) {
      await ensureRoads(manifest, headers, signal);
      setStatus({ phase: "ready", done: installed.tileCount, total: installed.tileCount });
      return getInstalledPack();
    }

    const tiles = tilesForManifest(manifest);
    const needBytes = Number(manifest.totalBytes) || 0;
    if (needBytes && Paths.availableDiskSpace < needBytes * 1.2) {
      throw new Error(`Not enough free storage for the offline map (needs about ${Math.ceil(needBytes / 1048576)} MB).`);
    }

    const target = packDir(manifest.version);
    target.create({ intermediates: true, idempotent: true });
    const ext = tileExt(manifest.format);
    const packMeta = {
      format: ext,
      version: manifest.version,
      attribution: String(manifest.attribution || ""),
      minZoom: manifest.minZoom,
      maxZoom: manifest.maxZoom,
      bounds: manifest.bounds,
      regions: (manifest.regions || []).map((r) => ({ id: r.id, name: r.name })),
      tileCount: manifest.tileCount,
      totalBytes: manifest.totalBytes,
    };
    // First install (or resuming the same version): render tiles as they
    // arrive. Upgrading: keep the old complete pack active until done.
    if (!installed?.complete || installed.version === manifest.version) {
      await writeState({ ...packMeta, complete: false });
    }

    // Re-read at most once a minute (or on retry) so a token that expires
    // mid-download gets refreshed.
    let headersFetchedAt = Date.now();
    const authHeaders = async (force) => {
      if (force || Date.now() - headersFetchedAt > 60000) {
        headers = (await mapServerHeaders()) || headers;
        headersFetchedAt = Date.now();
      }
      return headers;
    };

    const madeDirs = new Set();
    let done = 0;
    let failed = 0;
    setStatus({ phase: "downloading", done, total: tiles.length });

    const fetchOne = async ({ z, x, y }) => {
      const dest = new File(target, String(z), String(x), `${y}.${ext}`);
      if (dest.exists && dest.size > 0) return;
      const dirKey = `${z}/${x}`;
      if (!madeDirs.has(dirKey)) {
        new Directory(target, String(z), String(x)).create({ intermediates: true, idempotent: true });
        madeDirs.add(dirKey);
      }
      const part = new File(target, String(z), String(x), `${y}.${ext}.part`);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        try {
          await File.downloadFileAsync(`${mapApiBase()}/tiles/${z}/${x}/${y}.${ext}`, part, {
            headers: await authHeaders(attempt > 1),
            idempotent: true,
            signal,
          });
          part.moveSync(dest);
          return;
        } catch (err) {
          if (err?.name === "AbortError" || signal.aborted) throw err;
          if (part.exists) part.delete();
          if (/\b404\b/.test(err?.message || "")) return; // server has no tile here (e.g. open terrain)
          if (attempt === MAX_ATTEMPTS) {
            failed++;
            return;
          }
          await sleep(500 * attempt);
        }
      }
    };

    const queue = tiles.slice();
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        await fetchOne(t);
        done++;
        if (done % 25 === 0 || done === tiles.length) setStatus({ done });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (failed) {
      throw new Error(`${failed} map tiles failed to download — tap retry when the connection is better.`);
    }

    await writeState({ ...packMeta, complete: true, installedAt: Date.now() });
    await ensureRoads(manifest, await authHeaders(true), signal);
    // Remove superseded packs only after the new one is fully in place.
    for (const entry of mapRoot().list()) {
      if (entry instanceof Directory && entry.name.startsWith("tiles-") && entry.name !== `tiles-${manifest.version}`) {
        try {
          entry.delete();
        } catch {
          // best-effort cleanup
        }
      }
    }
    setStatus({ phase: "ready", done: tiles.length, total: tiles.length, error: null });
    return getInstalledPack();
  } catch (err) {
    const cancelled = err?.name === "AbortError";
    setStatus({ phase: cancelled ? "idle" : "error", error: cancelled ? null : err?.message || "Download failed" });
    if (!cancelled) throw err;
    return getInstalledPack();
  }
}
