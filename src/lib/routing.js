// src/lib/routing.js
// Turn-by-turn navigation is delegated to the phone's native Maps app —
// once opened there, Google Maps / Apple Maps provide real turn-by-turn
// guidance; we don't reimplement that here (see navigate.js for the
// single-destination version of this).
//
// Multi-job routing builds one Google Maps "directions" deep link with
// every job as a waypoint, so a crew can navigate stop-to-stop through
// their whole shift in one tap instead of one address at a time.
import { Linking } from "react-native";

function encode(address) {
  return encodeURIComponent(address);
}

// jobs: array of { address }, in the order they should be visited.
export function buildMultiStopUrl(jobs) {
  const addresses = jobs.map((j) => j.address).filter(Boolean);
  if (!addresses.length) return null;

  const destination = addresses[addresses.length - 1];
  const waypoints = addresses.slice(0, -1);

  let url = `https://www.google.com/maps/dir/?api=1&destination=${encode(destination)}&travelmode=driving`;
  if (waypoints.length) {
    url += `&waypoints=${waypoints.map(encode).join("|")}`;
  }
  return url;
}

export function openMultiJobRoute(jobs) {
  const url = buildMultiStopUrl(jobs);
  if (!url) return Promise.resolve();
  return Linking.openURL(url);
}