import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { repo } from '../infra/repo.js';
import { requireRole } from './auth.js';
import { bus, TOPICS } from '../domain/bus.js';     
import { canTransition, nextStates, LABELS } from '../domain/lifecycle.js';
import { computeIndices, computeMTTR, computeSLACompliance, computeCrewProductivity, computeOutageFrequency } from '../domain/indices.js';
import { buildCsv, buildPdf } from '../domain/reports.js';
import { sendReportNow } from '../realtime/scheduledReports.js';
import { resolve as resolveAsset, substations as netSubstations } from '../infra/geo.js';
import { cacheGet, cacheSet, cacheDel } from '../infra/redis.js';
import sharp from 'sharp';

export const api = Router();
const actor = (req) => req.header('x-user') || 'operator';

// ---------- network topology (real Haridwar GIS, loaded once - unchanged, no DB) ----------
const _dir = dirname(fileURLToPath(import.meta.url));
let NETWORK = null;
try { NETWORK = JSON.parse(readFileSync(join(_dir, '..', 'infra', 'network.json'), 'utf8')); }
catch { NETWORK = { counts: {}, substations: [], feederLines: [] }; }
api.get('/network', (req, res) => res.json(NETWORK));
api.get('/network/meta', (req, res) => res.json({ counts: NETWORK.counts, bounds: NETWORK.bounds, feeders: NETWORK.feeders }));

// ---------- incidents ----------
api.get('/incidents', async (req, res) => res.json(await repo.incidents()));

api.get('/incidents/:id', async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  res.json({ ...inc, events: await repo.incidentEvents(inc.id), nextStates: nextStates(inc.status), stateLabels: LABELS });
});
api.get('/incidents/:id', async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  res.json({ ...inc, events: await repo.incidentEvents(inc.id), nextStates: nextStates(inc.status), stateLabels: LABELS });
});

// List messages for an incident
api.get('/incidents/:id/messages', async (req, res) => {
  res.json(await repo.messages(req.params.id));
});

// Post a message to an incident (crew <-> dispatcher thread)
api.post('/incidents/:id/messages', async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  const { body } = req.body || {};
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'body required' });
  }
  const sender = req.user?.username || 'unknown';
  const KNOWN = ['system_admin','oms_operator','dms_operator','scada_operator','call_centre_attendant','field_crew_coordinator','operations_engineer','configuration_engineer'];
  const role = (req.user?.roles || []).find(r => KNOWN.includes(r)) || 'user';
  const msg = await repo.addMessage(req.params.id, sender, role, String(body).trim());
  bus.publish(TOPICS.MESSAGE_POSTED, msg);
  res.status(201).json(msg);
});

// Combined photos for an incident, across every job ever tied to it
// (crew reassignments mean more than one job can share an incident_id).
api.get('/incidents/:id/photos', async (req, res) => {
  const photos = await repo.photosForIncident(req.params.id);
  res.json(photos);
});

// ---------- crew app job/crew messages ----------
// These reuse the SAME messages thread the web app's incident drawer shows --
// a job's messages ARE that job's incident's messages. No separate storage;
// just resolving job/crew -> incident_id and delegating to the existing
// repo.messages()/repo.addMessage() functions above.
api.get('/mobile/jobs/:id/messages', async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (!job.incident_id) return res.json([]);
  res.json(await repo.messages(job.incident_id));
});

api.post('/mobile/jobs/:id/messages', async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (!job.incident_id) return res.status(400).json({ error: 'job has no linked incident' });
  const { body } = req.body || {};
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'body required' });
  }
  const sender = req.user?.username || 'crew';
  const msg = await repo.addMessage(job.incident_id, sender, 'field_crew_coordinator', String(body).trim());
  bus.publish(TOPICS.MESSAGE_POSTED, msg);
  res.status(201).json(msg);
});

