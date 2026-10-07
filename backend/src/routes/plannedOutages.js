// OMS-01 planned outages: control-room and crew-app routes. Mounted by
// routes/api.js BEFORE its own routes, because three existing routes must
// hand planned outages over to the switching plan instead of moving the
// incident themselves (they call next() for everything else, so fault
// incidents and jobs go through the existing handlers unchanged):
//   GET   /incidents/:id          planned: no manual next states, plus the outage id
//   PATCH /incidents/:id/status   planned: 409, use the planned-outage actions
//   PATCH /mobile/jobs/:id/status planned: permit gates; the job moves, the incident doesn't
//
// Identity for every OMS-01 action comes from the verified token
// (req.user), never from the x-user header. Rules: domain/plannedOutage.js.
// See docs/OMS-01-DESIGN.md §5.
import { Router } from 'express';
import { repo } from '../infra/repo.js';
import { requireRole } from './auth.js';
import { bus, TOPICS } from '../domain/bus.js';
import { LABELS } from '../domain/lifecycle.js';
import * as rules from '../domain/plannedOutage.js';
import { draftFromTrace } from '../domain/switchingPlan.js';
import { traceSection } from '../domain/sectionalize.js';
import { clientTime } from '../domain/clientTime.js';
import { publishNotice } from '../realtime/plannedNotices.js';

export const plannedOutageRoutes = Router();
const r = plannedOutageRoutes;

// Same async wrapper as api.js: a rejected handler becomes a JSON 500, not a hang.
for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
  const original = r[method].bind(r);
  r[method] = (path, ...handlers) => original(path, ...handlers.map((h) =>
    typeof h === 'function' ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next) : h));
}

const operator = requireRole('oms_operator', 'system_admin');
const crew = requireRole('field_crew');

function actor(req) {
  return { username: req.user?.username || null, roles: req.user?.roles || [], crewId: req.user?.crewId || null };
}
// Refuse a token without a username: the safety log must name a person.
function needActor(req, res, next) {
  if (!req.user?.username) return res.status(401).json({ code: 'NO_IDENTITY', message: 'token has no username' });
  next();
}

// After a successful change: tell the dashboard, and if the incident moved,
// publish it once with its final status (notifier "restored" message, etc.).
function publish(out) {
  const o = out.outage;
  if (!o) return;
  if (out.transitions?.length) bus.publish(TOPICS.INCIDENT_UPDATED, o.incident);
  bus.publish(TOPICS.PLANNED_OUTAGE_UPDATED, {
    id: o.id, incidentId: o.incident_id, status: o.incident.status, planState: o.plan.state, transitions: out.transitions || [],
  });
}

function reply(res, out, status = 200) {
  if (out.error) return res.status(out.error.status || 409).json({ code: out.error.code, message: out.error.message });
  publish(out);
  const { outage, transitions, ...rest } = out;
  return res.status(status).json({ ...rest, transitions, outage });
}

// ---------- hand-overs from existing routes ----------

r.get('/incidents/:id', async (req, res, next) => {
  const po = await repo.plannedOutageByIncident(req.params.id);
  if (!po) return next();
  res.json({ ...po.incident, events: await repo.incidentEvents(po.incident_id), nextStates: [], stateLabels: LABELS, plannedOutageId: po.id });
});

r.patch('/incidents/:id/status', async (req, res, next) => {
  if (!(await repo.isPlannedIncident(req.params.id))) return next();
  res.status(409).json({ code: 'USE_PLANNED_OUTAGE_ACTIONS', message: 'a planned outage moves through its switching plan and permits (/planned-outages/...)' });
});

// Crew job status for a planned outage. Work Started needs the permit
// issued, Work Complete needs it returned (the crew app checks first; this
// is the server-side gate). The incident is never moved from here.
const CREW_STATUS = { 'En Route': 'in_transit', 'On Site': 'in_service', 'Work Started': 'in_service', 'Work Complete': 'available' };
r.patch('/mobile/jobs/:id/status', async (req, res, next) => {
  const job = await repo.job(req.params.id);
  if (!job || !(await repo.isPlannedIncident(job.incident_id))) return next();
  const who = actor(req);
  if (rules.isCrew(who) && who.crewId !== job.crew_id) return res.status(403).json({ code: 'NOT_YOUR_JOB', message: 'this job belongs to another crew' });
  const status = req.body?.status === 'Work Finished' ? 'Work Complete' : req.body?.status;
  if (status === 'Work Started' || status === 'Work Complete') {
    const permit = await repo.latestPermitForJob(job.id);
    const need = status === 'Work Started' ? 'issued' : 'returned';
    if (permit?.state !== need) {
      return res.status(409).json({
        code: status === 'Work Started' ? 'PERMIT_NOT_ISSUED' : 'PERMIT_NOT_RETURNED',
        message: status === 'Work Started' ? 'work can start only under an issued permit' : 'return the permit before completing the job',
      });
    }
  }
  const { lat, lon, note } = req.body || {};
  const updated = await repo.updateJob(job.id, { status, updated_at: new Date().toISOString() });
  await repo.addJobUpdate(job.id, status, lat ?? null, lon ?? null, note ?? null);
  if (CREW_STATUS[status]) bus.publish(TOPICS.CREW_UPDATED, await repo.updateCrew(job.crew_id, { status: CREW_STATUS[status] }));
  await repo.addIncidentEvent(job.incident_id, who.username || 'Crew', 'field', `Crew job ${job.id}: ${status}`);
  bus.publish(TOPICS.JOB_UPDATED, updated);
  res.json(updated);
});

