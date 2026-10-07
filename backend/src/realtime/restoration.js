import { bus, TOPICS } from '../domain/bus.js';
import { repo } from '../infra/repo.js';

// ============================================================
// Phase 2 — Restoration command publisher (INT-002)
//
// When an incident reaches "resolved" (crew confirms power is back), the
// production DMS needs to be told the feeder is re-energised so its own
// topology model flips the switch state back to closed/normal. This module
// is that publisher: it listens for the incident lifecycle event, builds one
// restoration command per incident, and POSTs it to the DMS's REST endpoint.
//
// Two properties the roadmap calls for explicitly:
//   - Authenticated: a bearer token is attached if DMS_API_TOKEN is set.
//   - Idempotent: the command carries the incident id as its idempotency
//     key, and this module tracks which incidents it has already published
//     for, so a duplicate "resolved" event (e.g. a retry, or two instances
//     running) never sends the same restoration command twice.
//
// DMS_RESTORATION_URL defaults to this same app's own mock DMS endpoint
// (see routes/api.js: POST /dms/restore) — that mock exists specifically so
// this whole path is testable end-to-end without a real utility DMS
// connection, exactly like the SCADA fault-injection endpoint from P2.1/P2.3.
// ============================================================

function dmsUrl() {
  return process.env.DMS_RESTORATION_URL || `http://localhost:${process.env.PORT || 4000}/api/dms/restore`;
}
const DMS_TOKEN = process.env.DMS_API_TOKEN || null;
const MAX_RETRIES = 3;

// In-memory idempotency guard — a Set of incident ids already published this
// run. The DB-backed check below (audit_log) is the authoritative guard that
// survives restarts / multiple instances; this Set just avoids a redundant
// audit-log query on the common case of one event firing once.
const published = new Set();

async function alreadyPublished(incidentId) {
  if (published.has(incidentId)) return true;
  const log = await repo.auditLog();
  return log.some((e) => e.action === 'dms.restoration.published' && e.target === incidentId);
}

function buildCommand(incident) {
  return {
    idempotencyKey: `restore-${incident.id}`,
    incidentId: incident.id,
    feeder: incident.feeder,
    substation: incident.substation,
    action: 'CLOSE', // restoration = re-close the switch/breaker that isolated the fault
    resolvedAt: new Date().toISOString(),
    customersRestored: incident.customers || 0,
  };
}

async function postWithRetry(command, attempt = 1) {
  try {
    const headers = { 'content-type': 'application/json' };
    if (DMS_TOKEN) headers.authorization = `Bearer ${DMS_TOKEN}`;
    const res = await fetch(dmsUrl(), { method: 'POST', headers, body: JSON.stringify(command) });
    if (!res.ok) throw new Error(`DMS responded ${res.status}`);
    return await res.json().catch(() => ({}));
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    // Exponential-ish backoff: 300ms, 900ms — short because this is a REST
    // call to a DMS that's expected to be up; a real deployment would tune
    // this against the DMS's actual SLA.
    await new Promise((r) => setTimeout(r, 300 * attempt));
    return postWithRetry(command, attempt + 1);
  }
}

export async function publishRestoration(incident) {
  // Restored by SCADA = the device itself reported closed, so the DMS already
  // knows; commanding a CLOSE would be redundant (OMS-02).
  if (incident.restored_by === 'SCADA') return { skipped: true, reason: 'restored by SCADA' };
  if (await alreadyPublished(incident.id)) return { skipped: true, reason: 'already published' };
  const command = buildCommand(incident);
  try {
    const response = await postWithRetry(command);
    published.add(incident.id);
    await repo.audit('system', 'dms.restoration.published', incident.id);
    await repo.addIncidentEvent(incident.id, 'DMS', 'restoration',
      `Restoration command sent to DMS for ${incident.feeder || incident.substation || 'unknown asset'} — switch commanded CLOSE`);
    bus.publish('dms.restoration.published', { incident: incident.id, command, response });
    return { skipped: false, command, response };
  } catch (err) {
    console.error(`[dms] restoration command failed for ${incident.id}:`, err.message);
    await repo.addIncidentEvent(incident.id, 'DMS', 'restoration',
      `Restoration command to DMS FAILED after ${MAX_RETRIES} attempts: ${err.message} — will not auto-retry; needs manual follow-up`);
    return { skipped: false, error: err.message };
  }
}

export function startRestorationPublisher() {
  bus.subscribe(TOPICS.INCIDENT_UPDATED, (incident) => {
    if (incident?.status === 'resolved') publishRestoration(incident);
  });
  console.log(`[dms] restoration publisher active → ${dmsUrl()}`);
}

// Exposed for the self-test so idempotency state can be reset between assertions.
export function _resetPublishedState() { published.clear(); }