// src/lib/locationQueue.js
// Durable store-and-forward queue for crew GPS fixes. Every fix is written
// to on-device SQLite first — whether or not there is network — and then
// uploaded to OMS in batches whenever connectivity allows. Nothing is
// deleted until the server has acknowledged it, so a dead zone, airplane
// mode, a crash, or the OS killing the app never loses the trail.
//
// SQLite (not AsyncStorage) because the background task appends every
// ~30s for hours: SQLite appends are O(1) and transactional, whereas an
// AsyncStorage JSON array is rewritten whole on every fix and can be left
// corrupt if the process dies mid-write.
import * as SQLite from "expo-sqlite";
import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import { MAP_API_BASE, mapServerHeaders, usingMapTestServer } from "./mapServer";

const BATCH_SIZE = 200;
// ~7 days of fixes at one per 30s. Beyond that the oldest are dropped
// rather than letting the queue grow without bound.
const MAX_QUEUED = 20000;
// Matches the server's backfill window — older points would be rejected.
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;
// Fixes worse than this are noise (e.g. a cold GPS) — don't store them.
const MAX_ACCURACY_M = 500;
const REQUEST_TIMEOUT_MS = 20000;

let dbPromise = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("oms-crew.db");
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS pending_locations (
          id          TEXT PRIMARY KEY NOT NULL,
          crew_id     TEXT NOT NULL,
          lat         REAL NOT NULL,
          lon         REAL NOT NULL,
          accuracy    REAL,
          speed       REAL,
          heading     REAL,
          recorded_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_locations_crew_time ON pending_locations(crew_id, recorded_at);
      `);
      return db;
    })().catch((err) => {
      dbPromise = null; // allow a retry on the next call
      throw err;
    });
  }
  return dbPromise;
}

const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// `locations` are expo-location LocationObjects (as delivered to the
// background task, oldest first).
export async function enqueueLocations(crewId, locations) {
  const rows = (locations || []).filter(
    (l) =>
      Number.isFinite(l?.coords?.latitude) &&
      Number.isFinite(l?.coords?.longitude) &&
      !(l.coords.accuracy > MAX_ACCURACY_M)
  );
  if (!crewId || !rows.length) return 0;

  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const l of rows) {
      await txn.runAsync(
        `INSERT OR IGNORE INTO pending_locations (id, crew_id, lat, lon, accuracy, speed, heading, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        Crypto.randomUUID(),
        crewId,
        l.coords.latitude,
        l.coords.longitude,
        finiteOrNull(l.coords.accuracy),
        finiteOrNull(l.coords.speed),
        finiteOrNull(l.coords.heading),
        Math.round(l.timestamp || Date.now())
      );
    }
    await txn.runAsync("DELETE FROM pending_locations WHERE recorded_at < ?", Date.now() - MAX_AGE_MS);
    await txn.runAsync(
      `DELETE FROM pending_locations WHERE id IN (
         SELECT id FROM pending_locations ORDER BY recorded_at DESC LIMIT -1 OFFSET ?
       )`,
      MAX_QUEUED
    );
  });
  return rows.length;
}

export async function getPendingLocationCount() {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync("SELECT COUNT(*) AS n FROM pending_locations");
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

async function postBatch(crewId, headers, rows) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${MAP_API_BASE}/mobile/crews/${encodeURIComponent(crewId)}/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        points: rows.map((r) => ({
          id: r.id,
          lat: r.lat,
          lon: r.lon,
          accuracy: r.accuracy,
          speed: r.speed,
          heading: r.heading,
          recordedAt: r.recorded_at,
        })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status };
    const data = await response.json();
    return { ok: true, ack: Array.isArray(data?.ack) ? data.ack : [] };
  } finally {
    clearTimeout(timer);
  }
}

// Serialises flushes within this JS runtime: the background task and the
// foreground "back online" listener can both trigger one at the same time.
let flushing = null;

// Upload everything queued, oldest first. Safe to call often — it's a
// no-op when the queue is empty or the device is offline.
export function flushLocations() {
  if (!flushing) {
    flushing = doFlush().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function doFlush() {
  const result = { sent: 0, remaining: 0, error: null };
  try {
    const net = await Network.getNetworkStateAsync().catch(() => null);
    const db = await getDb();
    const pending = async () => (await db.getFirstAsync("SELECT COUNT(*) AS n FROM pending_locations"))?.n ?? 0;
    // The LAN test server is reachable even when the internet isn't, so
    // only require a connection there, not internet reachability.
    const offline = net && (net.isConnected === false || (!usingMapTestServer && net.isInternetReachable === false));
    if (offline) {
      result.remaining = await pending();
      result.error = "offline";
      return result;
    }

    const headers = await mapServerHeaders();
    if (!headers) {
      result.remaining = await pending();
      result.error = "no-session";
      return result;
    }

    const crews = await db.getAllAsync("SELECT DISTINCT crew_id FROM pending_locations");
    for (const { crew_id: crewId } of crews) {
      for (;;) {
        const rows = await db.getAllAsync(
          "SELECT * FROM pending_locations WHERE crew_id = ? ORDER BY recorded_at ASC LIMIT ?",
          crewId,
          BATCH_SIZE
        );
        if (!rows.length) break;

        const res = await postBatch(crewId, headers, rows);
        if (!res.ok) {
          // 401/403: session problem or wrong crew — keep the data and stop;
          // anything else (5xx, timeout) is transient — retry next flush.
          result.error = `http-${res.status}`;
          break;
        }
        if (res.ack.length) {
          await db.withExclusiveTransactionAsync(async (txn) => {
            for (let i = 0; i < res.ack.length; i += 500) {
              const chunk = res.ack.slice(i, i + 500);
              await txn.runAsync(
                `DELETE FROM pending_locations WHERE id IN (${chunk.map(() => "?").join(",")})`,
                ...chunk
              );
            }
          });
        }
        result.sent += res.ack.length;
        if (res.ack.length < rows.length) break; // server skipped some; don't spin
      }
    }
    result.remaining = await pending();
  } catch (err) {
    result.error = err?.name === "AbortError" ? "timeout" : err?.message || "failed";
    result.remaining = await getPendingLocationCount();
  }
  return result;
}