// A crew's "inbox" -- combined messages across every job currently assigned
// to them, newest last. Simple default: there's no single ongoing crew
// thread, so this unions each active job's incident thread instead.
api.get('/mobile/crews/:id/messages', async (req, res) => {
  const jobs = await repo.jobsForCrew(req.params.id);
  const incidentIds = [...new Set(jobs.map((j) => j.incident_id).filter(Boolean))];
  const threads = await Promise.all(incidentIds.map((id) => repo.messages(id)));
  const all = threads.flat().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  res.json(all);
});

api.post('/incidents', async (req, res) => {
  const b = req.body || {};
  if (!b.zone || !b.severity) return res.status(400).json({ error: 'zone and severity are required (FR-OMS-002)' });
  const id = await repo.nextIncidentId();
  const opened = new Date().toISOString();
  const SLA = { critical: 90, high: 180, medium: 360, low: 720 }[b.severity] || 360;
  const inc = await repo.createIncident({
    id, type: b.type || 'Power Outage', severity: b.severity, status: 'open',
    zone: b.zone, feeder: b.feeder || null, customers: b.customers || 0, cause: b.cause || 'Unknown',
    lat: b.lat ?? null, lon: b.lon ?? null, crew_id: null, opened_at: opened,
    ert: null, sla_due_at: new Date(Date.now() + SLA * 60000).toISOString(), source: b.source || 'MANUAL',
  });
  await repo.addIncidentEvent(id, actor(req), 'created', `Manually created - ${b.cause || 'Unknown'}`);
  await repo.audit(actor(req), 'incident.create', id);
  bus.publish(TOPICS.INCIDENT_CREATED, inc);
  await cacheDel('indicators');
  res.status(201).json(inc);
});

api.patch('/incidents/:id/status', requireRole('oms_operator', 'system_admin'), async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  const to = req.body?.status;
  if (!canTransition(inc.status, to))
    return res.status(409).json({ error: `illegal transition ${inc.status} - ${to}`, allowed: nextStates(inc.status) });
  const patch = { status: to };
  if (to === 'resolved') patch.ert = null;
  const updated = await repo.updateIncident(inc.id, patch);
  await repo.addIncidentEvent(inc.id, actor(req), 'status', `${LABELS[inc.status]} - ${LABELS[to]}${req.body?.note ? ' - ' + req.body.note : ''}`);
  await repo.audit(actor(req), 'incident.status', `${inc.id}:${to}`);
  bus.publish(TOPICS.INCIDENT_UPDATED, updated);
  await pushIndices();
  res.json(updated);
});

// Set/update the estimated restoration time; notifies customers if it moves by >30 min
api.patch('/incidents/:id/ert', requireRole('oms_operator', 'system_admin'), async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  const newErt = req.body?.ert;
  if (!newErt) return res.status(400).json({ error: 'ert required (ISO datetime)' });

  const oldErt = inc.ert;
  await repo.updateIncident(inc.id, { ert: newErt });
  const updated = await repo.incident(inc.id);

  if (oldErt) {
    const diffMin = Math.abs(new Date(newErt) - new Date(oldErt)) / 60000;
    if (diffMin > 30) {
      bus.publish(TOPICS.ERT_CHANGED, { ...updated, previousErt: oldErt });
    }
  }
  await repo.addIncidentEvent(inc.id, actor(req), 'ert', `Estimated restoration updated to ${new Date(newErt).toLocaleString()}`);
  await repo.audit(actor(req), 'incident.ert', inc.id);
  bus.publish(TOPICS.INCIDENT_UPDATED, updated);
  res.json(updated);
});
// Customer opt-out (per channel: 'email' or 'sms')
api.post('/notify/opt-out', async (req, res) => {
  const { recipient, channel } = req.body || {};
  if (!recipient || !channel) return res.status(400).json({ error: 'recipient and channel required' });
  await repo.setOptOut(recipient, channel);
  res.status(201).json({ recipient, channel, optedOut: true });
});

