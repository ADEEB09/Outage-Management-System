import pgPromise from 'pg-promise';

const pgp = pgPromise({
});

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/oms';
export const db = pgp(connectionString);

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