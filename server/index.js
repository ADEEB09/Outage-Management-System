import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { URL } from "node:url";
import pg from "pg";
import sharp from "sharp";

const { Pool } = pg;
const port = Number(process.env.PHOTO_PORT || process.env.PORT || 4001);
const useSsl = process.env.DB_SSL === "true";
const readPem = (path) => (path ? fs.readFileSync(path, "utf8") : undefined);
const ssl = useSsl
  ? {
      ca: readPem(process.env.DB_SSL_CA),
      cert: readPem(process.env.DB_SSL_CERT),
      key: readPem(process.env.DB_SSL_KEY),
      rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false",
    }
  : false;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/oms",
  ssl,
});
const maxUploadBytes = 20 * 1024 * 1024;

const photoSchemaSql = `
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
    technician_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS job_photos_job_id_idx ON job_photos (job_id);
`;

const assetScanSchemaSql = `
  CREATE TABLE IF NOT EXISTS asset_scans (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    crew_id TEXT,
    asset_id TEXT,
    raw_value TEXT,
    asset_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS asset_scans_job_id_idx ON asset_scans (job_id);
`;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxUploadBytes) {
      throw new Error("Photo payload is too large");
    }
  }
  return JSON.parse(body || "{}");
}

function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Expected a JPEG, PNG, or WebP data URL");
  return { contentType: match[1], buffer: Buffer.from(match[2], "base64") };
}

async function storePhoto(jobId, payload) {
  const latitude = Number(payload.lat);
  const longitude = Number(payload.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Latitude and longitude are required; photo was not stored");
  }
  const original = decodeDataUrl(payload.dataUrl);
  const image = sharp(original.buffer, { limitInputPixels: 40e6 });
  const metadata = await image.metadata();
  const compressed = await image
    .rotate()
    .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 72, effort: 4 })
    .toBuffer();

  const result = await pool.query(
    `INSERT INTO job_photos
      (job_id, image_data, content_type, original_content_type, width, height, latitude, longitude, note, technician_id, metadata)
         VALUES ($1, $2, 'image/webp', $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, job_id, content_type, width, height, octet_length(image_data) AS bytes, captured_at`,
    [
      jobId,
      compressed,
      original.contentType,
      metadata.width || 0,
      metadata.height || 0,
      latitude,
      longitude,
      payload.note ?? null,
      payload.technicianId ?? null,
      payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
    ]
  );
  return { ...result.rows[0], originalBytes: original.buffer.length };
}

async function storeAssetScan(jobId, payload) {
  const latitude = Number(payload.lat);
  const longitude = Number(payload.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Latitude and longitude are required; asset scan was not stored");
  }
  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO asset_scans
      (id, job_id, crew_id, asset_id, raw_value, asset_details, lat, lon)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, job_id, crew_id, asset_id, raw_value, asset_details, lat, lon, scanned_at`,
    [
      id,
      jobId,
      payload.crewId ?? null,
      payload.assetId ?? null,
      payload.rawValue ?? null,
      payload.assetDetails && typeof payload.assetDetails === "object" ? payload.assetDetails : {},
      latitude,
      longitude,
    ]
  );
  return result.rows[0];
}

async function ensureDatabaseSchema() {
  await pool.query(photoSchemaSql);
  await pool.query(assetScanSchemaSql);
  await pool.query(`
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS technician_id TEXT;
    ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return sendJson(response, 204, {});
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      await pool.query("SELECT 1");
      return sendJson(response, 200, { ok: true, database: "postgresql" });
    }

    const photoMatch = url.pathname.match(/^\/api\/mobile\/jobs\/([^/]+)\/photos$/);
    if (request.method === "POST" && photoMatch) {
      const payload = await readJson(request);
      const photo = await storePhoto(decodeURIComponent(photoMatch[1]), payload);
      return sendJson(response, 201, { photo });
    }

    const assetScanMatch = url.pathname.match(/^\/api\/mobile\/jobs\/([^/]+)\/assets\/scans$/);
    if (request.method === "POST" && assetScanMatch) {
      const payload = await readJson(request);
      const scan = await storeAssetScan(decodeURIComponent(assetScanMatch[1]), payload);
      return sendJson(response, 201, scan);
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const status = error.message === "Photo payload is too large" ? 413 : 400;
    console.error(error);
    return sendJson(response, status, { error: error.message || "Request failed" });
  }
});

async function startServer() {
  try {
    await ensureDatabaseSchema();
    server.listen(port, () => {
      console.log(`OMS API listening on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Failed to initialize PostgreSQL schema:", error);
    process.exit(1);
  }
}

startServer();

process.on("SIGTERM", async () => {
  await pool.end();
  server.close();
});
