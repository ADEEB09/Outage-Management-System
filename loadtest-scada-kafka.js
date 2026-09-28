// Kafka load test for P8.6: simulate SCADA fault events hitting the real
// scada.alarm.raised topic at increasing rates, and directly measure what
// backend/src/realtime/scada.js's handleScadaEvent() actually does with
// them -- not just "did the publish succeed", but "how many incidents did
// this genuinely create, and did the 60s dedup window ever leak a
// duplicate incident for the same asset under concurrent load."
//
// Run: node loadtest-scada-kafka.js
//   env KAFKA_BROKERS   (default localhost:9092, same convention as backend/src/domain/bus.js)
//   env DATABASE_URL    (default postgres://oms:oms@localhost:5432/oms, same as backend/.env)
//
// Uses kafkajs -- the same Kafka client already a dependency of backend/,
// not a second library. Payload shape and real substation/feeder identifiers
// are taken directly from:
//   - backend/src/realtime/dnp3.js's evt shape (tag, condition, limit_val,
//     priority, substation, feeder, message, ts, ack, id) -- the real,
//     lat/lon-free shape a genuine field adapter publishes
//   - backend/src/infra/network.json -- the real UPCL Ganga Corridor
//     substations/feeders (not invented names)

import { Kafka, logLevel } from 'kafkajs';
import pgPromise from 'pg-promise';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _dir = dirname(fileURLToPath(import.meta.url));
const NET = JSON.parse(readFileSync(join(_dir, 'backend/src/infra/network.json'), 'utf8'));

const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://oms:oms@localhost:5432/oms';
const TOPIC = 'scada.alarm.raised'; // TOPICS.ALARM_RAISED in backend/src/domain/bus.js

const pgp = pgPromise({});
const db = pgp(DATABASE_URL);

const kafka = new Kafka({ clientId: 'oms-scada-loadtest', brokers: BROKERS, logLevel: logLevel.NOTHING });
const producer = kafka.producer();
const admin = kafka.admin();

// Real assets: each entry is one substation with its real feeder names,
// parsed straight out of network.json's "feeders" field (e.g.
// "1-PANT DEEP, 2-S/S FEEDER ,..." -> feeder ids like "UPCL-BW-F1").
const ASSETS = NET.substations.map((s) => {
  const feederNums = (s.feeders || '').split(',').map((f) => (f.match(/^\s*(\d+)/) || [])[1]).filter(Boolean);
  return {
    substationCode: s.code,
    substationName: s.name,
    feeders: (feederNums.length ? feederNums : ['1']).map((n) => `${s.code}-F${n}`),
  };
});

const CONDITIONS = ['CRITICAL', 'TRIP', 'MAJOR', 'MINOR']; // exact keys from scada.js's CONDITION_SEVERITY

function randomEvent(asset, feeder, seq) {
  const condition = CONDITIONS[Math.floor(Math.random() * CONDITIONS.length)];
  return {
    id: `ALM-LOADTEST-${seq}`,
    tag: `${feeder}.T1.MW`,
    condition,
    limit_val: condition === 'MINOR' ? '95A' : 'TRIP',
    priority: condition === 'CRITICAL' || condition === 'TRIP' ? 1 : condition === 'MAJOR' ? 2 : 3,
    substation: asset.substationCode,
    feeder,
    customers: Math.floor(50 + Math.random() * 2000), // randomized, per real estimateCustomers() field
    message: `${condition} condition detected on field device (loadtest)`,
    ts: new Date().toISOString(),
    ack: 0,
  };
}

function pickAsset() {
  const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
  const feeder = asset.feeders[Math.floor(Math.random() * asset.feeders.length)];
  return { asset, feeder };
}

async function publishAtRate(ratePerSec, durationSec, seqRef) {
  const intervalMs = 1000 / ratePerSec;
  const totalEvents = ratePerSec * durationSec;
  const batch = [];
  let sent = 0;
  const start = Date.now();
  for (let i = 0; i < totalEvents; i++) {
    const { asset, feeder } = pickAsset();
    const evt = randomEvent(asset, feeder, seqRef.n++);
    batch.push(producer.send({ topic: TOPIC, messages: [{ value: JSON.stringify(evt) }] }));
    sent++;
    // throttle to the target rate without blocking on each individual send
    if (batch.length >= 50) {
      await Promise.all(batch.splice(0));
      const elapsed = Date.now() - start;
      const expected = (i / ratePerSec) * 1000;
      if (expected > elapsed) await new Promise((r) => setTimeout(r, expected - elapsed));
    }
  }
  await Promise.all(batch);
  const wallMs = Date.now() - start;
  return { sent, wallMs };
}

