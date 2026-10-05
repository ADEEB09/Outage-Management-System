// Writes the crew photos stored in PostgreSQL (job_photos) out as image
// files, so you can open them in any image viewer.
//
// Usage (from backend/):
//   npm run photos:export                      # all photos -> ../photo-export
//   npm run photos:export -- JOB-004           # only that job's photos
//   npm run photos:export -- --compress-old    # also compress photos uploaded
//                                              # before server-side compression
//
// Env:
//   DATABASE_URL  same as the backend (e.g. postgresql://oms:oms@localhost:15432/oms)
//   OUT_DIR       default ../photo-export (git-ignored)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { db } from '../src/infra/db.js';
import { compressPhoto, decodePhotoDataUrl } from '../src/domain/photos.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.env.OUT_DIR || join(here, '..', '..', 'photo-export'));
const args = process.argv.slice(2);
const compressOld = args.includes('--compress-old');
const jobId = args.find((a) => !a.startsWith('--'));

const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const kb = (n) => `${Math.round(n / 1024)} KB`;

const rows = await db.any(
  `SELECT id, job_id, image_data, content_type, data_url, width, height, ts
   FROM job_photos ${jobId ? 'WHERE job_id = $1' : ''} ORDER BY ts`,
  jobId ? [jobId] : []
);
await mkdir(outDir, { recursive: true });

for (const row of rows) {
  let buffer = row.image_data;
  let contentType = row.content_type;
  let note = `${row.width}x${row.height}`;
  if (!buffer && row.data_url) {
    // Uploaded before compression was wired up: the original is in data_url.
    const original = decodePhotoDataUrl(row.data_url);
    if (compressOld) {
      const image = await compressPhoto(original.buffer);
      await db.none(
        `UPDATE job_photos SET image_data=$2, content_type=$3, original_content_type=$4,
           width=$5, height=$6, data_url=NULL WHERE id=$1`,
        [row.id, image.buffer, image.contentType, original.contentType, image.width, image.height]
      );
      note = `${image.width}x${image.height}, compressed now (was ${kb(original.buffer.length)})`;
      ({ buffer, contentType } = image);
    } else {
      note = 'original, not compressed (run with --compress-old)';
      ({ buffer, contentType } = original);
    }
  }
  if (!buffer) { console.log(`${row.id}  no image data, skipped`); continue; }
  const file = join(outDir, `${row.job_id}_${row.id}.${EXT[contentType] || 'bin'}`);
  await writeFile(file, buffer);
  console.log(`${row.id}  ${kb(buffer.length).padStart(7)}  ${note}  -> ${file}`);
}

console.log(`\n${rows.length} photo(s) exported to ${outDir}`);
await db.$pool.end();
