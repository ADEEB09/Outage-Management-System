// src/config.js
// Static app configuration. The server address itself is NOT fixed here:
// it lives in lib/server.js, defaults to DEFAULT_SERVER below, and a tester
// can change it on the sign-in screen without rebuilding the app.
//
// The server is the PC running the OMS backend (port API_PORT) and Keycloak
// (port KEYCLOAK_PORT) — see docs/MOBILE_TESTING.md. A physical phone must
// use that PC's LAN IP (`ipconfig` on Windows), not "localhost"; an Android
// emulator uses 10.0.2.2.

// Build-time default, e.g. `EXPO_PUBLIC_OMS_SERVER=192.168.1.20 eas build ...`
// (set per profile in eas.json). Expo inlines EXPO_PUBLIC_* at build time.
export const DEFAULT_SERVER = process.env.EXPO_PUBLIC_OMS_SERVER || "192.168.29.159";

export const API_PORT = 4000;
export const KEYCLOAK_PORT = 18080;

export const REALM = "oms-upcl";
export const CLIENT_ID = "oms-mobile";
export const REDIRECT_SCHEME = "omscrew";

// Standalone map/tracking test server (backend/map-test-server, started with
// `npm run map:test-server` in backend/). When set, the offline map pack and
// GPS uploads go there WITHOUT a Keycloak login. Development only — leave
// unset for any build a tester or crew member gets; the test server has no auth.
export const MAP_TEST_SERVER = process.env.EXPO_PUBLIC_MAP_TEST_SERVER || null;
