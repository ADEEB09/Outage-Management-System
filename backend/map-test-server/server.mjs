// Standalone test server for the crew app's offline map + offline tracking.
//
// The crew app runs without a real login (demo mode), so it can't use the
// Keycloak-protected OMS backend. This server exposes the SAME endpoints
// the app uses — tile pack download and batched GPS upload — with no auth,
// backed by its own Postgres database (oms_map_test, created automatically;
// your main `oms` database is never touched). It reuses the real API's
// validation rules so behaviour matches production.
//
// Open http://<this-pc>:4100/ in a browser to watch crew positions and
// trails arrive live — including the backlog a phone uploads after being
// offline.
//
// TESTING ONLY: no authentication. Run it on a trusted LAN, never expose it.
//
//   cd backend && npm run map:test-server
//
// Env (backend/.env):
//   MAP_TEST_DATABASE_URL  postgres://postgres:<password>@localhost:5432/oms_map_test
//   MAP_TEST_PORT          default 4100
//   TILES_DIR              default backend/tiles (from `npm run tiles:fetch`)
import 'dotenv/config';
import express from 'express';
import pgPromise from 'pg-promise';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_LOCATION_BATCH,
  parseLocationBatch,
  newestLivePoint,
  parseTileParams,
} from '../src/domain/locations.js';
import { createRouter } from '../src/domain/roadRouter.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MAP_TEST_PORT || 4100);
const TILES_DIR = process.env.TILES_DIR || join(here, '..', 'tiles');
const DB_URL = process.env.MAP_TEST_DATABASE_URL;
if (!DB_URL) {
  console.error('Set MAP_TEST_DATABASE_URL in backend/.env, e.g. postgres://postgres:<password>@localhost:5432/oms_map_test');
  process.exit(1);
}

const pgp = pgPromise();

// Create the test database on first run (connects to the default
// `postgres` maintenance DB to do so).
async function ensureDatabase() {
  const url = new URL(DB_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe database name "${name}"`);
  url.pathname = '/postgres';
  const admin = pgp(url.toString());
  try {
    const found = await admin.oneOrNone('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!found) {
      await admin.none('CREATE DATABASE $1:name', [name]);
      console.log(`  created database ${name}`);
    }
  } finally {
    await admin.$pool.end();
  }
}

await ensureDatabase();
const db = pgp(DB_URL);
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
  CREATE TABLE IF NOT EXISTS crew_live (
    crew_id      TEXT PRIMARY KEY,
    lat          DOUBLE PRECISION NOT NULL,
    lon          DOUBLE PRECISION NOT NULL,
    accuracy     REAL,
    recorded_at  TIMESTAMPTZ NOT NULL
  );
`);

const cs = new pgp.helpers.ColumnSet(
  ['id', 'crew_id', 'lat', 'lon', 'accuracy', 'speed', 'heading', 'recorded_at'],
  { table: 'crew_locations' }
);
const CREW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Log every request except the viewer's own polling and individual tile
// fetches, so you can see whether the phone is reaching this server at all.
app.use((req, res, next) => {
  const quiet = /^\/(api\/tiles\/\d|api\/crews\/live|api\/mobile\/crews\/[^/]+\/track|vendor\/)/.test(req.path);
  if (!quiet) res.on('finish', () => console.log(`  ${new Date().toLocaleTimeString()}  ${req.ip}  ${req.method} ${req.path} -> ${res.statusCode}`));
  next();
});

const api = express.Router();

api.get('/health', (req, res) => res.json({ ok: true, server: 'map-test', ts: new Date().toISOString() }));

// ---- offline map tile pack (same routes as the real backend, no auth)
api.get('/tiles/manifest', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile('manifest.json', { root: TILES_DIR }, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'No tile pack yet — run `npm run tiles:fetch` in backend/ first.' });
    }
  });
});

api.get('/tiles/:z/:x/:y.:ext(png|webp)', (req, res) => {
  const tile = parseTileParams(req.params);
  if (!tile) return res.status(400).json({ error: 'invalid tile' });
  res.sendFile(`${tile.z}/${tile.x}/${tile.y}.${req.params.ext}`, { root: TILES_DIR, maxAge: '1d', dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---- road graph + road routing (same routes as the real backend, no auth)
api.get('/tiles/roads.json', (req, res) => {
  res.sendFile('roads.json', { root: TILES_DIR }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'No road graph yet — run `npm run roads:build` in backend/.' });
  });
});

let router = null;
let routerMtime = 0;
api.get('/route', (req, res) => {
  const point = (v) => {
    const [lat, lon] = String(v ?? '').split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  };
  const from = point(req.query.from), to = point(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'from and to must be "lat,lon"' });
  const file = join(TILES_DIR, 'roads.json');
  if (!existsSync(file)) return res.status(503).json({ error: 'No road graph yet — run `npm run roads:build` in backend/.' });
  const mtime = statSync(file).mtimeMs;
  if (!router || mtime !== routerMtime) {
    router = createRouter(JSON.parse(readFileSync(file, 'utf8')));
    routerMtime = mtime;
  }
  const route = router.route(from, to);
  if (!route) return res.status(404).json({ error: 'no road route between these points' });
  res.json({ ...route, source: 'server' });
});

