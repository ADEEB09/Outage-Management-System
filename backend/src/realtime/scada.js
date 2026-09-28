import { nanoid } from 'nanoid';
import { bus, TOPICS } from '../domain/bus.js';
import { repo } from '../infra/repo.js';
import { resolve as resolveAsset } from '../infra/geo.js';
import { setTag } from '../infra/redis.js';

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

export async function handleScadaEvent(evt) {
  try {
    // Always push the raw value into the RTDB tag cache first -- even non-outage
    // conditions matter for the live HMI (Phase 2's live tag view). Non-fatal
    // if Redis is down.
    if (evt.tag) {
      await setTag(evt.tag, evt.limit_val ?? evt.value ?? evt.condition, evt.quality || 'GOOD');
    }

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
        recentByAsset.set(key, { incidentId: inc.id, ts: now });
        return { deduplicated: true, incidentId: inc.id };
      }
    }

    // --- classify (FR-OMS-004) ---
    const customers = estimateCustomers(evt, loc);
    const severity = classifySeverity(evt.condition, customers);

    // --- auto-create the incident (FR-OMS-001) ---
    const id = await repo.nextIncidentId();
    const openedAt = new Date().toISOString();
    const inc = await repo.createIncident({
      id,
      type: 'outage',
      severity,
      status: 'open',
      zone: loc.substation || null,
      feeder: loc.feeder || null,
      substation: loc.substation || null,
      customers,
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
      `Auto-detected from SCADA ${evt.condition} on ${evt.tag || key} - ${severity} severity, ~${customers} customers`);
    await repo.audit('SCADA', 'incident.autodetect', id);
    if (evt.id) await repo.updateAlarm(evt.id, { incident_id: id }).catch(() => {});

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