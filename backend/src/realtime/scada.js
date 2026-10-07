import { nanoid } from 'nanoid';
import { bus, TOPICS } from '../domain/bus.js';
import { repo } from '../infra/repo.js';
import { resolve as resolveAsset } from '../infra/geo.js';
import { setTag, cacheDel } from '../infra/redis.js';
import { canScadaRestore, LABELS } from '../domain/lifecycle.js';
import { predictDownstream } from '../domain/prediction.js';
import { sendRestorationCallbacks } from './notifier.js';

// ============================================================
// Phase 2 ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â SCADA & DMS integration: fault-event ingest + auto-detection
//
// This is the piece that turns the OMS from "operators manually raise
// incidents" into "the grid tells us it faulted and an incident appears on
// its own." It consumes SCADA fault events off the event bus (Kafka topic
// scada.alarm.raised ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â INT-001), and for each genuine fault:
//   1. resolves WHICH part of the network faulted (feeder/substation) ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â via
//      the existing PostGIS-backed geo resolver;
//   2. de-duplicates against outages already open on the same asset within a
//      short window, so one feeder trip doesn't spawn 20 incidents
//      (FR-OMS-003);
//   3. classifies severity from the SCADA condition + how many customers the
//      faulted asset feeds (FR-OMS-004);
//   4. auto-creates the incident and publishes it, exactly as if an operator
//      had (FR-OMS-001).
//
// It deliberately reuses repo + geo + the bus rather than introducing a new
// data path, so everything the control room, indices, and dispatch already do
// works unchanged on an auto-detected incident.
// ============================================================

// Dedup window: two fault events on the same feeder within this window are
// treated as the same outage. 60s per FR-OMS-003.
const DEDUP_WINDOW_MS = 60_000;

// SCADA "condition" ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ base severity. TRIP/CRITICAL is a confirmed outage;
// MAJOR is likely; MINOR is usually a warning that isn't an outage on its own.
const CONDITION_SEVERITY = {
  CRITICAL: 'critical',
  TRIP: 'critical',
  MAJOR: 'high',
  MINOR: 'medium',
};

// Rough customers-per-kVA heuristic used only when we can't get a real count,
// so severity has *something* to weigh. Documented as an assumption, not a
// measurement ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Phase 3's load model will replace this.
const CUSTOMERS_PER_KVA = 2;

// In-memory index of "asset ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ most recent open incident id + time", so dedup
// is O(1) and doesn't hammer the DB on every tag. Rebuilt lazily; the DB is
// still the source of truth (we double-check there before creating).
const recentByAsset = new Map(); // key: feeder||substation, val: { incidentId, ts }

function assetKey(loc) {
  return (loc.feeder || loc.substation || 'UNKNOWN').toUpperCase();
}

// Is this SCADA condition actually an outage we should open an incident for?
// MINOR alarms (e.g. a load approaching a limit) are recorded but don't by
// themselves create an outage ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â that would flood the control room.
function isOutageCondition(condition) {
  const sev = CONDITION_SEVERITY[(condition || '').toUpperCase()];
  return sev === 'critical' || sev === 'high';
}

// Pull lat/lon out of a SCADA event if it carries them; otherwise fall back to
// resolving from the tag's asset. Real SCADA points are geo-tagged; the
// simulator's tags aren't, so we tolerate both.
function locate(evt) {
  if (typeof evt.lat === 'number' && typeof evt.lon === 'number') {
    return { ...resolveAsset(evt.lat, evt.lon), lat: evt.lat, lon: evt.lon };
  }
  // Tag shape like "DEHRA.SE01.T2.MW" follows SUBSTATION.FEEDER.DEVICE.SIGNAL.
  // Without coordinates we can't geo-resolve, so we read the asset identity
  // straight from the tag path: token 0 = substation, tokens 0+1 = feeder.
  // Deriving both the same way every time is what makes dedup keys line up
  // regardless of whether a later event also carries explicit fields.
  const parts = (evt.tag || '').split('.').filter(Boolean);
  const substation = evt.substation || parts[0] || null;
  const feeder = evt.feeder || (parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null);
  return {
    dt_id: null,
    feeder,
    substation,
    substation_code: parts[0] || null,
    lat: null,
    lon: null,
  };
}

