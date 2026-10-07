import pgPromise from 'pg-promise';

const pgp = pgPromise({
});

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15432/oms';
export const db = pgp(connectionString);

export async function syncIdSequences() {
  // Forward-only: GREATEST() never rewinds a sequence onto live IDs, so calling
  // this again at any point (e.g. after seed()) can only move a counter forward.
  await db.none(`
    DO $$
    DECLARE target bigint;
    BEGIN
      SELECT GREATEST(
        COALESCE((SELECT MAX((substring(id from '[0-9]+$'))::bigint) FROM incidents
                   WHERE id ~ '^INC-[0-9]{4}-[0-9]+$'), 0),
        COALESCE((SELECT last_value FROM pg_sequences
                   WHERE schemaname = 'public' AND sequencename = 'incident_id_seq'), 0)
      ) INTO target;
      IF target < 1 THEN PERFORM setval('incident_id_seq', 1, false);
      ELSE PERFORM setval('incident_id_seq', target, true); END IF;

      SELECT GREATEST(
        COALESCE((SELECT MAX((substring(qid from '[0-9]+$'))::bigint) FROM complaints
                   WHERE qid ~ '^QRY-[0-9]{4}-[0-9]+$'), 0),
        COALESCE((SELECT last_value FROM pg_sequences
                   WHERE schemaname = 'public' AND sequencename = 'complaint_qid_seq'), 0)
      ) INTO target;
      IF target < 1 THEN PERFORM setval('complaint_qid_seq', 1, false);
      ELSE PERFORM setval('complaint_qid_seq', target, true); END IF;
    END $$;
  `);
}

