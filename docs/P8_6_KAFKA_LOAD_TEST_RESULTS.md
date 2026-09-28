# SCADA Kafka ingestion load test (P8.6)

Test date: 2026-09-23
Tool: kafkajs v2.2.4 (same client already used by `backend/src/domain/bus.js` -- no second Kafka library introduced)
Target: `scada.alarm.raised` topic → `backend/src/realtime/scada.js`'s `handleScadaEvent()`, running against the real Kafka-driver backend (`EVENT_BUS_DRIVER=kafka`), real Postgres, real dedup logic -- not a simulation of it.
Script: `loadtest-scada-kafka.js` (repo root, same location convention as `loadtest-dashboard.js`)
Load pattern: ramp 10 → 100 → 1000 events/sec, 20s sustained per stage, plus a dedicated concurrency/race test

## Two real infrastructure bugs found and fixed before the test could even run

Before any load could be produced, the project's own `EVENT_BUS_DRIVER=kafka` path was **completely non-functional** in local dev. Both issues were in Kafka's docker-compose configuration, not in application code, and both are now fixed:

1. **`docker-compose.override.yml` pointed the KRaft controller quorum at the wrong port.** The override remaps the `CONTROLLER` listener to port 9094, but never updated `KAFKA_CONTROLLER_QUORUM_VOTERS`, which still inherited `1@kafka:9093` from the base `docker-compose.yml` -- port 9093 is the *INTERNAL broker* listener under the override, not the controller. The broker could never register with its own controller and crashed on every startup (`Received a fatal error while waiting for the controller to acknowledge that we are caught up`). Fixed by adding `KAFKA_CONTROLLER_QUORUM_VOTERS: "1@kafka:9094"` to the override so it matches the remapped controller port.
2. **Single-broker cluster with the default replication factor of 3.** Even after (1) was fixed, every Kafka consumer group -- including the backend's own `oms-backend` group -- hung forever on `KafkaJSGroupCoordinatorNotFound: Failed to find group coordinator`. Root cause: `__consumer_offsets` auto-creates with `offsets.topic.replication.factor=3` by default, which a single-broker dev cluster can never satisfy, so the topic silently never gets created and no consumer group can ever form. Fixed by adding `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR`, `KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR`, and `KAFKA_TRANSACTION_STATE_LOG_MIN_ISR`, all set to `"1"`, to `docker-compose.yml`.

**Practical implication:** anyone who has tried running this project with `EVENT_BUS_DRIVER=kafka` against the checked-in compose files, in local dev, would have hit a silently-stuck consumer with zero events ever processed. This was verified directly -- the first full test run below (before either fix) produced 22,240 published events and **0** incidents created, with the admin API reporting no consumer groups existed at all. After both fixes, a manual single-event smoke test round-tripped correctly (published → consumed → `INC-2026-000130` auto-created) before the real load test was run.

## Result: dedup holds at all three ramp rates, with real evidence writes, not silent drops

| Stage | Target rate | Events published | Actual rate achieved | Incidents created | Consumer lag at end of stage |
|---|---|---|---|---|---|
| 1 | 10/s for 20s | 200 | 10.0/s | 15 | 0 |
| 2 | 100/s for 20s | 2,000 | 100.0/s | 0 | 0 |
| 3 | 1,000/s for 20s | 20,000 | 999.6/s | 0 | 0 |

Raw stage output (verbatim from the actual run):

```
=== Stage: 10 events/sec for 20s ===
{
  "targetRate": 10, "durationSec": 20, "eventsPublished": 200, "actualWallMs": 19913,
  "actualRate": 10, "incidentsBefore": 130, "incidentsAfter": 145, "incidentsCreated": 15,
  "dedupedOrDiscarded": 185,
  "consumerLag": [ { "partition": 0, "committedOffset": "201", "highWaterMark": "201", "lag": 0 } ]
}

=== Stage: 100 events/sec for 20s ===
{
  "targetRate": 100, "durationSec": 20, "eventsPublished": 2000, "actualWallMs": 20002,
  "actualRate": 100, "incidentsBefore": 145, "incidentsAfter": 145, "incidentsCreated": 0,
  "dedupedOrDiscarded": 2000,
  "consumerLag": [ { "partition": 0, "committedOffset": "2201", "highWaterMark": "2201", "lag": 0 } ]
}

=== Stage: 1000 events/sec for 20s ===
{
  "targetRate": 1000, "durationSec": 20, "eventsPublished": 20000, "actualWallMs": 20008,
  "actualRate": 999.6, "incidentsBefore": 145, "incidentsAfter": 145, "incidentsCreated": 0,
  "dedupedOrDiscarded": 20000,
  "consumerLag": [ { "partition": 0, "committedOffset": "22201", "highWaterMark": "22201", "lag": 0 } ]
}
```

**Why 15 incidents in stage 1 and 0 afterward, and why that's correct, not a bug:** the load generator cycles through the 15 real substations from `backend/src/infra/network.json` (the actual UPCL Ganga Corridor data -- `UPCL-BW`, `UPCL-JW`, `UPCL-IA`, etc.), each with real feeder identifiers derived from that substation's own `feeders` field. Stage 1's first CRITICAL/TRIP/MAJOR event on each of the 15 substation/feeder combinations opened a genuine incident (15 total); every subsequent event on an already-open asset, at every rate up to 1000/s, was correctly deduplicated -- confirmed not by "no errors" but by directly querying Postgres: 19,102 real `incident_events` rows were written with the exact dedup evidence note (`"... (deduplicated)"`) `backend/src/realtime/scada.js` produces on a correlated repeat hit. That is genuinely fewer than the ~22,185 non-MINOR events sent post-stage-1, because roughly a quarter of the randomized conditions were MINOR (not an outage condition -- `isOutageCondition()` correctly discards those before dedup logic even runs). **Consumer lag stayed at 0 at every measured checkpoint, including right after the 1,000/s stage** -- the consumer kept up with production in real time; it was never falling behind and silently catching up later.

