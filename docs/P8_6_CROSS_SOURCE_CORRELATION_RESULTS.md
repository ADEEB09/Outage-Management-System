# Cross-source correlation & burst-capacity test (P8.6)

Test date: 2026-09-23
Tool: kafkajs (SCADA side, same as `docs/P8_6_KAFKA_LOAD_TEST_RESULTS.md`) + real HTTP `POST /api/complaints` calls with a real Keycloak bearer token (TCS/IVR side)
Script: `loadtest-cross-source-correlation.js` (repo root)
Target: does a SCADA fault event and TCS/IVR customer complaints for the **same physical fault** collapse into one incident? This is a different code path from `docs/P8_6_KAFKA_LOAD_TEST_RESULTS.md`, which never called `ingestComplaint()` -- this test exercises `backend/src/realtime/scada.js`'s `handleScadaEvent()`/`locate()`/`assetKey()` **and** `backend/src/routes/api.js`'s `ingestComplaint()`/`pickIncident()`/`repo.activeIncidentsAtSubstation()` together, for the same asset, at the same time.

## Headline finding: a severe, previously-unknown crash bug, found before correlation could even be tested at realistic concurrency

Before the correlation questions could be answered at the concurrency level originally specified (3-5 simultaneous complaints per substation), the test hit something more serious: **`POST /api/complaints` reliably crashes the entire backend process** under any meaningfully concurrent complaint load -- which is exactly the shape of the real-world scenario this whole test exists to check (a storm knocks out a substation, and multiple customers call in within the same window).

**Root cause, confirmed by reading the code and reproducing it directly, twice, identically:**

```js
// backend/src/infra/repo.js
nextQueryId: async () => {
  const { c } = await db.one('SELECT COUNT(*) c FROM complaints');
  return 'QRY-2026-' + String(Number(c) + 1).padStart(6, '0');
},
```

This is a classic read-then-write race: two concurrent complaint requests both read the same `COUNT(*)`, both compute the same `qid`, and the second `INSERT` throws:

```
error: duplicate key value violates unique constraint "complaints_pkey"
detail: 'Key (qid)=(QRY-2026-000006) already exists.'
```

**And that alone would only fail one request -- the reason it's severe is what happens next:** `backend/src/index.js` has **no `process.on('uncaughtException'/'unhandledRejection')` handler anywhere**. This unhandled Postgres error is not caught by Express's request-handling machinery, so it propagates all the way up and **crashes the entire Node process**:

```
C:\...\node_modules\pg-protocol\dist\parser.js:306
        : new messages_1.DatabaseError(messageValue, LATEINIT_LENGTH, name);
Node.js v24.19.0
```

