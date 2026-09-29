// Backfills the 249 RMUs already sitting in backend/src/infra/network.json
// into network.protection_assets as kind='FRTU' rows -- per the 2026-09-29
// decision to bring existing FRTU-equivalent assets into the new schema now,
// rather than leave them stranded in the old flat file while FPI data lands
// in the new one.
//
// Source data is genuinely thin (confirmed during the earlier CIM-conversion
// work): id, lat, lon, status only -- no feeder or substation link. So these
// rows get geog set directly and terminal_id/equipment_id left NULL; a real
// FPI import later would normally set terminal_id instead (see
// importCimNetwork.js), and both are supported by the same table.
//
// cim_mrid is prefixed 'RMU:' -- these are NOT real CIM mRIDs (no CIM export
// produced them), and raw ids were found to collide across classes in the
// source .mdb export (documented in the earlier network.json conversion
// work); prefixing keeps this synthetic ID space from ever colliding with a
// real imported CIM mRID.
//
// Idempotent: ON CONFLICT (cim_mrid) DO UPDATE, safe to re-run.
//
// Run: node src/infra/backfillRmusToProtectionAssets.js
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { db, migrate } from './db.js';

const _dir = dirname(fileURLToPath(import.meta.url));

async function backfillRmus() {
  await migrate();
  const net = JSON.parse(readFileSync(join(_dir, 'network.json'), 'utf8'));
  let count = 0;
  for (const rmu of net.rmus || []) {
    if (typeof rmu.lat !== 'number' || typeof rmu.lon !== 'number') continue;
    await db.none(
      `INSERT INTO network.protection_assets (cim_mrid, kind, name, geog, raw_attrs)
       VALUES ($/mrid/, 'FRTU', $/name/,
         ST_SetSRID(ST_MakePoint($/lon/, $/lat/), 4326)::geography, $/attrs/)
       ON CONFLICT (cim_mrid) DO UPDATE SET name=EXCLUDED.name, geog=EXCLUDED.geog, raw_attrs=EXCLUDED.raw_attrs`,
      {
        mrid: `RMU:${rmu.id}`,
        name: rmu.id,
        lat: rmu.lat,
        lon: rmu.lon,
        attrs: { source: 'network.json:rmus', raw_id: rmu.id, status: rmu.status ?? '' },
      }
    );
    count++;
  }
  return { backfilled: count, totalInSource: (net.rmus || []).length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stats = await backfillRmus();
  console.log('[backfillRmusToProtectionAssets]', stats);
  process.exit(0);
}

export { backfillRmus };