api.post('/notify/opt-in', async (req, res) => {
  const { recipient, channel } = req.body || {};
  if (!recipient || !channel) return res.status(400).json({ error: 'recipient and channel required' });
  await repo.clearOptOut(recipient, channel);
  res.status(201).json({ recipient, channel, optedOut: false });
});

// ---------- dispatch ----------
api.post('/incidents/:id/assign', requireRole('oms_operator', 'system_admin'), async (req, res) => {
  const inc = await repo.incident(req.params.id);
  const crew = await repo.crew(req.body?.crewId);
  if (!inc || !crew) return res.status(404).json({ error: 'incident or crew not found' });
  await repo.updateIncident(inc.id, { crew_id: crew.id, status: inc.status === 'open' ? 'dispatched' : inc.status });
  await repo.updateCrew(crew.id, { status: 'in_transit', job_id: inc.id, location: inc.zone });
  const job = await repo.createJob({
    id: 'JOB-' + inc.id.slice(-3) + '-' + crew.id, incident_id: inc.id, crew_id: crew.id,
    priority: req.body?.priority || 'Normal', status: 'Acknowledged', address: inc.zone,
    updated_at: new Date().toISOString(),
  });
  await repo.addJobUpdate(job.id, 'Acknowledged', null, null, null);
  await repo.addIncidentEvent(inc.id, actor(req), 'assigned', `${crew.name} assigned`);
  await repo.audit(actor(req), 'dispatch.assign', `${inc.id}-${crew.id}`);
  const updated = await repo.incident(inc.id);
  const updatedCrew = await repo.crew(crew.id);
  bus.publish(TOPICS.INCIDENT_UPDATED, updated);
  bus.publish(TOPICS.CREW_UPDATED, updatedCrew);
  bus.publish(TOPICS.JOB_UPDATED, job);
  res.json({ incident: updated, crew: updatedCrew, job });
});

// ---------- crews ----------
api.get('/crews', async (req, res) => res.json(await repo.crews()));

// Nearest available crews to an incident (PostGIS distance-ranked).
// Was previously registered *inside* the POST /assign handler, which meant it
// only existed after the first assign call (and got re-registered on every
// call after that). Hoisted to top-level route registration - fixed as part
// of the Phase 1 regression pass.
api.get('/incidents/:id/nearest-crews', async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  const crews = await repo.nearestAvailableCrews(inc.id);
  res.json(crews);
});

// ---------- alarms ----------
api.get('/alarms', async (req, res) => res.json(await repo.alarms()));

api.post('/alarms/:id/ack', async (req, res) => {
  const a = await repo.updateAlarm(req.params.id, { ack: 1 });
  await repo.audit(actor(req), 'alarm.ack', req.params.id);
  bus.publish(TOPICS.ALARM_ACKED, a);
  res.json(a);
});

// ---------- mock DMS endpoint (Phase 2, INT-002) ----------
// Stands in for the utility's real DMS REST interface so the restoration
// publisher (realtime/restoration.js) is testable end-to-end without a real
// SCADA/DMS connection - exactly like /scada/fault stands in for a live feed.
// A real DMS integration would replace DMS_RESTORATION_URL in .env with the
// utility's actual endpoint; this route then becomes dead code, kept only
// for local dev/demo.
const seenIdempotencyKeys = new Set();
api.post('/dms/restore', async (req, res) => {
  const { idempotencyKey, incidentId, feeder, action } = req.body || {};
  if (!idempotencyKey || !incidentId) return res.status(400).json({ error: 'idempotencyKey and incidentId are required' });
  if (seenIdempotencyKeys.has(idempotencyKey)) {
    return res.json({ accepted: true, duplicate: true, message: 'already processed - idempotent no-op' });
  }
  seenIdempotencyKeys.add(idempotencyKey);
  console.log(`[mock-dms] restoration command: ${action} on ${feeder || incidentId}`);
  res.json({ accepted: true, duplicate: false, switchState: 'CLOSED', ts: new Date().toISOString() });
});

