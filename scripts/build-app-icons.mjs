// Builds the crew app's launcher icons from the brand mark (assets/logo.png)
// so they fit every platform's mask instead of being cropped:
//
//   assets/icon.png           1024x1024, logo on the navy brand background
//                             (iOS + legacy Android; iOS forbids transparency)
//   assets/adaptive-icon.png  1024x1024 transparent foreground for Android
//                             adaptive icons, logo kept inside the safe circle
//                             that survives every launcher's mask shape
//
// Re-run after replacing assets/logo.png (a larger, square source gives
// sharper icons):
//
//   npm run build:icons
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const SIZE = 1024;
const BRAND_BG = '#173355'; // must match expo.android.adaptiveIcon.backgroundColor

// Android shows only the middle 72dp of a 108dp adaptive layer and masks it
// (circle, squircle, ...); the 66dp circle in the centre is always visible.
const ADAPTIVE_SAFE_RADIUS = Math.floor((SIZE * 66) / 108 / 2) - 8; // small margin
// The legacy/iOS icon is shown whole; leave a little breathing room.
const FULL_SAFE_RADIUS = Math.floor(SIZE * 0.42);

// Crop the transparent padding, then measure how far the visible pixels
// reach from the logo's centre — scaling by that radius (not the bounding
// box) lets the logo be as large as possible while no part is ever masked.
const { data, info } = await sharp(join(assets, 'logo.png'))
  .ensureAlpha()
  .trim({ threshold: 1 })
  .raw()
  .toBuffer({ resolveWithObject: true });
const trimmed = sharp(data, { raw: info });
const cx = info.width / 2;
const cy = info.height / 2;
let reach = 0;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 24) reach = Math.max(reach, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
  }
}

async function render(file, safeRadius, background) {
  const scale = safeRadius / reach;
  const w = Math.round(info.width * scale);
  const h = Math.round(info.height * scale);
  const logo = await trimmed.clone().resize(w, h, { kernel: 'lanczos3' }).png().toBuffer();
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background } })
    .composite([{ input: logo, left: Math.round((SIZE - w) / 2), top: Math.round((SIZE - h) / 2) }])
    .png({ compressionLevel: 9 })
    .toFile(join(assets, file));
  console.log(`${file}: logo ${w}x${h} on ${SIZE}x${SIZE}`);
}

await render('icon.png', FULL_SAFE_RADIUS, BRAND_BG);
await render('adaptive-icon.png', ADAPTIVE_SAFE_RADIUS, { r: 0, g: 0, b: 0, alpha: 0 });