// The race-condition test: fire many events for the SAME asset within the
// 60s dedup window, all at once (Promise.all, not spaced out), to see
// whether handleScadaEvent's in-memory recentByAsset check and the DB
// fallback (activeIncidentsAtSubstation) both ever create a separate
// incident for what should be one deduplicated event.
async function raceConditionTest(seqRef) {
  const asset = ASSETS[0]; // 33/11 kV BHOOPATWALA S/s (UPCL-BW) -- real, fixed asset
  const feeder = asset.feeders[0];
  const N = 40;
  const events = Array.from({ length: N }, () => randomEvent(asset, feeder, `RACE-${seqRef.n++}`));
  // Force CRITICAL so every one of these is a genuine outage-condition event
  // (isOutageCondition must be true, or scada.js discards it before dedup logic runs).
  for (const e of events) { e.condition = 'CRITICAL'; e.limit_val = 'TRIP'; }

  const before = await db.one(
    `SELECT count(*)::int c FROM incidents WHERE substation = $1 AND opened_at >= now() - interval '2 minutes'`,
    [asset.substationCode]
  );

  const fireStart = Date.now();
  await Promise.all(events.map((e) => producer.send({ topic: TOPIC, messages: [{ value: JSON.stringify(e) }] })));
  const fireMs = Date.now() - fireStart;

  // Give the consumer a few seconds to actually process everything (publish
  // is fire-and-forget; the real handleScadaEvent() work happens async on
  // the consumer side after this).
  await new Promise((r) => setTimeout(r, 8000));

  const after = await db.any(
    `SELECT id, substation, feeder, opened_at FROM incidents
     WHERE substation = $1 AND opened_at >= now() - interval '2 minutes'
     ORDER BY opened_at ASC`,
    [asset.substationCode]
  );

  return {
    asset: asset.substationCode,
    eventsFiredConcurrently: N,
    fireWallMs: fireMs,
    incidentsBeforeInWindow: Number(before.c),
    incidentsAfterInWindow: after.length,
    newIncidents: after,
    duplicateFound: after.length - Number(before.c) > 1,
  };
}

async function countIncidents() {
  const r = await db.one('SELECT count(*)::int c FROM incidents');
  return r.c;
}

async function fetchLagFromKafkaUi() {
  // Direct, more reliable than scraping kafka-ui's HTML: kafkajs admin API's
  // own describeGroups + fetchOffsets against the real consumer group the
  // backend's KafkaBus actually uses ("oms-backend", see backend/src/domain/bus.js).
  try {
    const groupId = 'oms-backend';
    const topicOffsets = await admin.fetchTopicOffsets(TOPIC);
    const groupOffsets = await admin.fetchOffsets({ groupId, topics: [TOPIC] });
    const partitionLag = groupOffsets[0].partitions.map((p) => {
      const hw = topicOffsets.find((t) => t.partition === p.partition)?.offset;
      return { partition: p.partition, committedOffset: p.offset, highWaterMark: hw, lag: hw != null ? Number(hw) - Number(p.offset) : null };
    });
    return partitionLag;
  } catch (e) {
    return [{ error: e.message }];
  }
}

async function main() {
  console.log(`[loadtest] connecting to Kafka brokers: ${BROKERS.join(',')}`);
  await producer.connect();
  await admin.connect();

  const results = { stages: [], race: null };
  const seqRef = { n: 0 };

  const stages = [
    { rate: 10, durationSec: 20 },
    { rate: 100, durationSec: 20 },
    { rate: 1000, durationSec: 20 },
  ];

  for (const stage of stages) {
    console.log(`\n=== Stage: ${stage.rate} events/sec for ${stage.durationSec}s ===`);
    const incidentsBefore = await countIncidents();
    const t0 = Date.now();
    const { sent, wallMs } = await publishAtRate(stage.rate, stage.durationSec, seqRef);
    // let the consumer drain
    await new Promise((r) => setTimeout(r, Math.min(10000, stage.rate * stage.durationSec / 50)));
    const incidentsAfter = await countIncidents();
    const lag = await fetchLagFromKafkaUi();
    const stageResult = {
      targetRate: stage.rate,
      durationSec: stage.durationSec,
      eventsPublished: sent,
      actualWallMs: wallMs,
      actualRate: Number((sent / (wallMs / 1000)).toFixed(1)),
      incidentsBefore,
      incidentsAfter,
      incidentsCreated: incidentsAfter - incidentsBefore,
      dedupedOrDiscarded: sent - (incidentsAfter - incidentsBefore),
      consumerLag: lag,
    };
    console.log(JSON.stringify(stageResult, null, 2));
    results.stages.push(stageResult);
  }

  console.log(`\n=== Race-condition test: same asset, ${40} concurrent events inside 60s dedup window ===`);
  results.race = await raceConditionTest(seqRef);
  console.log(JSON.stringify(results.race, null, 2));

  console.log('\n=== FULL RESULTS JSON ===');
  console.log(JSON.stringify(results, null, 2));

  await producer.disconnect();
  await admin.disconnect();
  pgp.end();
}

main().catch((e) => { console.error('[loadtest] fatal', e); process.exit(1); });
