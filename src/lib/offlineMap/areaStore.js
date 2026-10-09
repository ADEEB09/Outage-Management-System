// src/lib/offlineMap/areaStore.js
// Replacement for tileStore.js that uses the in-house vector map server instead of the big raster tile pack.
//
// Instead of thousands of tile images, the phone downloads ONE small map file (.mbtiles, a few MB) for the
// service area from the map server, through the OMS backend (/api/map/*, protected by the crew's login).
// The map page in the WebView cannot open that file itself, so it asks the app for each tile and font file
// over the message bridge and readMapResource() answers from the file.
//
// It exposes the same functions as tileStore.js (getInstalledPack, downloadPack, cancelPackDownload,
// getPackStatus, subscribePackStatus, mapRoot), so NativeApp.jsx only changes its import line.
//
//  - Cheap to repeat: if the phone already has the server's current map version, nothing is downloaded.
//  - Atomic: files download to .part and are renamed into place, so a crash never leaves a half file in use.
//  - Road graph for offline directions is still fetched from the OMS backend, exactly as before.
import { Directory, File } from "expo-file-system";
import * as SQLite from "expo-sqlite";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { mapApiBase, mapServerHeaders } from "../mapServer";
import { mapRoot } from "./tileStore";

export { mapRoot };

const STATE_KEY = "oms-offline-area";
const MIN_ZOOM = 8;
const VERSION_RE = /^[a-f0-9]{8,64}$/;
// Fonts the map style uses, and the alphabets we keep (English, Hindi/Indian scripts, punctuation).
const FONTS = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"];
const FONT_RANGES = ["0-255", "256-511", "512-767", "768-1023", "1536-1791", "2304-2559", "2560-2815", "2816-3071", "3072-3327", "3328-3583", "8192-8447", "8448-8703", "65280-65535"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- state ------------------------------------------------------------------------------------------

// Short stable fingerprint of a text (FNV-1a), used to give each region its own file name.
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function readState() {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
const writeState = (state) => AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
const roadsFile = (version) => new File(mapRoot(), `roads-${version}.json`);
const mapFile = (name) => new File(mapRoot(), name);

// Plain-text credit for the map corner (the server sends it as HTML).
const plainCredit = (html) =>
  String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&copy;/g, "©")
    .replace(/\s+/g, " ")
    .trim();

// ---- installed map ------------------------------------------------------------------------------------

export async function getInstalledPack() {
  const state = await readState();
  if (!state?.file || !state.mapVersion) return null;
  const file = mapFile(state.file);
  const styleFile = new File(mapRoot(), "style.json");
  if (!file.exists || !styleFile.exists) return null;
  let style;
  try {
    style = JSON.parse(await styleFile.text());
  } catch {
    return null;
  }
  const roads = state.roads?.version && VERSION_RE.test(state.roads.version) ? roadsFile(state.roads.version) : null;
  return {
    ...state,
    kind: "vector",
    version: state.mapVersion,
    complete: true,
    regions: state.regionId ? [{ id: state.regionId, name: state.regionName }] : [],
    tileUrl: "oms://tile/{z}/{x}/{y}", // handled by the page, answered by readMapResource()
    style,
    roadsUri: roads?.exists ? roads.uri : null,
  };
}

// ---- status broadcast (same shape tileStore uses: phase / done / total / error) -------------------------

let status = { phase: "idle", done: 0, total: 0, error: null };
const listeners = new Set();
function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}
export const getPackStatus = () => status;
export function subscribePackStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- small helpers ------------------------------------------------------------------------------------

async function readJson(response, what) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // not JSON
  }
  if (!response.ok) throw new Error(body?.error || `${what} failed (HTTP ${response.status}).`);
  return body;
}

// Moves a freshly downloaded .part file into place (replacing any older copy).
function installFile(part, dest) {
  if (dest.exists) dest.delete();
  part.moveSync(dest);
}

async function download(url, dest, headers, signal) {
  const part = new File(`${dest.uri}.part`);
  if (part.exists) part.delete();
  try {
    await File.downloadFileAsync(url, part, { headers, idempotent: true, signal });
    installFile(part, dest);
  } catch (err) {
    if (part.exists) part.delete();
    throw err;
  }
}

