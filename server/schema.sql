CREATE TABLE IF NOT EXISTS job_photos (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  image_data BYTEA NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/webp',
  original_content_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  note TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS job_photos_job_id_idx ON job_photos (job_id);