// ---------- SCADA fault injection (Phase 2) ----------
// Lets an operator (or the demo) push a synthetic SCADA fault through the exact
// same auto-detection path the live DNP3/IEC-61968 adapter will use in
// production. Publishes to the ALARM_RAISED topic; the SCADA consumer does the
// rest (detect - dedup - classify - auto-create). INT-001.
api.post('/scada/fault', async (req, res) => {
  const { tag, condition = 'CRITICAL', limit_val = 'TRIP', customers, feeder, substation, lat, lon } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'tag is required' });
  const evt = {
    id: 'ALM-' + Math.random().toString(36).slice(2, 7),
    tag, condition, limit_val,
    priority: condition === 'CRITICAL' ? 1 : condition === 'MAJOR' ? 2 : 3,
    customers, feeder, substation, lat, lon,
    message: `${condition} injected on ${tag}`,
    ts: new Date().toISOString(), ack: 0,
  };
  await repo.createAlarm({ id: evt.id, tag: evt.tag, condition: evt.condition, limit_val: evt.limit_val, priority: evt.priority, message: evt.message, ts: evt.ts, ack: 0 });
  bus.publish(TOPICS.ALARM_RAISED, evt);
  await repo.audit(actor(req), 'scada.fault.inject', tag);
  res.status(202).json({ accepted: true, event: evt });
});

api.post('/alarms/ack-all', async (req, res) => {
  // NOTE: was `.forEach(async ...)` - that pattern doesn't await, so it's a
  // correctness bug once repo calls are async. Use a real loop instead.
  const alarms = await repo.alarms();
  for (const a of alarms.filter(a => !a.ack)) {
    await repo.updateAlarm(a.id, { ack: 1 });
    bus.publish(TOPICS.ALARM_ACKED, { ...a, ack: 1 });
  }
  res.json(await repo.alarms());
});

// ---------- trouble calls ----------
api.get('/calls', async (req, res) => res.json(await repo.calls()));

api.post('/calls/:id/to-incident', async (req, res) => {
  const calls = await repo.calls();
  const call = calls.find(c => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: 'not found' });
  const id = await repo.nextIncidentId();
  const opened = new Date().toISOString();
  const inc = await repo.createIncident({
    id, type: 'Power Outage', severity: call.category === 'Critical' ? 'critical' : 'medium',
    status: 'open', zone: call.address, feeder: null, customers: 1, cause: 'Customer reported',
    lat: null, lon: null, crew_id: null, opened_at: opened, ert: null,
    sla_due_at: new Date(Date.now() + 180 * 60000).toISOString(), source: 'TCS',
  });
  await repo.updateCall(call.id, { status: 'incident', linked_id: id });
  await repo.addIncidentEvent(id, actor(req), 'created', `From trouble call ${call.id} (${call.customer})`);
  bus.publish(TOPICS.INCIDENT_CREATED, inc);
  await cacheDel('indicators');
  res.status(201).json(inc);
});

// ---------- complaints (external REST intake - dedup - merge - traceability) ----------
const CATEGORY_TYPE = { 'No Supply': 'Power Outage', 'Partial Supply': 'Partial Power', 'Voltage': 'Power Quality', 'Wire Down': 'Safety Hazard', 'Meter': 'Metering', 'Other': 'Power Outage' };
const CATEGORY_SEV = { 'Wire Down': 'critical', 'No Supply': 'high', 'Partial Supply': 'medium', 'Voltage': 'medium', 'Meter': 'low', 'Other': 'medium' };