// Estimate affected customers for severity weighting. Prefers a real count if
// the event carries one; else a documented kVA-based heuristic; else 0.
function estimateCustomers(evt, loc) {
  if (typeof evt.customers === 'number') return evt.customers;
  if (typeof evt.kva === 'number') return Math.round(evt.kva * CUSTOMERS_PER_KVA);
  return 0;
}

// Final severity = base severity from condition, escalated one step if the
// faulted asset feeds a lot of customers. Keeps critical as the ceiling.
function classifySeverity(condition, customers) {
  let sev = CONDITION_SEVERITY[(condition || '').toUpperCase()] || 'medium';
  if (customers >= 1000 && sev === 'high') sev = 'critical';
  if (customers >= 500 && sev === 'medium') sev = 'high';
  return sev;
}

// The core handler: one SCADA fault event in, at most one incident out.
// Severity ranking so we can tell whether a SCADA confirmation should
// actually upgrade an incident's severity, or just corroborate it as-is.
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

// If the incident we just matched a SCADA event against was opened from a
// customer complaint alone (unconfirmed), a real electrical confirmation is
// meaningfully different from "one more customer said the same thing" --
// it should be logged distinctly, and if SCADA's own classification implies
// a higher severity than the complaint-based guess, the incident should be
// upgraded to reflect that. Returns true if it wrote a "confirmed" event
// (so the caller can skip its own generic dedup note).
async function corroborateFromCustomerReport(inc, evt, loc) {
  if (inc.source !== 'Customer') return false;
  const customers = estimateCustomers(evt, loc);
  const scadaSeverity = classifySeverity(evt.condition, customers);
  if (SEVERITY_RANK[scadaSeverity] > SEVERITY_RANK[inc.severity]) {
    await repo.updateIncident(inc.id, { severity: scadaSeverity });
    await repo.addIncidentEvent(inc.id, 'SCADA', 'confirmed',
      `SCADA confirmed this outage (was customer-reported only) - severity upgraded ${inc.severity} to ${scadaSeverity}`);
    bus.publish(TOPICS.INCIDENT_UPDATED, await repo.incident(inc.id));
  } else {
    await repo.addIncidentEvent(inc.id, 'SCADA', 'confirmed',
      `SCADA confirmed this outage (was customer-reported only) - severity unchanged (${inc.severity})`);
  }
  return true;
}

// ---- OMS-02: downstream prediction, trip tags, reclose ----

// Record the trip's tag on the incident it created or was merged into, and
// attach a downstream prediction if the incident doesn't have one yet.
async function recordTrip(incidentId, evt, loc) {
  if (evt.tag) await repo.addTripTag(incidentId, evt.tag);
  const inc = await repo.incident(incidentId);
  if (inc && !inc.prediction) {
    const prediction = await predictDownstream({ feeder: loc.feeder, cim_mrid: evt.cim_mrid });
    prediction.customers_source = typeof evt.customers === 'number' ? 'event' : 'estimated';
    await repo.updateIncident(incidentId, { prediction });
    await repo.addIncidentEvent(incidentId, 'SCADA', 'predicted', predictionNote(prediction));
  }
}

function predictionNote(p) {
  if (p.method === 'none') return `Downstream prediction unavailable: ${p.basis}`;
  if (p.method === 'cim-trace') return `Predicted downstream: ${p.transformers} transformers (CIM trace) - ${p.basis}`;
  return `Predicted downstream: ${p.transformers} transformers, ~${p.customers_estimate} customers (feeder-level, ${p.kva_total} kVA on ${p.feeder})`;
}

const momentaryMaxMin = () => Number(process.env.MOMENTARY_MAX_MIN) || 5;

