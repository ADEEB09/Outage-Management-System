// Cross-source correlation + burst-capacity test for P8.6.
//
// Different code path from loadtest-scada-kafka.js (which only ever touched
// the Kafka -> handleScadaEvent() dedup path). This test proves whether a
// SCADA fault event and TCS/IVR customer complaints about the SAME physical
// fault correctly collapse into one incident, by exercising BOTH real intake
// paths for the same asset:
//   - Kafka -> scada.alarm.raised -> backend/src/realtime/scada.js's
//     handleScadaEvent() / locate() / assetKey()
//   - HTTP POST /api/complaints -> backend/src/routes/api.js's
//     ingestComplaint() / pickIncident() / repo.activeIncidentsAtSubstation()
//
// Run: node loadtest-cross-source-correlation.js
//   env KAFKA_BROKERS  (default localhost:9092)
//   env DATABASE_URL   (default postgres://oms:oms@localhost:5432/oms)
//   env API_BASE       (default http://localhost:4001/api)
//   env TCS_TOKEN      REQUIRED -- a real Keycloak bearer token (test.operator),
//                      since /api/complaints sits behind requireAuth same as
//                      every other route. Short-lived (5 min) -- get a fresh
//                      one from the browser Network tab if this fails with 401.

import { Kafka, logLevel } from 'kafkajs';
import pgPromise from 'pg-promise';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _dir = dirname(fileURLToPath(import.meta.url));
const NET = JSON.parse(readFileSync(join(_dir, 'backend/src/infra/network.json'), 'utf8'));

const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://oms:oms@localhost:5432/oms';
const API_BASE = process.env.API_BASE || 'http://localhost:4001/api';
const TOKEN = process.env.TCS_TOKEN;
const TOPIC = 'scada.alarm.raised';

if (!TOKEN) {
  console.error('Set TCS_TOKEN to a real Keycloak bearer token (POST /api/complaints is behind requireAuth).');
  process.exit(1);
}

const pgp = pgPromise({});
const db = pgp(DATABASE_URL);
const kafka = new Kafka({ clientId: 'oms-xsrc-loadtest', brokers: BROKERS, logLevel: logLevel.NOTHING });
const producer = kafka.producer();
const admin = kafka.admin();

// Real substations straight from backend/src/infra/network.json -- same data
// backend/src/infra/geo.js loads and the same set the Kafka-only load test used.
const ASSETS = NET.substations.map((s) => ({ code: s.code, name: s.name, lat: s.lat, lon: s.lon }));

let seq = 0;
const jitter = (v, amt = 0.001) => v + (Math.random() - 0.5) * 2 * amt;

// SCADA event WITH lat/lon -- the realistic shape for a geo-tagged field
// device (per scada.js's own comment: "Real SCADA points are geo-tagged").
// No evt.substation/evt.feeder given, so locate() takes the lat/lon branch
// and calls the exact same resolveAsset()/geo.resolve() that ingestComplaint()
// calls -- this is the scenario where the two sources' substation string
// SHOULD be identical, because it's the same function producing it.
function scadaEventGeoTagged(asset, condition = 'CRITICAL') {
  return {
    id: `ALM-XSRC-${seq++}`, tag: `${asset.code}.T1.MW`, condition,
    limit_val: condition === 'MINOR' ? '95A' : 'TRIP',
    priority: condition === 'CRITICAL' || condition === 'TRIP' ? 1 : condition === 'MAJOR' ? 2 : 3,
    lat: asset.lat, lon: asset.lon,
    customers: Math.floor(50 + Math.random() * 2000),
    message: `${condition} field device (xsrc-loadtest, geo-tagged)`, ts: new Date().toISOString(), ack: 0,
  };
}

