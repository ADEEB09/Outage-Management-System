// OMS-01 planned-outage self-test: switching order, permit lifecycle, restore
// blocked while a permit is outstanding, the safety log, the crew-app routes,
// SCADA/DMS interactions, and a regression check that fault incidents and
// jobs behave exactly as before. Same style as selftest.js: real DB, real
// routes, identities injected the way requireAuth would attach them.
// Run: node src/selftest-oms01.js (needs DATABASE_URL; use a scratch DB).
import 'dotenv/config';
import express from 'express';
import { migrate, db } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { bus, initBus, TOPICS } from './domain/bus.js';
import { TRANSITIONS, canTransition } from './domain/lifecycle.js';
import * as rules from './domain/plannedOutage.js';
import { draftFromTrace } from './domain/switchingPlan.js';
import { clientTime } from './domain/clientTime.js';
import { handleScadaEvent, _resetDedupState } from './realtime/scada.js';
import { publishRestoration } from './realtime/restoration.js';
import { sendDueNotices } from './realtime/plannedNotices.js';
// The crew app's planned-outage rules are plain JS (no React Native imports).
import * as crewApp from '../../src/lib/plannedOutage.js';

await migrate();
await seed();
await initBus();

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

// Who is calling, the way requireAuth would set req.user from a verified
// token. x-test-as picks the identity; x-user (the header the rest of the
// API trusts for audit names) is deliberately also sent below to prove
// OMS-01 ignores it.
const USERS = {
  op: { username: 'op.sharma', roles: ['oms_operator'], crewId: null },
  c3: { username: 'crew03', roles: ['field_crew'], crewId: 'C003' },
  c5: { username: 'crew05', roles: ['field_crew'], crewId: 'C005' },
};
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = USERS[req.header('x-test-as') || 'op']; next(); });
app.use('/api', api);

const notices = [];
bus.subscribe(TOPICS.PLANNED_NOTICE, (n) => notices.push(n));

