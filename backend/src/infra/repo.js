import { db } from './db.js';
import { nanoid } from 'nanoid';
import { canTransition, LABELS } from '../domain/lifecycle.js';
import * as rules from '../domain/plannedOutage.js';

// The only module that talks SQL. Every function is now async because the
// pg driver is async (unlike node:sqlite/better-sqlite3, which were sync).
// Named params use pg-promise's $/name/ syntax instead of the old bare @name.
const parseSkills = (r) => r ? { ...r, skills: r.skills ? r.skills.split(',') : [] } : r;

// Builds a "col=$/col/" SET clause from a patch object -- same dynamic-update
// pattern as before, just async at the call site now.
const setClause = (patch) => Object.keys(patch).map(k => `${k}=$/${k}/`).join(',');

// ---- OMS-01 planned outages: shared transaction helpers ----
// Every change to a planned outage runs in one transaction that first locks
// its switching_plans row, so two confirmations for the same outage are
// processed strictly one after the other. The rules themselves are in
// domain/plannedOutage.js; the change and its safety_log row commit together.

const STEP_ORDER = "ORDER BY CASE phase WHEN 'isolate' THEN 0 ELSE 1 END, seq";
const notFound = (what) => ({ error: { code: 'NOT_FOUND', message: `${what} not found`, status: 404 } });

async function loadOutage(t, plannedOutageId, { lock = false } = {}) {
  const po = await t.oneOrNone('SELECT * FROM planned_outages WHERE id=$1', [plannedOutageId]);
  if (!po) return null;
  const plan = await t.one(`SELECT * FROM switching_plans WHERE planned_outage_id=$1${lock ? ' FOR UPDATE' : ''}`, [po.id]);
  const incident = await t.one('SELECT * FROM incidents WHERE id=$1', [po.incident_id]);
  const steps = await t.any(`SELECT * FROM switching_steps WHERE plan_id=$1 ${STEP_ORDER}`, [plan.id]);
  const permits = await t.any('SELECT * FROM work_permits WHERE planned_outage_id=$1 ORDER BY requested_at', [po.id]);
  return { po, plan, incident, steps, permits };
}

const outageView = ({ po, plan, incident, steps, permits }) => ({ ...po, incident, plan, steps, permits });

function requireActor(actor) {
  if (!actor?.username || !Array.isArray(actor.roles)) throw new Error('planned-outage changes need a verified actor { username, roles, crewId }');
}

