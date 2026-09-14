import { db } from './db.js';
import { nanoid } from 'nanoid';

// The only module that talks SQL. Every function is now async because the
// pg driver is async (unlike node:sqlite/better-sqlite3, which were sync).
// Named params use pg-promise's $/name/ syntax instead of the old bare @name.
const parseSkills = (r) => r ? { ...r, skills: r.skills ? r.skills.split(',') : [] } : r;

// Builds a "col=$/col/" SET clause from a patch object ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â same dynamic-update
// pattern as before, just async at the call site now.
const setClause = (patch) => Object.keys(patch).map(k => `${k}=$/${k}/`).join(',');

export const repo = {
  // ---- incidents
  incidents: () => db.any('SELECT * FROM incidents ORDER BY opened_at DESC'),
  incident: (id) => db.oneOrNone('SELECT * FROM incidents WHERE id=$1', [id]),
  incidentEvents: (id) => db.any('SELECT * FROM incident_events WHERE incident_id=$1 ORDER BY ts ASC', [id]),
  allIncidentEvents: () => db.any('SELECT * FROM incident_events ORDER BY ts ASC'),
  nextIncidentId: async () => {
    const { c } = await db.one('SELECT COUNT(*) c FROM incidents');
    return 'INC-2026-' + String(Number(c) + 1).padStart(6, '0');
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
  addIncidentEvent: async (incidentId, actor, kind, note) => {
    const ev = { id: 'EV' + nanoid(8), incident_id: incidentId, ts: new Date().toISOString(), actor, kind, note };
    await db.none(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note)
      VALUES ($/id/,$/incident_id/,$/ts/,$/actor/,$/kind/,$/note/)`, ev);
    return ev;
  },

  // ---- complaints (external REST intake, dedup + merge, traceability)
  complaints: () => db.any('SELECT * FROM complaints ORDER BY ts DESC'),
  complaint: (qid) => db.oneOrNone('SELECT * FROM complaints WHERE qid=$1', [qid]),
  complaintsForIncident: (incidentId) => db.any('SELECT * FROM complaints WHERE incident_id=$1 ORDER BY ts ASC', [incidentId]),
  nextQueryId: async () => {
    const { c } = await db.one('SELECT COUNT(*) c FROM complaints');
    return 'QRY-2026-' + String(Number(c) + 1).padStart(6, '0');
  },
  addComplaint: async (c) => {
    await db.none(`INSERT INTO complaints
      (qid,external_id,customer,phone,address,category,lat,lon,dt_id,feeder,substation,incident_id,action,ts)
      VALUES ($/qid/,$/external_id/,$/customer/,$/phone/,$/address/,$/category/,$/lat/,$/lon/,$/dt_id/,$/feeder/,$/substation/,$/incident_id/,$/action/,$/ts/)`,
      c);
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
  // Available crews nearest an incident, using real PostGIS distance ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â replaces
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
    await db.none(`INSERT INTO trouble_calls (id,customer,phone,address,category,status,linked_id,ts)
      VALUES ($/id/,$/customer/,$/phone/,$/address/,$/category/,$/status/,$/linked_id/,$/ts/)`, c);
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

  // ---- admin / audit
  audit: async (actor, action, target) => {
    await db.none(`INSERT INTO audit_log (id,ts,actor,action,target) VALUES ($1,$2,$3,$4,$5)`,
      ['AU' + nanoid(8), new Date().toISOString(), actor, action, target]);
  },
  auditLog: () => db.any('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 50'),

    addJobPhoto: async (jobId, dataUrl, lat, lon, note) => {
    const ph = {
      id: 'PH' + nanoid(8),
      job_id: jobId,
      data_url: dataUrl,
      lat: lat ?? null,
      lon: lon ?? null,
      note: note ?? null,
      ts: new Date().toISOString(),
    };
    await db.none(
      `INSERT INTO job_photos (id,job_id,data_url,lat,lon,note,ts)
       VALUES ($/id/,$/job_id/,$/data_url/,$/lat/,$/lon/,$/note/,$/ts/)`,
      ph
    );
    return ph;
  },
  jobPhotos: (jobId) =>
    db.any('SELECT id, job_id, lat, lon, note, ts FROM job_photos WHERE job_id=$1 ORDER BY ts DESC', [jobId]),
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

    setOptOut: async (recipient, channel) => {
    await db.none(
      `INSERT INTO opt_outs (id, recipient, channel, ts) VALUES ($/id/, $/recipient/, $/channel/, $/ts/)`,
      { id: 'OPT' + nanoid(8), recipient, channel, ts: new Date().toISOString() }
    );
  },
  clearOptOut: (recipient, channel) =>
    db.none('DELETE FROM opt_outs WHERE recipient=$1 AND channel=$2', [recipient, channel]),
  isOptedOut: async (recipient, channel) => {
    const row = await db.oneOrNone('SELECT 1 FROM opt_outs WHERE recipient=$1 AND channel=$2', [recipient, channel]);
    return !!row;
  },
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