const PORT = 4120;
const server = app.listen(PORT, async () => {
  const call = async (as, method, path, body, extraHeaders = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-test-as': as, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

  try {
    console.log('-- pure rules');
    check('fault TRANSITIONS unchanged', JSON.stringify(TRANSITIONS) === JSON.stringify({
      scheduled: ['open', 'cancelled'], open: ['dispatched', 'cancelled'], dispatched: ['in_progress', 'open', 'cancelled'],
      in_progress: ['pending', 'cancelled'], pending: ['resolved', 'in_progress'], resolved: ['closed'], closed: [], cancelled: [],
    }));
    check('planned table only when planned', canTransition('scheduled', 'notified', true) && !canTransition('scheduled', 'notified'));
    check('no cancel once isolating', !canTransition('isolating', 'cancelled', true) && !canTransition('in_progress', 'cancelled', true));
    const now = Date.parse('2026-10-07T10:00:00Z');
    check('clientTime corrects a phone clock 3 min slow',
      clientTime('2026-10-07T09:47:00Z', '2026-10-07T09:57:00Z', { now }) === '2026-10-07T09:50:00.000Z');
    check('clientTime never in the future', clientTime('2026-10-07T11:00:00Z', null, { now }) === '2026-10-07T10:00:00.000Z');
    const draft = draftFromTrace({
      origin: { cim_mrid: 'DT14', name: 'DT-14' },
      boundarySwitches: [{ cim_mrid: 'AB1', cim_class: 'LoadBreakSwitch', name: 'AB P-214', hops: 2 }, { cim_mrid: 'CB1', cim_class: 'Breaker', name: 'CB-11', hops: 5 }],
    }, { crewId: 'C003' });
    const iso = draft.filter((s) => s.phase === 'isolate'), res = draft.filter((s) => s.phase === 'restore');
    check('draft from trace: open switches, test dead, earth; restore in reverse',
      iso.map((s) => s.action).join() === 'open,open,test_dead,earth_apply' && res.map((s) => s.action).join() === 'earth_remove,close,close'
      && res[1].device_label === 'CB-11' && iso[0].assignee === 'crew' && iso[1].assignee === 'control_room');
    check('draft passes the plan shape rules', rules.checkDraftSteps(draft) === null);

    console.log('-- control room: create, plan, notify');
    check('crew cannot create a planned outage', (await call('c3', 'POST', '/planned-outages', { zone: 'Z' })).status === 403);
    let r = await call('op', 'POST', '/planned-outages', { zone: 'Kankhal-2', substation: 'TESTPO', workDescription: 'Replace DT-14 bushings', windowStart: hours(30), windowEnd: hours(34), customers: 120 });
    const po = r.body.outage;
    check('create -> 201, incident Scheduled/scheduled, draft plan', r.status === 201 && po?.incident.status === 'scheduled' && po.incident.type === 'Scheduled' && po.plan.state === 'draft', po?.incident.id);
    const incId = po.incident.id;
    r = await call('op', 'GET', `/incidents/${incId}`);
    check('GET /incidents/:id: no manual next states, outage id', r.body.nextStates?.length === 0 && r.body.plannedOutageId === po.id);
    r = await call('op', 'PATCH', `/incidents/${incId}/status`, { status: 'open' });
    check('PATCH /incidents/:id/status refused for planned', r.status === 409 && r.body.code === 'USE_PLANNED_OUTAGE_ACTIONS');
    r = await call('op', 'POST', `/planned-outages/${po.id}/switching-plan/draft`, { workMrid: 'NOPE', crewId: 'C003' });
    check('draft from trace without network data -> clear error', [409, 404].includes(r.status) && ['NETWORK_UNAVAILABLE', 'EQUIPMENT_NOT_FOUND'].includes(r.body.code), r.body.code);
    const steps = [
      { phase: 'isolate', seq: 1, action: 'open', device_label: 'CB-11', location: 'TESTPO S/s', assignee: 'control_room' },
      { phase: 'isolate', seq: 2, action: 'open', device_label: 'AB P-214', location: 'Pole 214', assignee: 'crew', assignee_crew_id: 'C003' },
      { phase: 'isolate', seq: 3, action: 'earth_apply', device_label: 'DT-14 work site', location: 'DT-14', assignee: 'crew', assignee_crew_id: 'C003' },
      { phase: 'restore', seq: 1, action: 'earth_remove', device_label: 'DT-14 work site', location: 'DT-14', assignee: 'crew', assignee_crew_id: 'C003' },
      { phase: 'restore', seq: 2, action: 'close', device_label: 'AB P-214', location: 'Pole 214', assignee: 'crew', assignee_crew_id: 'C003' },
      { phase: 'restore', seq: 3, action: 'close', device_label: 'CB-11', location: 'TESTPO S/s', assignee: 'control_room' },
    ];
    check('steps saved', (await call('op', 'PUT', `/planned-outages/${po.id}/switching-plan/steps`, { steps })).status === 200);
    check('notify before approval -> PLAN_NOT_APPROVED', (await call('op', 'POST', `/planned-outages/${po.id}/notify`)).body.code === 'PLAN_NOT_APPROVED');
    check('approve', (await call('op', 'POST', `/planned-outages/${po.id}/switching-plan/approve`)).status === 200);
    r = await call('op', 'POST', `/planned-outages/${po.id}/notify`);
    check('notify -> notified, notice published', r.body.outage?.incident.status === 'notified' && notices.some((n) => n.plannedOutageId === po.id));
    const asg = await call('op', 'POST', `/incidents/${incId}/assign`, { crewId: 'C003' });
    const jobId = asg.body.job?.id;
    check('crew assigned with the existing route; outage stays notified', !!jobId && asg.body.incident.status === 'notified', jobId);

    console.log('-- crew app');
    r = await call('c5', 'GET', `/mobile/jobs/${jobId}/planned-outage`);
    check('another crew cannot read this job\'s outage', r.status === 403);
    r = await call('c3', 'GET', `/mobile/jobs/${jobId}/planned-outage`);
    const S = (phase, seq) => r.body.steps.find((s) => s.phase === phase && s.seq === seq);
    check('crew view: 6 steps in order, control-room steps not "mine", nothing actionable yet',
      r.body.steps?.length === 6 && !S('isolate', 1).mine && S('isolate', 2).mine && r.body.steps.every((s) => !s.actionable));
    const ids = Object.fromEntries(r.body.steps.map((s) => [`${s.phase}${s.seq}`, s.id]));
    const confirm = (as, key, cid, extra = {}) =>
      call(as, 'POST', as === 'op' ? `/switching-steps/${ids[key]}/confirm` : `/mobile/switching-steps/${ids[key]}/confirm`, { clientConfirmationId: cid, ...extra });

    r = await confirm('c3', 'isolate2', 'c3-i2');
    check('crew step before control-room step 1 -> 409 PREDECESSOR_UNCONFIRMED', r.status === 409 && r.body.code === 'PREDECESSOR_UNCONFIRMED');
    r = await confirm('c3', 'isolate1', 'c3-i1');
    check('crew confirming a control-room step -> WRONG_ASSIGNEE', r.status === 409 && r.body.code === 'WRONG_ASSIGNEE');
    r = await confirm('op', 'isolate1', 'op-i1');
    check('operator confirms isolate 1 -> isolating', r.body.outage?.incident.status === 'isolating');
    r = await call('c3', 'GET', `/mobile/jobs/${jobId}/planned-outage`);
    check('crew view: isolate 2 now actionable for C003', r.body.steps.find((s) => s.id === ids.isolate2).actionable === true);
    // Recorded offline 9 min ago on a phone whose clock is 2 min slow.
    const phoneNow = Date.now() - 2 * 60000;
    r = await confirm('c3', 'isolate2', 'c3-i2', { performedAt: new Date(phoneNow - 9 * 60000).toISOString(), sentAt: new Date(phoneNow).toISOString() });
    const lag = (Date.now() - Date.parse(r.body.step?.performed_at)) / 60000;
    check('offline confirmation lands at its real time (clock-corrected)', r.status === 200 && lag > 8.5 && lag < 9.5, `${lag.toFixed(2)} min ago`);
    r = await confirm('c3', 'isolate2', 'c3-i2');
    check('same confirmation re-sent -> 200 replay, recorded once', r.status === 200 && r.body.replay === true);
    r = await call('c5', 'POST', `/mobile/switching-steps/${ids.isolate3}/confirm`, { clientConfirmationId: 'c5-i3' });
    check('another crew -> WRONG_ASSIGNEE', r.body.code === 'WRONG_ASSIGNEE');
    r = await call('c3', 'POST', `/mobile/jobs/${jobId}/permit/request`, { clientRequestId: 'pr-early' });
    check('permit before own isolation complete -> ISOLATION_INCOMPLETE', r.body.code === 'ISOLATION_INCOMPLETE');
    await confirm('c3', 'isolate3', 'c3-i3');
    r = await call('c3', 'PATCH', `/mobile/jobs/${jobId}/status`, { status: 'Work Started' });
    check('Work Started without permit -> 409 PERMIT_NOT_ISSUED', r.status === 409 && r.body.code === 'PERMIT_NOT_ISSUED');
    r = await call('c3', 'POST', `/mobile/jobs/${jobId}/permit/request`, { clientRequestId: 'pr-1' });
    const permitId = r.body.permit?.id;
    check('permit requested', r.status === 200 && r.body.permit.state === 'requested', r.body.permit?.permit_no);
    r = await confirm('op', 'restore1', 'op-r1', { onBehalfNote: 'test' });
    check('restore while permit requested -> PERMIT_OUTSTANDING', r.body.code === 'PERMIT_OUTSTANDING');
    r = await call('op', 'POST', `/permits/${permitId}/issue`, { isolationPoints: 'CB-11 open; AB P-214 open', earthingPoints: 'DT-14 both sides' }, { 'x-user': 'mallory' });
    check('permit issued -> outage in_progress', r.body.permit?.state === 'issued' && r.body.outage.incident.status === 'in_progress');
    r = await call('op', 'POST', `/planned-outages/${po.id}/cancel`, { reason: 'x' });
    check('cancel after switching started -> SWITCHING_STARTED', r.body.code === 'SWITCHING_STARTED');
    r = await call('c3', 'PATCH', `/mobile/jobs/${jobId}/status`, { status: 'Work Started' });
    const incNow = (await repo.incident(incId)).status;
    check('Work Started under issued permit -> 200; incident NOT moved by the status route', r.status === 200 && incNow === 'in_progress', incNow);
    r = await call('c3', 'PATCH', `/mobile/jobs/${jobId}/status`, { status: 'Work Finished' });
    check('Work Complete before return -> 409 PERMIT_NOT_RETURNED', r.body.code === 'PERMIT_NOT_RETURNED');
    r = await confirm('c3', 'restore1', 'c3-r1');
    check('restore while permit issued -> PERMIT_OUTSTANDING', r.body.code === 'PERMIT_OUTSTANDING');

    console.log('-- SCADA during planned work');
    _resetDedupState();
    const trip = await handleScadaEvent({ tag: 'TESTPO.F1.CB11', condition: 'CRITICAL', substation: 'TESTPO' });
    check('SCADA trip at the substation opens its own incident, not merged into the planned one', !!trip?.incidentId && trip.incidentId !== incId && trip.deduplicated === false, trip?.incidentId);
    const evs = (await repo.incidentEvents(incId)).map((e) => e.note).join(' | ');
    check('planned outage timeline notes the trip', evs.includes(trip.incidentId));
    const reclose = await handleScadaEvent({ event: 'reclose', tag: 'TESTPO.F1.CB11' });
    check('reclose never restores the planned outage', (await repo.incident(incId)).status === 'in_progress' && !(reclose.restored || []).some((x) => x.incidentId === incId));
    check('planned incidents are never merge candidates', !(await repo.activeIncidentsAtSubstation('TESTPO')).some((i) => i.id === incId));

    console.log('-- return and restore');
    r = await call('c3', 'POST', `/mobile/permits/${permitId}/return`, { clientRequestId: 'ret-1', declaration: { menWithdrawn: true, earthsRemoved: true } });
    check('return without full declaration -> DECLARATION_INCOMPLETE', r.body.code === 'DECLARATION_INCOMPLETE');
    r = await call('c3', 'POST', `/mobile/permits/${permitId}/return`, { clientRequestId: 'ret-1', declaration: { menWithdrawn: true, earthsRemoved: true, toolsClear: true } });
    check('permit returned -> restoring', r.body.permit?.state === 'returned' && r.body.outage.incident.status === 'restoring');
    check('Work Complete after return -> 200', (await call('c3', 'PATCH', `/mobile/jobs/${jobId}/status`, { status: 'Work Finished' })).status === 200);
    r = await confirm('op', 'restore3', 'op-r3');
    check('restore out of order -> PREDECESSOR_UNCONFIRMED', r.body.code === 'PREDECESSOR_UNCONFIRMED');
    await confirm('c3', 'restore1', 'c3-r1');
    r = await confirm('op', 'restore2', 'op-r2');
    check('operator on a crew step without a note -> WRONG_ASSIGNEE', r.body.code === 'WRONG_ASSIGNEE');
    await confirm('op', 'restore2', 'op-r2', { onBehalfNote: 'crew03 reported by radio' });
    r = await confirm('op', 'restore3', 'op-r3');
    const fin = r.body.outage?.incident;
    check('last restore step -> resolved by switching plan', fin?.status === 'resolved' && fin.restored_by === 'SWITCHING_PLAN');
    const dms = await publishRestoration(fin);
    check('no automatic DMS CLOSE command for a planned restore', dms.skipped === true && /switching plan/.test(dms.reason));
    check('close -> closed', (await call('op', 'POST', `/planned-outages/${po.id}/close`)).body.outage?.incident.status === 'closed');

    console.log('-- safety log');
    const log = (await call('op', 'GET', `/planned-outages/${po.id}/safety-log`)).body;
    check('every step and permit transition logged', log.filter((l) => l.action === 'step.confirm').length === 6
      && ['permit.request', 'permit.issue', 'permit.return'].every((a) => log.some((l) => l.action === a)), `${log.length} rows`);
    check('rejected attempts logged with their code', log.some((l) => l.action === 'step.confirm.rejected' && l.details.code === 'PREDECESSOR_UNCONFIRMED'));
    check('actor is the verified user, never the x-user header', log.find((l) => l.action === 'permit.issue')?.actor === 'op.sharma' && !log.some((l) => l.actor === 'mallory'));
    check('on-behalf confirmation records the note', log.some((l) => l.action === 'step.confirm' && l.details.onBehalfNote === 'crew03 reported by radio'));
    let blocked = 0;
    for (const sql of ['UPDATE safety_log SET actor = $1', 'DELETE FROM safety_log', 'TRUNCATE safety_log']) {
      try { await db.none(sql, ['x']); } catch { blocked++; }
    }
    check('safety log cannot be changed, deleted or truncated', blocked === 3);

    console.log('-- concurrency and the notice scheduler');
    const c = (await call('op', 'POST', '/planned-outages', { zone: 'Mayapur', workDescription: 'race', windowStart: hours(2), windowEnd: hours(3) })).body.outage;
    await call('op', 'PUT', `/planned-outages/${c.id}/switching-plan/steps`, { steps: steps.map((s) => ({ ...s, assignee: 'control_room', assignee_crew_id: null })) });
    await call('op', 'POST', `/planned-outages/${c.id}/switching-plan/approve`);
    const sent = await sendDueNotices();
    check('scheduler sends a notice that is due (window inside lead time)', sent.includes(c.id) && (await repo.incident(c.incident.id)).status === 'notified');
    check('scheduler does not send it twice', !(await sendDueNotices()).includes(c.id));
    const co = await repo.plannedOutage(c.id);
    const s1 = co.steps.find((s) => s.phase === 'isolate' && s.seq === 1), s2 = co.steps.find((s) => s.phase === 'isolate' && s.seq === 2);
    await Promise.all([
      call('op', 'POST', `/switching-steps/${s2.id}/confirm`, { clientConfirmationId: 'race-2' }),
      call('op', 'POST', `/switching-steps/${s1.id}/confirm`, { clientConfirmationId: 'race-1' }),
    ]);
    const after = await repo.plannedOutage(c.id);
    const f1 = after.steps.find((s) => s.id === s1.id), f2 = after.steps.find((s) => s.id === s2.id);
    check('two confirmations at the same instant never break the order',
      f2.state !== 'confirmed' || (f1.state === 'confirmed' && new Date(f1.received_at) <= new Date(f2.received_at)));

    console.log('-- crew app: unsynced confirmations and gates (src/lib/plannedOutage.js)');
    const view = {
      permit: null,
      steps: [
        { id: 'a', phase: 'isolate', seq: 1, mine: false, state: 'confirmed' },
        { id: 'b', phase: 'isolate', seq: 2, mine: true, state: 'pending', actionable: true },
        { id: 'c', phase: 'isolate', seq: 3, mine: true, state: 'pending', actionable: false },
        { id: 'd', phase: 'restore', seq: 1, mine: false, state: 'pending', actionable: false },
      ],
    };
    const st = (id, pend) => crewApp.stepUiState(view.steps.find((s) => s.id === id), view, pend);
    check('actionable only when the server says so and nothing is unsent', st('b', []) === 'actionable' && st('c', []) === 'pending' && st('d', []) === 'control_room');
    const unsent = [{ client_confirmation_id: 'u1', step_id: 'b', last_code: null }];
    check('a step done offline shows UNSYNCED, never confirmed', st('b', unsent) === 'unsynced');
    view.steps[2].actionable = true; // even if a stale server view says the next one is open
    check('nothing unlocks while a confirmation is unsent', st('c', unsent) === 'pending');
    check('a refused confirmation shows REJECTED', st('b', [{ ...unsent[0], last_code: 'PREDECESSOR_UNCONFIRMED' }]) === 'rejected');
    check('gate: offline -> closed', !!crewApp.gateFor(null, 'Work Started'));
    check('gate: Work Started needs own isolation + issued permit',
      !!crewApp.gateFor(view, 'Work Started')
      && crewApp.gateFor({ ...view, steps: view.steps.map((s) => ({ ...s, state: 'confirmed' })), permit: { state: 'issued' } }, 'Work Started') === null);
    check('gate: Work Finished needs the permit returned',
      !!crewApp.gateFor({ ...view, permit: { state: 'issued' } }, 'Work Finished') && crewApp.gateFor({ ...view, permit: { state: 'returned' } }, 'Work Finished') === null);

    // An in-memory stand-in for safetyStore's SQLite table.
    const memStore = (items) => ({
      items,
      list: async () => [...items],
      remove: async (id) => { const i = items.findIndex((x) => x.client_confirmation_id === id); if (i >= 0) items.splice(i, 1); },
      markAttempt: async (id, m) => { const x = items.find((y) => y.client_confirmation_id === id); x.attempts = (x.attempts || 0) + 1; x.last_error = m; },
      markRejected: async (id, code, m) => { const x = items.find((y) => y.client_confirmation_id === id); x.last_code = code; x.last_error = m; },
    });
    const sentOrder = [];
    let qs = memStore([{ client_confirmation_id: 'q1', step_id: 's1' }, { client_confirmation_id: 'q2', step_id: 's2' }]);
    await crewApp.flushConfirmations(qs, async () => { throw new TypeError('Network request failed'); });
    check('no signal: nothing removed, order kept', qs.items.map((x) => x.client_confirmation_id).join() === 'q1,q2' && qs.items[0].attempts === 1 && !qs.items[1].attempts);
    await crewApp.flushConfirmations(qs, async (it) => { sentOrder.push(it.client_confirmation_id); if (it.client_confirmation_id === 'q1') throw Object.assign(new Error('step 1 not confirmed'), { status: 409, code: 'PREDECESSOR_UNCONFIRMED' }); });
    check('refused: kept as rejected, later ones not sent', qs.items.length === 2 && qs.items[0].last_code === 'PREDECESSOR_UNCONFIRMED' && sentOrder.join() === 'q1');
    await crewApp.flushConfirmations(qs, async (it) => { sentOrder.push(it.client_confirmation_id); });
    check('refused one is never retried automatically and blocks the rest', sentOrder.join() === 'q1' && qs.items.length === 2);
    qs = memStore([{ client_confirmation_id: 'q3', step_id: 's3' }, { client_confirmation_id: 'q4', step_id: 's4' }]);
    const order = [];
    await crewApp.flushConfirmations(qs, async (it) => { order.push(it.client_confirmation_id); });
    check('acknowledged ones removed, sent oldest first', qs.items.length === 0 && order.join() === 'q3,q4');

    // End to end against the API: the server takes the confirmation but the
    // reply is lost (phone went out of signal). The phone keeps it and resends
    // the same id later; the server answers it as a replay, recorded once.
    const e = (await call('op', 'POST', '/planned-outages', { zone: 'Gurukul', workDescription: 'lost ack', windowStart: hours(70), windowEnd: hours(72) })).body.outage;
    await call('op', 'PUT', `/planned-outages/${e.id}/switching-plan/steps`, { steps: [steps[0], steps[1], steps[4], steps[5]].map((s, i) => ({ ...s, seq: i < 2 ? i + 1 : i - 1 })) });
    await call('op', 'POST', `/planned-outages/${e.id}/switching-plan/approve`);
    await call('op', 'POST', `/planned-outages/${e.id}/notify`);
    const eo = await repo.plannedOutage(e.id);
    await call('op', 'POST', `/switching-steps/${eo.steps[0].id}/confirm`, { clientConfirmationId: 'lost-op-1' });
    const lost = memStore([{ client_confirmation_id: 'lost-c3-2', step_id: eo.steps[1].id, performed_at: new Date(Date.now() - 4 * 60000).toISOString() }]);
    const sendAsC3 = async (it) => {
      const res = await call('c3', 'POST', `/mobile/switching-steps/${it.step_id}/confirm`, { clientConfirmationId: it.client_confirmation_id, performedAt: it.performed_at, sentAt: new Date().toISOString() });
      if (res.status >= 400) throw Object.assign(new Error(res.body.message), { status: res.status, code: res.body.code });
      return res;
    };
    await crewApp.flushConfirmations(lost, async (it) => { await sendAsC3(it); throw new TypeError('connection lost before the reply'); });
    check('reply lost: still stored on the phone (not assumed sent)', lost.items.length === 1);
    await crewApp.flushConfirmations(lost, sendAsC3);
    const eLog = (await repo.safetyLog(e.id)).filter((l) => l.action === 'step.confirm' && l.entity_id === eo.steps[1].id);
    check('resend of the same id: accepted as replay, recorded once', lost.items.length === 0 && eLog.length === 1);

    console.log('-- fault incidents and jobs unchanged');
    const fault = (await call('op', 'POST', '/incidents', { zone: 'Mayapur', severity: 'high', type: 'Power Outage' })).body;
    check('fault incident created as open', fault.status === 'open');
    const fa = await call('op', 'POST', `/incidents/${fault.id}/assign`, { crewId: 'C005' });
    check('fault assign -> dispatched', fa.body.incident?.status === 'dispatched');
    const fj = fa.body.job.id;
    check('fault job On Site -> incident in_progress (existing route)', (await call('c5', 'PATCH', `/mobile/jobs/${fj}/status`, { status: 'On Site' })).status === 200 && (await repo.incident(fault.id)).status === 'in_progress');
    check('fault job Work Started needs no permit', (await call('c5', 'PATCH', `/mobile/jobs/${fj}/status`, { status: 'Work Started' })).status === 200);
    check('fault job Work Complete -> incident pending', (await call('c5', 'PATCH', `/mobile/jobs/${fj}/status`, { status: 'Work Finished' })).status === 200 && (await repo.incident(fault.id)).status === 'pending');
    const fr = await call('op', 'PATCH', `/incidents/${fault.id}/status`, { status: 'resolved' });
    check('fault PATCH /incidents/:id/status still works', fr.status === 200 && fr.body.status === 'resolved');
    const fg = await call('op', 'GET', `/incidents/${fault.id}`);
    check('fault GET /incidents/:id still lists next states', Array.isArray(fg.body.nextStates) && fg.body.nextStates.includes('closed') && !fg.body.plannedOutageId);
    check('fault mobile job routes untouched (no planned-outage view)', (await call('c5', 'GET', `/mobile/jobs/${fj}/planned-outage`)).body.code === 'NOT_A_PLANNED_JOB');
  } catch (e) {
    fails++;
    console.log('  [FAIL] unexpected error', e.stack);
  }
  console.log('  ----------------------------------------');
  console.log(`  ${passes}/${passes + fails} passed`);
  server.close();
  await db.$pool.end().catch(() => {});
  process.exit(fails ? 1 : 0);
});
