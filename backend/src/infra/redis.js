import { createClient } from 'redis';

// Real-time tag cache (SDP §3; ADMS §5.2.3). In production this is the RTDB
// that sits in front of Postgres: current UNS tag values, alarm states, and
// short-TTL read-through caches for hot REST endpoints. Phase 2's SCADA
// ingest service is the main producer once it exists; for now this module
// gives the rest of the app (and Phase 2, when it lands) a real client to
// plug into instead of the in-memory placeholder that was here before.
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:16379';

export const redis = createClient({
  url: REDIS_URL,
  socket: {
    // Bounded retry, and — critically — the client's default strategy
    // retries forever without the connect() promise ever settling, which
    // hangs the whole app's boot sequence when Redis isn't running yet.
    // Give up after a handful of attempts so connectRedis() below always
    // resolves one way or the other.
    reconnectStrategy: (retries) => (retries > 3 ? false : Math.min(retries * 100, 500)),
  },
});
let loggedError = false;
redis.on('error', (err) => {
  if (!loggedError) { console.error('[redis] client error:', err.message); loggedError = true; }
});

let connected = false;
let connecting = null;

// Non-fatal by design: Redis is a cache/RTDB, not the system of record.
// If it's unreachable (e.g. a laptop that hasn't run `docker compose up redis`
// yet) the app should still boot and serve everything straight from Postgres —
// just without the cache speedup. Every helper below checks `connected` first.
export async function connectRedis() {
  if (connected) return redis;
  if (connecting) return connecting;
  connecting = redis.connect()
    .then(() => { connected = true; console.log(`[redis] connected → ${REDIS_URL}`); })
    .catch((err) => { console.warn(`[redis] unavailable (${err.message}) — continuing without cache`); })
    .finally(() => { connecting = null; });
  return connecting;
}

export function isRedisConnected() { return connected; }

// ---------- UNS tag cache ----------
// Key shape mirrors the CIM/UNS path convention used elsewhere in the docs,
// e.g. "DEHRA.SE01.T2.MW". Phase 2's SCADA ingest service will call setTag()
// on every Kafka scada.tags message; the HMI/WebSocket hub can read straight
// from here instead of round-tripping to TimescaleDB for the live value.
const tagKey = (path) => `tag:${path}`;

export async function setTag(path, value, quality = 'GOOD') {
  if (!connected) return null;
  const record = { value, quality, ts: new Date().toISOString() };
  await redis.set(tagKey(path), JSON.stringify(record));
  await redis.publish('tags.updates', JSON.stringify({ path, ...record }));
  return record;
}

export async function getTag(path) {
  if (!connected) return null;
  const raw = await redis.get(tagKey(path));
  return raw ? JSON.parse(raw) : null;
}

export async function getTagsByPrefix(prefix = '') {
  if (!connected) return {};
  const keys = await redis.keys(`tag:${prefix}*`);
  if (!keys.length) return {};
  const values = await redis.mGet(keys);
  const out = {};
  keys.forEach((k, i) => { if (values[i]) out[k.slice(4)] = JSON.parse(values[i]); });
  return out;
}

// ---------- generic read-through cache ----------
// Used for endpoints that are cheap to compute but hit on every dashboard
// refresh (e.g. /indicators). Short TTL — this is a speed layer, not a
// source of truth, so a stale value for a few seconds is an acceptable
// trade against hammering Postgres on every poll.
export async function cacheGet(key) {
  if (!connected) return null;
  const raw = await redis.get(`cache:${key}`);
  return raw ? JSON.parse(raw) : null;
}

export async function cacheSet(key, value, ttlSeconds = 15) {
  if (!connected) return;
  await redis.set(`cache:${key}`, JSON.stringify(value), { EX: ttlSeconds });
}

export async function cacheDel(key) {
  if (!connected) return;
  await redis.del(`cache:${key}`);
}

export async function disconnectRedis() {
  if (connected) { await redis.quit(); connected = false; }
}