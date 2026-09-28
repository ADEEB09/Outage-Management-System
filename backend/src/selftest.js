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
  check('GET /incidents returns seeded rows', inc.body.length === 7, `(${inc.body.length})`);

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