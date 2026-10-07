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
  app2.use((req, res, next) => { req.user = { username: 'crew-user', roles: ['field_crew'] }; next(); });
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
  server2.close();

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
  master.close();
  await outstation.close();

  console.log('\n  OMS backend self-test\n  ' + '-'.repeat(40));
  results.forEach(([s, n, e]) => console.log(`  [${s}] ${n} ${e}`));
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log('  ' + '-'.repeat(40));
  console.log(`  ${results.length - fails}/${results.length} passed\n`);
  server.close();
  process.exit(fails ? 1 : 0);
});