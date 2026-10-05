// UTM (WGS84 ellipsoid) -> longitude/latitude, no dependencies.
//
// Why this exists: real CIM exports from this vendor mix coordinate systems
// under a single, incorrect "EPSG:4326" declaration -- point assets carry
// lon/lat degrees, but line geometry (ACLineSegment) carries UTM easting/
// northing in metres. See importCimNetwork.js for how the zone is chosen and
// verified; this file is only the maths.
//
// Kruger n-series (same series PROJ's etmerc uses), accurate to well under a
// millimetre inside a UTM zone. Verified against pyproj/PROJ on the real data
// this was written for (see the verification notes in the PR description).

const A = 6378137.0;                 // WGS84 semi-major axis (m)
const F = 1 / 298.257223563;         // WGS84 flattening
const K0 = 0.9996;                   // UTM scale factor on the central meridian
const E0 = 500000.0;                 // false easting (m)
const N0_SOUTH = 10000000.0;         // false northing, southern hemisphere (m)

const n = F / (2 - F);
const n2 = n * n, n3 = n2 * n, n4 = n3 * n;
const Ahat = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64);
const beta = [
  n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4,
  n2 / 48 + n3 / 15 - (437 / 1440) * n4,
  (17 / 480) * n3 - (37 / 840) * n4,
  (4397 / 161280) * n4,
];
const delta = [
  2 * n - (2 / 3) * n2 - 2 * n3 + (116 / 45) * n4,
  (7 / 3) * n2 - (8 / 5) * n3 - (227 / 45) * n4,
  (56 / 15) * n3 - (136 / 35) * n4,
  (4279 / 630) * n4,
];

/** Central meridian (degrees) of a UTM zone. */
export const zoneCentralMeridian = (zone) => zone * 6 - 183;
/** UTM zone number containing a longitude. */
export const zoneOfLon = (lon) => Math.floor((lon + 180) / 6) + 1;

/**
 * @param {number} easting  metres
 * @param {number} northing metres
 * @param {number} zone     UTM zone 1..60
 * @param {boolean} north   northern hemisphere (default true)
 * @returns {[number, number]} [lon, lat] in degrees
 */
export function utmToLonLat(easting, northing, zone, north = true) {
  const xi = (northing - (north ? 0 : N0_SOUTH)) / (K0 * Ahat);
  const eta = (easting - E0) / (K0 * Ahat);

  let xiP = xi, etaP = eta;
  for (let j = 1; j <= 4; j++) {
    xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);

  const lambda = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  const lon = zoneCentralMeridian(zone) + (lambda * 180) / Math.PI;
  return [lon, (phi * 180) / Math.PI];
}