const SUPPLY = ['No Supply', 'Partial Supply', 'Voltage'];      // symptoms of one outage
const OUTAGE_TYPES = ['Power Outage', 'Partial Power', 'Power Quality'];
// Decide whether a new complaint belongs to an already-open incident at the same substation. (pure, unchanged)
function pickIncident(candidates, category) {
  const supply = SUPPLY.includes(category);
  return candidates.find((c) =>
    supply ? (OUTAGE_TYPES.includes(c.type) || SUPPLY.includes(c.cause)) : c.cause === category) || null;
}

// Core intake: takes an external complaint, mints our own query id, resolves the
// affected substation, and either MERGES into an active matching incident or opens a new one.
async function ingestComplaint(body, who) {
  const qid = await repo.nextQueryId();
  const ts = new Date().toISOString();
  const category = body.category || 'No Supply';
  const lat = typeof body.lat === 'number' ? body.lat : null;
  const lon = typeof body.lon === 'number' ? body.lon : null;
  const loc = resolveAsset(lat, lon);                       // - nearest DT, feeder, substation (in-memory, sync)

  const candidates = loc.substation ? await repo.activeIncidentsAtSubstation(loc.substation) : [];
  const match = pickIncident(candidates, category);
  let incidentId, action;

  if (match) {                                              // MERGE
    incidentId = match.id; action = 'merged';
    await repo.updateIncident(match.id, { customers: (match.customers || 0) + 1 });
    await repo.addIncidentEvent(match.id, who, 'complaint', `Merged complaint ${qid}${body.externalId ? ' (ext ' + body.externalId + ')' : ''} - ${category}, ${body.customer || 'customer'}`);
    bus.publish(TOPICS.INCIDENT_UPDATED, await repo.incident(match.id));
  } else {                                                  // NEW
    incidentId = await repo.nextIncidentId(); action = 'created';
    const inc = await repo.createIncident({
      id: incidentId, type: CATEGORY_TYPE[category] || 'Power Outage', severity: CATEGORY_SEV[category] || 'medium',
      status: 'open', zone: loc.substation ? loc.substation.replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim() : (body.address || 'Unknown'),
      feeder: loc.feeder, customers: 1, cause: category, lat: lat, lon: lon, crew_id: null,
      opened_at: ts, ert: null, sla_due_at: new Date(Date.now() + 180 * 60000).toISOString(),
      source: 'Customer', substation: loc.substation,
    });
    await repo.addIncidentEvent(incidentId, who, 'created', `Opened from complaint ${qid} - ${category} near ${loc.substation || 'unknown'}`);
    bus.publish(TOPICS.INCIDENT_CREATED, inc);
  }
  await cacheDel('indicators');

  const complaint = await repo.addComplaint({
    qid, external_id: body.externalId || null, customer: body.customer || null, phone: body.phone || null,
    address: body.address || null, category, lat, lon, dt_id: loc.dt_id, feeder: loc.feeder,
    substation: loc.substation, incident_id: incidentId, action, ts,
  });
  return { complaint, action, incidentId, resolved: loc };
}

api.get('/complaints', async (req, res) => res.json(await repo.complaints()));

// REST intake used by the external complaint service
api.post('/complaints', async (req, res) => {
  const r = await ingestComplaint(req.body || {}, actor(req));
  res.status(201).json({
    queryId: r.complaint.qid, externalId: r.complaint.external_id, action: r.action,
    incidentId: r.incidentId, feeder: r.resolved.feeder, substation: r.resolved.substation,
    complaint: r.complaint,
  });
});

// Full traceback: complaint - query - incident/problem - feeder - substation
api.get('/complaints/:qid/trace', async (req, res) => {
  const c = await repo.complaint(req.params.qid);
  if (!c) return res.status(404).json({ error: 'not found' });
  const inc = c.incident_id ? await repo.incident(c.incident_id) : null;
  const siblings = c.incident_id ? await repo.complaintsForIncident(c.incident_id) : [c];
  res.json({
    complaint: { qid: c.qid, externalId: c.external_id, customer: c.customer, category: c.category, address: c.address, ts: c.ts, action: c.action },
    incident: inc ? { id: inc.id, type: inc.type, severity: inc.severity, status: inc.status, customers: inc.customers } : null,
    feeder: c.feeder, substation: c.substation, dt: c.dt_id,
    grouped: siblings.length, groupedIds: siblings.map((s) => s.qid),
  });
});