export async function migrate() {
  await db.none(`
    CREATE TABLE IF NOT EXISTS incidents (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      severity      TEXT NOT NULL,
      status        TEXT NOT NULL,
      zone          TEXT,
      feeder        TEXT,
      customers     INTEGER DEFAULT 0,
      cause         TEXT,
      lat           DOUBLE PRECISION,
      lon           DOUBLE PRECISION,
      crew_id       TEXT,
      opened_at     TIMESTAMPTZ NOT NULL,
      ert           TEXT,
      sla_due_at    TIMESTAMPTZ,
      source        TEXT DEFAULT 'SCADA',
      substation    TEXT
    );

    CREATE TABLE IF NOT EXISTS complaints (
      qid          TEXT PRIMARY KEY,
      external_id  TEXT,
      customer     TEXT,
      phone        TEXT,
      address      TEXT,
      category     TEXT,
      lat          DOUBLE PRECISION,
      lon          DOUBLE PRECISION,
      dt_id        TEXT,
      feeder       TEXT,
      substation   TEXT,
      incident_id  TEXT,
      action       TEXT,
      ts           TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incident_events (
      id          TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      ts          TIMESTAMPTZ NOT NULL,
      actor       TEXT NOT NULL,
      kind        TEXT NOT NULL,
      note        TEXT
    );

    CREATE TABLE IF NOT EXISTS crews (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      lead      TEXT,
      status    TEXT NOT NULL,
      location  TEXT,
      job_id    TEXT,
      lat       DOUBLE PRECISION,
      lon       DOUBLE PRECISION,
      skills    TEXT
    );

    CREATE TABLE IF NOT EXISTS alarms (
      id         TEXT PRIMARY KEY,
      tag        TEXT NOT NULL,
      condition  TEXT NOT NULL,
      limit_val  TEXT,
      priority   INTEGER,
      message    TEXT,
      ts         TIMESTAMPTZ NOT NULL,
      ack        INTEGER DEFAULT 0,
      incident_id TEXT REFERENCES incidents(id)
    );

    CREATE TABLE IF NOT EXISTS trouble_calls (
      id        TEXT PRIMARY KEY,
      customer  TEXT,
      phone     TEXT,
      address   TEXT,
      category  TEXT,
      status    TEXT,
      linked_id TEXT,
      ts        TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      incident_id TEXT REFERENCES incidents(id),
      crew_id     TEXT REFERENCES crews(id),
      priority    TEXT DEFAULT 'Normal',
      status      TEXT DEFAULT 'Acknowledged',
      address     TEXT,
      updated_at  TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS asset_scans (
      id           TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      crew_id      TEXT,
      asset_id     TEXT,
      raw_value    TEXT NOT NULL,
      asset_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      lat          DOUBLE PRECISION,
      lon          DOUBLE PRECISION,
      scanned_at   TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS asset_scans_job_id_idx ON asset_scans(job_id);

    CREATE TABLE IF NOT EXISTS job_updates (
      id     TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      lat    DOUBLE PRECISION,
      lon    DOUBLE PRECISION,
      note   TEXT,
      ts     TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id     TEXT PRIMARY KEY,
      ts     TIMESTAMPTZ NOT NULL,
      actor  TEXT,
      action TEXT,
      target TEXT
    );

    
    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      incident_id TEXT,
      channel     TEXT NOT NULL,
      recipient   TEXT,
      subject     TEXT,
      body        TEXT,
      status      TEXT NOT NULL,
      error       TEXT,
      ts          TIMESTAMPTZ NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS job_photos (
      id       TEXT PRIMARY KEY,
      job_id   TEXT NOT NULL,
      data_url TEXT,
      image_data BYTEA,
      content_type TEXT NOT NULL DEFAULT 'image/webp',
      original_content_type TEXT,
      width INTEGER,
      height INTEGER,
      lat      DOUBLE PRECISION,
      lon      DOUBLE PRECISION,
      note     TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      technician_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ts       TIMESTAMPTZ NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      sender      TEXT NOT NULL,
      sender_role TEXT,
      body        TEXT NOT NULL,
      ts          TIMESTAMPTZ NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS opt_outs (
      id        TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      channel   TEXT NOT NULL,
      ts        TIMESTAMPTZ NOT NULL
    );
  `);
  await db.none(`
    ALTER TABLE alarms    ADD COLUMN IF NOT EXISTS incident_id TEXT REFERENCES incidents(id);
    ALTER TABLE trouble_calls ADD COLUMN IF NOT EXISTS area TEXT;
    ALTER TABLE trouble_calls ADD COLUMN IF NOT EXISTS reject_reason TEXT;
    ALTER TABLE trouble_calls ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
    ALTER TABLE trouble_calls ADD COLUMN IF NOT EXISTS rejected_by TEXT;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS prediction JSONB;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS trip_tag TEXT;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS open_trip_tags JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS momentary BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS restored_by TEXT;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS contact_ref TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_callback_once ON notifications (incident_id, contact_ref) WHERE contact_ref IS NOT NULL;
    ALTER TABLE crews ADD COLUMN IF NOT EXISTS tracking_state TEXT;
    ALTER TABLE crews ADD COLUMN IF NOT EXISTS tracking_reason TEXT;
    ALTER TABLE crews ADD COLUMN IF NOT EXISTS tracking_changed_at TIMESTAMPTZ;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS data_url TEXT;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS image_data BYTEA;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'image/webp';
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS original_content_type TEXT;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS width INTEGER;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS height INTEGER;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS technician_id TEXT;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE job_photos ALTER COLUMN data_url DROP NOT NULL;
  `);

  // Crew GPS breadcrumb trail. Points are recorded on the phone (possibly
  // while offline) and uploaded later in batches, so each row carries the
  // device-side recorded_at plus a client-generated id that makes retried
  // uploads idempotent. crews.location_updated_at guards the live position
  // against being overwritten by an older, late-arriving backfill batch.
  // No FK to crews(id): a ping can arrive for a crew_id the demo data
  // doesn't recognize.
  await db.none(`
    CREATE TABLE IF NOT EXISTS crew_locations (
      id           TEXT PRIMARY KEY,
      crew_id      TEXT NOT NULL,
      lat          DOUBLE PRECISION NOT NULL,
      lon          DOUBLE PRECISION NOT NULL,
      accuracy     REAL,
      speed        REAL,
      heading      REAL,
      recorded_at  TIMESTAMPTZ NOT NULL,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS crew_locations_crew_time_idx ON crew_locations(crew_id, recorded_at DESC);
    ALTER TABLE crews ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

    -- Upgrade the earlier single-ping table (BIGSERIAL id, no accuracy/speed/
    -- heading) in place, keeping its rows. The id default keeps plain
    -- INSERTs without an id (repo.addCrewLocation) working.
    ALTER TABLE crew_locations ADD COLUMN IF NOT EXISTS accuracy REAL;
    ALTER TABLE crew_locations ADD COLUMN IF NOT EXISTS speed REAL;
    ALTER TABLE crew_locations ADD COLUMN IF NOT EXISTS heading REAL;
    ALTER TABLE crew_locations ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT now();
    DO $$
    BEGIN
      IF (SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'crew_locations' AND column_name = 'id') = 'bigint' THEN
        ALTER TABLE crew_locations ALTER COLUMN id DROP DEFAULT;
        ALTER TABLE crew_locations ALTER COLUMN id TYPE TEXT USING id::text;
        DROP SEQUENCE IF EXISTS crew_locations_id_seq;
      END IF;
    END $$;
    ALTER TABLE crew_locations ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
    DROP INDEX IF EXISTS crew_locations_crew_id_idx; -- duplicate of crew_locations_crew_time_idx
  `);

  // OMS-01 planned outages: switching plans, work permits and the safety log.
  // See docs/OMS-01-DESIGN.md §2. A planned outage is an incident (type
  // 'Scheduled') plus a planned_outages row; crew work on it is an ordinary
  // job. work_permits.job_id has no FK on purpose: db/reset-demo.sql deletes
  // every job, and a permit is a safety record that must outlive it.
  await db.none(`
    CREATE TABLE IF NOT EXISTS planned_outages (
      id                  TEXT PRIMARY KEY,
      incident_id         TEXT UNIQUE NOT NULL REFERENCES incidents(id),
      window_start        TIMESTAMPTZ NOT NULL,
      window_end          TIMESTAMPTZ NOT NULL,
      work_description    TEXT NOT NULL,
      work_mrid           TEXT,
      notice_lead_minutes INTEGER NOT NULL DEFAULT 1440,
      notice_due_at       TIMESTAMPTZ,
      notice_sent_at      TIMESTAMPTZ,
      notice_skipped_reason TEXT,
      created_by          TEXT NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL,
      CHECK (window_end > window_start)
    );

    CREATE TABLE IF NOT EXISTS switching_plans (
      id                TEXT PRIMARY KEY,
      planned_outage_id TEXT UNIQUE NOT NULL REFERENCES planned_outages(id),
      state             TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'approved')),
      source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'trace')),
      trace_caveat      TEXT,
      approved_by       TEXT,
      approved_at       TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS switching_steps (
      id               TEXT PRIMARY KEY,
      plan_id          TEXT NOT NULL REFERENCES switching_plans(id),
      phase            TEXT NOT NULL CHECK (phase IN ('isolate', 'restore')),
      seq              INTEGER NOT NULL CHECK (seq > 0),
      action           TEXT NOT NULL,
      device_mrid      TEXT,
      device_label     TEXT NOT NULL,
      location         TEXT NOT NULL,
      assignee         TEXT NOT NULL CHECK (assignee IN ('control_room', 'crew')),
      assignee_crew_id TEXT,
      state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed')),
      confirmed_by     TEXT,
      performed_at     TIMESTAMPTZ,
      received_at      TIMESTAMPTZ,
      client_confirmation_id TEXT UNIQUE,
      on_behalf_note   TEXT,
      lat              DOUBLE PRECISION,
      lon              DOUBLE PRECISION,
      UNIQUE (plan_id, phase, seq),
      CHECK (assignee = 'control_room' OR assignee_crew_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS switching_steps_plan_idx ON switching_steps(plan_id, phase, seq);

    CREATE SEQUENCE IF NOT EXISTS permit_no_seq AS bigint MINVALUE 1;
    CREATE TABLE IF NOT EXISTS work_permits (
      id                TEXT PRIMARY KEY,
      permit_no         TEXT UNIQUE NOT NULL,
      planned_outage_id TEXT NOT NULL REFERENCES planned_outages(id),
      job_id            TEXT NOT NULL,
      crew_id           TEXT NOT NULL,
      state             TEXT NOT NULL CHECK (state IN ('requested', 'issued', 'returned', 'refused', 'withdrawn')),
      requested_by      TEXT NOT NULL,
      requested_at      TIMESTAMPTZ NOT NULL,
      request_client_id TEXT UNIQUE NOT NULL,
      issued_by         TEXT,
      issued_at         TIMESTAMPTZ,
      isolation_points  TEXT,
      earthing_points   TEXT,
      returned_by       TEXT,
      returned_at       TIMESTAMPTZ,
      return_client_id  TEXT UNIQUE,
      return_declaration JSONB,
      on_behalf_note    TEXT,
      closed_by         TEXT,
      closed_at         TIMESTAMPTZ,
      refusal_reason    TEXT
    );
    -- At most one permit requested or issued per job, enforced by the
    -- database as well as by domain/plannedOutage.js.
    CREATE UNIQUE INDEX IF NOT EXISTS work_permits_one_open_per_job
      ON work_permits(job_id) WHERE state IN ('requested', 'issued');
    CREATE INDEX IF NOT EXISTS work_permits_outage_idx ON work_permits(planned_outage_id);

    -- The safety document: who did what to which permit / switching step,
    -- when. No FK, so it outlives anything it refers to.
    CREATE TABLE IF NOT EXISTS safety_log (
      id                TEXT PRIMARY KEY,
      ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
      occurred_at       TIMESTAMPTZ,
      actor             TEXT NOT NULL,
      actor_role        TEXT NOT NULL,
      actor_crew_id     TEXT,
      planned_outage_id TEXT NOT NULL,
      entity            TEXT NOT NULL,
      entity_id         TEXT NOT NULL,
      action            TEXT NOT NULL,
      from_state        TEXT,
      to_state          TEXT,
      details           JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS safety_log_outage_idx ON safety_log(planned_outage_id, ts);

    -- Append-only, enforced in the database for every environment (unlike
    -- audit_log's trigger, which lives in a manual migration). TRUNCATE is
    -- blocked too, so a reset script can't wipe it by accident.
    CREATE OR REPLACE FUNCTION prevent_safety_log_change() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'safety_log records are permanent and cannot be modified or deleted';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_safety_log_immutable ON safety_log;
    CREATE TRIGGER trg_safety_log_immutable BEFORE UPDATE OR DELETE ON safety_log
      FOR EACH ROW EXECUTE FUNCTION prevent_safety_log_change();
    DROP TRIGGER IF EXISTS trg_safety_log_no_truncate ON safety_log;
    CREATE TRIGGER trg_safety_log_no_truncate BEFORE TRUNCATE ON safety_log
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_safety_log_change();
  `);

  // ID sequences for incidents.id / complaints.qid. These replace the old
  // SELECT COUNT(*) minting in repo.js, which raced under concurrency and
  // crashed the process on the resulting duplicate-key error (P8.6).
  await db.none(`
    CREATE SEQUENCE IF NOT EXISTS incident_id_seq   AS bigint MINVALUE 1;
    CREATE SEQUENCE IF NOT EXISTS complaint_qid_seq AS bigint MINVALUE 1;
  `);
  // Setting a sequence's VALUE is separate from creating it, because seed()
  // inserts its demo rows with hand-written IDs (INC-2026-000001..7) AFTER
  // migrate() has run. Bootstrapping only here, before those rows exist, left
  // the counter at 1 on a brand-new database, so the first real incident got an
  // ID that already existed -> duplicate key -> HTTP 500 (this is what turned
  // CI red: its database is always brand new). seed() now calls
  // syncIdSequences() again after its inserts; this call keeps a production
  // database (no seed step) self-bootstrapping on migrate() alone.
  await syncIdSequences();

  const postgis = await db.oneOrNone(
    "SELECT 1 FROM pg_extension WHERE extname = 'postgis'"
  );
  if (postgis) await db.none(`
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS geog public.geography(Point, 4326);
    ALTER TABLE crews     ADD COLUMN IF NOT EXISTS geog public.geography(Point, 4326);
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS geog public.geography(Point, 4326);

    CREATE OR REPLACE FUNCTION sync_geog() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
        NEW.geog := public.ST_SetSRID(public.ST_MakePoint(NEW.lon, NEW.lat), 4326)::public.geography;
      ELSE
        NEW.geog := NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_incidents_geog ON incidents;
    CREATE TRIGGER trg_incidents_geog BEFORE INSERT OR UPDATE OF lat, lon ON incidents
      FOR EACH ROW EXECUTE FUNCTION sync_geog();

    DROP TRIGGER IF EXISTS trg_crews_geog ON crews;
    CREATE TRIGGER trg_crews_geog BEFORE INSERT OR UPDATE OF lat, lon ON crews
      FOR EACH ROW EXECUTE FUNCTION sync_geog();

    DROP TRIGGER IF EXISTS trg_complaints_geog ON complaints;
    CREATE TRIGGER trg_complaints_geog BEFORE INSERT OR UPDATE OF lat, lon ON complaints
      FOR EACH ROW EXECUTE FUNCTION sync_geog();

    CREATE INDEX IF NOT EXISTS idx_incidents_geog ON incidents USING GIST (geog);
    CREATE INDEX IF NOT EXISTS idx_crews_geog ON crews USING GIST (geog);
    CREATE INDEX IF NOT EXISTS idx_complaints_geog ON complaints USING GIST (geog);
  `);
}