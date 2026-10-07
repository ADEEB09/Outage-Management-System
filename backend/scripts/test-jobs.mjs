// Test incidents + jobs for trying the crew app on a phone away from the
// service area (Delhi NCR test region: road routing and the offline map work
// there when the pack was built with PACK_TEST_REGIONS=delhi-ncr).
//
//   node scripts/test-jobs.mjs           add (idempotent: existing ones are skipped)
//   node scripts/test-jobs.mjs --remove  delete every INC-TEST-* / JOB-TEST-* row
//
// Everything is tagged TEST in its id so it is easy to find and remove
// before a demo or release. Needs DATABASE_URL like the backend.
import { db } from '../src/infra/db.js';

const TEST_JOBS = [
  // crew03 (C003)
  { n: '01', crew: 'C003', zone: 'Sector 18 Market, Noida', lat: 28.5708, lon: 77.3261, type: 'Power Outage', severity: 'critical', customers: 640, status: 'Pending Acceptance', priority: 'Urgent' },
  { n: '02', crew: 'C003', zone: 'Sector 62, Noida', lat: 28.6280, lon: 77.3649, type: 'Line Fault', severity: 'high', customers: 410, status: 'Acknowledged', priority: 'High' },
  { n: '03', crew: 'C003', zone: 'Botanical Garden, Noida', lat: 28.5640, lon: 77.3340, type: 'Transformer Failure', severity: 'high', customers: 295, status: 'Acknowledged', priority: 'High' },
  { n: '04', crew: 'C003', zone: 'Sector 137, Noida Expressway', lat: 28.5103, lon: 77.4040, type: 'Partial Power', severity: 'medium', customers: 120, status: 'Pending Acceptance', priority: 'Normal' },
  // crew05 (C005) and crew06 (C006), for a second and third tester
  { n: '05', crew: 'C005', zone: 'Indirapuram, Ghaziabad', lat: 28.6411, lon: 77.3695, type: 'Power Outage', severity: 'high', customers: 530, status: 'Pending Acceptance', priority: 'High' },
  { n: '06', crew: 'C005', zone: 'Sector 50, Noida', lat: 28.5707, lon: 77.3640, type: 'Line Fault', severity: 'medium', customers: 180, status: 'Acknowledged', priority: 'Normal' },
  { n: '07', crew: 'C006', zone: 'Mayur Vihar Phase 1, Delhi', lat: 28.6045, lon: 77.2940, type: 'Transformer Failure', severity: 'critical', customers: 720, status: 'Pending Acceptance', priority: 'Urgent' },
  { n: '08', crew: 'C006', zone: 'Sector 15, Noida', lat: 28.5850, lon: 77.3110, type: 'Power Outage', severity: 'high', customers: 350, status: 'Acknowledged', priority: 'High' },
];

async function remove() {
  await db.tx(async (t) => {
    await t.none("DELETE FROM job_photos WHERE job_id LIKE 'JOB-TEST-%'");
    const jobs = await t.result("DELETE FROM jobs WHERE id LIKE 'JOB-TEST-%'");
    await t.none("UPDATE crews SET job_id=NULL WHERE job_id LIKE 'INC-TEST-%'");
    const inc = await t.result("DELETE FROM incidents WHERE id LIKE 'INC-TEST-%'");
    console.log(`Removed ${jobs.rowCount} test jobs and ${inc.rowCount} test incidents.`);
  });
}

async function add() {
  const now = new Date();
  let added = 0;
  for (const j of TEST_JOBS) {
    const incId = `INC-TEST-${j.n}`;
    const jobId = `JOB-TEST-${j.n}`;
    if (await db.oneOrNone('SELECT 1 FROM jobs WHERE id=$1', [jobId])) continue;
    await db.tx(async (t) => {
      await t.none(`INSERT INTO incidents (id,type,severity,status,zone,customers,cause,lat,lon,crew_id,opened_at,source)
        VALUES ($/id/,$/type/,$/severity/,'dispatched',$/zone/,$/customers/,'Test job for crew app',$/lat/,$/lon/,$/crew/,$/ts/,'MANUAL')
        ON CONFLICT (id) DO NOTHING`,
        { ...j, id: incId, ts: now.toISOString() });
      await t.none(`INSERT INTO jobs (id,incident_id,crew_id,priority,status,address,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [jobId, incId, j.crew, j.priority, j.status, j.zone, now.toISOString()]);
      await t.none('INSERT INTO job_updates (id,job_id,status,ts) VALUES ($1,$2,$3,$4)', [jobId + '-created', jobId, j.status, now.toISOString()]);
    });
    added++;
  }
  console.log(`Added ${added} test jobs (${TEST_JOBS.length - added} already there).`);
  for (const crew of [...new Set(TEST_JOBS.map((j) => j.crew))]) {
    const ids = TEST_JOBS.filter((j) => j.crew === crew).map((j) => `JOB-TEST-${j.n}`);
    console.log(`  ${crew}: ${ids.join(', ')}`);
  }
}

try {
  await (process.argv.includes('--remove') ? remove() : add());
} finally {
  await db.$pool.end();
}
