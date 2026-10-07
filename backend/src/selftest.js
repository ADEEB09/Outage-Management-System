// Boots the real Express app in-process (supertest-free), exercises the API
// against the real SQLite DB, prints results, and exits. Run: node src/selftest.js
import 'dotenv/config'; // loads .env into process.env
process.env.PORT = process.env.PORT || '4100'; // so the restoration publisher's mock-DMS URL matches this test server
import express from 'express';
import { migrate } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { initBus } from './domain/bus.js';
import { connectRedis, isRedisConnected } from './infra/redis.js';
import { handleScadaEvent, startScadaConsumer, _resetDedupState } from './realtime/scada.js';
import { publishRestoration, _resetPublishedState } from './realtime/restoration.js';
import { Dnp3Master, Dnp3TestOutstation, _internal as dnp3Internal } from './realtime/dnp3.js';
import { computeIndices, customersServed } from './domain/indices.js';
import { feederAllocations, substationForFeeder } from './domain/prediction.js';
import { sendRestorationCallbacks } from './realtime/notifier.js';

// Complaint phones are encrypted with ENCRYPTION_KEY (pgcrypto). CI doesn't set
// one; a throwaway key keeps the callback test's complaint contact readable.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';

await migrate();
await seed({ force: true });
await connectRedis();
await initBus();
startScadaConsumer(); // subscribes to scada.alarm.raised — needed for the DNP3 adapter's bus-integration test below

const app = express();
app.use(express.json());
// The real app authenticates via Keycloak (see routes/auth.js's requireAuth/
// requireRole, wired in index.js). This test harness builds its own bare
// app and doesn't run a real Keycloak server, so it injects a trusted
// system_admin identity directly — the same shape requireAuth would attach
// to req.user after a real token verifies, letting the role-gated routes
// (assign, status, audit) be exercised without standing up Keycloak.
app.use((req, res, next) => { req.user = { username: 'test-harness', roles: ['system_admin', 'oms_operator'] }; next(); });
app.use('/api', api);

