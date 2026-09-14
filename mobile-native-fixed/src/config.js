// src/config.js
// Central place for backend + Keycloak endpoints.
//
// During development your phone/emulator must be able to reach the backend.
// Use your computer's LAN IP (find it with `ipconfig` on Windows or
// `ifconfig`/`ip a` on mac/Linux) â€” a physical phone can't see the PC's
// "localhost". Android emulators should use 10.0.2.2 instead.
//
// In production these should come from EAS build profiles / env vars
// rather than being hard-coded.

const isAndroidEmulator = false; // flip manually if you're on an Android emulator

export const API_BASE = isAndroidEmulator
  ? "http://10.0.2.2:4000/api"
  : "http://localhost:4000/api";

export const KEYCLOAK_URL = isAndroidEmulator
  ? "http://10.0.2.2:8080"
  : "http://localhost:8080";

export const REALM = "oms-upcl";
export const CLIENT_ID = "oms-mobile";
export const REDIRECT_SCHEME = "omscrew";