// ---- batched GPS upload (same contract as the real backend)
api.post('/mobile/crews/:id/locations', async (req, res) => {
  const crewId = req.params.id;
  if (!CREW_ID_RE.test(crewId)) return res.status(400).json({ error: 'invalid crew id' });
  const input = req.body?.points;
  if (!Array.isArray(input) || !input.length) return res.status(400).json({ error: 'points[] required' });
  if (input.length > MAX_LOCATION_BATCH) return res.status(413).json({ error: `max ${MAX_LOCATION_BATCH} points per batch` });

  const { valid, ack } = parseLocationBatch(input);
  let inserted = 0;
  if (valid.length) {
    const rows = valid.map((p) => ({ ...p, crew_id: crewId }));
    inserted = (await db.result(`${pgp.helpers.insert(rows, cs)} ON CONFLICT (id) DO NOTHING`)).rowCount;
  }
  const newest = newestLivePoint(valid);
  if (newest) {
    await db.none(
      `INSERT INTO crew_live (crew_id, lat, lon, accuracy, recorded_at)
       VALUES ($/crewId/, $/lat/, $/lon/, $/accuracy/, $/recorded_at/)
       ON CONFLICT (crew_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon,
         accuracy = EXCLUDED.accuracy, recorded_at = EXCLUDED.recorded_at
       WHERE crew_live.recorded_at < EXCLUDED.recorded_at`,
      { crewId, ...newest }
    );
  }

  // Log so you can see offline backlogs arriving, e.g. "12 points, oldest 9 min ago".
  const oldest = valid.reduce((m, p) => (p.recorded_at < m ? p.recorded_at : m), valid[0]?.recorded_at);
  const ageMin = oldest ? Math.round((Date.now() - Date.parse(oldest)) / 60000) : 0;
  console.log(
    `  ${new Date().toLocaleTimeString()}  ${crewId}: ${input.length} point(s), ${inserted} new` +
      (valid.length < input.length ? `, ${input.length - valid.length} rejected` : '') +
      (ageMin >= 2 ? `  <- offline backlog, oldest ${ageMin} min ago` : '')
  );
  res.json({ ack, inserted, rejected: input.length - valid.length });
});

api.get('/mobile/crews/:id/track', async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 12 * 3600 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: 'invalid from/to' });
  res.json(
    await db.any(
      `SELECT lat, lon, accuracy, speed, heading, recorded_at, received_at FROM crew_locations
       WHERE crew_id = $1 AND recorded_at BETWEEN $2 AND $3 ORDER BY recorded_at ASC LIMIT 5000`,
      [req.params.id, from.toISOString(), to.toISOString()]
    )
  );
});

// Every crew's live position plus a point count, for the viewer.
api.get('/crews/live', async (req, res) => {
  res.json(
    await db.any(`
      SELECT l.*, (SELECT COUNT(*)::int FROM crew_locations c WHERE c.crew_id = l.crew_id) AS points
      FROM crew_live l ORDER BY l.recorded_at DESC`)
  );
});

// Wipe test data (viewer's "Clear" button).
api.delete('/test-data', async (req, res) => {
  await db.none('TRUNCATE crew_locations, crew_live');
  console.log('  test data cleared');
  res.json({ ok: true });
});

app.use('/api', api);

// ---- live viewer page + a local copy of Leaflet (no CDN needed)
const require = createRequire(import.meta.url);
app.use('/vendor/leaflet', express.static(join(dirname(require.resolve('leaflet/package.json')), 'dist')));
app.get('/', (req, res) => res.sendFile(join(here, 'viewer.html')));

// Test APK over the LAN (fast, unlike downloading from a remote CDN).
// Drop a build at backend/map-test-server/app.apk (git-ignored).
app.get('/app.apk', (req, res) => {
  res.sendFile(join(here, 'app.apk'), {
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="oms-crew-test.apk"',
    },
  }, (err) => {
    if (err && !res.headersSent) res.status(404).type('text').send('No test APK yet.');
  });
});

app.use((err, req, res, _next) => {
  console.error('  error:', err.message);
  res.status(500).json({ error: 'server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('\n  OMS map test server (NO AUTH — testing only)');
  console.log(`  Viewer   -> http://localhost:${PORT}/`);
  ips.forEach((ip) => console.log(`  Phone    -> set MAP_TEST_SERVER = "http://${ip}:${PORT}/api" in src/config.js`));
  console.log(`  Tiles    -> ${existsSync(join(TILES_DIR, 'manifest.json')) ? TILES_DIR : 'NOT GENERATED yet (run npm run tiles:fetch)'}\n`);
});