// The tripped device reported closed again. Remove its tag from every active
// incident holding it; an incident is restored only once no tripped device
// remains open on it.
async function handleReclose(evt) {
  if (!evt.tag) return { restored: [], pending: [] };
  const touched = await repo.removeTripTag(evt.tag);
  const restored = [], pending = [];
  for (const inc of touched) {
    const left = inc.open_trip_tags || [];
    if (left.length) {
      await repo.addIncidentEvent(inc.id, 'SCADA', 'field', `${evt.tag} reclosed; still open: ${left.join(', ')}`);
      pending.push(inc.id);
      continue;
    }
    const r = await restoreFromScada(inc, evt.tag);
    if (r) restored.push(r);
  }
  return { restored, pending };
}

async function restoreFromScada(inc, tag) {
  if (!canScadaRestore(inc.status)) return null;
  const now = new Date();
  const minutes = (now.getTime() - new Date(inc.opened_at).getTime()) / 60000;
  const momentary = minutes <= momentaryMaxMin();

  if (inc.crew_id) {
    await repo.addIncidentEvent(inc.id, 'SCADA', 'restored',
      `Restored by SCADA while crew ${inc.crew_id} assigned - confirm whether the crew is still needed`);
  }
  await repo.updateIncident(inc.id, { status: 'resolved', restored_by: 'SCADA', resolved_at: now.toISOString(), momentary, ert: null });
  await repo.addIncidentEvent(inc.id, 'SCADA', 'status',
    `${LABELS[inc.status]} - ${LABELS.resolved} - ${tag} reclosed after ${minutes.toFixed(1)} min (${momentary ? 'momentary' : 'sustained'})`);
  if (momentary) {
    await repo.updateIncident(inc.id, { status: 'closed' });
    await repo.addIncidentEvent(inc.id, 'SCADA', 'status',
      `${LABELS.resolved} - ${LABELS.closed} - auto-closed as momentary interruption (<= ${momentaryMaxMin()} min, counted in MAIFI)`);
  }
  await repo.audit('SCADA', momentary ? 'incident.momentary' : 'incident.scada_restored', inc.id);
  await cacheDel('indicators'); // SAIDI/SAIFI/MAIFI change now, not after the 15 s cache TTL
  const final = await repo.incident(inc.id);
  await sendRestorationCallbacks(final);
  // Published once, after the final status, so status-driven listeners fire once.
  bus.publish(TOPICS.INCIDENT_UPDATED, final);
  return { incidentId: inc.id, momentary, status: final.status };
}

