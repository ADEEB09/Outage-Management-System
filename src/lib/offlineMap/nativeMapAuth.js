// src/lib/offlineMap/nativeMapAuth.js
// SPIKE: keeps the native map's Authorization header in step with the crew's
// login, for @maplibre/maplibre-react-native.
//
// The native map engine makes its own HTTP requests (style, tiles, fonts,
// sprites, offline pack downloads), so it cannot ask auth.js for a token.
// Instead we register one header with TransformRequestManager, scoped by regex
// to our own /api/map/ URLs, and replace it under the same id every time the
// token changes. The token only ever travels in a header, never in a URL.
import { TransformRequestManager } from "@maplibre/maplibre-react-native";
import { mapApiBase, mapServerHeaders } from "../mapServer";

const HEADER_ID = "oms-map-auth";
const CHECK_MS = 60000; // getFreshAccessToken refreshes when < 30 s are left

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let timer = null;
let lastValue = null;

// Reads the current token (refreshing it if it is about to expire) and puts it
// on the native map's requests. Returns true when a token is in place.
export async function syncMapAuthHeader() {
  const headers = await mapServerHeaders(); // also loads the saved server host
  const value = headers?.Authorization || null;
  if (value === lastValue) return Boolean(value);
  lastValue = value;
  if (!value) {
    TransformRequestManager.removeHeader(HEADER_ID);
    return false;
  }
  TransformRequestManager.addHeader({
    id: HEADER_ID,
    // Only our own map endpoints get the token, never a third-party URL.
    match: "^" + escapeRegex(`${mapApiBase()}/map/`),
    name: "Authorization",
    value,
  });
  return true;
}

export function startMapAuth() {
  if (!timer) timer = setInterval(() => syncMapAuthHeader().catch(() => {}), CHECK_MS);
  return syncMapAuthHeader();
}

export function stopMapAuth() {
  if (timer) clearInterval(timer);
  timer = null;
  lastValue = null;
  TransformRequestManager.removeHeader(HEADER_ID);
}
