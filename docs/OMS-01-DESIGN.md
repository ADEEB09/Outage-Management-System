# OMS-01 Outage Scheduling — Design (Phase 1)

Status: **draft for review**. No code has been written for OMS-01. This document
is the contract Phases 2–6 implement; anything not written here is out of scope
until it is added here.

Planned outage = supply switched off on purpose so a crew can work. OMS-01
covers four things, in this order of importance:

1. Work permits (UPCL Line Clear / Permit to Work): request → issue → **return**.
2. Switching plans: an ordered isolate / restore sequence, enforced server-side.
3. Status tracking from scheduling through work-order closure.
4. Advance notification of affected customers.

---

## 1. What exists today (findings)

These shape the design. Items marked **⚠** are existing problems the design
has to work around; they are not fixed by OMS-01 unless the reviewer says so.

| Area | Finding |
|---|---|
| `domain/lifecycle.js` | 8 states. `scheduled → open \| cancelled` only. `canTransition` is enforced in exactly one place: `PATCH /incidents/:id/status`. |
| ⚠ Lifecycle bypass | `POST /incidents/:id/assign` sets `dispatched`, and `PATCH /mobile/jobs/:id/status` sets `in_progress` / `pending` by calling `repo.updateIncident` directly, without `lifecycle.js`. The rule "transitions only through lifecycle.js" is already broken for fault jobs. OMS-01 will route **its own** transitions through lifecycle.js and leave the fault path as it is (changing it would risk regressing fault jobs). |
| ⚠ Creating a "Scheduled" incident today | `POST /incidents` with `type: 'Scheduled'` creates status **`open`** (not `scheduled`), starts an SLA clock, and the notifier emails *"We have detected a power outage… crews are responding"*. Only the seed data has a real `scheduled` row (INC-2026-000007). |
| `domain/indices.js` | Already excludes `type === 'Scheduled'` from interrupting incidents in the reliability indices. OMS-01 keeps `type: 'Scheduled'` so this keeps working. |
| `domain/sectionalize.js` | `traceSection(cimMrid)` does a BFS over `network.terminals`/`connectivity_nodes` and returns `sectionEquipment` + `boundarySwitches` (switch classes stop the walk). Its own caveats: switch open/closed state is **unknown** (`normalOpen` unpopulated in every source file), and there is no source/load orientation, so it cannot say which side of a boundary switch is the supply side. |
| ⚠ `network.*` schema | Created by `db/migrations/network_topology_schema.sql` + `infra/importCimNetwork.js`, applied **separately** from `migrate()`. It does not exist in the local dev database (verified 2026-10-07). Nothing links an incident to a CIM mRID today (incidents carry `zone`/`feeder`/`substation` text only). |
| `domain/topology.js` | Read-only GeoJSON export of `network.*`. Not needed by OMS-01 except for map display later. |
| `infra/db.js` | Style: `CREATE TABLE IF NOT EXISTS`, `TEXT` primary keys with prefixes (`JU…`, `EV…`), `TIMESTAMPTZ`, later columns added via `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. `migrate()` does **not** run `db/migrations/*.sql`. |
| `infra/repo.js` | All SQL; `setClause` dynamic updates; ids from `nanoid(8)` or sequences (`nextIncidentId`). No existing function uses a transaction (`db.tx`) — OMS-01 needs them. |
| ⚠ Audit identity | `actor = req.header('x-user') \|\| 'operator'`: the actor name is whatever the client sends, not the authenticated user. `requireAuth` already puts the verified `username`, `roles`, `crewId` on `req.user`. |
| ⚠ Audit immutability | `db/migrations/audit_log_immutable.sql` (UPDATE/DELETE trigger) exists but is a manual migration and is **not applied** in the local dev DB. `audit_log` columns are just `actor, action, target` text. |
| ⚠ `/mobile/jobs/:id/*` authorization | Only the `/mobile/crews/:id/*` routes check ownership (`ownsCrew`). Job routes accept any authenticated user for any job. Crew tokens do carry a verified `crew_id` claim and the `field_crew` role. |
| `realtime/notifier.js` | Subscribes to `INCIDENT_CREATED` / `INCIDENT_UPDATED` (resolved) / `ERT_CHANGED`. Sends every message to **one** address (`NOTIFY_TEST_TO`); SMS is console-only; records each attempt in `notifications`; honours `opt_outs`. |
| ⚠ Customer data | There is no customer table and no customer → feeder / transformer mapping (only `incidents.customers`, a count). "Notify affected customers" cannot target real customers until consumer-indexing data exists. |
| `realtime/staleLocation.js` | Example of a restart-safe periodic monitor (60 s check against the DB). Same pattern fits the advance-notice scheduler. |
| Crew app `NEXT_STATUS` | `Pending Acceptance → Acknowledged → En Route → On Site → Work Started → Work Finished` (`src/NativeApp.jsx:66`; server maps `Work Finished` → `Work Complete`). |
| Crew app `requestAdvance` | `src/NativeApp.jsx:1126` (line numbers have drifted from the brief). Gates: `On Site` → `SafetyChecklist`, `Work Started` → diagnosis → parts → sign-off. All transitions also require the `PriorityChecklist`. |
| Crew app transport | All calls go through `req()` in `src/lib/api.js` (it now attaches `err.status`). The app has no socket connection; it polls. |
| Crew app `offlineQueue.js` | See §8. The race described in the brief has been **narrowed but not eliminated** by uncommitted work from 2026-10-07. OMS-01 does not use this queue either way. |
| `src/lib/locationQueue.js` | Uses **expo-sqlite** with transactions and client-generated ids acknowledged by the server — the right model for switching confirmations (§7.4). |
| `mobile-native-fixed/` | Stale duplicate. Not touched. |
| ⚠ `realtime/restoration.js` (found in Phase 2) | On every `INCIDENT_UPDATED` → `resolved` it sends the DMS a **switch CLOSE** command, unless `restored_by === 'SCADA'`. For a planned outage the restore is done by the switching plan, so an automatic CLOSE would be wrong. Phase 2 sets `restored_by: 'SWITCHING_PLAN'`; **Phase 3 adds the skip** (same shape as the SCADA one) before any route publishes a planned `resolved`. |
| ⚠ SCADA trips during planned work (found in Phase 2) | Opening a substation breaker as an isolate step will look to `realtime/scada.js` like a trip: it would raise a fault incident or merge into a nearby active one, and a later CLOSE could "SCADA-restore" it. `canScadaRestore` includes `in_progress`. Phase 3 must keep SCADA away from planned incidents (no merge, no SCADA restore) and decide how a trip on a device in an active isolate step is shown (Q8). |
| ⚠ `PATCH /mobile/jobs/:id/status` | Sets the incident to `in_progress` on "On Site" and `pending` on "Work Complete". For a planned outage that would corrupt its state. Phase 3: for planned jobs, update the job only; the incident moves only via the plan/permits. |
| `db/reset-demo.sql` | Deletes every job and bulk-closes incidents by direct UPDATE. Hence `work_permits.job_id` has no FK, and `safety_log` blocks TRUNCATE. |

---

## 2. Domain model

A planned outage **is an incident** (`type: 'Scheduled'`) so it appears in the
existing incident list, map, reliability exclusion and notifier, plus four new
tables. Crew work on it is an ordinary **job** (`jobs` row), so the crew app's
job list, navigation, photos and QR scans work unchanged.

```
incidents (type 'Scheduled')  1──1  planned_outages
                                         │1
                         ┌───────────────┼──────────────────┐
                         │*              │1                 │*
                   work_permits    switching_plans      jobs (existing)
                         │               │1
                         │               │*
                         │         switching_steps
                         └──────┬────────┘
                                │ every transition
                           safety_log (append-only)
```

### 2.1 Tables (Phase 2; added to `migrate()` in the existing style)

**`planned_outages`**

| column | type | notes |
|---|---|---|
| id | TEXT PK | `PO` + nanoid |
| incident_id | TEXT UNIQUE NOT NULL → incidents | |
| window_start, window_end | TIMESTAMPTZ NOT NULL | planned supply-off window |
| work_description | TEXT NOT NULL | |
| work_mrid | TEXT | CIM mRID of the equipment being worked on (input to the trace); nullable when the network schema is unavailable |
| notice_lead_minutes | INTEGER NOT NULL DEFAULT 1440 | see §6 |
| notice_due_at, notice_sent_at | TIMESTAMPTZ | |
| created_by, created_at | TEXT, TIMESTAMPTZ | from `req.user` |

**`switching_plans`** — one per planned outage.

| column | type | notes |
|---|---|---|
| id | TEXT PK | `SP` + nanoid |
| planned_outage_id | TEXT UNIQUE NOT NULL | |
| state | TEXT NOT NULL | `draft → approved` (§3.3). Editing only in `draft`. |
| source | TEXT | `trace` or `manual` |
| trace_caveat | TEXT | copied from `traceSection().caveat` so the operator sees it at approval |
| approved_by, approved_at | | |

**`switching_steps`**

| column | type | notes |
|---|---|---|
| id | TEXT PK | `SS` + nanoid |
| plan_id | TEXT NOT NULL → switching_plans | |
| phase | TEXT NOT NULL | `isolate` \| `restore` |
| seq | INTEGER NOT NULL | 1..n within phase; UNIQUE (plan_id, phase, seq) |
| action | TEXT NOT NULL | `open`, `close`, `rack_out`, `rack_in`, `test_dead`, `earth_apply`, `earth_remove`, `tag_apply`, `tag_remove` |
| device_mrid | TEXT | nullable (earths and tags often have none) |
| device_label, location | TEXT NOT NULL | what a human reads |
| assignee | TEXT NOT NULL | `control_room` \| `crew` |
| assignee_crew_id | TEXT | required when assignee = crew |
| state | TEXT NOT NULL DEFAULT 'pending' | `pending` \| `confirmed` (no other states server-side) |
| confirmed_by | TEXT | verified username |
| performed_at | TIMESTAMPTZ | when it was physically done (client time, clock-corrected via `sentAt` like existing `clientTime()`) |
| received_at | TIMESTAMPTZ | server time the confirmation arrived |
| client_confirmation_id | TEXT UNIQUE | idempotency key from the device / browser |
| on_behalf_note | TEXT | set when the control room records a crew step reported by phone/radio (§3.2, open question Q2) |

**`work_permits`**

| column | type | notes |
|---|---|---|
| id | TEXT PK | `PTW` + nanoid |
| permit_no | TEXT UNIQUE NOT NULL | human number, e.g. `PTW-2026-000123` from a sequence (same approach as `nextIncidentId`) |
| planned_outage_id | TEXT NOT NULL | |
| job_id, crew_id | TEXT NOT NULL | the holder |
| state | TEXT NOT NULL | `requested` → `issued` → `returned`; `requested` → `refused`/`withdrawn` |
| requested_by/_at, issued_by/_at, returned_by/_at, closed_by/_at | | each transition's who + when |
| isolation_points, earthing_points | TEXT | written by the issuer; shown to the crew on the permit |
| return_declaration | JSONB | `{ menWithdrawn, earthsRemoved, toolsClear, remarks }` — all three booleans must be true to return |
| refusal_reason | TEXT | |

Partial unique index: at most one permit in `requested` or `issued` per job.

**`safety_log`** — the safety document. Append-only.

| column | type | notes |
|---|---|---|
| id | TEXT PK | `SL` + nanoid |
| ts | TIMESTAMPTZ NOT NULL | server time written |
| occurred_at | TIMESTAMPTZ | when it physically happened, if different (offline confirmations) |
| actor | TEXT NOT NULL | **verified** username from `req.user`, never `x-user` |
| actor_role | TEXT NOT NULL | `oms_operator`, `system_admin`, `field_crew` |
| actor_crew_id | TEXT | |
| planned_outage_id | TEXT NOT NULL | |
| entity, entity_id | TEXT NOT NULL | `permit` / `step` / `plan` / `outage` |
| action | TEXT NOT NULL | e.g. `permit.issue`, `step.confirm`, `step.reject` |
| from_state, to_state | TEXT | |
| details | JSONB | step snapshot, declaration, rejection code, client id |

- Written **in the same transaction** as the state change it records (repo
  function does both in `db.tx`); a state change without its log row cannot
  commit.
- **Rejected attempts are logged too** (`step.reject` with the error code). For
  a safety record, a crew trying to confirm out of order is as important as
  a success.
- Immutability: an UPDATE/DELETE-raising trigger created in `migrate()` (same
  body as `audit_log_immutable.sql`), so it exists in every environment,
  not only where someone ran the manual migration.
- Why not `audit_log`: it has no structure for from/to state or details, its
  actor is client-supplied, and its immutability trigger isn't reliably
  applied. One line still goes to `audit_log` per transition, so the existing
  Admin audit view keeps showing activity.

### 2.2 Repo functions (Phase 2, `repo.js` only)

`createPlannedOutage`, `plannedOutage(id)` (joined view incl. plan, steps,
permits), `plannedOutageForJob(jobId)`, `replaceDraftSteps(planId, steps)`,
`approvePlan`, `confirmStep({ stepId, actor, performedAt, clientConfirmationId, onBehalfNote })`,
`requestPermit`, `issuePermit`, `refusePermit`, `withdrawPermit`, `returnPermit`,
`safetyLog(plannedOutageId)`, `dueNotices(now)`, `markNoticeSent`.

Every state-changing function: `db.tx` → `SELECT … FROM switching_plans WHERE id=$1 FOR UPDATE`
(serialises all changes to one outage) → validate → write → `safety_log` →
commit. Validation lives in a pure module `domain/plannedOutage.js` (no SQL,
unit-testable) that the repo function calls inside the transaction with the
locked rows. That keeps "SQL only in repo.js" and keeps the rules testable
without a database.

---

## 3. State machines

### 3.1 Incident lifecycle (lifecycle.js extension)

Fault incidents keep `TRANSITIONS` **byte-for-byte unchanged**. Planned
outages get a separate table, selected by type:

As built in Phase 2, the table is chosen by whether the incident has a
`planned_outages` row (`canTransition(from, to, planned)`), not by
`type === 'Scheduled'`: older 'Scheduled' incidents created as `open` stay on
the fault table.

```js
export const PLANNED_TRANSITIONS = {
  scheduled:  ['notified', 'cancelled'],
  notified:   ['isolating', 'scheduled', 'cancelled'], // back to scheduled = rescheduled, re-notify
  isolating:  ['in_progress', 'restoring'],            // restoring here = abort before work
  in_progress:['restoring'],
  restoring:  ['resolved'],
  resolved:   ['closed'],
  closed: [], cancelled: [],
};
export function transitionsFor(incident) { … }  // Scheduled → PLANNED_TRANSITIONS, else TRANSITIONS
export function canTransition(from, to, type) { … } // type optional → existing callers unchanged
```

Two new labels: `notified` "Customers notified", `isolating` "Isolating",
`restoring` "Restoring". (`in_progress`, `resolved`, `closed`, `cancelled`
reuse existing labels.)

Guards (checked server-side in `domain/plannedOutage.js`, on top of the table):

| transition | guard |
|---|---|
| scheduled → notified | plan `approved`; notice sent (or explicitly skipped by operator with reason, logged) |
| notified → isolating | first isolate step confirmed (automatic) |
| isolating → in_progress | all isolate steps confirmed **and** a permit `issued` (automatic on issue) |
| in_progress → restoring | no permit in `requested`/`issued` (automatic on last return) |
| isolating → restoring | no permit `issued` (abort path) |
| restoring → resolved | all restore steps confirmed (automatic) |
| any → cancelled | only from `scheduled`/`notified`: **no step confirmed yet**. After the first isolate step, the only way out is restoring. |

Most transitions are **driven by permit/step events**, not by a manual status
button. `PATCH /incidents/:id/status` rejects manual moves into
`isolating`/`in_progress`/`restoring`/`resolved` for planned outages (409
`USE_SWITCHING_PLAN`). Manual: `scheduled → notified` (send notice),
`notified → scheduled` (reschedule), cancel, `resolved → closed`.

`resolved` publishes `INCIDENT_UPDATED`, so the existing notifier "power
restored" message is reused as the restoration notice.

### 3.2 Switching step rules (server-enforced)

A confirmation for step S is rejected (409, logged as `step.reject`) when:

| code | rule |
|---|---|
| `PLAN_NOT_APPROVED` | plan is not `approved` |
| `PREDECESSOR_UNCONFIRMED` | any step in the same phase with lower `seq` is not `confirmed` |
| `ISOLATION_INCOMPLETE` | S is a `restore` step and any `isolate` step is unconfirmed |
| `PERMIT_OUTSTANDING` | S is a `restore` step and any permit for the outage is `requested` or `issued` |
| `WRONG_ASSIGNEE` | crew confirming a `control_room` step; a crew other than `assignee_crew_id`; an operator confirming a crew step without `on_behalf_note` (Q2) |
| `ALREADY_CONFIRMED` | S confirmed with a **different** `client_confirmation_id` |
| `NOT_YOUR_JOB` | crew token's `crew_id` ≠ the job's crew |

Same `client_confirmation_id` again → `200` with the existing record (idempotent
replay; this is what makes offline retry safe).

Strictly sequential within a phase. Parallel steps (two crews at two ends) are
deliberately **not** supported in v1 (Q3).

### 3.3 Plan

`draft → approved`. Steps editable only in `draft`. No un-approve once any
step is confirmed; before that, an operator may return it to `draft` (logged).

### 3.4 Permit

```
requested ──issue──▶ issued ──return──▶ returned
    │
    ├─refuse (control room, reason)──▶ refused
    └─withdraw (crew)────────────────▶ withdrawn
```

| transition | who | guard |
|---|---|---|
| request | crew holding the job | outage `isolating`; no other open permit on the job; crew's own isolate steps confirmed (server state) |
| issue | `oms_operator` | **all** isolate steps confirmed; writes isolation + earthing points |
| refuse / withdraw | operator / crew | only from `requested` |
| return | crew holding the permit | from `issued`; declaration all true |

There is no `cancel` from `issued`: an issued permit can only end by being
**returned**. If a crew cannot return it (lost phone, injury), the control
room records the return on the crew's behalf with a mandatory note — the
same `on_behalf` mechanism as steps, and logged as such (Q2).

All permit transitions are **online-only** (§7.3).

---

## 4. Switching plan draft from `sectionalize.js`

New pure module `domain/switchingPlan.js` — **no graph walking of its own**:

```
draftFromTrace(traceResult, { crewId }) → steps[]
```

1. Route `POST /planned-outages/:id/switching-plan/draft { workMrid }` calls
   the existing `traceSection(workMrid)` and passes its result in.
2. Isolate phase: for each `boundarySwitches` entry, an `open` step; then
   `test_dead`, `earth_apply` (both `crew`, device_label "Work site — <name>").
3. Default assignee by CIM class: `Breaker`, `Recloser` → `control_room`;
   `LoadBreakSwitch`, `Disconnector`, `Switch`, `Fuse`, `Jumper`,
   `ProtectedSwitch` → `crew`. The operator can change any step.
4. Restore phase: `earth_remove`, then the isolate switch steps reversed with
   `close`.
5. The draft is saved with `state: 'draft'`, `source: 'trace'` and the trace's
   `caveat`.

What this does **not** claim, and the UI must say so at approval: the trace
doesn't know switch states or which side is the supply side, so it can't say
which boundary switches actually need opening, in what electrical order, or
where earths go. The draft is a starting list of the right devices, not a
verified plan. **Order and content are the approving operator's
responsibility**, which is why approval is a logged, named act.

If the network schema isn't loaded or `workMrid` isn't found (today's dev DB),
the endpoint returns 404 from the trace and the operator builds the plan
manually (`source: 'manual'`). Everything else works the same.

---

## 5. API

Conventions kept: Express router in `routes/api.js`, `requireRole(...)` for
control-room writes, `/mobile/*` for the crew app, events on the bus →
socket.io. New: identity for every OMS-01 write comes from `req.user` (helper
`verifiedActor(req)`), never the `x-user` header.

### 5.1 Control room (`requireRole('oms_operator', 'system_admin')` on writes)

| method & path | purpose |
|---|---|
| `POST /planned-outages` | create incident (`type 'Scheduled'`, status `scheduled`, no SLA clock) + `planned_outages` + empty draft plan. Does **not** publish `INCIDENT_CREATED` with fault wording (§6). |
| `GET /planned-outages` | list with plan/permit summary |
| `GET /planned-outages/:id` | incident + plan + steps + permits + jobs |
| `GET /planned-outages/:id/safety-log` | full log |
| `PATCH /planned-outages/:id` | window/description; only `scheduled`/`notified` (moving the window in `notified` → back to `scheduled`, re-notify) |
| `POST /planned-outages/:id/switching-plan/draft` | `{ workMrid }` → trace-based draft (§4) |
| `PUT /planned-outages/:id/switching-plan/steps` | replace all steps; `draft` only |
| `POST /planned-outages/:id/switching-plan/approve` / `/unapprove` | §3.3 |
| `POST /planned-outages/:id/notify` | send notice now (→ `notified`) or `{ skip: true, reason }` |
| `POST /planned-outages/:id/cancel` | §3.1 guard |
| `POST /switching-steps/:id/confirm` | control-room steps, or crew steps with `onBehalfNote` |
| `POST /permits/:id/issue` | `{ isolationPoints, earthingPoints }` |
| `POST /permits/:id/refuse` | `{ reason }` |
| `POST /permits/:id/return-on-behalf` | `{ declaration, note }` |
| `POST /incidents/:id/assign` | existing; for planned outages it creates the job the same way |

### 5.2 Crew app (`/mobile/*`, `requireRole('field_crew')` + job ownership from the token's `crew_id`)

| method & path | body | returns |
|---|---|---|
| `GET /mobile/jobs/:id/planned-outage` | — | `{ outage, plan, steps[], permit, serverTime }`; each step has `actionable` computed by the server (crew's step, predecessor confirmed, phase allowed) |
| `POST /mobile/jobs/:id/permit/request` | `{ clientRequestId }` | permit |
| `POST /mobile/permits/:id/withdraw` | `{ clientRequestId }` | permit |
| `POST /mobile/permits/:id/return` | `{ clientRequestId, declaration }` | permit |
| `POST /mobile/switching-steps/:id/confirm` | `{ clientConfirmationId, performedAt, sentAt, lat, lon }` | step |

Errors: `409 { code, message }` with the codes in §3.2/§3.4; `403 NOT_YOUR_JOB`.
All permit and step endpoints are idempotent on their client id.

Status gate on the existing route (planned jobs only): `PATCH
/mobile/jobs/:id/status` returns `409 PERMIT_NOT_ISSUED` for `Work Started` and
`409 PERMIT_NOT_RETURNED` for `Work Complete` when the job belongs to a planned
outage. Fault jobs: no change.

### 5.3 Events (bus → socket.io)

`planned.outage.updated` (outage + plan summary), `permit.changed`,
`switching.step.confirmed`, `switching.step.rejected`. Added to `TOPICS`, so
the Kafka driver creates them automatically.

---

## 6. Advance notification (notifier.js reuse)

- New topic `planned.outage.notice`; notifier subscribes and sends with
  planned-outage wording ("Planned shutdown in <zone> on <date> from <start>
  to <end> for <work>. Ref …") through the existing `sendEmail`/`sendSms`,
  which already record to `notifications` and honour opt-outs.
- One guard added to the existing `INCIDENT_CREATED` handler: skip
  `type === 'Scheduled'` (today it sends the fault "outage detected" text).
  Fault incidents are unaffected.
- Restoration notice: the existing `INCIDENT_UPDATED` → `resolved` handler,
  unchanged.
- Scheduling: `realtime/plannedNotices.js`, same pattern as
  `staleLocation.js` — every 60 s, `repo.dueNotices(now)` →
  publish → `markNoticeSent`. Restart-safe because the due/sent state is in the
  DB, not in a timer.
- **Limitation:** recipients are still the single `NOTIFY_TEST_TO` address.
  Real targeting needs customer ↔ feeder/DT data that doesn't exist (Q1).
  The notice records the affected-customer **count** from the incident.

---

## 7. Crew-app contract

### 7.1 Detection

`normalizeOmsJob` adds `planned: job.incident?.type === 'Scheduled'` and
`plannedOutageId`. Everything below applies only when `planned` is true;
for fault jobs no new code path runs.

### 7.2 Gates in `requestAdvance` (no parallel flow)

Planned checks run **before** the existing gates, in the same function:

| advancing to | planned-outage gate (server state, fetched live) | then existing gate |
|---|---|---|
| `On Site` | — | SafetyChecklist (unchanged) |
| `Work Started` | **G1** crew's isolate steps all server-confirmed; **G2** permit `issued`. Otherwise open the permit panel: "Request permit" / "Waiting for control room" | — |
| `Work Finished` | **G3** permit `returned` (server-acknowledged). Otherwise open the return form | diagnosis → parts → sign-off (unchanged) |

Gate checks call `GET /mobile/jobs/:id/planned-outage`. Offline → the gate
stays closed with "Needs connection — permit status must come from the
control room". Planned-job status changes through gated transitions are
**sent online only**: if the PATCH fails they are not put in Pending Sync
(where a 409 would sit forever); the crew retries when connected. Ungated
planned transitions (Accept, En Route, On Site) use the normal queue.

### 7.3 Permit — online only

Request, withdraw and return are a handshake with the control room; the app
never records them locally. UI states: `none` → "Request permit" button,
`requested` → "Waiting for control room…" (poll every 10 s while visible),
`issued` → permit card (number, isolation & earthing points, issuer, time),
`returned` → read-only. Network error → "Not sent — no connection. The
control room has NOT received this." and the button stays.

### 7.4 Switching steps — ordered list, per-step confirm

Every step is shown in order, both phases, both assignees:

| UI state | look | meaning | unlocks next? |
|---|---|---|---|
| Control-room step | grey, no button | context only | — |
| Pending | outline | not yet reachable | no |
| Next (actionable) | primary button "Confirm done" + device/location | server says actionable | — |
| **UNSYNCED** | **amber/red striped, "NOT SENT — control room does not know"**, no tick, never green | recorded on the phone, no server ack | **no** |
| Rejected | red, server message, "Call control room" | 409 from server | no |
| Confirmed | green tick, who + time | server acknowledged | yes |

Confirm → confirmation dialog naming the device and action → send. With no
connection, the confirmation is written to a **separate** on-device store,
`src/lib/safetyStore.js` (expo-sqlite, like `locationQueue.js`):

```
pending_confirmations(client_confirmation_id PK, step_id, performed_at,
                      lat, lon, created_at, attempts, last_error, last_code)
```

- Insert is one SQLite transaction; nothing is lost if the app is killed.
- Sender sends **one at a time in step order**, through `src/lib/api.js`
  (`confirmSwitchingStep`). Deleted only on a 2xx (incl. idempotent replay).
- 409 → kept, shown as **Rejected** with the code; never retried
  automatically, never silently dropped. The crew must phone the control room.
- The next step stays locked until the server acknowledges. The app shows a
  banner while anything in this store is unsent.
- Does not touch `offlineQueue.js`; fault jobs use exactly the code they use
  today.

---

## 8. `offlineQueue.js` and the race

The brief's description (read → await network → write back, losing items
queued in between) matches the committed version. The **uncommitted** 2026-10-07
version re-reads the queue after flushing and appends items added meanwhile,
and serialises flushes. Two windows remain:

1. a `push()` landing between the flush's final read and its write;
2. two concurrent `push()` calls (both read-modify-write AsyncStorage).

Both are unlikely but possible. OMS-01 is designed so this doesn't matter:
permits never go through any queue, switching confirmations use
`safetyStore.js` (SQLite transactions, server ack per id), and gated planned
status changes are online-only. Fixing the queue itself (moving it to SQLite)
is recommended but **out of scope** — it changes fault-job behaviour, which
this work must not do.

---

## 9. Control room UI (Phase 4, outline)

- **Incidents** drawer: for `type 'Scheduled'`, a "Planned outage" panel:
  window, notice status, plan (two phase lists with assignee badges and
  per-step confirm for control-room steps), permits (issue / refuse with the
  isolation & earthing form), safety log tab. Manual status buttons for
  driven states are hidden.
- **New planned outage** form (replaces "Scheduled" in the generic new-incident
  type list, which today creates an `open` incident).
- **Dispatch**: planned outages in their own section by window start;
  assignment uses the existing assign route.
- Live updates via the new socket topics; a red toast for `switching.step.rejected`.

---

## 10. Tests (Phase 6)

In `selftest.js` style, against a **disposable** database (selftest writes to
whatever `DATABASE_URL` points at):

- Pure (`domain/plannedOutage.js`, `domain/switchingPlan.js`): every
  transition in §3, every rejection code, draft-from-trace on a fixture trace
  result.
- API: out-of-order confirm → 409 `PREDECESSOR_UNCONFIRMED` + `step.reject`
  logged; restore step while permit `issued` → 409 `PERMIT_OUTSTANDING`;
  permit issue before isolation complete → 409; full happy path → incident
  ends `resolved` and the safety log has one row per transition with verified
  actors; idempotent replay of the same `clientConfirmationId` → 200, one row;
  crew A confirming crew B's step → 403/409; `x-user` header ignored.
- Concurrency: two simultaneous confirms of steps 1 and 2 → step 2 rejected or
  ordered, never both accepted out of order (row lock).
- Safety log immutability: UPDATE/DELETE raise.
- Crew app (logic-level tests on `safetyStore.js` with a fake api): unsynced
  never unlocks, 409 kept not dropped, order preserved after app restart.
- **Fault-job regression:** the existing selftest suite passes unchanged;
  `TRANSITIONS` unchanged; `PATCH /mobile/jobs/:id/status` for a fault job
  behaves exactly as before for every status; notifier still sends the
  fault-created message for non-Scheduled incidents.

---

## 11. Open questions for the repo owner

1. **Notice audience and lead time.** No customer ↔ network data exists. OK to
   ship with the single test recipient + customer count? Required UPCL lead
   time (default 24 h here)?
2. **On-behalf records.** May the control room confirm a crew step or return a
   permit reported by phone/radio (logged with a note)? Field practice usually
   needs this; it weakens the "crew confirms crew steps" rule.
3. **One crew/permit per outage in v1?** Multi-crew outages need parallel steps
   and several simultaneous permits; the schema allows several permits, the
   step rules assume one sequence.
4. **Earthing.** Earths aren't in the CIM data, so they're free-text steps
   added by the operator. Acceptable for v1?
5. **Fix the existing lifecycle bypass / `x-user` actor / missing job
   ownership checks for fault jobs?** Recommended, but each touches fault
   behaviour, so separate PRs.
6. **Network schema in dev/CI.** Should `migrate()` apply
   `network_topology_schema.sql` (empty tables are enough for the manual-plan
   path and for tests with fixtures)?
7. **Permit number format** — confirm `PTW-YYYY-NNNNNN` or UPCL's own.
8. **SCADA events on planned isolation devices.** When a breaker in an active
   isolate step reports open, show it as "expected (planned)" on the outage,
   or suppress it? It must not create or merge into a fault incident either way.

---

## 12. Delivery

- Branch `feature/oms-01-outage-scheduling` off `master`; one PR per phase.
- The working tree currently holds uncommitted crew-app work from 2026-10-07
  (tracking alerts, Pending Sync changes, test-jobs script). It should be
  committed on its own branch first, so OMS-01 diffs contain only OMS-01.
- `mobile-native-fixed/` is not touched.