// Demo helper: generate a realistic incoming complaint near a random substation
api.post('/complaints/simulate', async (req, res) => {
  const cats = ['No Supply', 'No Supply', 'Partial Supply', 'Voltage', 'Wire Down', 'Meter'];
  const names = ['Rakesh Verma', 'Sunita Devi', 'Imran Khan', 'Pooja Sharma', 'Deepak Rana', 'Anjali Bisht', 'Mohit Saini', 'Kavita Joshi'];
  const s = netSubstations[Math.floor(Math.random() * netSubstations.length)] || { lat: 29.95, lon: 78.13 };
  const body = {
    externalId: 'EXT-' + Math.floor(100000 + Math.random() * 899999),
    customer: names[Math.floor(Math.random() * names.length)],
    phone: '9' + Math.floor(100000000 + Math.random() * 899999999),
    category: cats[Math.floor(Math.random() * cats.length)],
    address: 'Near ' + (s.name || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim(),
    lat: s.lat + (Math.random() - 0.5) * 0.006, lon: s.lon + (Math.random() - 0.5) * 0.006,
  };
  const r = await ingestComplaint(body, 'complaint-api');
  res.status(201).json({ queryId: r.complaint.qid, action: r.action, incidentId: r.incidentId, substation: r.resolved.substation, feeder: r.resolved.feeder, category: body.category, customer: body.customer });
});

// ---------- indicators / analytics ----------
// Read-through cache (Redis RTDB, SDP -3): dashboards poll this endpoint
// frequently and the underlying computation re-scans every incident, so a
// short TTL cache takes the repeat load off Postgres without risking a
// stale value for more than a few seconds. Cache is invalidated explicitly
// wherever an incident is created/updated (see invalidateIndicators below).
api.get('/indicators', async (req, res) => {
  const cached = await cacheGet('indicators');
  if (cached) return res.json(cached);
  const fresh = computeIndices(await repo.incidents());
  await cacheSet('indicators', fresh, 15);
  res.json(fresh);
});
api.get('/analytics/monthly', async (req, res) => {
  // Real, stored monthly snapshots -- see POST /analytics/snapshot below for
  // how these get captured. Falls back to the live current-month figure only
  // if a month has no snapshot yet (e.g. right after this feature shipped,
  // before a full year of real history has accumulated).
  const snapshots = await repo.getMonthlySnapshots(12);
  const byMonth = Object.fromEntries(snapshots.map((s) => [s.month_key, s]));
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push(key);
  }
  const fresh = computeIndices(await repo.incidents());
  const currentKey = months[months.length - 1];
  const saidi = months.map((key) =>
    byMonth[key] ? Number(byMonth[key].saidi) : (key === currentKey ? fresh.saidi : null));
  res.json({ months, saidi, hasRealData: snapshots.length > 0 });
});
// Captures this month's real, currently-computed reliability indices into a
// permanent record -- the actual data a regulatory report should be built
// from, rather than a live number that changes every time someone looks.
// Call manually for now (Admin screen action); wire to a monthly cron once
// deployed for real.
api.post('/analytics/snapshot', requireRole('system_admin', 'oms_operator'), async (req, res) => {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const indices = computeIndices(await repo.incidents());
  await repo.saveMonthlySnapshot(monthKey, indices);
  await repo.audit(actor(req), 'analytics.snapshot', monthKey);
  res.json({ monthKey, ...indices, saved: true });
});
// P7.1 -- Supervisor dashboard: Mean Time To Restore, grouped by zone.
// Reads real incident_events history, not just current status, so this
// stays accurate for incidents that have moved on to Closed.
api.get('/analytics/mttr', async (req, res) => {
  const [incidents, events] = await Promise.all([repo.incidents(), repo.allIncidentEvents()]);
  const mttr = computeMTTR(incidents, events);
  res.json(mttr);
});
// P7.1 -- Supervisor dashboard: SLA compliance (resolved before/after deadline).
api.get('/analytics/sla', async (req, res) => {
  const [incidents, events] = await Promise.all([repo.incidents(), repo.allIncidentEvents()]);
  const sla = computeSLACompliance(incidents, events);
  res.json(sla);
});
// P7.1 -- Supervisor dashboard: crew productivity (jobs completed, avg time per job).
api.get('/analytics/crew-productivity', async (req, res) => {
  const [jobs, jobUpdates, crews] = await Promise.all([repo.jobs(), repo.allJobUpdates(), repo.crews()]);
  const productivity = computeCrewProductivity(jobs, jobUpdates, crews);
  res.json(productivity);
});
// P7.1 -- Supervisor dashboard: outage frequency by zone, split by severity.
api.get('/analytics/outage-frequency', async (req, res) => {
  const incidents = await repo.incidents();
  const freq = computeOutageFrequency(incidents);
  res.json(freq);
});
  