// ---------- control room ----------

r.get('/planned-outages', async (req, res) => res.json(await repo.plannedOutages()));

r.get('/planned-outages/:id', async (req, res) => {
  const po = await repo.plannedOutage(req.params.id);
  if (!po) return res.status(404).json({ code: 'NOT_FOUND', message: 'planned outage not found' });
  res.json(po);
});

r.get('/planned-outages/:id/safety-log', async (req, res) => res.json(await repo.safetyLog(req.params.id)));

r.post('/planned-outages', operator, needActor, async (req, res) => {
  const b = req.body || {};
  const out = await repo.createPlannedOutage({
    zone: b.zone, feeder: b.feeder, substation: b.substation, customers: Number(b.customers) || 0, lat: b.lat, lon: b.lon,
    severity: b.severity, windowStart: b.windowStart, windowEnd: b.windowEnd, workDescription: b.workDescription,
    workMrid: b.workMrid, noticeLeadMinutes: b.noticeLeadMinutes,
  }, actor(req));
  if (!out.error) bus.publish(TOPICS.INCIDENT_CREATED, out.outage.incident); // notifier skips 'Scheduled'
  reply(res, out, 201);
});

r.patch('/planned-outages/:id', operator, needActor, async (req, res) => {
  const { windowStart, windowEnd, workDescription } = req.body || {};
  reply(res, await repo.reschedulePlannedOutage(req.params.id, actor(req), { windowStart, windowEnd, workDescription }));
});

// Draft from the network trace around the work equipment. The network model
// may not be loaded (network.* is a separate migration): then the operator
// builds the plan by hand with PUT .../steps.
r.post('/planned-outages/:id/switching-plan/draft', operator, needActor, async (req, res) => {
  const po = await repo.plannedOutage(req.params.id);
  if (!po) return res.status(404).json({ code: 'NOT_FOUND', message: 'planned outage not found' });
  const workMrid = req.body?.workMrid || po.work_mrid;
  const crewId = req.body?.crewId || po.incident.crew_id;
  if (!workMrid) return res.status(400).json({ code: 'BAD_INPUT', message: 'workMrid is required' });
  if (!crewId) return res.status(400).json({ code: 'BAD_INPUT', message: 'crewId is required (the crew doing the line work)' });
  let trace;
  try {
    trace = await traceSection(workMrid);
  } catch (e) {
    return res.status(409).json({ code: 'NETWORK_UNAVAILABLE', message: `network model not available (${e.message}); build the plan manually` });
  }
  if (!trace.found) return res.status(404).json({ code: 'EQUIPMENT_NOT_FOUND', message: trace.reason });
  const steps = draftFromTrace(trace, { crewId, workLabel: req.body?.workLabel });
  reply(res, await repo.replaceDraftSteps(po.id, steps, actor(req), { source: 'trace', traceCaveat: trace.caveat }));
});

r.put('/planned-outages/:id/switching-plan/steps', operator, needActor, async (req, res) => {
  reply(res, await repo.replaceDraftSteps(req.params.id, req.body?.steps, actor(req)));
});

r.post('/planned-outages/:id/switching-plan/approve', operator, needActor, async (req, res) =>
  reply(res, await repo.approvePlan(req.params.id, actor(req))));

r.post('/planned-outages/:id/switching-plan/unapprove', operator, needActor, async (req, res) =>
  reply(res, await repo.unapprovePlan(req.params.id, actor(req))));

r.post('/planned-outages/:id/notify', operator, needActor, async (req, res) => {
  const skip = req.body?.skip === true;
  const out = await repo.markNotified(req.params.id, actor(req), { skip, reason: req.body?.reason });
  if (!out.error && !skip) publishNotice(out.outage);
  reply(res, out);
});

r.post('/planned-outages/:id/cancel', operator, needActor, async (req, res) =>
  reply(res, await repo.cancelPlannedOutage(req.params.id, actor(req), { reason: req.body?.reason })));

r.post('/planned-outages/:id/close', operator, needActor, async (req, res) =>
  reply(res, await repo.closePlannedOutage(req.params.id, actor(req))));

