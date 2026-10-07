// One-off: compress photos stored before upload compression existed. Those
// rows hold the full camera image as a base64 data_url; this converts each to
// the same WebP bytes new uploads get (image_data) and clears data_url.
//
//   node scripts/compress-old-photos.mjs
//
// Idempotent: only rows that still have a data_url and no image_data change.
// Needs DATABASE_URL like the backend.
import { db } from '../src/infra/db.js';
import { decodePhotoDataUrl, compressPhoto } from '../src/domain/photos.js';

try {
  const rows = await db.any('SELECT id, data_url, metadata FROM job_photos WHERE data_url IS NOT NULL AND image_data IS NULL');
  let before = 0;
  let after = 0;
  for (const row of rows) {
    const original = decodePhotoDataUrl(row.data_url);
    const image = await compressPhoto(original.buffer);
    const metadata = { ...(row.metadata || {}), originalBytes: original.buffer.length, storedBytes: image.buffer.length };
    await db.none(
      `UPDATE job_photos SET image_data=$/data/, content_type=$/type/, original_content_type=$/orig/,
         width=$/w/, height=$/h/, metadata=$/metadata:json/::jsonb, data_url=NULL WHERE id=$/id/`,
      { id: row.id, data: image.buffer, type: image.contentType, orig: original.contentType, w: image.width, h: image.height, metadata }
    );
    before += original.buffer.length;
    after += image.buffer.length;
    console.log(`${row.id}: ${Math.round(original.buffer.length / 1024)} KB -> ${Math.round(image.buffer.length / 1024)} KB`);
  }
  console.log(rows.length ? `Compressed ${rows.length} photos: ${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB` : 'No uncompressed photos left.');
} finally {
  await db.$pool.end();
}