// ---------- P7.2: regulatory reliability reports ----------
  api.get('/reports/reliability', requireRole('system_admin', 'oms_operator'), async (req, res) => {
    const { from, to, zone, assetType, format = 'json' } = req.query;
    const filters = { from, to, zone, assetType };
    const incidents = await repo.incidents();
    const indices = computeIndices(incidents, filters);
    const meta = { generatedAt: new Date().toISOString(), filters: indices.filters };

    if (format === 'csv') {
      const csv = buildCsv(indices, meta);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="reliability-report.csv"');
      return res.send(csv);
    }

    if (format === 'pdf') {
      const pdf = await buildPdf(indices, meta);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="reliability-report.pdf"');
      return res.send(pdf);
    }

    res.json({ ...indices, generatedAt: meta.generatedAt });
  });

  api.post('/reports/reliability/send-now', requireRole('system_admin'), async (req, res) => {
  try {
    await sendReportNow();
    res.json({ sent: true });
  } catch (err) {
    console.error('[send-now] failed:', err.message);
    res.status(500).json({ sent: false, error: err.message });
  }
});
// ---------- crew app (mobile) ----------
api.get('/mobile/crews/:id/jobs', async (req, res) => {
  // NOTE: was a sync `.map()` with a repo lookup inside - under async repo
  // calls that returns an array of unresolved Promises. Use Promise.all instead.
  const rawJobs = await repo.jobsForCrew(req.params.id);
  const jobs = await Promise.all(rawJobs.map(async (j) => ({ ...j, incident: await repo.incident(j.incident_id) })));
  res.json(jobs);
});

api.get('/mobile/crews/:id', async (req, res) => {
  const crew = await repo.crew(req.params.id);
  if (!crew) return res.status(404).json({ error: 'not found' });
  res.json(crew);
});

// Continuous background location ping from the crew's phone. Persists the
// crew's live lat/lon (the crews.geog column auto-updates via DB trigger,
// which is what nearestAvailableCrews() and the dispatch map already read).
api.post('/mobile/crews/:id/location', async (req, res) => {
  const { lat, lon } = req.body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat/lon required' });
  }
  const crew = await repo.crew(req.params.id);
  if (!crew) return res.status(404).json({ error: 'not found' });
  const updated = await repo.updateCrew(req.params.id, { lat, lon });
  bus.publish(TOPICS.CREW_UPDATED, updated);
  res.json({ ok: true, crew: updated });
});

api.get('/mobile/crews/:id/messages', async (req, res) => {
  const crew = await repo.crew(req.params.id);
  if (!crew) return res.status(404).json({ error: 'not found' });
  res.json(await repo.messagesForCrew(req.params.id));
});