export async function handleScadaEvent(evt) {
  try {
    // Always push the raw value into the RTDB tag cache first -- even non-outage
    // conditions matter for the live HMI (Phase 2's live tag view). Non-fatal
    // if Redis is down.
    if (evt.tag) {
      await setTag(evt.tag, evt.limit_val ?? evt.value ?? evt.condition, evt.quality || 'GOOD');
    }

    if (evt.event === 'reclose') return { reclose: true, ...(await handleReclose(evt)) };

    if (!isOutageCondition(evt.condition)) return null; // recorded, not an outage

    const loc = locate(evt);
    const key = assetKey(loc);
    const now = Date.now();

    // --- de-duplication (FR-OMS-003) ---
    // 1) fast in-memory check
    const recent = recentByAsset.get(key);
    if (recent && now - recent.ts < DEDUP_WINDOW_MS) {
      // Same asset, same window -- attach as evidence to the existing incident
      // instead of opening a new one. If that incident was customer-reported
      // only, this SCADA event is a real confirmation, not just a repeat.
      const existingInc = await repo.incident(recent.incidentId);
      const confirmed = existingInc ? await corroborateFromCustomerReport(existingInc, evt, loc) : false;
      if (!confirmed) {
        await repo.addIncidentEvent(recent.incidentId, 'SCADA', 'field',
          `Correlated SCADA ${evt.condition} on ${evt.tag || key} (deduplicated)`);
      }
      if (evt.id) await repo.updateAlarm(evt.id, { incident_id: recent.incidentId }).catch(() => {});
      await recordTrip(recent.incidentId, evt, loc);
      recentByAsset.set(key, { incidentId: recent.incidentId, ts: now });
      return { deduplicated: true, incidentId: recent.incidentId };
    }
    // 2) authoritative DB check -- covers restarts / multiple app instances,
    //    where the in-memory index is cold. Reuses the same helper the
    //    trouble-call path uses.
    if (loc.substation) {
      const open = await repo.activeIncidentsAtSubstation(loc.substation);
      if (open && open.length) {
        const inc = open[0];
        const confirmed = await corroborateFromCustomerReport(inc, evt, loc);
        if (!confirmed) {
          await repo.addIncidentEvent(inc.id, 'SCADA', 'field',
            `Correlated SCADA ${evt.condition} on ${evt.tag || key} (deduplicated)`);
        }
        if (evt.id) await repo.updateAlarm(evt.id, { incident_id: inc.id }).catch(() => {});
        await recordTrip(inc.id, evt, loc);
        recentByAsset.set(key, { incidentId: inc.id, ts: now });
        return { deduplicated: true, incidentId: inc.id };
      }
    }

    // --- classify (FR-OMS-004) ---
    const customers = estimateCustomers(evt, loc);
    const severity = classifySeverity(evt.condition, customers);

    // --- downstream prediction (OMS-02) ---
    // A real customer count on the event always wins; otherwise the incident
    // carries the prediction's kVA-share estimate. Severity above is unchanged.
    const prediction = await predictDownstream({ feeder: loc.feeder, cim_mrid: evt.cim_mrid });
    const hasRealCount = typeof evt.customers === 'number';
    prediction.customers_source = hasRealCount ? 'event' : 'estimated';
    const incCustomers = hasRealCount || prediction.customers_estimate == null ? customers : prediction.customers_estimate;

    // --- auto-create the incident (FR-OMS-001) ---
    const id = await repo.nextIncidentId();
    const openedAt = new Date().toISOString();
    const created = await repo.createIncident({
      id,
      type: 'outage',
      severity,
      status: 'open',
      zone: loc.substation || null,
      feeder: loc.feeder || null,
      substation: loc.substation || null,
      customers: incCustomers,
      cause: `SCADA ${evt.condition} on ${evt.tag || key}`,
      lat: loc.lat,
      lon: loc.lon,
      crew_id: null,
      opened_at: openedAt,
      ert: null,
      sla_due_at: null,
      source: 'SCADA',
    });
    await repo.addIncidentEvent(id, 'SCADA', 'created',
      `Auto-detected from SCADA ${evt.condition} on ${evt.tag || key} - ${severity} severity, ~${incCustomers} customers`);
    await repo.audit('SCADA', 'incident.autodetect', id);
    if (evt.id) await repo.updateAlarm(evt.id, { incident_id: id }).catch(() => {});
    if (evt.tag) await repo.addTripTag(id, evt.tag);
    await repo.updateIncident(id, { prediction });
    await repo.addIncidentEvent(id, 'SCADA', 'predicted', predictionNote(prediction));
    const inc = await repo.incident(id) || created;

    recentByAsset.set(key, { incidentId: id, ts: now });
    bus.publish(TOPICS.INCIDENT_CREATED, inc);
    return { deduplicated: false, incidentId: id, incident: inc };
  } catch (e) {
    console.error('[scada] failed to handle event', evt?.tag || '', e.message);
    return null;
  }
}

// Wire the consumer to the bus. Call once at boot AFTER initBus().
// Subscribes to the same ALARM_RAISED topic the simulator already publishes to,
// so in local dev the existing simulated alarms now drive real auto-detection;
// in production the SCADA ingest adapter (DNP3/IEC 61968, P2.2) publishes to the
// same topic and nothing here changes.
export function startScadaConsumer() {
  bus.subscribe(TOPICS.ALARM_RAISED, (evt) => { handleScadaEvent(evt); });
  console.log('[scada] fault-event consumer subscribed to', TOPICS.ALARM_RAISED);
}

// Exposed for the self-test so dedup state can be reset between assertions.
export function _resetDedupState() { recentByAsset.clear(); }