const server = app.listen(4100, async () => {
  const base = 'http://127.0.0.1:4100/api';
  const j = async (m, p, b) => {
    const r = await fetch(base + p, {
      method: m, headers: { 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const results = [];
  const check = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); };

  const inc = await j('GET', '/incidents');
  check('GET /incidents returns seeded rows', inc.body.length === 9, `(${inc.body.length})`);

  // ---- OMS-02 trouble calls: derived state per call (checked first, before the
  // lifecycle tests below move seeded incidents around) ----
  const seededCalls = (await j('GET', '/calls')).body;
  const stateOf = (id) => seededCalls.find((c) => c.id === id);
  const expectState = {
    'CALL-001': 'Assigned', 'CALL-002': 'Unassigned', 'CALL-003': 'Incident', 'CALL-004': 'Completed',
    'CALL-005': 'Assigned', 'CALL-006': 'Unassigned', 'CALL-007': 'Rejected', 'CALL-008': 'Closed',
    'CALL-009': 'Rejected', 'CALL-010': 'Incident', 'CALL-011': 'Assigned',
  };
  for (const [id, want] of Object.entries(expectState)) {
    check(`call ${id} derived state = ${want}`, stateOf(id)?.state === want, `(${stateOf(id)?.state})`);
  }
  check('resolved incident keeps its crew but call shows Completed (terminal before crew test)',
    stateOf('CALL-004')?.crew_id === 'C004' && stateOf('CALL-004')?.state === 'Completed');
  check('rejected call carries its reason', stateOf('CALL-007')?.state_reason === 'Duplicate of CALL-001 (same feeder fault)');
  check('cancelled incident shows call Rejected with reason', stateOf('CALL-009')?.state_reason === 'Incident cancelled (false alarm)');
  check('GET /calls row shape', ['id', 'customer', 'phone', 'address', 'category', 'status', 'linked_id', 'ts', 'area',
    'reject_reason', 'rejected_at', 'rejected_by', 'state', 'state_reason', 'incident_status', 'crew_id'].every((k) => k in seededCalls[0]));
  check('seed has Premium-VIP calls and every category', ['Normal', 'Critical', 'Premium-VIP', 'Medical'].every((c) => seededCalls.some((x) => x.category === c)));
  const scadaOutages = (await j('GET', '/incidents')).body.filter((i) => i.source === 'SCADA');
  check('seed has SCADA outages for the Outages tab', scadaOutages.length >= 4 && scadaOutages.every((i) => i.substation), `(${scadaOutages.length})`);

  const ind = await j('GET', '/indicators');
  check('indicators computed', ind.body.saidi > 0 && ind.body.caidi < 100,
    `saidi=${ind.body.saidi} saifi=${ind.body.saifi} caidi=${ind.body.caidi}`);

  const bad = await j('PATCH', '/incidents/INC-2026-000003/status', { status: 'closed' });
  check('state machine rejects open→closed', bad.status === 409, `(${bad.status})`);

  const good = await j('PATCH', '/incidents/INC-2026-000003/status', { status: 'dispatched' });
  check('state machine allows open→dispatched', good.body.status === 'dispatched');

  const created = await j('POST', '/incidents', { zone: 'Test Zone', severity: 'high', cause: 'Test', feeder: 'FDR-X' });
  check('manual incident create (FR-OMS-002)', created.status === 201 && /INC-2026-/.test(created.body.id), created.body.id);

  const asg = await j('POST', '/incidents/INC-2026-000006/assign', { crewId: 'C004', priority: 'Urgent' });
  check('dispatch assigns crew + creates job', asg.body.crew.status === 'in_transit' && !!asg.body.job);

  const jobId = asg.body.job.id;
  const mob = await j('PATCH', `/mobile/jobs/${jobId}/status`, { status: 'On Site', lat: 30.1, lon: 78.2 });
  check('mobile status update accepted', mob.body.status === 'On Site');
  const incAfter = await j('GET', '/incidents/INC-2026-000006');
  check('mobile On Site flips incident → in_progress', incAfter.body.status === 'in_progress', incAfter.body.status);

  const ack = await j('POST', '/alarms/ack-all');
  check('ack-all clears unacked alarms', ack.body.every(a => a.ack === 1));

  const tcs = await j('POST', '/calls/CALL-002/to-incident');
  check('trouble call → incident (FR-OMS-005)', tcs.status === 201);

  // ---- OMS-02 trouble calls: log, validate, reject, promote ----
  const areas = (await j('GET', '/calls/areas')).body;
  check('GET /calls/areas returns {value,label} from the real substation list',
    areas.length > 0 && areas.every((a) => a.value && a.label) && areas.some((a) => a.value === '33/11 kV BHOOPATWALA S/s' && a.label === 'BHOOPATWALA'), `(${areas.length})`);
  const AREA = '33/11 kV BHOOPATWALA S/s';
  const mk = (category, extra = {}) => j('POST', '/calls', { customer: 'Test Cust', phone: '9000000000', address: '1 Test Rd', category, area: AREA, ...extra });
  const made = {};
  for (const cat of ['Normal', 'Critical', 'Premium-VIP', 'Medical']) {
    made[cat] = await mk(cat);
    check(`POST /calls accepts category ${cat}`, made[cat].status === 201 && made[cat].body.category === cat && made[cat].body.area === AREA && made[cat].body.status === 'unassigned');
  }
  check('POST /calls rejects an unknown category (400)', (await mk('Urgent')).status === 400);
  check('POST /calls rejects a missing field (400)', (await j('POST', '/calls', { customer: 'x', phone: '1', category: 'Normal' })).status === 400);
  check('POST /calls rejects an unknown area (400)', (await mk('Normal', { area: 'Nowhere S/s' })).status === 400);
  const noArea = await mk('Normal', { area: undefined });
  check('POST /calls area is optional', noArea.status === 201 && noArea.body.area === null);

  const rj = (id, body) => j('POST', `/calls/${id}/reject`, body);
  check('reject needs a reason (400)', (await rj(made.Normal.body.id, {})).status === 400);
  check('reject reason too short (400)', (await rj(made.Normal.body.id, { reason: 'x' })).status === 400);
  check('reject reason too long (400)', (await rj(made.Normal.body.id, { reason: 'x'.repeat(501) })).status === 400);
  check('a call linked to an incident cannot be rejected (409)', (await rj('CALL-001', { reason: 'not valid' })).status === 409);
  check('reject unknown call (404)', (await rj('CALL-NOPE', { reason: 'not valid' })).status === 404);
  const rejected = await rj(made.Normal.body.id, { reason: 'Caller hung up, no fault' });
  check('reject sets status + reject_* columns', rejected.status === 200 && rejected.body.status === 'rejected'
    && rejected.body.reject_reason === 'Caller hung up, no fault' && !!rejected.body.rejected_at && !!rejected.body.rejected_by);
  check('rejecting twice is refused (409)', (await rj(made.Normal.body.id, { reason: 'again please' })).status === 409);
  const afterReject = (await j('GET', '/calls')).body.find((c) => c.id === made.Normal.body.id);
  check('rejected call is displayed as Rejected with its reason', afterReject.state === 'Rejected' && afterReject.state_reason === 'Caller hung up, no fault');

  const expectSev = { 'Premium-VIP': 'high', Critical: 'critical', Medical: 'critical' };
  for (const [cat, sev] of Object.entries(expectSev)) {
    const p = await j('POST', `/calls/${made[cat].body.id}/to-incident`);
    check(`promote ${cat} → severity ${sev}, area copied to incident.substation`, p.status === 201 && p.body.severity === sev && p.body.substation === AREA, `(${p.body.severity}, ${p.body.substation})`);
  }
  const pn = await j('POST', `/calls/${noArea.body.id}/to-incident`);
  check('promote Normal → severity medium; no area stays null', pn.status === 201 && pn.body.severity === 'medium' && pn.body.substation === null);
  const afterPromote = (await j('GET', '/calls')).body.find((c) => c.id === made.Medical.body.id);
  check('promoted call is displayed as Incident', afterPromote.state === 'Incident' && afterPromote.linked_id.startsWith('INC-'), afterPromote.state);

  // role guards: a second app instance whose user has none of the allowed roles
  const app2 = express();
  app2.use(express.json());
  app2.use((req, res, next) => { req.user = { username: 'crew-user', roles: ['field_crew_coordinator'] }; next(); });
  app2.use('/api', api);
  const server2 = app2.listen(4101);
  const j2 = async (m, p, b) => {
    const r = await fetch('http://127.0.0.1:4101/api' + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return r.status;
  };
  check('POST /calls is 403 without a permitted role', await j2('POST', '/calls', { customer: 'x', phone: '1', address: 'a', category: 'Normal' }) === 403);
  check('POST /calls/:id/reject is 403 without a permitted role', await j2('POST', '/calls/CALL-006/reject', { reason: 'not valid' }) === 403);
  check('POST /calls/:id/to-incident is 403 without a permitted role', await j2('POST', '/calls/CALL-006/to-incident') === 403);
  check('GET /calls stays readable without those roles', await j2('GET', '/calls') === 200);
  check('POST /scada/fault is 403 for a crew role (OMS-02)', await j2('POST', '/scada/fault', { tag: 'X.Y.CB1.TRIP' }) === 403);
  server2.close();
  const savedSimFlag = process.env.ENABLE_SCADA_SIMULATION;
  delete process.env.ENABLE_SCADA_SIMULATION;
  const simOff = await j('POST', '/scada/simulate', { tag: 'X.Y.CB1.TRIP', event: 'trip' });
  check('POST /scada/simulate is 403 without ENABLE_SCADA_SIMULATION, even for system_admin', simOff.status === 403 && /ENABLE_SCADA_SIMULATION/.test(simOff.body.error));
  if (savedSimFlag !== undefined) process.env.ENABLE_SCADA_SIMULATION = savedSimFlag;

  // Phase 1 tail — Redis read-through cache on /indicators
  const first = await j('GET', '/indicators');
  const second = await j('GET', '/indicators');
  check('indicators cache-hit returns consistent payload', JSON.stringify(first.body) === JSON.stringify(second.body));
  check(`redis connected (${isRedisConnected() ? 'live' : 'unavailable — degraded mode, cache no-ops'})`, true);

  // ---- Phase 2 — SCADA auto-detection, dedup, severity ----
  _resetDedupState();
  const beforeCount = (await j('GET', '/incidents')).body.length;

  // 1) A CRITICAL SCADA trip auto-creates an incident (FR-OMS-001)
  const r1 = await handleScadaEvent({ tag: 'DEHRA.FDR7.CB1.TRIP', condition: 'CRITICAL', limit_val: 'TRIP', customers: 1200 });
  const afterOne = (await j('GET', '/incidents')).body.length;
  check('SCADA CRITICAL auto-creates incident (FR-OMS-001)', !!r1 && r1.deduplicated === false && afterOne === beforeCount + 1, r1 && r1.incidentId);

  // 2) Severity escalates to critical for a high-customer trip (FR-OMS-004)
  const autoInc = (await j('GET', `/incidents/${r1.incidentId}`)).body;
  check('SCADA severity classified critical (FR-OMS-004)', autoInc.severity === 'critical' && autoInc.source === 'SCADA', autoInc.severity);
  check('a real customer count on the event wins over the estimate', autoInc.customers === 1200 && autoInc.prediction?.customers_source === 'event' && autoInc.prediction?.method === 'none',
    `${autoInc.customers}, ${autoInc.prediction?.customers_source}, ${autoInc.prediction?.method}`);

  // 3) A second fault on the same feeder within the window is deduplicated (FR-OMS-003)
  const r2 = await handleScadaEvent({ tag: 'DEHRA.FDR7.RELAY2.OC', condition: 'MAJOR', customers: 900 });
  const afterTwo = (await j('GET', '/incidents')).body.length;
  check('SCADA duplicate on same asset deduplicated (FR-OMS-003)', r2 && r2.deduplicated === true && afterTwo === afterOne, `same→${r2 && r2.incidentId}`);

  // 3b) A SCADA confirmation on a customer-reported-only incident should
  // upgrade its severity if SCADA classifies it higher, and log a real
  // "confirmed" event -- not treat it as just another duplicate report.
  _resetDedupState();
  const custInc = await repo.createIncident({
    id: await repo.nextIncidentId(), type: 'Power Outage', severity: 'medium', status: 'open',
    zone: 'TESTSUB', feeder: null, substation: 'TESTSUB', customers: 1, cause: 'No Supply',
    lat: null, lon: null, crew_id: null, opened_at: new Date().toISOString(),
    ert: null, sla_due_at: new Date(Date.now() + 180 * 60000).toISOString(), source: 'Customer',
  });
  const r3b = await handleScadaEvent({ tag: 'TESTSUB.FDR9.CB1.TRIP', condition: 'CRITICAL', customers: 1500 });
  const upgraded = await repo.incident(custInc.id);
  const events3b = await repo.incidentEvents(custInc.id);
  const hasConfirmedEvent = events3b.some((e) => e.kind === 'confirmed');
  check('SCADA confirmation upgrades a customer-reported incident\'s severity',
    r3b && r3b.deduplicated === true && upgraded.severity === 'critical' && hasConfirmedEvent,
    `${upgraded.severity}, confirmed event: ${hasConfirmedEvent}`);

  // 4) A MINOR alarm does NOT create an outage
  _resetDedupState();
  const before4 = (await j('GET', '/incidents')).body.length;
  const r4 = await handleScadaEvent({ tag: 'RK01.SE02.LOAD', condition: 'MINOR', customers: 50 });
  const after4 = (await j('GET', '/incidents')).body.length;
  check('SCADA MINOR does not open an outage', r4 === null && after4 === before4);

  // 5) The originating alarm row gets linked to the incident it triggered (P2.5 —
  //    this is what lets the control-room Alarms table show "this alarm → that incident")
  _resetDedupState();
  const scadaAlarm = { id: 'ALM-linktest', tag: 'MAYA.FDR2.CB1.TRIP', condition: 'CRITICAL', limit_val: 'TRIP', priority: 1, message: 'test', ts: new Date().toISOString(), ack: 0 };
  await repo.createAlarm(scadaAlarm);
  const r5 = await handleScadaEvent({ ...scadaAlarm, customers: 700 });
  const linkedAlarm = (await j('GET', '/alarms')).body.find(a => a.id === 'ALM-linktest');
  check('alarm row linked to the incident it auto-created (P2.5)', !!r5 && linkedAlarm && linkedAlarm.incident_id === r5.incidentId, linkedAlarm && linkedAlarm.incident_id);

  // ---- Phase 2 — restoration command publisher (INT-002) ----
  _resetPublishedState();
  const resolvable = await j('POST', '/incidents', { zone: 'Restore Test', severity: 'high', cause: 'Test', feeder: 'FDR-RESTORE' });
  const rid = resolvable.body.id;
  // walk the incident through the lifecycle to a resolvable state, then resolve it
  await j('PATCH', `/incidents/${rid}/status`, { status: 'dispatched' });
  await j('PATCH', `/incidents/${rid}/status`, { status: 'in_progress' });
  await j('PATCH', `/incidents/${rid}/status`, { status: 'pending' });
  const resolvedInc = (await j('PATCH', `/incidents/${rid}/status`, { status: 'resolved' })).body;

  const pub1 = await publishRestoration(resolvedInc);
  check('restoration command published to DMS on resolve (INT-002)', pub1.skipped === false && pub1.response?.accepted === true, JSON.stringify(pub1.response));

  const pub2 = await publishRestoration(resolvedInc);
  check('restoration command is idempotent — no duplicate send', pub2.skipped === true);
  check('operator resolve sets resolved_at', !!resolvedInc.resolved_at && !resolvedInc.restored_by);

  // ---- Phase 2 — P2.2 DNP3-over-IP protocol adapter (INT-003) ----
  // Link layer correctness, independent of any network/hardware:
  const crcOk = dnp3Internal.crc16dnp(Buffer.from('123456789', 'ascii')) === 0xea82;
  check('DNP3 CRC-16/DNP matches the standard test vector', crcOk);

  const sampleUserData = Buffer.from([0xC0, 0x81, 0x00, 0x00, 0x02, 0x01, 0x17, 0x01, 0x07, 0x81]);
  const builtFrame = dnp3Internal.buildFrame({ control: 0x44, dest: 1, src: 1024, userData: sampleUserData });
  const parsedFrame = dnp3Internal.parseFrame(builtFrame);
  check('DNP3 link-layer frame round-trips correctly', !!parsedFrame && Buffer.compare(parsedFrame.userData, sampleUserData) === 0);

  const corruptedFrame = Buffer.from(builtFrame); corruptedFrame[15] ^= 0xFF;
  check('DNP3 corrupted frame is rejected by CRC check', dnp3Internal.parseFrame(corruptedFrame) === null);

  // End-to-end: real TCP socket, real framing, simulated outstation reports a
  // trip, master decodes it, and it flows through the SAME auto-detection
  // pipeline as every other alarm source (P2.1/P2.3) — proving the adapter's
  // integration seam, not just its byte-level correctness.
  _resetDedupState();
  const outstation = new Dnp3TestOutstation({ port: 20101 });
  await outstation.listen();
  const master = new Dnp3Master({
    host: '127.0.0.1', port: 20101, substation: 'DNP3TEST', feeder: 'FDR1',
    pointMap: { 7: { tag: 'DNP3TEST.FDR1.CB1.TRIP', description: 'Test breaker 1' } },
  });
  const beforeDnp3 = (await j('GET', '/incidents')).body.length;
  await master.connect();
  outstation.triggerTrip(7);
  master.requestBinaryInputEvents();
  await new Promise((r) => setTimeout(r, 400)); // let the async bus→scada.js pipeline finish
  const afterDnp3 = (await j('GET', '/incidents')).body.length;
  const dnp3Incidents = (await j('GET', '/incidents')).body.filter(i => i.cause && i.cause.includes('DNP3TEST'));
  check('DNP3 trip over real TCP auto-creates an incident via the existing pipeline (P2.2)',
    afterDnp3 === beforeDnp3 + 1 && dnp3Incidents.length === 1, dnp3Incidents[0] && dnp3Incidents[0].id);
  outstation.triggerReclose(7);
  master.requestBinaryInputEvents();
  await new Promise((r) => setTimeout(r, 400));
  const dnp3After = dnp3Incidents[0] && await repo.incident(dnp3Incidents[0].id);
  check('DNP3 point back to closed = reclose, restores the incident (OMS-02)', dnp3After?.status === 'closed' && dnp3After?.momentary === true, dnp3After?.status);
  master.close();
  await outstation.close();

  // Crew trail: the dashboard draws this. A long window must keep the NEWEST points.
  {
    const t0 = Date.now() - 50 * 60 * 1000;
    const pts = [0, 1, 2, 3, 4].map((k) => ({ id: `selftest-trail-${k}-${t0}`, lat: 30.0 + k * 0.001, lon: 78.0 + k * 0.001, accuracy: 8, recordedAt: t0 + k * 10 * 60 * 1000 }));
    const up = await j('POST', '/mobile/crews/C006/locations', { points: pts });
    check('trail: GPS batch stored', up.status === 200 && up.body.inserted === 5, JSON.stringify(up.body));
    const from = new Date(t0 - 60000).toISOString(), to = new Date().toISOString();
    const all = await j('GET', `/mobile/crews/C006/track?from=${from}&to=${to}`);
    check('trail: returns every point oldest -> newest, with received_at',
      Array.isArray(all.body) && all.body.length === 5 && all.body.every((p, i, a) => !i || new Date(p.recorded_at) >= new Date(a[i - 1].recorded_at)) && all.body.every((p) => p.received_at),
      all.body.length);
    const last2 = await j('GET', `/mobile/crews/C006/track?from=${from}&to=${to}&limit=2`);
    check('trail: ?limit keeps the NEWEST points (still oldest -> newest)',
      last2.body.length === 2 && Math.abs(last2.body[1].lat - 30.004) < 1e-9 && Math.abs(last2.body[0].lat - 30.003) < 1e-9,
      JSON.stringify(last2.body.map((p) => p.lat)));
  }
  // ==== OMS-02 SCADA trip handling + OMS-04 MAIFI ====
  const trip = (tag, feeder, extra = {}) => handleScadaEvent({ tag, condition: 'CRITICAL', limit_val: 'TRIP', feeder, substation: substationForFeeder(feeder), ...extra });
  const reclose = (tag) => handleScadaEvent({ tag, event: 'reclose', condition: 'NORMAL', limit_val: 'CLOSED' });
  const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

  const illegal = await j('POST', '/incidents', { zone: 'Lifecycle Test', severity: 'high', cause: 'Test', feeder: 'FDR-LC' });
  check('PATCH /status open→resolved is still 409 for operators (SCADA bypass is internal only)',
    (await j('PATCH', `/incidents/${illegal.body.id}/status`, { status: 'resolved' })).status === 409);

  const alloc = feederAllocations();
  const allocSum = alloc.reduce((s, f) => s + f.customers, 0);
  check('kVA-share customer estimates over all feeders sum to CUSTOMERS_SERVED', Math.abs(allocSum - customersServed()) <= alloc.length, `${allocSum} vs ${customersServed()} over ${alloc.length} feeders`);

  // 1) trip -> incident with a feeder-level prediction
  _resetDedupState();
  const tp = await trip('JWL3.FDRB.CB1.TRIP', 'UPCL-JP-B');
  const tpInc = await repo.incident(tp.incidentId);
  const jpFeeder = alloc.find((f) => f.feeder === 'UPCL-JP-B');
  const tpEvents = await repo.incidentEvents(tp.incidentId);
  check('trip creates an incident with a feeder-level downstream prediction',
    tp.deduplicated === false && tpInc.prediction?.method === 'feeder' && tpInc.prediction.transformers > 0
      && tpInc.prediction.customers_estimate === jpFeeder.customers && /feeder-level/.test(tpInc.prediction.basis),
    `${tpInc.prediction?.transformers} DTs, ~${tpInc.prediction?.customers_estimate} customers`);
  check('no event count: incident.customers takes the estimate (customers_source=estimated)', tpInc.customers === jpFeeder.customers && tpInc.prediction.customers_source === 'estimated');
  check('trip records trip_tag/open_trip_tags and a prediction timeline event',
    tpInc.trip_tag === 'JWL3.FDRB.CB1.TRIP' && JSON.stringify(tpInc.open_trip_tags) === '["JWL3.FDRB.CB1.TRIP"]' && tpEvents.some((e) => e.kind === 'predicted' && /Predicted downstream/.test(e.note)));
  const tpDup = await trip('JWL3.FDRB.CB1.TRIP', 'UPCL-JP-B');
  check('duplicate trip inside 60 s still dedups, tag not doubled', tpDup.deduplicated === true && tpDup.incidentId === tp.incidentId
    && (await repo.incident(tp.incidentId)).open_trip_tags.length === 1);

  // 2) reclose inside MOMENTARY_MAX_MIN -> momentary, auto-closed
  const rc = await reclose('JWL3.FDRB.CB1.TRIP');
  const tpClosed = await repo.incident(tp.incidentId);
  check('reclose within 5 min → momentary, auto-closed, restored_by SCADA',
    rc.restored.length === 1 && tpClosed.status === 'closed' && tpClosed.momentary === true && tpClosed.restored_by === 'SCADA' && !!tpClosed.resolved_at, tpClosed.status);
  const indM = computeIndices([tpClosed]);
  check('momentary incident is in MAIFI, not in SAIFI/SAIDI', indM.saifi === 0 && indM.saidi === 0 && indM.maifi === +(tpClosed.customers / customersServed()).toFixed(3) && indM.maifi > 0, `maifi=${indM.maifi}`);
  check('second reclose of the same tag is a no-op', (await reclose('JWL3.FDRB.CB1.TRIP')).restored.length === 0);

  // 3) two devices on one feeder: restore only after both reclose
  _resetDedupState();
  const d1 = await trip('JWL2.FDRA.CB1.TRIP', 'UPCL-JL-A');
  const d2 = await trip('JWL2.FDRA.REC2.TRIP', 'UPCL-JL-A');
  check('second device on the same feeder merges into the incident with both tags open',
    d2.incidentId === d1.incidentId && (await repo.incident(d1.incidentId)).open_trip_tags.length === 2);
  await reclose('JWL2.FDRA.CB1.TRIP');
  const half = await repo.incident(d1.incidentId);
  check('one of two devices reclosed → incident stays open', half.status === 'open' && JSON.stringify(half.open_trip_tags) === '["JWL2.FDRA.REC2.TRIP"]', half.status);
  await reclose('JWL2.FDRA.REC2.TRIP');
  check('both devices reclosed → incident restored', (await repo.incident(d1.incidentId)).status === 'closed');

  // 4) a trip merged into a customer-reported incident restores it on reclose
  _resetDedupState();
  const anSub = substationForFeeder('UPCL-AN-B');
  const custOnly = await repo.createIncident({
    id: await repo.nextIncidentId(), type: 'Power Outage', severity: 'high', status: 'open', zone: 'Arya Nagar', feeder: null,
    substation: anSub, customers: 3, cause: 'No Supply', lat: null, lon: null, crew_id: null, opened_at: new Date().toISOString(),
    ert: null, sla_due_at: null, source: 'Customer',
  });
  const merged = await trip('ARYA.FDRB.CB1.TRIP', 'UPCL-AN-B');
  const mergedInc = await repo.incident(custOnly.id);
  check('trip at the same substation merges into the customer-reported incident and records its tag',
    merged.incidentId === custOnly.id && mergedInc.open_trip_tags.includes('ARYA.FDRB.CB1.TRIP') && mergedInc.prediction?.method === 'feeder');
  await reclose('ARYA.FDRB.CB1.TRIP');
  const custRestored = await repo.incident(custOnly.id);
  check('reclose restores the merged customer-reported incident', custRestored.status === 'closed' && custRestored.restored_by === 'SCADA', custRestored.status);

  // 5) sustained: restored after > 5 min, with a crew already assigned
  _resetDedupState();
  const sus = await trip('LALJ.FDRA.CB1.TRIP', 'UPCL-LW-A');
  const susAsg = await j('POST', `/incidents/${sus.incidentId}/assign`, { crewId: 'C005', priority: 'Normal' });
  const jobBefore = susAsg.body.job;
  await repo.updateIncident(sus.incidentId, { opened_at: minutesAgo(12) });
  await reclose('LALJ.FDRA.CB1.TRIP');
  const susInc = await repo.incident(sus.incidentId);
  const susEvents = await repo.incidentEvents(sus.incidentId);
  check('restore after > 5 min → sustained: resolved, restored_by SCADA, resolved_at set, not momentary',
    susInc.status === 'resolved' && susInc.restored_by === 'SCADA' && !!susInc.resolved_at && susInc.momentary === false, susInc.status);
  check('crew assigned: resolved anyway, timeline asks to confirm crew, job untouched',
    susEvents.some((e) => e.note === `Restored by SCADA while crew C005 assigned - confirm whether the crew is still needed`)
      && (await repo.jobs()).find((x) => x.id === jobBefore.id)?.status === jobBefore.status);
  const indS = computeIndices([susInc]);
  const susMin = (new Date(susInc.resolved_at) - new Date(susInc.opened_at)) / 60000;
  check('sustained incident counts in SAIFI/SAIDI using resolved_at, not in MAIFI',
    indS.maifi === 0 && indS.saifi === +(susInc.customers / customersServed()).toFixed(3) && indS.saidi === +(susInc.customers * susMin / customersServed()).toFixed(2),
    `saifi=${indS.saifi} saidi=${indS.saidi} (${susMin.toFixed(1)} min)`);
  const dmsSkip = await publishRestoration(susInc);
  check('no DMS restoration command for a SCADA-restored incident', dmsSkip.skipped === true && dmsSkip.reason === 'restored by SCADA');

  // 6) hand-worked IEEE 1366 example (shown in the PR): 18,500 customers served
  //    momentary A: 556 customers, momentary B: 191  -> MAIFI = 747 / 18500 = 0.040
  //    sustained C: 471 customers for 30 min        -> SAIFI = 471 / 18500 = 0.025
  //                                                     SAIDI = 471*30 / 18500 = 0.76 min, CAIDI = 30.0
  const t0 = '2026-10-01T10:00:00.000Z', t30 = '2026-10-01T10:30:00.000Z';
  const hand = computeIndices([
    { id: 'A', type: 'outage', severity: 'critical', status: 'closed', momentary: true, customers: 556, opened_at: t0, resolved_at: t0 },
    { id: 'B', type: 'outage', severity: 'critical', status: 'closed', momentary: true, customers: 191, opened_at: t0, resolved_at: t0 },
    { id: 'C', type: 'outage', severity: 'critical', status: 'resolved', momentary: false, customers: 471, opened_at: t0, resolved_at: t30 },
  ]);
  check('IEEE 1366 hand-worked example: MAIFI 0.040, SAIFI 0.025, SAIDI 0.76, CAIDI 30.0',
    customersServed() === 18500 && hand.maifi === 0.04 && hand.saifi === 0.025 && hand.saidi === 0.76 && hand.caidi === 30,
    `maifi=${hand.maifi} saifi=${hand.saifi} saidi=${hand.saidi} caidi=${hand.caidi}`);

  // 7) callbacks: linked calls + complaints, opt-outs, no phone, rejected, idempotent
  _resetDedupState();
  const cb = await trip('KNK3.FDRA.CB1.TRIP', 'UPCL-KI-A');
  const cbId = cb.incidentId;
  const mkCall = (id, phone, status = 'incident') => repo.createCall({ id, customer: id, phone, address: 'x', category: 'Normal', status, linked_id: cbId, ts: new Date().toISOString() });
  await mkCall('CALL-CB1', '9811100001');
  await mkCall('CALL-CB2', '9811100002');
  await repo.setOptOut('9811100002', 'sms');
  await mkCall('CALL-CB3', null);
  await mkCall('CALL-CB4', '9811100004', 'rejected');
  // Complaint phones need the pgcrypto migrations in db/migrations (not applied
  // by migrate()); on a database without them the complaint branch is skipped
  // and must not break the call callbacks.
  let complaintsReady = true;
  try {
    await repo.addComplaint({ qid: await repo.nextQueryId(), external_id: 'EXT-CB', customer: 'Complainant', phone: '9811100005', address: 'x',
      category: 'No Supply', lat: null, lon: null, dt_id: null, feeder: 'UPCL-KI-A', substation: substationForFeeder('UPCL-KI-A'), incident_id: cbId, action: 'merged', ts: new Date().toISOString() });
  } catch { complaintsReady = false; }
  await reclose('KNK3.FDRA.CB1.TRIP');
  const cbRows = await repo.callbacksForIncident(cbId);
  const st = (ref) => cbRows.find((n) => n.contact_ref === ref)?.status;
  const expectRows = complaintsReady ? 4 : 3, expectSent = complaintsReady ? 2 : 1;
  check(`callbacks: linked call${complaintsReady ? ' and complaint' : ''} called back, opted-out and no-phone recorded as skipped, rejected call excluded`
      + (complaintsReady ? '' : ' [complaint encryption not set up on this DB: complaint branch skipped]'),
    cbRows.length === expectRows && st('CALL-CB1') === 'logged' && st('CALL-CB2') === 'skipped-optout' && st('CALL-CB3') === 'skipped-no-contact'
      && !st('CALL-CB4') && cbRows.filter((n) => /^QRY-/.test(n.contact_ref) && n.status === 'logged').length === (complaintsReady ? 1 : 0),
    cbRows.map((n) => `${n.contact_ref}:${n.status}`).join(' '));
  check('callback rows never store the phone number in plaintext', cbRows.every((n) => !n.recipient || /^\*+\d{4}$/.test(n.recipient)) && !cbRows.some((n) => (n.recipient || '').includes('981110')));
  const cbNote = `Callback initiated to ${expectSent} customer${expectSent === 1 ? '' : 's'} (1 opted out, 1 no phone)`;
  check(`timeline: "${cbNote}"`, (await repo.incidentEvents(cbId)).some((e) => e.kind === 'callback' && e.note === cbNote));
  const again = await sendRestorationCallbacks(await repo.incident(cbId));
  check('callbacks are idempotent per (incident, contact): a retry sends nothing new',
    again.sent === 0 && again.already === expectRows && (await repo.callbacksForIncident(cbId)).length === expectRows);
  const cbCalls = (await j('GET', '/calls')).body;
  check('GET /calls shows callback_at only for calls actually called back',
    !!cbCalls.find((c) => c.id === 'CALL-CB1')?.callback_at && !cbCalls.find((c) => c.id === 'CALL-CB2')?.callback_at);

  // 8) the FAT hook end to end: /scada/simulate -> bus -> same handler
  process.env.ENABLE_SCADA_SIMULATION = 'true';
  _resetDedupState();
  const simTrip = await j('POST', '/scada/simulate', { tag: 'BHEL2.FDRB.CB1.TRIP', event: 'trip', feeder: 'UPCL-BS-B' });
  await new Promise((r) => setTimeout(r, 400));
  const simInc = (await j('GET', '/incidents')).body.find((i) => i.trip_tag === 'BHEL2.FDRB.CB1.TRIP');
  check('POST /scada/simulate trip (flag on, admin) → SCADA incident with prediction at the right substation',
    simTrip.status === 202 && simInc?.source === 'SCADA' && simInc?.prediction?.method === 'feeder' && simInc?.substation === substationForFeeder('UPCL-BS-B'), simInc?.id);
  const simRe = await j('POST', '/scada/simulate', { tag: 'BHEL2.FDRB.CB1.TRIP', event: 'reclose' });
  await new Promise((r) => setTimeout(r, 400));
  const simAfter = simInc && await repo.incident(simInc.id);
  check('POST /scada/simulate reclose → momentary auto-close', simRe.status === 202 && simAfter?.status === 'closed' && simAfter?.momentary === true, simAfter?.status);
  check('POST /scada/simulate rejects an unknown event (400)', (await j('POST', '/scada/simulate', { tag: 'X.Y', event: 'blink' })).status === 400);
  check('POST /scada/fault still ingests for system_admin (202)', (await j('POST', '/scada/fault', { tag: 'ZZ.FDR1.CB1.MINOR', condition: 'MINOR' })).status === 202);
  if (savedSimFlag === undefined) delete process.env.ENABLE_SCADA_SIMULATION; else process.env.ENABLE_SCADA_SIMULATION = savedSimFlag;

  console.log('\n  OMS backend self-test\n  ' + '-'.repeat(40));
  results.forEach(([s, n, e]) => console.log(`  [${s}] ${n} ${e}`));
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log('  ' + '-'.repeat(40));
  console.log(`  ${results.length - fails}/${results.length} passed\n`);
  server.close();
  process.exit(fails ? 1 : 0);
});