async function logSafety(t, plannedOutageId, actor, { entity, entityId, action, from = null, to = null, details = {}, occurredAt = null }) {
  await t.none(
    `INSERT INTO safety_log (id, occurred_at, actor, actor_role, actor_crew_id, planned_outage_id, entity, entity_id, action, from_state, to_state, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    ['SL' + nanoid(10), occurredAt, actor.username, rules.primaryRole(actor), actor.crewId || null,
      plannedOutageId, entity, entityId, action, from, to, JSON.stringify(details)]
  );
  // One line in the general audit trail too, so the Admin audit view shows it.
  await t.none('INSERT INTO audit_log (id,ts,actor,action,target) VALUES ($1,$2,$3,$4,$5)',
    ['AU' + nanoid(8), new Date().toISOString(), actor.username, `oms01.${action}`, `${plannedOutageId}:${entityId}`]);
}

// The only way a planned outage's incident changes status: checked against
// lifecycle.js, recorded as an incident event and in the safety log.
async function moveIncident(t, ctx, to, actor, note) {
  const from = ctx.incident.status;
  if (!canTransition(from, to, true)) throw new Error(`illegal planned-outage transition ${from} -> ${to}`);
  const patch = { status: to };
  if (to === 'resolved') Object.assign(patch, { resolved_at: new Date().toISOString(), restored_by: 'SWITCHING_PLAN', ert: null });
  await t.none(`UPDATE incidents SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id: ctx.incident.id });
  await t.none(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note) VALUES ($1,$2,$3,$4,'status',$5)`,
    ['EV' + nanoid(8), ctx.incident.id, new Date().toISOString(), actor.username, `${LABELS[from]} - ${LABELS[to]}${note ? ' - ' + note : ''}`]);
  await logSafety(t, ctx.po.id, actor, { entity: 'outage', entityId: ctx.po.id, action: 'outage.transition', from, to, details: { note: note || null } });
  ctx.incident = { ...ctx.incident, ...patch };
  return { from, to };
}

// Runs one change to a planned outage. `fn(t, ctx)` returns either
// { reject, entity, entityId, action } (logged as `${action}.rejected`, nothing
// else changes) or { result }. Afterwards the automatic transitions the plan
// and permits now imply are applied (notified -> isolating -> in_progress ...).
async function withOutage(plannedOutageId, actor, fn) {
  requireActor(actor);
  return db.tx(async (t) => {
    const ctx = await loadOutage(t, plannedOutageId, { lock: true });
    if (!ctx) return notFound('planned outage');
    const out = await fn(t, ctx);
    if (out.reject) {
      const { code, message, status } = out.reject;
      await logSafety(t, ctx.po.id, actor, { entity: out.entity, entityId: out.entityId, action: `${out.action}.rejected`, details: { code, message, ...(out.details || {}) } });
      return { error: { code, message, status } };
    }
    const transitions = [...(out.transitions || [])];
    for (let i = 0; i < 6; i++) {
      const fresh = await loadOutage(t, plannedOutageId);
      const to = rules.nextAutomaticStatus(fresh);
      if (!to) break;
      transitions.push(await moveIncident(t, fresh, to, actor, 'automatic'));
    }
    return { ...out.result, transitions, outage: outageView(await loadOutage(t, plannedOutageId)) };
  });
}

// A client-generated id must not already belong to a different record (a
// bug or a replay against the wrong item); checked before the UNIQUE
// constraint would turn it into a 500.
async function clientIdTaken(t, table, column, value, exceptId) {
  return !!(await t.oneOrNone(`SELECT 1 FROM ${table} WHERE ${column}=$1 AND id<>$2`, [value, exceptId || '']));
}

export const repo = {
  // ---- incidents
  incidents: () => db.any('SELECT * FROM incidents ORDER BY opened_at DESC'),
  incident: (id) => db.oneOrNone('SELECT * FROM incidents WHERE id=$1', [id]),
  incidentEvents: (id) => db.any('SELECT * FROM incident_events WHERE incident_id=$1 ORDER BY ts ASC', [id]),
  allIncidentEvents: () => db.any('SELECT * FROM incident_events ORDER BY ts ASC'),
  allJobUpdates: () => db.any('SELECT * FROM job_updates ORDER BY ts ASC'),
  // nextval() is atomic: two concurrent callers can never receive the same
  // number. The previous SELECT COUNT(*) version could, and the duplicate-key
  // error that followed crashed the whole process (P8.6 -- see
  // db/migrations/sequence_based_id_generation.sql). Same external format.
  nextIncidentId: async () => {
    const { n } = await db.one("SELECT nextval('incident_id_seq') n");
    return 'INC-2026-' + String(n).padStart(6, '0');
  },
  createIncident: async (i) => {
    // Known zone centroids for the Ganga Corridor network -- lets manually
    // created incidents (from the "New Incident" form, which has no map
    // picker) still get a real lat/lon so nearest-crew matching works,
    // instead of silently going geog=NULL and matching zero crews forever.
    const ZONE_COORDS = {
      'Mayapur': [29.940311, 78.147653],
      'Bhoopatwala': [29.971419, 78.182491],
      'Industrial Area': [29.921, 78.152],
      'Jwalapur-I': [29.930, 78.170],
      'Kankhal-2': [29.937, 78.174],
      'Dehradun Central': [30.3165, 78.0322],
      'Clement Town, Dehradun': [30.279, 77.977],
      'Ballupur, Dehradun': [30.348, 78.038],
      'Jwalapur, Haridwar': [29.930, 78.170],
    };
    let lat = i.lat;
    let lon = i.lon;
    if ((lat == null || lon == null) && i.zone && ZONE_COORDS[i.zone]) {
      lat = ZONE_COORDS[i.zone][0];
      lon = ZONE_COORDS[i.zone][1];
    }
    const row = { substation: null, ...i, lat, lon };
    await db.none(`INSERT INTO incidents
      (id,type,severity,status,zone,feeder,customers,cause,lat,lon,crew_id,opened_at,ert,sla_due_at,source,substation)
      VALUES ($/id/,$/type/,$/severity/,$/status/,$/zone/,$/feeder/,$/customers/,$/cause/,$/lat/,$/lon/,$/crew_id/,$/opened_at/,$/ert/,$/sla_due_at/,$/source/,$/substation/)`,
      row);
    return repo.incident(i.id);
  },
  updateIncident: async (id, patch) => {
    await db.none(`UPDATE incidents SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return repo.incident(id);
  },
  // SCADA trip tags still open on an incident (OMS-02). Atomic jsonb ops so
  // two concurrent events can't lose each other's tag.
  addTripTag: async (id, tag) => {
    await db.none(
      `UPDATE incidents SET
         open_trip_tags = CASE WHEN open_trip_tags ? $/tag/ THEN open_trip_tags ELSE open_trip_tags || to_jsonb($/tag/::text) END,
         trip_tag = COALESCE(trip_tag, $/tag/)
       WHERE id=$/id/`, { id, tag });
    return repo.incident(id);
  },
  // Removes the tag from every active incident holding it; returns those incidents after removal.
  removeTripTag: (tag) => db.any(
    `UPDATE incidents SET open_trip_tags = open_trip_tags - $/tag/
     WHERE open_trip_tags ? $/tag/ AND status NOT IN ('resolved','closed','cancelled')
     RETURNING *`, { tag }),
  addIncidentEvent: async (incidentId, actor, kind, note) => {
    const ev = { id: 'EV' + nanoid(8), incident_id: incidentId, ts: new Date().toISOString(), actor, kind, note };
    await db.none(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note)
      VALUES ($/id/,$/incident_id/,$/ts/,$/actor/,$/kind/,$/note/)`, ev);
    return ev;
  },
  // ---- complaints (external REST intake, dedup + merge, traceability)
  // phone is stored encrypted at rest (AES-256 via pgcrypto's pgp_sym_*).
  // Every read decrypts it back to plain text using ENCRYPTION_KEY; every
  // write encrypts it before it ever touches disk. If ENCRYPTION_KEY is
  // ever lost, encrypted phone numbers become permanently unrecoverable --
  // this is the real, correct tradeoff for genuine at-rest encryption.
  // safe_decrypt_text (db/migrations/safe_decrypt_phone.sql) wraps
  // pgp_sym_decrypt in a PL/pgSQL exception handler: a row whose phone
  // can't be decrypted with the current key (e.g. legacy/seeded data
  // encrypted under a different key) returns NULL instead of aborting
  // the whole query -- and, since these queries were previously called
  // with no try/catch, taking down the whole process.
  complaints: () => db.any(
    `SELECT qid, external_id, customer,
       safe_decrypt_text(phone, $/key/) AS phone,
       address, category, lat, lon, dt_id, feeder, substation, incident_id, action, ts
     FROM complaints ORDER BY ts DESC`,
    { key: process.env.ENCRYPTION_KEY }
  ),
  complaint: (qid) => db.oneOrNone(
    `SELECT qid, external_id, customer,
       safe_decrypt_text(phone, $/key/) AS phone,
       address, category, lat, lon, dt_id, feeder, substation, incident_id, action, ts
     FROM complaints WHERE qid=$/qid/`,
    { qid, key: process.env.ENCRYPTION_KEY }
  ),
  complaintsForIncident: (incidentId) => db.any(
    `SELECT qid, external_id, customer,
       safe_decrypt_text(phone, $/key/) AS phone,
       address, category, lat, lon, dt_id, feeder, substation, incident_id, action, ts
     FROM complaints WHERE incident_id=$/incidentId/ ORDER BY ts ASC`,
    { incidentId, key: process.env.ENCRYPTION_KEY }
  ),
  // Atomic, for the same reason as nextIncidentId above -- this is the exact
  // call that raced and took the backend down under concurrent complaints.
  nextQueryId: async () => {
    const { n } = await db.one("SELECT nextval('complaint_qid_seq') n");
    return 'QRY-2026-' + String(n).padStart(6, '0');
  },
  addComplaint: async (c) => {
    await db.none(`INSERT INTO complaints
      (qid,external_id,customer,phone,address,category,lat,lon,dt_id,feeder,substation,incident_id,action,ts)
      VALUES ($/qid/,$/external_id/,$/customer/,pgp_sym_encrypt($/phone/,$/key/),$/address/,$/category/,$/lat/,$/lon/,$/dt_id/,$/feeder/,$/substation/,$/incident_id/,$/action/,$/ts/)`,
      { ...c, key: process.env.ENCRYPTION_KEY });
    return repo.complaint(c.qid);
  },
  // Active incidents at a substation within the correlation window (most recent first).
  activeIncidentsAtSubstation: (substation, windowMin = 240) => {
    const cutoff = new Date(Date.now() - windowMin * 60000).toISOString();
    return db.any(
      `SELECT * FROM incidents
       WHERE substation IS NOT DISTINCT FROM $/substation/
         AND status NOT IN ('resolved','closed','cancelled')
         AND opened_at >= $/cutoff/
       ORDER BY opened_at DESC`,
      { substation, cutoff }
    );
  },

  // ---- crews
  crews: async () => (await db.any('SELECT * FROM crews ORDER BY name')).map(parseSkills),
  crew: async (id) => parseSkills(await db.oneOrNone('SELECT * FROM crews WHERE id=$1', [id])),
  updateCrew: async (id, patch) => {
    await db.none(`UPDATE crews SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return repo.crew(id);
  },
  // Bulk-insert GPS points uploaded by the crew app. Duplicate ids (a retried
  // upload whose earlier response was lost) are silently skipped.
  addCrewLocations: async (crewId, points) => {
    if (!points.length) return 0;
    const { helpers } = db.$config.pgp;
    const cs = new helpers.ColumnSet(
      ['id', 'crew_id', 'lat', 'lon', 'accuracy', 'speed', 'heading', 'recorded_at'],
      { table: 'crew_locations' }
    );
    const rows = points.map((p) => ({ ...p, crew_id: crewId }));
    const result = await db.result(`${helpers.insert(rows, cs)} ON CONFLICT (id) DO NOTHING`);
    return result.rowCount;
  },
  // Move the crew's live position only if this fix is newer than the one we
  // already have — an offline backlog flushed late must not rewind it.
  updateCrewLivePosition: async (crewId, { lat, lon, recorded_at }) => {
    const moved = await db.result(
      `UPDATE crews SET lat=$/lat/, lon=$/lon/, location_updated_at=$/recorded_at/
       WHERE id=$/crewId/ AND (location_updated_at IS NULL OR location_updated_at < $/recorded_at/)`,
      { crewId, lat, lon, recorded_at }
    );
    return moved.rowCount > 0;
  },
  // The newest `limit` fixes in the window, returned oldest -> newest. (Taking the
  // OLDEST `limit` instead would silently drop the most recent part of a long
  // window, which is the part dispatch wants to see.) received_at lets a client
  // tell a live fix from one recorded offline and uploaded later.
  crewTrack: (crewId, from, to, limit = 2000) =>
    db.any(
      `SELECT * FROM (
         SELECT lat, lon, accuracy, speed, heading, recorded_at, received_at FROM crew_locations
         WHERE crew_id=$/crewId/ AND recorded_at BETWEEN $/from/ AND $/to/
         ORDER BY recorded_at DESC LIMIT $/limit/
       ) t ORDER BY recorded_at ASC`,
      { crewId, from, to, limit }
    ),
  // Available crews nearest an incident, using real PostGIS distance -- replaces
  // picking "any available crew" with a distance-ranked list.
  nearestAvailableCrews: (incidentId, limit = 6) =>
    db.any(`
      SELECT c.*, public.ST_Distance(c.geog, i.geog) AS meters_away
      FROM crews c, incidents i
      WHERE i.id = $1
        AND c.status = 'available'
        AND c.geog IS NOT NULL AND i.geog IS NOT NULL
      ORDER BY meters_away
      LIMIT $2
    `, [incidentId, limit]),
  // ---- alarms
  alarms: () => db.any('SELECT * FROM alarms ORDER BY ts DESC'),
  updateAlarm: async (id, patch) => {
    await db.none(`UPDATE alarms SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return db.oneOrNone('SELECT * FROM alarms WHERE id=$1', [id]);
  },
  createAlarm: async (a) => {
    await db.none(`INSERT INTO alarms (id,tag,condition,limit_val,priority,message,ts,ack)
      VALUES ($/id/,$/tag/,$/condition/,$/limit_val/,$/priority/,$/message/,$/ts/,$/ack/)`, a);
    return db.oneOrNone('SELECT * FROM alarms WHERE id=$1', [a.id]);
  },

  // ---- trouble calls
  calls: () => db.any('SELECT * FROM trouble_calls ORDER BY ts DESC'),
  createCall: async (c) => {
    await db.none(`INSERT INTO trouble_calls (id,customer,phone,address,category,status,linked_id,ts,area)
      VALUES ($/id/,$/customer/,$/phone/,$/address/,$/category/,$/status/,$/linked_id/,$/ts/,$/area/)`, { area: null, ...c });
    return db.oneOrNone('SELECT * FROM trouble_calls WHERE id=$1', [c.id]);
  },
  updateCall: async (id, patch) => {
    await db.none(`UPDATE trouble_calls SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return db.oneOrNone('SELECT * FROM trouble_calls WHERE id=$1', [id]);
  },

  // ---- jobs (crew app)
  jobs: () => db.any('SELECT * FROM jobs ORDER BY updated_at DESC'),
  jobsForCrew: (crewId) => db.any('SELECT * FROM jobs WHERE crew_id=$1 ORDER BY updated_at DESC', [crewId]),
  jobUpdates: (jobId) => db.any('SELECT * FROM job_updates WHERE job_id=$1 ORDER BY ts ASC', [jobId]),
  jobsForIncident: (incidentId) => db.any('SELECT * FROM jobs WHERE incident_id=$1 ORDER BY updated_at DESC', [incidentId]),
  photosForIncident: (incidentId) => db.any(
    `SELECT p.id, p.job_id, p.lat, p.lon, p.note, p.ts, p.technician_id, p.metadata
     FROM job_photos p JOIN jobs j ON p.job_id = j.id
     WHERE j.incident_id = $1 ORDER BY p.ts DESC`,
    [incidentId]
  ),
  job: (id) => db.oneOrNone('SELECT * FROM jobs WHERE id=$1', [id]),
  createJob: async (j) => {
    await db.none(`INSERT INTO jobs (id,incident_id,crew_id,priority,status,address,updated_at)
      VALUES ($/id/,$/incident_id/,$/crew_id/,$/priority/,$/status/,$/address/,$/updated_at/)`, j);
    return repo.job(j.id);
  },
  updateJob: async (id, patch) => {
    await db.none(`UPDATE jobs SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return repo.job(id);
  },
  addJobUpdate: async (jobId, status, lat, lon, note) => {
    const u = { id: 'JU' + nanoid(8), job_id: jobId, status, lat, lon, note, ts: new Date().toISOString() };
    await db.none(`INSERT INTO job_updates (id,job_id,status,lat,lon,note,ts)
      VALUES ($/id/,$/job_id/,$/status/,$/lat/,$/lon/,$/note/,$/ts/)`, u);
    return u;
  },
  addAssetScan: async (scan) => {
    await db.none(
      `INSERT INTO asset_scans
       (id,job_id,crew_id,asset_id,raw_value,asset_details,lat,lon,scanned_at)
       VALUES ($/id/,$/job_id/,$/crew_id/,$/asset_id/,$/raw_value/,$/asset_details/,$/lat/,$/lon/,$/scanned_at/)`,
      scan
    );
    return db.one('SELECT * FROM asset_scans WHERE id=$1', [scan.id]);
  },
  assetScansForJob: (jobId) =>
    db.any('SELECT * FROM asset_scans WHERE job_id=$1 ORDER BY scanned_at DESC', [jobId]),
  addCrewLocation: async (crewId, lat, lon) =>
    db.one(
      `INSERT INTO crew_locations (crew_id, lat, lon) VALUES ($1, $2, $3)
       RETURNING id, crew_id, lat, lon, recorded_at`,
      [crewId, lat, lon]
    ),

  // ---- admin / audit
  audit: async (actor, action, target) => {
    await db.none(`INSERT INTO audit_log (id,ts,actor,action,target) VALUES ($1,$2,$3,$4,$5)`,
      ['AU' + nanoid(8), new Date().toISOString(), actor, action, target]);
  },
  auditLog: () => db.any('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 50'),

  // `image` is the already-compressed photo ({ buffer, contentType, width, height });
  // the returned row is metadata only, without the image bytes.
  addJobPhoto: async (jobId, { image, originalContentType, originalBytes }, lat, lon, note, technicianId, metadata) => {
    const ph = {
      id: 'PH' + nanoid(8),
      job_id: jobId,
      content_type: image.contentType,
      original_content_type: originalContentType ?? null,
      width: image.width,
      height: image.height,
      lat: lat ?? null,
      lon: lon ?? null,
      note: note ?? null,
      ts: new Date().toISOString(),
      technician_id: technicianId ?? null,
      metadata: { ...(metadata ?? {}), originalBytes, storedBytes: image.buffer.length },
    };
    await db.none(
      `INSERT INTO job_photos (id,job_id,image_data,content_type,original_content_type,width,height,lat,lon,note,ts,technician_id,metadata)
       VALUES ($/id/,$/job_id/,$/image_data/,$/content_type/,$/original_content_type/,$/width/,$/height/,$/lat/,$/lon/,$/note/,$/ts/,$/technician_id/,$/metadata:json/::jsonb)`,
      { ...ph, image_data: image.buffer }
    );
    return ph;
  },
  jobPhotos: (jobId) =>
    db.any('SELECT id, job_id, lat, lon, note, ts, technician_id, metadata FROM job_photos WHERE job_id=$1 ORDER BY ts DESC', [jobId]),
  jobPhotoById: (id) => db.oneOrNone('SELECT * FROM job_photos WHERE id=$1', [id]),

  addMessage: async (incidentId, sender, senderRole, body) => {
    const m = {
      id: 'MSG' + nanoid(8),
      incident_id: incidentId,
      sender,
      sender_role: senderRole ?? null,
      body,
      ts: new Date().toISOString(),
    };
    await db.none(
      `INSERT INTO messages (id,incident_id,sender,sender_role,body,ts)
       VALUES ($/id/,$/incident_id/,$/sender/,$/sender_role/,$/body/,$/ts/)`,
      m
    );
    return m;
  },
  messages: (incidentId) =>
    db.any('SELECT * FROM messages WHERE incident_id=$1 ORDER BY ts ASC', [incidentId]),
  messagesForCrew: (crewId) =>
    db.any(
      `SELECT m.*, j.id AS job_id, j.address AS job_address
       FROM messages m
       JOIN jobs j ON j.incident_id = m.incident_id
       WHERE j.crew_id=$1
       ORDER BY m.ts DESC`,
      [crewId]
    ),

  setOptOut: async (recipient, channel) => {
    await db.none(
      `INSERT INTO opt_outs (id, recipient, channel, ts) VALUES ($/id/, $/recipient/, $/channel/, $/ts/)`,
      { id: 'OPT' + nanoid(8), recipient, channel, ts: new Date().toISOString() }
    );
  },
  clearOptOut: (recipient, channel) =>
    db.none('DELETE FROM opt_outs WHERE recipient=$1 AND channel=$2', [recipient, channel]),
  isOptedOut: async (recipient, channel) => {
    // LIMIT 1: opting out twice inserts two rows, which made oneOrNone throw.
    const row = await db.oneOrNone('SELECT 1 FROM opt_outs WHERE recipient=$1 AND channel=$2 LIMIT 1', [recipient, channel]);
    return !!row;
  },
  callsForIncident: (incidentId) => db.any('SELECT * FROM trouble_calls WHERE linked_id=$1 ORDER BY ts ASC', [incidentId]),
  // Restoration callbacks (notifications.contact_ref = call id / complaint qid). Earliest per contact.
  callbacks: () => db.any(
    `SELECT DISTINCT ON (contact_ref) contact_ref, incident_id, status, ts
     FROM notifications WHERE contact_ref IS NOT NULL ORDER BY contact_ref, ts ASC`),
  callbacksForIncident: (incidentId) => db.any(
    'SELECT * FROM notifications WHERE incident_id=$1 AND contact_ref IS NOT NULL ORDER BY ts ASC', [incidentId]),
  saveMonthlySnapshot: async (monthKey, indices) => {
    await db.none(`
      INSERT INTO monthly_indices (month_key, saidi, saifi, caidi, maifi, computed_at)
      VALUES ($/monthKey/, $/saidi/, $/saifi/, $/caidi/, $/maifi/, now())
      ON CONFLICT (month_key) DO UPDATE SET
        saidi = EXCLUDED.saidi, saifi = EXCLUDED.saifi,
        caidi = EXCLUDED.caidi, maifi = EXCLUDED.maifi,
        computed_at = now()
    `, { monthKey, saidi: indices.saidi, saifi: indices.saifi, caidi: indices.caidi, maifi: indices.maifi });
  },
  getMonthlySnapshots: (limit = 12) =>
    db.any('SELECT * FROM monthly_indices ORDER BY month_key DESC LIMIT $1', [limit]),

  // ---- OMS-01 planned outages (docs/OMS-01-DESIGN.md) ----
  // Every write takes a verified actor { username, roles, crewId } and returns
  // either { error: { code, message, status } } or its result plus
  // `transitions` (incident status moves it caused) and the fresh `outage`.

  // Incident (type 'Scheduled', status 'scheduled', no SLA clock) + planned
  // outage + an empty draft switching plan.
  createPlannedOutage: async (input, actor) => {
    requireActor(actor);
    const bad = rules.checkCreateOutage(input, actor);
    if (bad) return { error: bad };
    const id = await repo.nextIncidentId();
    const poId = 'PO' + nanoid(8);
    const now = new Date().toISOString();
    const lead = Number.isInteger(input.noticeLeadMinutes) && input.noticeLeadMinutes >= 0 ? input.noticeLeadMinutes : 1440;
    await db.tx(async (t) => {
      await t.none(`INSERT INTO incidents
        (id,type,severity,status,zone,feeder,customers,cause,lat,lon,crew_id,opened_at,ert,sla_due_at,source,substation)
        VALUES ($/id/,'Scheduled',$/severity/,'scheduled',$/zone/,$/feeder/,$/customers/,$/cause/,$/lat/,$/lon/,NULL,$/now/,$/ert/,NULL,'PLANNED',$/substation/)`,
        { id, severity: input.severity || 'low', zone: input.zone, feeder: input.feeder || null, customers: input.customers || 0,
          cause: input.workDescription, lat: input.lat ?? null, lon: input.lon ?? null, now, ert: input.windowEnd, substation: input.substation || null });
      await t.none(`INSERT INTO planned_outages
        (id,incident_id,window_start,window_end,work_description,work_mrid,notice_lead_minutes,notice_due_at,created_by,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [poId, id, input.windowStart, input.windowEnd, input.workDescription, input.workMrid || null, lead,
          new Date(Date.parse(input.windowStart) - lead * 60000).toISOString(), actor.username, now]);
      await t.none('INSERT INTO switching_plans (id, planned_outage_id) VALUES ($1,$2)', ['SP' + nanoid(8), poId]);
      await t.none(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note) VALUES ($1,$2,$3,$4,'created',$5)`,
        ['EV' + nanoid(8), id, now, actor.username, `Planned outage scheduled - ${input.workDescription}`]);
      await logSafety(t, poId, actor, { entity: 'outage', entityId: poId, action: 'outage.create', to: 'scheduled',
        details: { incidentId: id, windowStart: input.windowStart, windowEnd: input.windowEnd } });
    });
    return { outage: await repo.plannedOutage(poId), transitions: [] };
  },

  plannedOutage: async (id) => {
    const ctx = await loadOutage(db, id);
    return ctx ? outageView(ctx) : null;
  },
  plannedOutageByIncident: async (incidentId) => {
    const row = await db.oneOrNone('SELECT id FROM planned_outages WHERE incident_id=$1', [incidentId]);
    return row ? repo.plannedOutage(row.id) : null;
  },
  plannedOutageForJob: async (jobId) => {
    const row = await db.oneOrNone('SELECT po.id FROM planned_outages po JOIN jobs j ON j.incident_id = po.incident_id WHERE j.id=$1', [jobId]);
    return row ? repo.plannedOutage(row.id) : null;
  },
  plannedOutages: () => db.any(
    `SELECT po.*, i.status, i.zone, i.feeder, i.substation, i.customers, i.crew_id,
            sp.state AS plan_state,
            (SELECT count(*) FROM switching_steps s WHERE s.plan_id = sp.id)::int AS step_count,
            (SELECT count(*) FROM switching_steps s WHERE s.plan_id = sp.id AND s.state = 'confirmed')::int AS steps_confirmed,
            (SELECT count(*) FROM work_permits p WHERE p.planned_outage_id = po.id AND p.state IN ('requested','issued'))::int AS open_permits
     FROM planned_outages po
     JOIN incidents i ON i.id = po.incident_id
     JOIN switching_plans sp ON sp.planned_outage_id = po.id
     ORDER BY po.window_start`),
  safetyLog: (plannedOutageId) => db.any('SELECT * FROM safety_log WHERE planned_outage_id=$1 ORDER BY ts, id', [plannedOutageId]),

  // Replace every step of a draft plan. opts.source/traceCaveat when the
  // steps were drafted from sectionalize.js (Phase 3).
  replaceDraftSteps: (plannedOutageId, steps, actor, { source = 'manual', traceCaveat = null } = {}) =>
    withOutage(plannedOutageId, actor, async (t, ctx) => {
      const reject = rules.checkEditPlan({ plan: ctx.plan, actor }) || rules.checkDraftSteps(steps);
      if (reject) return { reject, entity: 'plan', entityId: ctx.plan.id, action: 'plan.edit' };
      await t.none('DELETE FROM switching_steps WHERE plan_id=$1', [ctx.plan.id]);
      for (const s of steps) {
        await t.none(`INSERT INTO switching_steps (id,plan_id,phase,seq,action,device_mrid,device_label,location,assignee,assignee_crew_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          ['SS' + nanoid(8), ctx.plan.id, s.phase, s.seq, s.action, s.device_mrid || null, s.device_label, s.location, s.assignee,
            s.assignee === 'crew' ? s.assignee_crew_id : null]);
      }
      await t.none('UPDATE switching_plans SET source=$2, trace_caveat=$3 WHERE id=$1', [ctx.plan.id, source, traceCaveat]);
      await logSafety(t, ctx.po.id, actor, { entity: 'plan', entityId: ctx.plan.id, action: 'plan.edit', details: { source, steps } });
      return { result: {} };
    }),

  // Approval is a named, logged act: the approver takes responsibility for
  // the order and content of the plan (the trace can't know switch states).
  approvePlan: (plannedOutageId, actor) =>
    withOutage(plannedOutageId, actor, async (t, ctx) => {
      const reject = rules.checkApprovePlan({ plan: ctx.plan, steps: ctx.steps, actor });
      if (reject) return { reject, entity: 'plan', entityId: ctx.plan.id, action: 'plan.approve' };
      await t.none("UPDATE switching_plans SET state='approved', approved_by=$2, approved_at=now() WHERE id=$1", [ctx.plan.id, actor.username]);
      await logSafety(t, ctx.po.id, actor, { entity: 'plan', entityId: ctx.plan.id, action: 'plan.approve', from: 'draft', to: 'approved',
        details: { steps: ctx.steps.map(({ phase, seq, action, device_label, location, assignee, assignee_crew_id }) => ({ phase, seq, action, device_label, location, assignee, assignee_crew_id })), traceCaveat: ctx.plan.trace_caveat } });
      return { result: {} };
    }),

  unapprovePlan: (plannedOutageId, actor) =>
    withOutage(plannedOutageId, actor, async (t, ctx) => {
      const reject = rules.checkUnapprovePlan({ plan: ctx.plan, steps: ctx.steps, actor });
      if (reject) return { reject, entity: 'plan', entityId: ctx.plan.id, action: 'plan.unapprove' };
      await t.none("UPDATE switching_plans SET state='draft', approved_by=NULL, approved_at=NULL WHERE id=$1", [ctx.plan.id]);
      await logSafety(t, ctx.po.id, actor, { entity: 'plan', entityId: ctx.plan.id, action: 'plan.unapprove', from: 'approved', to: 'draft' });
      return { result: {} };
    }),

  // scheduled -> notified: notice sent (by the notifier / scheduler) or
  // skipped by an operator with a reason.
  markNotified: (plannedOutageId, actor, { skip = false, reason = null } = {}) =>
    withOutage(plannedOutageId, actor, async (t, ctx) => {
      const reject = rules.checkNotify({ incident: ctx.incident, plan: ctx.plan, actor, skip, reason });
      if (reject) return { reject, entity: 'outage', entityId: ctx.po.id, action: 'outage.notify' };
      if (skip) await t.none('UPDATE planned_outages SET notice_skipped_reason=$2 WHERE id=$1', [ctx.po.id, reason]);
      else await t.none('UPDATE planned_outages SET notice_sent_at=now() WHERE id=$1', [ctx.po.id]);
      await logSafety(t, ctx.po.id, actor, { entity: 'outage', entityId: ctx.po.id, action: skip ? 'outage.notice_skipped' : 'outage.notice_sent', details: { reason } });
      return { result: {}, transitions: [await moveIncident(t, ctx, 'notified', actor, skip ? `notice skipped: ${reason}` : 'customers notified')] };
    }),

  // Approved plans whose notice is due and not yet sent or skipped.
  dueNotices: (now = new Date()) => db.any(
    `SELECT po.* FROM planned_outages po
     JOIN incidents i ON i.id = po.incident_id AND i.status = 'scheduled'
     JOIN switching_plans sp ON sp.planned_outage_id = po.id AND sp.state = 'approved'
     WHERE po.notice_sent_at IS NULL AND po.notice_skipped_reason IS NULL AND po.notice_due_at <= $1
     ORDER BY po.notice_due_at`, [now.toISOString()]),

  // New window; a notified outage goes back to scheduled so it is notified again.
  reschedulePlannedOutage: (plannedOutageId, actor, { windowStart, windowEnd, workDescription }) =>
    withOutage(plannedOutageId, actor, async (t, ctx) => {
      const reject = rules.checkReschedule({ incident: ctx.incident, steps: ctx.steps, actor, windowStart, windowEnd });
      if (reject) return { reject, entity: 'outage', entityId: ctx.po.id, action: 'outage.reschedule' };
      const dueAt = new Date(Date.parse(windowStart) - ctx.po.notice_lead_minutes * 60000).toISOString();
      await t.none(`UPDATE planned_outages SET window_start=$2, window_end=$3, work_description=COALESCE($4, work_description),
          notice_due_at=$5, notice_sent_at=NULL, notice_skipped_reason=NULL WHERE id=$1`,
        [ctx.po.id, windowStart, windowEnd, workDescription || null, dueAt]);
      await t.none('UPDATE incidents SET ert=$2 WHERE id=$1', [ctx.incident.id, windowEnd]);
      await logSafety(t, ctx.po.id, actor, { entity: 'outage', entityId: ctx.po.id, action: 'outage.reschedule',
        details: { from: { windowStart: ctx.po.window_start, windowEnd: ctx.po.window_end }, to: { windowStart, windowEnd } } });
      const transitions = ctx.incident.status === 'notified' ? [await moveIncident(t, ctx, 'scheduled', actor, 'rescheduled')] : [];
      return { result: {}, transitions };
    }),

  cancelPlannedOutage: (plannedOutageId, actor, { reason }) =>
    withOutage(plannedOutageId, actor, async (t, ctx) => {
      const reject = rules.checkCancel({ incident: ctx.incident, steps: ctx.steps, actor, reason });
      if (reject) return { reject, entity: 'outage', entityId: ctx.po.id, action: 'outage.cancel' };
      return { result: {}, transitions: [await moveIncident(t, ctx, 'cancelled', actor, reason)] };
    }),

  closePlannedOutage: (plannedOutageId, actor) =>
    withOutage(plannedOutageId, actor, async (t, ctx) => {
      const reject = rules.checkClose({ incident: ctx.incident, actor });
      if (reject) return { reject, entity: 'outage', entityId: ctx.po.id, action: 'outage.close' };
      return { result: {}, transitions: [await moveIncident(t, ctx, 'closed', actor, 'work order closed')] };
    }),

  // One switching step done. performedAt: when it physically happened (the
  // route clock-corrects it); received_at is always the server's now.
  confirmSwitchingStep: async (stepId, actor, { clientConfirmationId, performedAt = null, onBehalfNote = null, lat = null, lon = null }) => {
    const row = await db.oneOrNone('SELECT sp.planned_outage_id FROM switching_steps s JOIN switching_plans sp ON sp.id = s.plan_id WHERE s.id=$1', [stepId]);
    if (!row) return notFound('switching step');
    return withOutage(row.planned_outage_id, actor, async (t, ctx) => {
      const step = ctx.steps.find((s) => s.id === stepId);
      const base = { entity: 'step', entityId: stepId, action: 'step.confirm', details: { phase: step.phase, seq: step.seq, clientConfirmationId } };
      let reject = rules.checkConfirmStep({ ...ctx, step, actor, clientConfirmationId, onBehalfNote });
      if (reject?.replay) return { result: { step, replay: true } };
      if (!reject && await clientIdTaken(t, 'switching_steps', 'client_confirmation_id', clientConfirmationId, stepId)) {
        reject = { code: 'CLIENT_ID_REUSED', message: 'clientConfirmationId already belongs to another step', status: 409 };
      }
      if (reject) return { ...base, reject };
      const when = performedAt || new Date().toISOString();
      await t.none(`UPDATE switching_steps SET state='confirmed', confirmed_by=$2, performed_at=$3, received_at=now(),
          client_confirmation_id=$4, on_behalf_note=$5, lat=$6, lon=$7 WHERE id=$1`,
        [stepId, actor.username, when, clientConfirmationId, onBehalfNote, lat, lon]);
      await logSafety(t, ctx.po.id, actor, { entity: 'step', entityId: stepId, action: 'step.confirm', from: 'pending', to: 'confirmed', occurredAt: when,
        details: { phase: step.phase, seq: step.seq, action: step.action, device: step.device_label, location: step.location,
          assignee: step.assignee, assigneeCrewId: step.assignee_crew_id, clientConfirmationId, onBehalfNote, lat, lon } });
      return { result: { step: await t.one('SELECT * FROM switching_steps WHERE id=$1', [stepId]) } };
    });
  },

  // ---- work permits: online-only handshake (§3.4) ----
  requestPermit: async (jobId, actor, { clientRequestId }) => {
    const job = await db.oneOrNone('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (!job) return notFound('job');
    const row = await db.oneOrNone('SELECT id FROM planned_outages WHERE incident_id=$1', [job.incident_id]);
    if (!row) return { error: { code: 'NOT_A_PLANNED_JOB', message: 'this job is not part of a planned outage', status: 409 } };
    return withOutage(row.id, actor, async (t, ctx) => {
      let reject = rules.checkRequestPermit({ ...ctx, job, actor, clientRequestId });
      if (reject?.replay) return { result: { permit: reject.permit, replay: true } };
      if (!reject && await clientIdTaken(t, 'work_permits', 'request_client_id', clientRequestId, null)) {
        reject = { code: 'CLIENT_ID_REUSED', message: 'clientRequestId already belongs to another permit', status: 409 };
      }
      if (reject) return { reject, entity: 'permit', entityId: jobId, action: 'permit.request', details: { clientRequestId } };
      const { n } = await t.one("SELECT nextval('permit_no_seq') n");
      const permit = {
        id: 'PTW' + nanoid(8), permit_no: `PTW-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`,
        planned_outage_id: ctx.po.id, job_id: jobId, crew_id: job.crew_id, requested_by: actor.username, request_client_id: clientRequestId,
      };
      await t.none(`INSERT INTO work_permits (id,permit_no,planned_outage_id,job_id,crew_id,state,requested_by,requested_at,request_client_id)
        VALUES ($/id/,$/permit_no/,$/planned_outage_id/,$/job_id/,$/crew_id/,'requested',$/requested_by/,now(),$/request_client_id/)`, permit);
      await logSafety(t, ctx.po.id, actor, { entity: 'permit', entityId: permit.id, action: 'permit.request', to: 'requested',
        details: { permitNo: permit.permit_no, jobId, crewId: job.crew_id, clientRequestId } });
      return { result: { permit: await t.one('SELECT * FROM work_permits WHERE id=$1', [permit.id]) } };
    });
  },

  issuePermit: (permitId, actor, { isolationPoints, earthingPoints }) =>
    withPermit(permitId, actor, 'permit.issue', (ctx, permit) => rules.checkIssuePermit({ ...ctx, permit, actor, isolationPoints, earthingPoints }),
      async (t, permit) => {
        await t.none(`UPDATE work_permits SET state='issued', issued_by=$2, issued_at=now(), isolation_points=$3, earthing_points=$4 WHERE id=$1`,
          [permit.id, actor.username, isolationPoints, earthingPoints]);
        return { to: 'issued', details: { isolationPoints, earthingPoints } };
      }),

  refusePermit: (permitId, actor, { reason }) =>
    withPermit(permitId, actor, 'permit.refuse', (ctx, permit) => rules.checkRefusePermit({ permit, actor, reason }),
      async (t, permit) => {
        await t.none(`UPDATE work_permits SET state='refused', closed_by=$2, closed_at=now(), refusal_reason=$3 WHERE id=$1`, [permit.id, actor.username, reason]);
        return { to: 'refused', details: { reason } };
      }),

  withdrawPermit: (permitId, actor) =>
    withPermit(permitId, actor, 'permit.withdraw', (ctx, permit) => rules.checkWithdrawPermit({ permit, actor }),
      async (t, permit) => {
        await t.none(`UPDATE work_permits SET state='withdrawn', closed_by=$2, closed_at=now() WHERE id=$1`, [permit.id, actor.username]);
        return { to: 'withdrawn' };
      }),

  // The crew's declaration that the line is clear from their side. Restore
  // steps stay blocked until every permit for the outage is returned.
  returnPermit: (permitId, actor, { declaration, clientRequestId, onBehalfNote = null }) =>
    withPermit(permitId, actor, 'permit.return',
      (ctx, permit) => rules.checkReturnPermit({ permit, actor, declaration, clientRequestId, onBehalfNote }),
      async (t, permit) => {
        if (await clientIdTaken(t, 'work_permits', 'return_client_id', clientRequestId, permit.id)) {
          return { reject: { code: 'CLIENT_ID_REUSED', message: 'clientRequestId already belongs to another permit', status: 409 } };
        }
        const decl = { menWithdrawn: true, earthsRemoved: true, toolsClear: true, remarks: declaration?.remarks || null };
        await t.none(`UPDATE work_permits SET state='returned', returned_by=$2, returned_at=now(), return_client_id=$3,
            return_declaration=$4::jsonb, on_behalf_note=$5 WHERE id=$1`,
          [permit.id, actor.username, clientRequestId, JSON.stringify(decl), onBehalfNote]);
        return { to: 'returned', details: { declaration: decl, clientRequestId, onBehalfNote } };
      }),
};

// Shared shape of the permit transitions after the request: lock the
// outage, check, apply, log. apply() may still reject (e.g. a reused id).
async function withPermit(permitId, actor, action, check, apply) {
  const row = await db.oneOrNone('SELECT planned_outage_id FROM work_permits WHERE id=$1', [permitId]);
  if (!row) return notFound('permit');
  return withOutage(row.planned_outage_id, actor, async (t, ctx) => {
    const permit = ctx.permits.find((p) => p.id === permitId);
    const base = { entity: 'permit', entityId: permitId, action, details: { permitNo: permit.permit_no } };
    const reject = check(ctx, permit);
    if (reject?.replay) return { result: { permit, replay: true } };
    if (reject) return { ...base, reject };
    const applied = await apply(t, permit);
    if (applied.reject) return { ...base, reject: applied.reject };
    await logSafety(t, ctx.po.id, actor, { entity: 'permit', entityId: permitId, action, from: permit.state, to: applied.to,
      details: { permitNo: permit.permit_no, ...(applied.details || {}) } });
    return { result: { permit: await t.one('SELECT * FROM work_permits WHERE id=$1', [permitId]) } };
  });
}