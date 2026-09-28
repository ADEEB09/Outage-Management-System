// src/lib/offlineNavigation.js
// Helpers for in-app navigation on the offline map: connectivity state (to
// decide whether Google Maps turn-by-turn is usable) and straight-line
// distance and direction from the crew to the incident.

const finite = (n) => typeof n === "number" && Number.isFinite(n);

// Unknown reachability counts as online, so a flaky check never hides the
// turn-by-turn option.
export const isOnlineState = (net) => !(net?.isConnected === false || net?.isInternetReachable === false);

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

// Straight-line distance and compass direction from one point to another,
// e.g. { meters: 2400, label: "2.4 km", direction: "north-east" }.
export function distanceAndDirection(from, to) {
  if (!finite(from?.lat) || !finite(from?.lon) || !finite(to?.lat) || !finite(to?.lon)) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat);
  const dLon = rad(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLon / 2) ** 2;
  const meters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const y = Math.sin(dLon) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) - Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(dLon);
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  const label = meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
  return { meters, label, direction: COMPASS[Math.round(bearing / 45) % 8] };
}
