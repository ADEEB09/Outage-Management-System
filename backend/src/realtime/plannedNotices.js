// OMS-01 advance notice of planned outages. Every minute, approved outages
// whose notice is due (window start minus notice_lead_minutes) are marked
// notified and the notice is handed to the notifier. Due/sent state lives in
// the database, so a restart never loses or repeats a notice.
//
// Recipients are whatever the notifier sends to today (NOTIFY_TEST_TO):
// there is no customer-to-network data to target real customers yet.
import { bus, TOPICS } from '../domain/bus.js';
import { repo } from '../infra/repo.js';
import { SYSTEM_ACTOR } from '../domain/plannedOutage.js';

const CHECK_EVERY_MS = 60 * 1000;

export function publishNotice(outage) {
  bus.publish(TOPICS.PLANNED_NOTICE, {
    plannedOutageId: outage.id, incident: outage.incident,
    windowStart: outage.window_start, windowEnd: outage.window_end, workDescription: outage.work_description,
  });
}

export async function sendDueNotices(now = new Date()) {
  const sent = [];
  for (const po of await repo.dueNotices(now)) {
    const out = await repo.markNotified(po.id, SYSTEM_ACTOR);
    if (out.error) continue; // e.g. an operator notified or rescheduled it meanwhile
    publishNotice(out.outage);
    bus.publish(TOPICS.INCIDENT_UPDATED, out.outage.incident);
    bus.publish(TOPICS.PLANNED_OUTAGE_UPDATED, { id: out.outage.id, incidentId: out.outage.incident_id, status: out.outage.incident.status, planState: out.outage.plan.state, transitions: out.transitions });
    sent.push(po.id);
  }
  return sent;
}

export function startPlannedNotices() {
  const run = () => sendDueNotices().catch((e) => console.error('[plannedNotices] check failed:', e.message));
  run();
  return setInterval(run, CHECK_EVERY_MS);
}