// SCADA event WITHOUT lat/lon, real substation CODE only -- the realistic
// shape for a tag/DNP3-style field device (this is literally the shape
// backend/src/realtime/dnp3.js's real adapter produces: substation/feeder
// set directly, no lat/lon). locate() then uses evt.substation AS-IS,
// with no normalization against geo.resolve()'s substation NAME string.
function scadaEventTagOnly(asset, condition = 'CRITICAL') {
  return {
    id: `ALM-XSRC-${seq++}`, tag: `${asset.code}.F1.T1.MW`, condition,
    limit_val: condition === 'MINOR' ? '95A' : 'TRIP', priority: 1,
    substation: asset.code, feeder: `${asset.code}-F1`,
    customers: Math.floor(50 + Math.random() * 2000),
    message: `${condition} field device (xsrc-loadtest, tag-only)`, ts: new Date().toISOString(), ack: 0,
  };
}

function complaintBody(asset, category = 'No Supply') {
  seq++;
  return {
    externalId: `EXT-XSRC-${seq}`, customer: `LoadTest Customer ${seq}`,
    phone: '9' + Math.floor(100000000 + Math.random() * 899999999),
    category, address: `Near ${asset.name}`, lat: jitter(asset.lat), lon: jitter(asset.lon),
  };
}

// backend/src/infra/repo.js's nextQueryId()/nextIncidentId() mint IDs via
// `SELECT COUNT(*)` -- a read-then-insert race. Truly simultaneous
// Promise.all complaints reliably collide on that count and throw an
// unhandled unique-constraint violation that -- with no process.on
// ('uncaughtException') guard anywhere in index.js -- crashes the entire
// backend (confirmed directly: see docs/P8_6_CROSS_SOURCE_CORRELATION_RESULTS.md).
// A small stagger keeps this test's OWN complaints far enough apart in
// practice to survive and measure the correlation questions this test is
// actually about, without that crash dominating every result. The crash
// itself is measured separately, deliberately, at full unstaggered
// concurrency in the burst-capacity section below.
async function fireStaggered(bodies, staggerMs = 25) {
  const promises = [];
  for (const b of bodies) {
    promises.push(postComplaint(b));
    await new Promise((r) => setTimeout(r, staggerMs));
  }
  return Promise.all(promises);
}

async function publishScada(evt) {
  return producer.send({ topic: TOPIC, messages: [{ value: JSON.stringify(evt) }] });
}

async function postComplaint(body) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_BASE}/complaints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    let json = null; try { json = await res.json(); } catch { /* non-JSON error body */ }
    return { status: res.status, ms, json };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: e.message };
  }
}

async function fetchLag() {
  try {
    const groupId = 'oms-backend';
    const topicOffsets = await admin.fetchTopicOffsets(TOPIC);
    const groupOffsets = await admin.fetchOffsets({ groupId, topics: [TOPIC] });
    return groupOffsets[0].partitions.map((p) => {
      const hw = topicOffsets.find((t) => t.partition === p.partition)?.offset;
      return { partition: p.partition, committedOffset: p.offset, highWaterMark: hw, lag: hw != null ? Number(hw) - Number(p.offset) : null };
    });
  } catch (e) {
    return [{ error: e.message }];
  }
}

async function openIncidentsAt(substationString, sinceMinutesAgo = 5) {
  return db.any(
    `SELECT id, substation, feeder, source, severity, status, cause, opened_at FROM incidents
     WHERE substation = $1 AND opened_at >= now() - interval '${sinceMinutesAgo} minutes'
     ORDER BY opened_at ASC`,
    [substationString]
  );
}