// A step confirmed from the control room: its own steps, or a crew step
// reported by phone/radio (onBehalfNote required, logged as such).
r.post('/switching-steps/:id/confirm', operator, needActor, async (req, res) => {
  const b = req.body || {};
  const out = await repo.confirmSwitchingStep(req.params.id, actor(req), {
    clientConfirmationId: b.clientConfirmationId, performedAt: clientTime(b.performedAt, b.sentAt), onBehalfNote: b.onBehalfNote || null,
  });
  stepEvents(out, req.params.id);
  reply(res, out);
});

r.post('/permits/:id/issue', operator, needActor, async (req, res) => {
  const out = await repo.issuePermit(req.params.id, actor(req), { isolationPoints: req.body?.isolationPoints, earthingPoints: req.body?.earthingPoints });
  permitEvent(out);
  reply(res, out);
});

r.post('/permits/:id/refuse', operator, needActor, async (req, res) => {
  const out = await repo.refusePermit(req.params.id, actor(req), { reason: req.body?.reason });
  permitEvent(out);
  reply(res, out);
});

r.post('/permits/:id/return-on-behalf', operator, needActor, async (req, res) => {
  const b = req.body || {};
  const out = await repo.returnPermit(req.params.id, actor(req), { declaration: b.declaration, clientRequestId: b.clientRequestId, onBehalfNote: b.onBehalfNote });
  permitEvent(out);
  reply(res, out);
});

// ---------- crew app (/mobile/*) ----------
// Permit actions are online-only (a two-party handshake); a step
// confirmation recorded offline arrives later with performedAt + sentAt.

// The job's outage as the crew sees it: every step in order, which ones this
// crew can confirm right now, and the job's permit.
r.get('/mobile/jobs/:id/planned-outage', crew, async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'job not found' });
  const who = actor(req);
  if (who.crewId !== job.crew_id) return res.status(403).json({ code: 'NOT_YOUR_JOB', message: 'this job belongs to another crew' });
  const po = await repo.plannedOutageForJob(job.id);
  if (!po) return res.status(404).json({ code: 'NOT_A_PLANNED_JOB', message: 'this job is not part of a planned outage' });
  const actionable = new Set(rules.actionableStepIds({ incident: po.incident, plan: po.plan, steps: po.steps, permits: po.permits }, who));
  res.json({
    plannedOutageId: po.id, incidentId: po.incident_id, status: po.incident.status, statusLabel: LABELS[po.incident.status],
    windowStart: po.window_start, windowEnd: po.window_end, workDescription: po.work_description, zone: po.incident.zone,
    planState: po.plan.state,
    steps: po.steps.map((s) => ({
      id: s.id, phase: s.phase, seq: s.seq, action: s.action, deviceLabel: s.device_label, location: s.location,
      assignee: s.assignee, assigneeCrewId: s.assignee_crew_id, mine: s.assignee === 'crew' && s.assignee_crew_id === who.crewId,
      state: s.state, confirmedBy: s.confirmed_by, performedAt: s.performed_at, actionable: actionable.has(s.id),
    })),
    permit: po.permits.filter((p) => p.job_id === job.id).at(-1) || null,
    serverTime: new Date().toISOString(),
  });
});

r.post('/mobile/jobs/:id/permit/request', crew, needActor, async (req, res) => {
  const out = await repo.requestPermit(req.params.id, actor(req), { clientRequestId: req.body?.clientRequestId });
  permitEvent(out);
  reply(res, out);
});

r.post('/mobile/permits/:id/withdraw', crew, needActor, async (req, res) => {
  const out = await repo.withdrawPermit(req.params.id, actor(req));
  permitEvent(out);
  reply(res, out);
});

r.post('/mobile/permits/:id/return', crew, needActor, async (req, res) => {
  const out = await repo.returnPermit(req.params.id, actor(req), { declaration: req.body?.declaration, clientRequestId: req.body?.clientRequestId });
  permitEvent(out);
  reply(res, out);
});

r.post('/mobile/switching-steps/:id/confirm', crew, needActor, async (req, res) => {
  const b = req.body || {};
  const out = await repo.confirmSwitchingStep(req.params.id, actor(req), {
    clientConfirmationId: b.clientConfirmationId, performedAt: clientTime(b.performedAt, b.sentAt),
    lat: Number.isFinite(b.lat) ? b.lat : null, lon: Number.isFinite(b.lon) ? b.lon : null,
  });
  stepEvents(out, req.params.id);
  reply(res, out);
});

function permitEvent(out) {
  if (!out.error && out.permit && !out.replay) bus.publish(TOPICS.PERMIT_CHANGED, out.permit);
}

// A rejected confirmation is shown to the control room live: a crew trying
// to switch out of order is something an operator must see.
function stepEvents(out, stepId) {
  if (out.error) bus.publish(TOPICS.STEP_REJECTED, { stepId, code: out.error.code, message: out.error.message });
  else if (!out.replay) bus.publish(TOPICS.STEP_CONFIRMED, out.step);
}