**Reproduced twice, deterministically, with a minimal isolated test** (5 near-simultaneous `POST /api/complaints` calls, no SCADA involved at all): every single request then failed with connection-refused, and `/api/health` stopped responding entirely. The exact same failure also occurred organically inside the correlation test itself (Test 1's first attempt, and the burst test below) every time complaints weren't deliberately spaced far enough apart.

**This kills more than the complaint request that lost the race.** Because the crash takes down the whole process:
- The SCADA Kafka consumer dies with it -- SCADA fault detection stops working for everyone.
- The dashboard and every other `/api/*` route go down for every operator.
- `repo.nextIncidentId()` (`backend/src/infra/repo.js`) uses the **exact same `COUNT(*)` pattern** for incident IDs, so this isn't unique to complaints -- any sufficiently concurrent write path minting an ID this way is a latent crash waiting to happen.

**Is this a quick fix or a design gap needing a decision?** Two independent things need fixing, and they're different sizes:
1. **Quick fix, no design decision needed:** add process-level `uncaughtException`/`unhandledRejection` handlers to `index.js` so a single bad request logs and returns a 500 instead of killing the process. This alone would have prevented every cascading failure described above, even with the ID race still present.
2. **Slightly bigger, but still not a design debate:** replace the `COUNT(*)`-based ID minting in both `nextQueryId()` and `nextIncidentId()` with something collision-proof under concurrency -- a Postgres `SERIAL`/`IDENTITY` column or sequence (`nextval()`), or an `INSERT ... RETURNING` against a dedicated counter table, or simply a `nanoid()`-suffixed ID (the codebase already uses `nanoid` elsewhere, e.g. `repo.addIncidentEvent`). None of these require a product/UX decision -- they're mechanical, same external ID format achievable either way.

Neither fix was applied at the time this section was written (unlike the two Kafka docker-compose bugs in the prior test, which were pure dev-infra config with no application-behavior implications, this is application logic the user should decide how to change) -- both were flagged for a deliberate decision, per how this task asked findings to be reported.

> **Update (2026-09-23, same day):** both fixes have since been applied and verified by re-running this exact burst test. Option 2 was implemented with Postgres sequences. See **"Fix verification -- crash guard + sequence-based ID generation"** at the end of this document for the before/after evidence.

## Correlation-correctness results

Because of the crash above, the originally-specified "3-5 simultaneous complaints per substation" scenario could not be run as designed -- it crashes the backend before 2 complaints complete, every time. To still get real signal on the actual correlation questions, Test 1 and Test 2 below use **one complaint per substation** (still genuinely concurrent with the SCADA event via `Promise.all`), which avoids the complaint-vs-complaint race while still fully exercising SCADA-vs-complaint correlation. The multi-complaint crash itself is measured separately and deliberately in the burst-capacity section.

### Test 1: simultaneous arrival (1 SCADA event + 1 complaint, same real substation, ~1s window)

Two groups, to tell apart two different candidate root causes for duplicate incidents:

**Group A -- geo-tagged SCADA** (SCADA event carries real substation lat/lon, so `locate()` calls the exact same `resolveAsset()`/`geo.resolve()` that `ingestComplaint()` calls -- this is the case where the two sources' substation strings *should* be identical):

| Substation | Incidents found | Notes |
|---|---|---|
| 33/11 kV BHOOPATWALA S/s | (see below) | Merged into a pre-existing incident from an earlier test run, opened >5 min prior -- test-methodology artifact, not a bug (see "Eventual-consistency window" below) |
| 33/11 kV JWALAPUR-I S/s | 1 | Correct |
| 33/11 kV INDUSTRIAL AREA S/s | 1 | Correct (later confirmed by SCADA, see below) |
| 33/11 kV JWALAPUR-II S/s | (see below) | Same test-methodology artifact as BHOOPATWALA |
| 33/11 kV GURUKUL S/s | (see below) | Same test-methodology artifact as BHOOPATWALA |

**Group B -- tag/code-only SCADA** (SCADA event has no lat/lon, only `evt.substation = 'UPCL-XX'` -- the real shape `backend/src/realtime/dnp3.js`'s actual field adapter produces, per its own code: `substation: this.substation, feeder: this.feeder` with no lat/lon at all):

| Substation | Incident landed under (name, i.e. the complaint's key) | Incident landed under (code, i.e. what SCADA used) |
|---|---|---|
| UPCL-LW / 33/11 kV LALJIWALA S/s | 1 | 0 |
| UPCL-KK / 33/11 kV KANKHAL- 2 S/s | 1 | 0 |
| UPCL-BC / 33/11 kV BAIRAGI CAMP S/s | 1 | 0 |
| UPCL-MP / 33/11 kV MAYAPUR S/s | 1 | 0 |
| UPCL-BS / 33/11 kV BHEL SECTOR_2 S/s | 1 | 0 |

**Root cause, confirmed by reading `backend/src/realtime/scada.js`'s `locate()`:**

```js
function locate(evt) {
  if (typeof evt.lat === 'number' && typeof evt.lon === 'number') {
    return { ...resolveAsset(evt.lat, evt.lon), lat: evt.lat, lon: evt.lon };
  }
  const parts = (evt.tag || '').split('.').filter(Boolean);
  const substation = evt.substation || parts[0] || null;   // <- used AS-IS, no normalization
  ...
}
```

When lat/lon is absent, `locate()` uses `evt.substation` verbatim. `ingestComplaint()` (`backend/src/routes/api.js`) always resolves its substation string via `resolveAsset(lat, lon)`, which returns the substation's **`name`** field from `backend/src/infra/network.json` (e.g. `"33/11 kV LALJIWALA S/s"`). A tag/code-only SCADA event's `evt.substation` (e.g. `"UPCL-LW"`, the substation's **`code`** field) never matches that string. `repo.activeIncidentsAtSubstation()` does an exact-string `IS NOT DISTINCT FROM` comparison, so these two representations of the identical physical substation are permanently invisible to each other. **In this run, every single tag-only-SCADA substation's SCADA-side incident query came back empty (0), while the complaint-side incident existed correctly (1)** -- meaning the SCADA event genuinely landed nowhere findable, not merely "didn't merge." The result in every case was a real gap: the fault physically exists, a customer reported it, but the SCADA confirmation of that exact same fault is orphaned under a substation identifier the complaint path will never look up.

**This is a genuine design gap, not a quick fix.** There is no normalization table anywhere in the codebase mapping a substation `code` (`UPCL-LW`) to its `name` (`"33/11 kV LALJIWALA S/s"`) for the tag-only intake path -- `geo.js`'s `codeToSub` map exists but is only used internally by `resolve(lat, lon)`, never exposed for a code-only lookup. Fixing this requires a decision: should `locate()`'s tag-parsing branch look up `evt.substation`/`parts[0]` against `network.json`'s `code` field and normalize to `name` before using it as the dedup key (cheapest, but assumes every real field device's tag/substation identifier will always be a valid, recognizable code -- not guaranteed for a real DNP3/IEC-61968 deployment with its own device-address scheme)? Or should the two systems agree on a single canonical substation identifier scheme up front (a real CIM mRID or similar), which is a bigger interoperability decision affecting more than just this dedup path? This needs a decision, not a patch.

### Test 2: order independence (geo-tagged only, to isolate this question from the string-mismatch gap above)

| Order | Substation | Result |
|---|---|---|
| SCADA first, then complaints | 33/11 kV JWALAPUR-III S/s | 1 incident, source `Customer`, severity `high` at snapshot time |
| Complaints first, then SCADA | "Import Point From 132 kV JWALAPUR S/s" | 0 incidents found under that exact name |

**Honest caveat, found while investigating the "0 incidents" result:** `"Import Point From 132 kV JWALAPUR S/s"` is a real entry in `network.json`'s substation list, but (unlike the 33/11 kV distribution substations used everywhere else in this test) it is a 132 kV import point, and complaints resolve via nearest-*distribution-transformer* first, only falling back to nearest-substation geographically if no distribution transformer is found. It's likely this asset has no directly associated distribution transformers in `network.json`'s `distTx` list, so a complaint placed at its exact coordinates resolves to a **different, nearby** serving substation's name instead of its own -- meaning this specific test asset was a poor choice for isolating "order independence," not evidence of an order-dependence bug. **This sub-test is inconclusive as run and should be repeated against a normal 33/11 kV distribution substation**, not one of the small number of import-point entries in the network data.

> **Update (2026-09-23, same day): re-run against a normal 33/11 kV distribution substation -- verdict replaced, this is a real order-dependence bug, not inconclusive.**
>
> Re-ran against `"33/11 kV LALTARO PUL S/s"` (code `UPCL-LP`, 62 real distribution transformers in `network.json`'s `distTx` list -- a normal distribution substation, unlike the 132 kV import point above), the only one of the 14 real 33/11 kV substations in this dataset with zero pre-existing active incidents at the time of this re-run (the other 13 all still carry active incidents opened during the correlation-test runs earlier the same day, and this environment's sandbox permissions block resolving/cleaning up existing incidents in the shared dev database, so a second substation couldn't be freshly cleared for a byte-identical repeat of both orders):
>
> | Order | Result |
> |---|---|
> | SCADA first, then complaint | **2 separate incidents** -- `INC-2026-000166` (source `SCADA`, type `outage`, cause `SCADA CRITICAL on UPCL-LP.F1.T1.MW`) and `INC-2026-000167` (source `Customer`, type `Power Outage`, cause `No Supply`). The complaint did **not** merge into the SCADA incident. |
> | Complaint already open, then a second SCADA event | **Merges correctly** -- the new SCADA event found `INC-2026-000167` (the complaint incident, most recent at that substation) via `handleScadaEvent()`'s own DB dedup check and added a `confirmed` event to it (`"SCADA confirmed this outage (was customer-reported only) - severity upgraded high to critical"`), with **no new incident created**. |
>
> **This is a genuine order-dependence bug**, and the root cause is visible directly in the code, which is why the asymmetry above is consistent rather than a fluke: `ingestComplaint()`'s matching function `pickIncident()` (`backend/src/routes/api.js`) only recognizes a candidate incident as the same outage if its `type` is one of `OUTAGE_TYPES` (`'Power Outage'`, `'Partial Power'`, `'Power Quality'`) or its `cause` is one of `SUPPLY` (`'No Supply'`, `'Partial Supply'`, `'Voltage'`). But `handleScadaEvent()` (`backend/src/realtime/scada.js`) always creates SCADA-detected incidents with `type: 'outage'` (lowercase, a different string) and `cause: `SCADA ${condition} on ${tag}`` -- neither of which ever satisfies `pickIncident()`'s check. So a complaint arriving **after** a SCADA-created incident at the same substation can never recognize it as the same event and always opens a duplicate. `handleScadaEvent()`'s own merge check has no such type/cause filter -- it merges into **any** active incident at the matching substation, complaint-created or not -- so a SCADA event arriving **after** a complaint-created incident merges correctly. The order in which the two channels report the same physical fault determines whether the OMS ends up with one incident or two.
>
> **Conclusion for Test 2, replacing the earlier "inconclusive" verdict:** order independence does **not** hold. This is a real, reproducible bug (asymmetric matching logic between the two intake paths), not a test-methodology artifact, and it is separate from -- but closely related to -- the substation code/name normalization gap already documented above (Test 1): both stem from the same underlying issue of the two intake paths not sharing one canonical way to recognize "this is the same outage."

**A separate, real, and confirmed eventual-consistency finding, found while chasing the above:** querying more broadly (not restricted to a 5-minute window) showed that cross-source corroboration **does work correctly** -- e.g. incident `INC-2026-000153` (INDUSTRIAL AREA) genuinely received `"SCADA confirmed this outage (was customer-reported only) - severity upgraded high to critical"` -- but this happened **2-4 minutes after** the events were fired, not within the few seconds this test initially waited before checking. That delay tracked directly with Kafka consumer lag building up under this test's own event volume (see below). **The correlation logic is correct; the practical time-to-corroboration under load is longer than a few seconds and should be measured explicitly in any SLA-facing test, not assumed instant.**

## Combined moderate-throughput test (20 SCADA/s + 5 complaints/s, 15s, genuinely concurrent)

```
{
  "durationSec": 15, "scadaSent": 271, "complaintsSent": 75, "complaintErrors": 0,
  "complaintLatencyMs": { "p50": 17, "p95": 22, "max": 24 },
  "consumerLagAfter": [ { "partition": 0, "committedOffset": "35940", "highWaterMark": "35940", "lag": 0 } ]
}
```

At this moderate, sustained, genuinely-concurrent rate: **zero complaint errors**, complaint latency stayed low (p95 22ms), and Kafka consumer lag returned to 0 -- neither channel measurably degraded the other. This is the honest "capacity is fine at realistic moderate load" result, in contrast to the burst section below.

---

## Burst-capacity test (separate from correctness -- this is the "can it absorb both channels at once" question)

Target: SCADA at 800/s + complaints at ~200/s, both genuinely concurrent, for 8 seconds.

```
{
  "durationSec": 8,
  "scadaSent": 6400, "scadaAchievedRate": 800, "scadaPublishErrors": 0,
  "complaintsSent": 1010, "complaintAchievedRate": 126.3,
  "complaintErrors": 1009, "complaintErrorRatePct": 99.9,
  "complaintLatencyMs": { "p50": 1, "p95": 2, "p99": 3, "max": 26 },
  "lagAfterDrain": [ { "partition": 0, "committedOffset": "35956", "highWaterMark": "42340", "lag": 6384 } ]
}
```

**What actually happened, traced through real evidence, not inferred from the numbers alone:** the backend crashed **~1.2 seconds into the 8-second burst**, from the exact same `complaints_pkey` race documented above -- confirmed by `pg_stat_activity` samples taken every ~1.2s throughout:

```
t=0ms:    { total: 5, active: 0, idle: 5, idle_in_txn: 0 }   <- backend's DB connections still alive
t=1222ms: { total: 3, active: 0, idle: 3, idle_in_txn: 0 }   <- backend's connections gone (crashed); only this test script's own 3 idle connections remain
t=2437ms through t=8500ms: unchanged, { total: 3, idle: 3 }  <- nothing came back
```

and by Kafka consumer lag, sampled on the same schedule:

```
t=0ms:    lag=1
t=1222ms: lag=965      <- consumer already stopped keeping up
t=2437ms: lag=1937
...
t=8500ms: lag=6384
t=9708ms: lag=6384      <- frozen, does not recover after the burst ends
```

**Answering the question this section exists to answer -- does one channel starve the other, or do they both just get slower:** neither. **The complaint channel doesn't slow the SCADA channel down at all** -- `scadaAchievedRate` hit its full 800/s target with zero publish errors, because publishing to Kafka only requires the broker to be up, not the backend consumer. **But the complaint channel crashing the shared backend process kills the SCADA *consumer* as a side effect**, even though SCADA production itself is unaffected. This is not "one channel degrading the other's latency" (the thing the question was originally framed around) -- it's a **single point of failure**: any one channel's failure mode (here, the complaint ID race) takes the *entire* backend down, silently starving every other channel that happens to share that one process, Kafka consumer included. The 6,384-message consumer lag did not recover on its own after the burst window ended, because there was no backend process left to consume it -- it would stay frozen at that value indefinitely until the backend is manually restarted (which is exactly what this test had to do, repeatedly, to make any further progress).

The 99.9% complaint error rate and low reported latencies (p50 1ms, p95 2ms) are themselves informative: those are **connection-refused failures returned near-instantly**, not slow requests -- once the crash happens, there's no server to be slow. A 100% instant-failure signature like this, appearing immediately after a burst starts and never recovering, is a distinctive, checkable symptom of "the process died," and is worth adding to monitoring/alerting as distinct from genuine backpressure (which would show climbing latency, not near-zero latency with 100% failure).

## Summary: what passed, what didn't, what needs a decision

**Passed:**
- Cross-source correlation logic itself, when both sources agree on the substation string (geo-tagged SCADA + geo-resolved complaint): confirmed working correctly, including the severity-upgrade corroboration logic, once given enough time for the Kafka consumer to catch up.
- Moderate combined-channel throughput (20 SCADA/s + 5 complaints/s sustained): zero errors, low latency, zero consumer lag by end of test.
- SCADA publish throughput under burst (800/s): unaffected by anything happening on the complaint side.

**Did not pass / real gaps found:**
1. **Backend-crashing ID-generation race (`repo.js`'s `nextQueryId`/`nextIncidentId`, no process-level crash guard in `index.js`).** Severity: high -- a genuine multi-caller storm scenario (the exact scenario this whole test simulates) can take down the entire backend, not just fail one request. Classified above as two separate, mechanically quick fixes (crash guard; collision-proof ID generation) that don't require a product decision. **Both have since been applied and verified** -- see the fix-verification section at the end of this document.
2. **Tag-only SCADA substation identifiers never normalize to the complaint path's substation-name strings**, so any real field device reporting via substation *code* (not lat/lon) produces permanently orphaned SCADA-side incidents that will never merge with a customer's complaint about the same fault, even though the complaint path itself works correctly. Classified as a genuine design gap needing a decision on the normalization/mapping approach (not applied).
3. **Order-independence test for the "complaints first" case was inconclusive** due to an unlucky test-asset choice (a 132 kV import point without its own distribution transformers) -- needs re-running against a normal distribution substation before it can be called pass or fail.

**Scope note, same spirit as the prior P8.6 docs:** this test used a real Keycloak bearer token with a 5-minute lifetime, obtained manually from a browser session each time it expired -- three separate token acquisitions were needed across this test's iterations because the crash bug forced multiple backend restarts and re-runs. This is not a repeatable, automatable load-testing setup as-is; a real CI-integrated version of this test would need a scripted way to mint a fresh test-user token (e.g. the Resource Owner Password Credentials grant against `oms-web`, which has `directAccessGrantsEnabled: true` in `infra/keycloak-realm.json`) rather than depending on a human copying one out of DevTools each time.

---

# Fix verification -- crash guard + sequence-based ID generation (re-run of the burst test)

Fix date: 2026-09-23 (same day as the findings above)
Verified by: re-running the **exact same** burst-capacity test that found the bug -- same script (`loadtest-cross-source-correlation.js`, now with `ONLY=burst` to go straight to the burst phase), same rates (SCADA 800/s + complaints ~200/s, concurrent, 8s), same sampling schedule (`pg_stat_activity` and Kafka consumer lag every ~1.2s), so the before/after is apples-to-apples rather than a different measurement method.

Scope: this fixes finding #1 only (the crash). Finding #2 (substation code/name mismatch) is deliberately **untouched** -- it's a separate design decision.

## What changed

**1. Process-level crash guards -- `backend/src/index.js`**

Registered before the startup `await`s (so they cover `migrate()`/`seed()`/`initBus()` too, not just post-listen traffic):

```js
function logFatal(kind, err) {
  console.error(`[fatal] ${kind} at ${new Date().toISOString()}:`, err?.stack || err);
}
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
```

**2. Sequence-based ID generation -- `backend/src/infra/repo.js` + `db/migrations/sequence_based_id_generation.sql`**

The actual race is gone, not merely survived. Both generators now use `nextval()`, which is atomic and can never hand the same value to two concurrent callers:

```js
nextIncidentId: async () => {
  const { n } = await db.one("SELECT nextval('incident_id_seq') n");
  return 'INC-2026-' + String(n).padStart(6, '0');
},
nextQueryId: async () => {
  const { n } = await db.one("SELECT nextval('complaint_qid_seq') n");
  return 'QRY-2026-' + String(n).padStart(6, '0');
},
```

The migration is idempotent and forward-only (`GREATEST(max_existing_suffix, current_sequence_value)`), so it is safe against a database that has never seen it *and* safe to re-run against one that has. Verified both properties directly:

```
-- first run, against the live DB holding 163 incidents / 99 complaints:
NOTICE:  incident_id_seq set so the next incident id suffix is 164
NOTICE:  complaint_qid_seq set so the next complaint qid suffix is 100

-- after consuming 164/100, re-running the migration did NOT reset backwards:
 last_value | is_called          last_value | is_called
------------+-----------        ------------+-----------
        164 | t                         100 | t
```

**External ID format is unchanged**, as required (these IDs appear in regulatory reports and are read aloud by operators). Confirmed with a real SCADA event through the real Kafka path after the fix: `INC-2026-000165` -- same `PREFIX-YYYY-NNNNNN`, same 6-digit zero padding.

The same idempotent sequence bootstrap was also added to `migrate()` in `backend/src/infra/db.js`, mirroring the migration file, so a **fresh** database (new dev laptop, CI) self-bootstraps instead of failing on its first complaint. Without this, the standalone migration would have been a required manual step that a new install would have no way to know about.

## Before / after, same test, same sampling schedule

| Measure | Before (original run) | After (this run) |
|---|---|---|
| Backend process | **Crashed ~1.2s into the 8s burst** | **Alive throughout; `/api/health` = 200 immediately after** |
| Complaints sent | 1,010 | 1,088 |
| Complaint errors | **1,009 (99.9%)** | **0 (0.00%)** |
| Complaint latency | p50 1ms, p95 2ms, max 26ms *(fake -- instant connection-refused, not real responses)* | p50 10ms, p95 18ms, p99 63ms, max 155ms *(real, successful responses under load)* |
| SCADA published | 6,400 @ 800/s, 0 errors | 6,400 @ 800/s, 0 errors |
| Consumer lag at end | **6,384, frozen, never recovered** | **0** |
| DB connections during burst | **5 -> 3 at t=1222ms, stayed 3** (backend's connections gone) | **4 -> 13, sustained 13 for the whole burst** (backend's pool alive) |

**Kafka consumer lag, sampled every ~1.2s:**

```
BEFORE                                  AFTER
t=0ms     lag=1                         t=15ms    lag=-9   (see note)
t=1222ms  lag=965                       t=1284ms  lag=1
t=2437ms  lag=1937                      t=2495ms  lag=0
t=3653ms  lag=2907                      t=3701ms  lag=-3
t=4869ms  lag=3883                      t=4916ms  lag=-1
t=6083ms  lag=4854                      t=6126ms  lag=-1
t=7291ms  lag=5819                      t=7331ms  lag=-1
t=8500ms  lag=6384                      t=8544ms  lag=0
t=9708ms  lag=6384  <- frozen           t=9762ms  lag=0
lagAfterDrain: 6384 (never recovers)    lagAfterDrain: 0
```

The consumer now keeps pace with an 800/s SCADA stream *while simultaneously* serving ~136 complaint POSTs/s, instead of dying and stalling permanently.

*Note on the small negative lag values:* `fetchTopicOffsets()` and `fetchOffsets()` are two separate admin calls, and on a topic moving at 800 msg/s the consumer commits between them, so the committed offset can read a few messages "ahead" of a high-water mark sampled microseconds earlier. This is a measurement artifact of the sampling method, not real negative lag -- it means the consumer is keeping up in real time, which is the point.

**`pg_stat_activity`, sampled every ~1.2s:**

```
BEFORE                                                    AFTER
t=0ms     {total:5,  active:0, idle:5}                    t=15ms    {total:4,  active:0, idle:4}
t=1222ms  {total:3,  active:0, idle:3}  <- backend gone   t=1284ms  {total:13, active:0, idle:13}
t=2437ms  {total:3,  active:0, idle:3}                    t=2495ms  {total:13, active:1, idle:12}
...unchanged through t=8500ms, nothing came back          t=3701ms  {total:13, active:1, idle:12}
                                                          t=4916ms  {total:13, active:1, idle:12}
                                                          t=6126ms  {total:13, active:0, idle:13}
                                                          t=7331ms  {total:13, active:0, idle:12}
                                                          t=8544ms  {total:13, active:0, idle:13}
                                                          t=9762ms  {total:13, active:0, idle:13}
```

The crash signature -- connection count collapsing to just the test script's own connections and never recovering -- is genuinely gone. `idle_in_txn` stayed at 0 throughout and at most 1 connection was ever `active` at a time, so there was no lock contention or connection-pool exhaustion: the combined load simply wasn't hard enough on Postgres to queue. Zero long-running queries were caught in any sample.

## Which fix actually did the work, and an honest caveat on the other

**The sequence fix is what fixed this.** The backend log across the entire burst contains **zero** errors and **zero** `[fatal]` entries -- the duplicate-key collision never happened at all, rather than happening and being survived. The crash guard was never invoked during the burst.

That meant the crash guard was unproven by the burst run alone, so it was **tested separately and directly**: a deliberately malformed complaint (`phone` sent as a number instead of a string) triggers a genuine unhandled rejection deep in the DB layer -- exactly the class of error that used to be fatal. Result:

```
[fatal] unhandledRejection at 2026-09-23T07:52:52.124Z: error: function pgp_sym_encrypt(integer, unknown) does not exist
    at parseErrorMessage (...\node_modules\pg-protocol\dist\parser.js:306:11)
    ...
```
```
backend alive after malformed request: health=200
```

The guard logged it with timestamp and full stack, and **the process survived** -- before this change, that single malformed request would have killed the backend, the SCADA consumer, and every operator's session.

**Lesser finding, reported rather than glossed over:** the offending request itself returned `http_status=000` -- no response at all; the client hangs until it times out. The crash guard keeps the *server* alive but does not make the *failed request* return a proper error, because `api.post('/complaints')` has no try/catch and Express never learns the promise rejected. This is strictly better than before (one hung request instead of a total outage) but it is not the finished state: an Express error-handling middleware, or an async-handler wrapper that forwards rejections to `next(err)`, should be added so these return a clean `500` instead of hanging.

> **Update (2026-09-23, same day):** fixed. Every route registered on `api` (not just `/complaints` -- the same no-try/catch pattern was present on all of them) is now auto-wrapped so a rejected handler promise is forwarded to `next(err)`, plus a global Express error-handling middleware in `backend/src/index.js` as a last-resort safety net that returns a clean JSON `500` instead of leaving the connection open. See **"Fix verification -- hung-request fix (complaints route error handling)"** below for the before/after evidence. This closed the gap flagged just above ("This is not fixed here") -- it is fixed here.

## Fix verification -- hung-request fix (complaints route error handling)

Fix date: 2026-09-23 (same day as the finding above).

Re-ran the exact same deliberately malformed request from the crash-guard verification above (`phone` sent as a number instead of a string), this time against the real `POST /api/complaints` route with the fix applied, to confirm it now returns a real HTTP status instead of hanging to `http_status=000`:

```
http_status=500 time=0.037194
{"error":"internal server error"}
```

Server log for that request shows the same underlying error class as before (proving this is a genuine fix of the same failure mode, not a different, easier bug):

```
[unhandled route error] error: function pgp_sym_encrypt(bigint, unknown) does not exist
    at parseErrorMessage (...\node_modules\pg-protocol\dist\parser.js:306:11)
    ...
```

`/api/health` immediately after:

```
health status=200
```

The request now returns promptly with a clean JSON error instead of hanging until client timeout, and the backend keeps serving other requests normally, same as the crash-guard verification above.

## Honest scope of this verification

- Both channels achieved lower complaint throughput than the 200/s target (136/s after, 126/s before) -- but for opposite reasons. Before, the ceiling was how fast connections could be refused; after, it's how fast genuinely-completed requests can be issued by the single-threaded test client at ~10-18ms each. The "after" number represents real work done; the "before" number represented none.
- This proves the crash is gone under *this* load shape for 8 seconds on one developer machine. It does not prove behaviour over a long soak, at higher complaint rates, or with multiple backend replicas sharing one Postgres -- the sequence fix is inherently safe across replicas (that is the point of `nextval()`), but that has not been measured here.
- Finding #2 (SCADA substation code vs. complaint substation name) is **unchanged and still open** by design -- nothing in this fix touches it.