// ============================================================
// Test 1: simultaneous arrival -- 1 SCADA event + complaint(s) for the
// SAME real substation, fired together via Promise.all (~1s window).
// Run against two distinct groups of substations so the two candidate
// root causes (substation-string mismatch vs. type-string mismatch) can
// be told apart empirically instead of guessed at.
//
// NOTE ON COMPLAINT COUNT: the task originally called for 3-5 complaints
// per substation. That was attempted first (see docs/P8_6_CROSS_SOURCE_
// CORRELATION_RESULTS.md) and deterministically crashed the entire backend
// process every time, even with a 25ms stagger between complaints --
// repo.js's COUNT(*)-based ID generation race (a separate, more severe bug
// than anything this test set out to find) makes multiple near-simultaneous
// complaints fundamentally unsafe right now. To still get real signal on
// the SCADA<->complaint correlation questions this test exists to answer,
// this scenario uses exactly ONE complaint per substation (still genuinely
// concurrent with the SCADA event via Promise.all) -- enough to test
// cross-source correlation without also tripping the complaint-vs-complaint
// race. The multi-complaint crash itself is measured deliberately and
// separately in the burst-capacity section below.
// ============================================================
async function simultaneousArrivalTest() {
  const geoAssets = ASSETS.slice(0, 5);   // geo-tagged SCADA: substation strings SHOULD match
  const tagAssets = ASSETS.slice(5, 10);  // tag/code-only SCADA: substation strings provably differ
  const results = [];

  for (const asset of geoAssets) {
    const scada = scadaEventGeoTagged(asset);
    const complaint = complaintBody(asset);
    await Promise.all([publishScada(scada), postComplaint(complaint)]);
    await new Promise((r) => setTimeout(r, 4000)); // let the Kafka consumer catch up
    const rows = await openIncidentsAt(asset.name);
    results.push({ mode: 'geo-tagged', substationKeyUsed: asset.name, expectedIncidents: 1, actualIncidents: rows.length, incidents: rows });
  }

  for (const asset of tagAssets) {
    const scada = scadaEventTagOnly(asset);
    const complaint = complaintBody(asset);
    await Promise.all([publishScada(scada), postComplaint(complaint)]);
    await new Promise((r) => setTimeout(r, 4000));
    const rowsByCode = await openIncidentsAt(asset.code);  // where SCADA's incident would land
    const rowsByName = await openIncidentsAt(asset.name);  // where complaints' incident would land
    results.push({
      mode: 'tag-only-scada', substationCodeUsed: asset.code, substationNameUsed: asset.name,
      expectedIncidents: 1, actualIncidents: rowsByCode.length + rowsByName.length,
      incidentsUnderCode: rowsByCode, incidentsUnderName: rowsByName,
    });
  }
  return results;
}

// ============================================================
// Test 2: order independence -- geo-tagged only (isolates the
// type/cause-matching question in pickIncident() from the substation-string
// question already covered by Test 1's tag-only group).
// ============================================================
async function orderIndependenceTest() {
  const [assetA, assetB] = ASSETS.slice(10, 12);

  // A: SCADA first, then complaints
  await publishScada(scadaEventGeoTagged(assetA));
  await new Promise((r) => setTimeout(r, 3000));
  for (const c of [complaintBody(assetA), complaintBody(assetA), complaintBody(assetA)]) await postComplaint(c);
  await new Promise((r) => setTimeout(r, 2000));
  const rowsA = await openIncidentsAt(assetA.name);

  // B: complaints first, then SCADA
  for (const c of [complaintBody(assetB), complaintBody(assetB), complaintBody(assetB)]) await postComplaint(c);
  await new Promise((r) => setTimeout(r, 1500));
  await publishScada(scadaEventGeoTagged(assetB));
  await new Promise((r) => setTimeout(r, 3000));
  const rowsB = await openIncidentsAt(assetB.name);

  return {
    scadaFirstThenComplaints: { substation: assetA.name, incidentCount: rowsA.length, incidents: rowsA },
    complaintsFirstThenScada: { substation: assetB.name, incidentCount: rowsB.length, incidents: rowsB },
    sameIncidentCount: rowsA.length === rowsB.length,
    sameFinalSeverity: rowsA[0]?.severity === rowsB[0]?.severity,
    sameFinalSource: rowsA[0]?.source === rowsB[0]?.source,
  };
}