// ---- road graph (offline directions) — unchanged behaviour, fetched from the OMS backend ---------------

async function ensureRoads(headers, signal) {
  let manifest = null;
  try {
    const response = await fetch(`${mapApiBase()}/tiles/manifest`, { headers, signal });
    if (response.ok) manifest = await response.json();
  } catch (err) {
    if (err?.name === "AbortError" || signal.aborted) throw err;
  }
  const want = manifest?.roads;
  if (!want?.version || !VERSION_RE.test(want.version)) return; // server has no road graph: directions stay online-only
  const dest = roadsFile(want.version);
  if (!dest.exists) {
    try {
      await download(`${mapApiBase()}/tiles/roads.json`, dest, headers, signal);
    } catch (err) {
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

// ---- fonts and style (small, change rarely) -------------------------------------------------------------

async function ensureFontsAndStyle(base, headers, signal) {
  const styleResponse = await fetch(`${base}/style.json`, { headers, signal });
  const style = await readJson(styleResponse, "Loading the map style");
  new File(mapRoot(), "style.json").write(JSON.stringify(style));

  for (const font of FONTS) {
    new Directory(mapRoot(), "fonts", font).create({ intermediates: true, idempotent: true });
    for (const range of FONT_RANGES) {
      const dest = new File(mapRoot(), "fonts", font, `${range}.pbf`);
      if (dest.exists) continue;
      await download(`${base}/fonts/${encodeURIComponent(font)}/${range}.pbf`, dest, headers, signal);
    }
  }
}

// ---- which part of the map does THIS crew need? -------------------------------------------------------------

// The OMS decides (from the crew's position and its regions config). Older backends without this route answer 404:
// the phone then falls back to the server-wide service area, exactly as before.
async function getMyRegion(base, headers, signal) {
  try {
    const response = await fetch(`${base}/my-region`, { headers, signal });
    if (!response.ok) return null;
    const body = await response.json();
    const box = body?.region?.bbox;
    return body?.region?.id && Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) ? body : null;
  } catch (err) {
    if (err?.name === "AbortError" || signal.aborted) throw err;
    return null;
  }
}

// ---- download -------------------------------------------------------------------------------------------

let running = null;
let abortController = null;

// Starts (or joins) the map download. Resolves with the installed pack.
export function downloadPack() {
  if (!running) {
    abortController = new AbortController();
    running = doDownload(abortController.signal)
      .catch((err) => {
        if (err?.name === "AbortError" || abortController?.signal.aborted) {
          setStatus({ phase: "idle", done: 0, total: 0, error: null });
        } else {
          setStatus({ phase: "error", error: err?.message || "Offline map download failed." });
        }
        throw err;
      })
      .finally(() => {
        running = null;
        abortController = null;
      });
  }
  return running;
}

export function cancelPackDownload() {
  abortController?.abort();
}

async function doDownload(signal) {
  setStatus({ phase: "checking", done: 0, total: 0, error: null });
  const headers = await mapServerHeaders();
  if (!headers) throw new Error("Sign in to download the offline map.");
  const base = `${mapApiBase()}/map`;

  const info = await readJson(await fetch(`${base}/info`, { headers, signal }), "Contacting the map server");
  if (!VERSION_RE.test(info?.version ?? "") || !Array.isArray(info?.bounds) || info.bounds.length !== 4) {
    throw new Error("The map server answered with unexpected data. Is it up to date?");
  }
  mapRoot().create({ intermediates: true, idempotent: true });

  const state = await readState();
  const mine = await getMyRegion(base, headers, signal);
  // The server may hold a huge map (all of India); phones only take the region the OMS assigns (or the service area).
  const area = mine
    ? mine.region.bbox
    : Array.isArray(info.serviceArea) && info.serviceArea.length === 4 ? info.serviceArea : info.bounds;
  const areaKey = mine ? `${mine.region.id}:${mine.region.bbox.join(",")}` : `area:${area.join(",")}`;
  const upToDate = state?.mapVersion === info.version && state?.areaKey === areaKey && state?.file && mapFile(state.file).exists;

  if (!upToDate) {
    // Ask the server to cut the service area into one file, wait for it, then download it.
    const maxZoom = Number.isFinite(info.maxzoom) ? info.maxzoom : 14;
    const start = mine
      ? await fetch(`${base}/regions/${encodeURIComponent(mine.region.id)}/export`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ minZoom: MIN_ZOOM, maxZoom }),
          signal,
        })
      : await fetch(`${base}/export`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ bbox: area.join(","), minZoom: MIN_ZOOM, maxZoom, label: "crew" }),
          signal,
        });
    let job = await readJson(start, "Preparing the offline map");
    setStatus({ phase: "downloading", done: 0, total: 100 });
    for (let waited = 0; job.status === "working"; waited += 700) {
      if (waited > 120000) throw new Error("The map server took too long to prepare the map.");
      await sleep(700);
      job = await readJson(await fetch(`${base}/export/${job.jobId}`, { headers, signal }), "Checking the offline map");
      setStatus({ done: Math.round((job.progressPercent || 0) * 0.3) });
    }
    if (job.status !== "ready") throw new Error(job.error || "The map server could not prepare the map.");

    setStatus({ done: 30 });
    // The name includes the region, so a different region is a different file (never silently replaced under a reader).
    const dest = mapFile(`area-${info.version}-${shortHash(areaKey)}.mbtiles`);
    await download(`${base}/export/${job.jobId}/file`, dest, headers, signal);
    closeDb(); // the next tile request opens the new file
    await writeState({
      file: dest.name,
      mapVersion: info.version,
      minZoom: MIN_ZOOM,
      maxZoom,
      bounds: area,
      areaKey,
      regionId: mine?.region.id ?? null,
      regionName: mine?.region.name ?? null,
      attribution: plainCredit(info.attribution),
      totalBytes: dest.size ?? 0,
      installedAt: Date.now(),
      roads: state?.roads || null,
    });
    // Remove superseded map files.
    for (const entry of mapRoot().list()) {
      if (entry instanceof File && /^area-[a-f0-9-]+\.mbtiles$/.test(entry.name) && entry.name !== dest.name) {
        try {
          entry.delete();
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  setStatus({ phase: "downloading", done: 90, total: 100 });
  await ensureFontsAndStyle(base, headers, signal);
  await ensureRoads(headers, signal);
  setStatus({ phase: "idle", done: 100, total: 100, error: null });
  return getInstalledPack();
}

// ---- answering the map page's tile and font requests ------------------------------------------------------

let db = null;
let dbFile = null;

function closeDb() {
  const old = db;
  db = null;
  dbFile = null;
  old?.then((d) => d.closeAsync()).catch(() => {});
}

async function openDb() {
  const state = await readState();
  if (!state?.file) return null;
  if (db && dbFile === state.file) return db;
  closeDb();
  const directory = decodeURI(mapRoot().uri.replace(/^file:\/\//, "")).replace(/\/$/, "");
  dbFile = state.file;
  db = SQLite.openDatabaseAsync(state.file, { useNewConnection: true }, directory);
  db.catch(() => {
    db = null;
    dbFile = null;
  });
  return db;
}

// Small, dependency-free base64 for tile bytes.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function bytesToBase64(bytes) {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i];
    const b = i + 1 < n ? bytes[i + 1] : 0;
    const c = i + 2 < n ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < n ? B64[c & 63] : "=";
  }
  return out;
}

// msg is what the page posted: { type: 'tile', z, x, y } or { type: 'font', stack, range }.
// Resolves to a base64 string, or null when there is nothing for that request.
export async function readMapResource(msg) {
  if (msg?.type === "tile") {
    const { z, x, y } = msg;
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
    const database = await openDb();
    if (!database) return null;
    const handle = await database;
    const row = await handle.getFirstAsync(
      "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
      [z, x, 2 ** z - 1 - y], // the file stores rows upside-down
    );
    return row?.tile_data ? bytesToBase64(row.tile_data) : null;
  }
  if (msg?.type === "font") {
    const font = String(msg.stack || "").split(",")[0].trim();
    if (!FONTS.includes(font) || !/^\d+-\d+$/.test(String(msg.range))) return null; // only our own files
    const file = new File(mapRoot(), "fonts", font, `${msg.range}.pbf`);
    return file.exists ? await file.base64() : null;
  }
  return null;
}
