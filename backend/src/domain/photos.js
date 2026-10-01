import sharp from 'sharp';

// Phone cameras send 3000x4000 JPEGs; 1600px on the long side is plenty to
// read a meter or pole number and keeps each photo around 100-200 KB.
const PHOTO_MAX_EDGE = 1600;
const PHOTO_WEBP_QUALITY = 75;

export function decodePhotoDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a JPEG, PNG, or WebP data URL');
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

export async function compressPhoto(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate() // apply EXIF orientation before the metadata is dropped
    .resize(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: PHOTO_WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, contentType: 'image/webp', width: info.width, height: info.height };
}
