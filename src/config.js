// src/config.js
// Central place for backend + Keycloak endpoints.
//
// During development your phone/emulator must be able to reach the backend.
// Use your computer's LAN IP (find it with `ipconfig` on Windows or
// `ifconfig`/`ip a` on mac/Linux) — a physical phone can't see the PC's
// "localhost". Android emulators should use 10.0.2.2 instead.
//
// In production these should come from EAS build profiles / env vars
// rather than being hard-coded.

const isAndroidEmulator = false; // flip manually if you're on an Android emulator

export const API_BASE = isAndroidEmulator
  ? "http://10.0.2.2:4001/api"
  : "http://192.168.29.159:4000/api";

export const PHOTO_API_BASE = API_BASE;

export const KEYCLOAK_URL = isAndroidEmulator
  ? "http://10.0.2.2:8080"
  : "http://192.168.29.159:8080";

export const REALM = "oms-upcl";
export const CLIENT_ID = "oms-mobile";
export const REDIRECT_SCHEME = "omscrew";

// Standalone map/tracking test server (backend/map-test-server, started with
// `npm run map:test-server` in backend/). When set, the offline map pack and
// GPS uploads go here WITHOUT a Keycloak login, so both features can be
// tested while the app runs in demo mode. It prints the exact URL to use on
// startup. MUST be null in production builds — the test server has no auth.
export const MAP_TEST_SERVER = "http://192.168.0.115:4100/api";

// Where the offline map pack and GPS uploads go.
export const MAP_API_BASE = MAP_TEST_SERVER || API_BASE;