api.get('/mobile/jobs/:id/messages', async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job.incident_id ? await repo.messages(job.incident_id) : []);
});

api.get('/mobile/jobs/:id/history', async (req, res) => res.json(await repo.jobUpdates(req.params.id)));

api.post('/mobile/jobs/:id/assets/scans', async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const { rawValue, assetId, assetDetails, lat, lon, crewId } = req.body || {};
  if (!rawValue || typeof rawValue !== 'string') {
    return res.status(400).json({ error: 'rawValue is required' });
  }
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }
  const scan = await repo.addAssetScan({
    id: `AS${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
    job_id: job.id,
    crew_id: crewId || job.crew_id || null,
    asset_id: assetId || rawValue,
    raw_value: rawValue,
    asset_details: assetDetails && typeof assetDetails === 'object' ? assetDetails : {},
    lat: Number(lat),
    lon: Number(lon),
    scanned_at: new Date().toISOString(),
  });
  res.status(201).json(scan);
});

api.get('/mobile/jobs/:id/assets/scans', async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(await repo.assetScansForJob(job.id));
});

function decodePhotoDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a JPEG, PNG, or WebP data URL');
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// Compress every incoming photo before PostgreSQL storage.
api.post('/mobile/jobs/:id/photos', async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { dataUrl, lat, lon, note, technicianId, metadata } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(400).json({ error: 'dataUrl required' });
  }
  const photo = await repo.addJobPhoto(req.params.id, dataUrl, lat, lon, note, technicianId, metadata);
  const { data_url, ...meta } = photo;
  res.status(201).json(meta);
});

// List photo metadata for a job
api.get('/mobile/jobs/:id/photos', async (req, res) => {
  res.json(await repo.jobPhotos(req.params.id));
});

// Fetch one full photo (data URL) by id
api.get('/mobile/photos/:photoId', async (req, res) => {
  const row = await repo.jobPhotoById(req.params.photoId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

api.patch('/mobile/jobs/:id/status', async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { lat, lon, note } = req.body || {};
  const status = req.body?.status === 'Work Finished' ? 'Work Complete' : req.body?.status;
  await repo.updateJob(job.id, { status, updated_at: new Date().toISOString() });
  await repo.addJobUpdate(job.id, status, lat ?? null, lon ?? null, note ?? null);
  // reflect crew status + incident progress back to control room
  const map = { 'En Route': 'in_transit', 'On Site': 'in_service', 'Work Started': 'in_service', 'Work Complete': 'available' };
  if (map[status]) await repo.updateCrew(job.crew_id, { status: map[status] });
  if (status === 'On Site' && job.incident_id) await repo.updateIncident(job.incident_id, { status: 'in_progress' });
  if (job.incident_id) { await repo.addIncidentEvent(job.incident_id, 'Crew', 'field', 'Status: ' + status); }
  if (status === 'Work Complete' && job.incident_id) {
    await repo.updateIncident(job.incident_id, { status: 'pending' });
    await repo.addIncidentEvent(job.incident_id, 'Crew', 'field', 'Work complete - awaiting verification');
  }
  if (job.incident_id) await cacheDel('indicators');
  const updated = await repo.job(job.id);
  const updatedCrew = await repo.crew(job.crew_id);
  bus.publish(TOPICS.JOB_UPDATED, updated);
  bus.publish(TOPICS.CREW_UPDATED, updatedCrew);
  if (job.incident_id) bus.publish(TOPICS.INCIDENT_UPDATED, await repo.incident(job.incident_id));
  res.json(updated);
});

// ---------- admin ----------
api.get('/audit', requireRole('system_admin'), async (req, res) => res.json(await repo.auditLog()));

async function pushIndices() {
  await cacheDel('indicators');
  bus.publish(TOPICS.INDICES_UPDATED, computeIndices(await repo.incidents()));
}
export { pushIndices };