// ============================================================
// Test 3: moderate combined throughput -- both channels running
// CONCURRENTLY (not sequential bursts) at a sustained, moderate rate,
// checking neither path's latency degrades and dedup still holds.
// ============================================================
async function combinedThroughputTest({ durationSec = 15, scadaRate = 20, complaintRate = 5 } = {}) {
  const complaintLatencies = [];
  let complaintErrors = 0, complaintsSent = 0, scadaSent = 0;
  const start = Date.now();
  const end = start + durationSec * 1000;

  const scadaLoop = (async () => {
    while (Date.now() < end) {
      const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
      const cond = ['CRITICAL', 'TRIP', 'MAJOR', 'MINOR'][Math.floor(Math.random() * 4)];
      publishScada(scadaEventGeoTagged(asset, cond)).catch(() => {});
      scadaSent++;
      await new Promise((r) => setTimeout(r, 1000 / scadaRate));
    }
  })();

  const complaintLoop = (async () => {
    while (Date.now() < end) {
      const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
      const t0 = Date.now();
      postComplaint(complaintBody(asset)).then((r) => {
        complaintLatencies.push(Date.now() - t0);
        if (r.status < 200 || r.status >= 300) complaintErrors++;
      }).catch(() => { complaintErrors++; });
      complaintsSent++;
      await new Promise((r) => setTimeout(r, 1000 / complaintRate));
    }
  })();

  await Promise.all([scadaLoop, complaintLoop]);
  await new Promise((r) => setTimeout(r, 4000));

  complaintLatencies.sort((a, b) => a - b);
  const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] : null);
  const lag = await fetchLag();

  return {
    durationSec, scadaSent, complaintsSent, complaintErrors,
    complaintLatencyMs: { p50: pct(complaintLatencies, 0.5), p95: pct(complaintLatencies, 0.95), max: complaintLatencies[complaintLatencies.length - 1] ?? null },
    consumerLagAfter: lag,
  };
}

// ============================================================
// Section 2: burst-capacity test -- NOT about correlation correctness.
// Both channels hammering the backend concurrently at high rate for a
// short window; measures whether one channel starves the other for
// shared resources (DB pool, event loop), using real evidence:
// HTTP latency percentiles, real Kafka consumer lag samples during the
// burst, and real pg_stat_activity samples.
// ============================================================
async function pgStatSample() {
  const poolSummary = await db.one(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE state = 'active')::int active,
           count(*) FILTER (WHERE state = 'idle')::int idle,
           count(*) FILTER (WHERE state = 'idle in transaction')::int idle_in_txn,
           count(*) FILTER (WHERE wait_event_type IS NOT NULL)::int waiting
    FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
  const slowest = await db.any(`
    SELECT pid, state, wait_event_type, wait_event,
           EXTRACT(EPOCH FROM (now() - query_start))::numeric(10,3) AS duration_sec,
           left(query, 100) AS query
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IS DISTINCT FROM 'idle'
    ORDER BY duration_sec DESC NULLS LAST LIMIT 8`);
  return { poolSummary, slowest };
}

