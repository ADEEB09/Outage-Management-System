import { db } from './db.js';
import { nanoid } from 'nanoid';

// The only module that talks SQL. Every function is now async because the
// pg driver is async (unlike node:sqlite/better-sqlite3, which were sync).
// Named params use pg-promise's $/name/ syntax instead of the old bare @name.
const parseSkills = (r) => r ? { ...r, skills: r.skills ? r.skills.split(',') : [] } : r;

// Builds a "col=$/col/" SET clause from a patch object -- same dynamic-update
// pattern as before, just async at the call site now.
const setClause = (patch) => Object.keys(patch).map(k => `${k}=$/${k}/`).join(',');

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
  crewTrack: (crewId, from, to, limit = 2000) =>
    db.any(
      `SELECT lat, lon, accuracy, speed, heading, recorded_at FROM crew_locations
       WHERE crew_id=$/crewId/ AND recorded_at BETWEEN $/from/ AND $/to/
       ORDER BY recorded_at ASC LIMIT $/limit/`,
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
};