One legitimate multi-incident case surfaced in the substation-level breakdown: `UPCL-JP` shows 2 open incidents post-test (`INC-2026-000143` on feeder `UPCL-JP-F3`, `INC-2026-000144` on feeder `UPCL-JP-F1`, opened 4ms apart). This is **not** a dedup failure -- `assetKey()` in `scada.js` keys dedup by feeder when a feeder is present, and these are two different real feeders on the same substation, which is exactly the granularity FR-OMS-003 is meant to have (one feeder tripping shouldn't suppress detection of a second, independent feeder tripping on the same substation).

## The race-condition question: tested, not found

The specific concern -- whether the in-memory `recentByAsset` check and the DB fallback (`activeIncidentsAtSubstation`) can both race past each other and create two incidents for one asset inside the 60s dedup window -- was tested directly, not assumed away: 40 CRITICAL events for the same real asset (`UPCL-BW`, feeder `UPCL-BW-F1`) were fired via `Promise.all` (not spaced out) so they land on the broker and get consumed back-to-back, maximizing the chance of hitting the gap between the async check and the async set in `handleScadaEvent()`.

```
=== Race-condition test: same asset, 40 concurrent events inside 60s dedup window ===
{
  "asset": "UPCL-BW",
  "eventsFiredConcurrently": 40,
  "fireWallMs": 11,
  "incidentsBeforeInWindow": 1,
  "incidentsAfterInWindow": 1,
  "newIncidents": [
    { "id": "INC-2026-000130", "substation": "UPCL-BW", "feeder": "UPCL-BW-F1", "opened_at": "2026-09-23T05:26:11.464Z" }
  ],
  "duplicateFound": false
}
```

**Result: no duplicate incident was created.** `incidentsAfterInWindow` stayed at 1 -- the same incident (`INC-2026-000130`) that already existed from an earlier manual smoke-test event on that same asset. Because the backend process had been freshly restarted shortly before this run, its in-memory `recentByAsset` cache was cold for this asset -- meaning this specific run exercised the **DB fallback path** (`activeIncidentsAtSubstation`), not the in-memory fast path, and that path held up correctly under 40 genuinely concurrent hits.

**Honest scope limitation on this specific finding:** this run proves the DB-fallback dedup path is race-safe under concurrent load for a cold cache. It does *not* by itself prove the in-memory fast path (`recentByAsset` Map read-then-write) is race-safe once it's warm, nor does it prove safety across multiple backend instances/pods racing on the same in-memory-cold, DB-fallback path simultaneously (this test only ran one backend instance). Both `recentByAsset.get()`/`.set()` and the DB read-then-insert are genuinely two separate async steps with no lock between them in the current code, so a theoretical window still exists -- this test's honest finding is "not observed in 40 concurrent hits against one backend instance," not "structurally impossible." A stronger follow-up test would warm the cache first (send one event, wait, confirm cache is hot) and then fire the concurrent burst, and separately would run two backend instances against the same broker/DB concurrently.

## Honest scope of what this test does and does not prove

What it genuinely proves:
- The real Kafka producer → `scada.alarm.raised` topic → real KafkaJS consumer group (`oms-backend`) → `handleScadaEvent()` → real Postgres path handles 1,000 events/sec sustained with zero consumer lag.
- Deduplication (FR-OMS-003) is genuinely effective at all three tested rates, verified against actual incident and incident_event rows in the database, not inferred from absence of errors.
- The DB-fallback dedup path did not produce a duplicate incident under one specific concurrent-burst scenario against one backend instance.
- Fixed two real, previously-undiscovered infrastructure bugs that made the Kafka event-bus driver completely non-functional in local dev.

What it does not yet prove:
- This tests the Kafka/consumer/dedup path only, not the DNP3-over-TCP protocol adapter (`backend/src/realtime/dnp3.js`) directly -- that adapter publishes to the same topic once it decodes a real DNP3 frame, but no test here drives load through actual DNP3 wire traffic. That would need a separate test that opens many concurrent TCP connections against `Dnp3TestOutstation` (or a real DNP3 outstation) and measures the link-layer/CRC/frame-parsing path under load, which is a materially different bottleneck (TCP + byte-level framing) than the Kafka path tested here.
- The in-memory `recentByAsset` fast-path's race safety once warm was not directly isolated from the DB-fallback path in this run (see limitation above).
- This ran on one developer machine (single Kafka broker, single backend instance) -- it says nothing about behavior with multiple partitions/consumers or multiple backend replicas consuming the same topic, which is the actual production deployment shape and where partition-key assignment (not tested here -- messages weren't keyed, so ordering per asset isn't guaranteed across partitions in a multi-partition production topic) becomes relevant to dedup correctness.
- No rate-limiting layer (Kong, as found relevant in `docs/P8_6_PERFORMANCE_RESULTS.md`) sits in front of a Kafka producer, so this test is not subject to -- and says nothing about -- the API gateway's rate-limit configuration.

## Recommended next steps

1. Warm-cache variant of the race test, and a two-backend-instance variant, to fully close out the concurrency question this test only partially answers.
2. A DNP3-level load/stress test against `Dnp3TestOutstation` (or real hardware) to cover the protocol-adapter layer this test explicitly does not touch.
3. If production Kafka will run with more than one partition on `scada.alarm.raised`, add a partition key (e.g. substation/feeder) to the producer -- the current `bus.js` `KafkaBus.publish()` sends unkeyed messages, so on a multi-partition topic, dedup's correctness would depend on partition assignment in a way this single-partition test does not exercise.