async function burstCapacityTest({ durationSec = 8, scadaRatePerSec = 800, complaintRatePerSec = 200 } = {}) {
  const complaintLatencies = [];
  let complaintErrors = 0, complaintsSent = 0, scadaSent = 0, scadaPublishErrors = 0;
  const pgSamples = [];
  const lagSamples = [];
  const start = Date.now();
  const end = start + durationSec * 1000;

  const scadaTask = (async () => {
    let batch = [];
    while (Date.now() < end) {
      const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
      const cond = ['CRITICAL', 'TRIP', 'MAJOR', 'MINOR'][Math.floor(Math.random() * 4)];
      batch.push(publishScada(scadaEventGeoTagged(asset, cond)).catch(() => { scadaPublishErrors++; }));
      scadaSent++;
      if (batch.length >= 50) { await Promise.all(batch); batch = []; }
      const elapsed = Date.now() - start;
      const expected = (scadaSent / scadaRatePerSec) * 1000;
      if (expected > elapsed) await new Promise((r) => setTimeout(r, Math.min(expected - elapsed, 20)));
    }
    await Promise.all(batch);
  })();

  const complaintTask = (async () => {
    while (Date.now() < end) {
      const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
      const t0 = Date.now();
      postComplaint(complaintBody(asset)).then((r) => {
        complaintLatencies.push(Date.now() - t0);
        if (r.status < 200 || r.status >= 300) complaintErrors++;
      }).catch(() => { complaintErrors++; });
      complaintsSent++;
      await new Promise((r) => setTimeout(r, 1000 / complaintRatePerSec));
    }
  })();

  const monitorTask = (async () => {
    while (Date.now() < end + 2000) {
      const t = Date.now() - start;
      try { pgSamples.push({ t, ...(await pgStatSample()) }); } catch (e) { pgSamples.push({ t, error: e.message }); }
      try { lagSamples.push({ t, lag: await fetchLag() }); } catch (e) { lagSamples.push({ t, error: e.message }); }
      await new Promise((r) => setTimeout(r, 1200));
    }
  })();

  await Promise.all([scadaTask, complaintTask, monitorTask]);
  await new Promise((r) => setTimeout(r, 5000));
  const lagAfterDrain = await fetchLag();

  complaintLatencies.sort((a, b) => a - b);
  const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] : null);

  return {
    durationSec,
    scadaSent, scadaAchievedRate: Number((scadaSent / durationSec).toFixed(1)), scadaPublishErrors,
    complaintsSent, complaintAchievedRate: Number((complaintsSent / durationSec).toFixed(1)),
    complaintErrors, complaintErrorRatePct: complaintsSent ? Number(((complaintErrors / complaintsSent) * 100).toFixed(2)) : null,
    complaintLatencyMs: {
      p50: pct(complaintLatencies, 0.5), p95: pct(complaintLatencies, 0.95), p99: pct(complaintLatencies, 0.99),
      max: complaintLatencies[complaintLatencies.length - 1] ?? null,
    },
    lagDuringBurst: lagSamples,
    lagAfterDrain,
    pgActivitySamples: pgSamples,
  };
}

async function main() {
  console.log(`[xsrc-loadtest] connecting -- Kafka: ${BROKERS.join(',')}  API: ${API_BASE}`);
  await producer.connect();
  await admin.connect();

  const out = {};

  // ONLY=burst runs just the burst-capacity test. The bearer token this
  // needs lives ~5 minutes, and the correlation tests above burn most of
  // that -- so the burst regression re-run (P8.6 crash fix verification)
  // needs to be able to go straight to the part it's verifying.
  const only = (process.env.ONLY || '').toLowerCase();

  if (only !== 'burst') {
    console.log('\n=== Test 1: simultaneous arrival ===');
    out.simultaneousArrival = await simultaneousArrivalTest();
    console.log(JSON.stringify(out.simultaneousArrival, null, 2));

    console.log('\n=== Test 2: order independence ===');
    out.orderIndependence = await orderIndependenceTest();
    console.log(JSON.stringify(out.orderIndependence, null, 2));

    console.log('\n=== Test 3: combined moderate throughput ===');
    out.combinedThroughput = await combinedThroughputTest();
    console.log(JSON.stringify(out.combinedThroughput, null, 2));
  }

  console.log('\n=== Burst capacity test (separate from correctness) ===');
  out.burstCapacity = await burstCapacityTest();
  console.log(JSON.stringify(out.burstCapacity, null, 2));

  console.log('\n=== FULL RESULTS JSON ===');
  console.log(JSON.stringify(out, null, 2));

  await producer.disconnect();
  await admin.disconnect();
  pgp.end();
}

main().catch((e) => { console.error('[xsrc-loadtest] fatal', e); process.exit(1); });
