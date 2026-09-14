# OMS Crew — Integration Notes

This merges the requirements from `OMS_Adeeb_ReactNative_Expo_Guide.docx`
into the existing `mobile-main` project (Vite web build + Expo native
build sharing one React codebase).

## What was added/changed

- **`src/config.js`** — backend + Keycloak endpoints (`API_BASE`,
  `KEYCLOAK_URL`, `REALM`, `CLIENT_ID`). **Edit the LAN IP here** before
  running on a device.
- **`src/lib/auth.js`** — Keycloak OAuth login via `expo-auth-session`
  (PKCE), token persisted in `expo-secure-store`, session restore on
  cold start.
- **`src/lib/api.js`** — rewritten as the single backend gateway, per the
  guide's "one rule": screens never call `fetch` directly.
  - On **web** it keeps the original cookie-session calls to `/api/...`.
  - On **native** it calls the real OMS endpoints with a Keycloak bearer
    token: `GET /mobile/crews/:crewId`, `GET /mobile/crews/:crewId/jobs`,
    `PATCH /mobile/jobs/:id/status`, `POST /mobile/jobs/:id/photos`.
  - Falls back to demo data if the backend/Keycloak isn't reachable, so
    the app is still demoable standalone.
  - `src/services/jobsApi.js` was folded into `api.js` and removed (was
    unused duplication once `api.js` covered its logic).
- **`src/lib/location.js`** — GPS via `expo-location`, used to tag status
  updates and photos.
- **`src/lib/photos.js`** — camera capture + base64 upload via
  `expo-image-picker`.
- **`src/lib/offlineQueue.js`** — queues status updates in
  `AsyncStorage` when a network call fails, auto-flushes on a 30s
  interval while signed in.
- **`src/lib/navigate.js`** — opens the phone's native Maps app.
- **`src/lib/biometric.js`** — optional Face ID/fingerprint unlock
  (`expo-local-authentication`), not wired into the login flow yet — call
  `biometricUnlock()` after `restoreSession()` if you want to gate app
  reopen behind it.
- **`src/components/SafetyChecklist.js`** — reusable checklist that gates
  the "On Site" → "Work Started" transition.
- **`src/components/QrScanner.js`** — QR asset-tag scanner via
  `expo-camera`.
- **`src/NativeApp.jsx`** — rewritten: real Keycloak sign-in screen, job
  list, job detail modal with status advance (safety-gated), photo
  capture, QR asset scan, native maps navigation, offline-queue badge.
- **`package.json`** — added `expo-auth-session`, `expo-secure-store`,
  `expo-web-browser`, `expo-location`, `expo-camera`,
  `expo-image-picker`, `expo-local-authentication`, `expo-network`,
  `expo-crypto`, `@react-native-async-storage/async-storage`.
- **`app.json`** — added `scheme: "omscrew"` (OAuth redirect), camera/
  location permission strings for iOS + Android, and the corresponding
  Expo config plugins.
- `package-lock.json` was removed since it's stale against the new
  dependency list — regenerate it with `npm install`.

`src/App.jsx` (the web build) was left as-is except that it now imports
from the merged `api.js`, which is a drop-in replacement.

## Why this wasn't run end-to-end here

This sandbox has **no network access**, so `npm install` (needed to pull
in the new Expo packages) and `expo start` can't actually execute here.
Every file was instead verified statically:

- All `.js`/`.jsx` files parse cleanly (checked with esbuild).
- Both entry points (`src/App.jsx` for web, `src/NativeApp.jsx` for
  native) bundle successfully with esbuild, confirming every local
  import path resolves and there are no circular/broken references.

## How to actually run it

```bash
cd mobile-main
npm install
# recommended: let Expo pick the exact compatible versions for SDK 53
npx expo install --check

# Edit src/config.js: set API_BASE / KEYCLOAK_URL to your machine's LAN IP
# (find it with `ipconfig` / `ifconfig`), and confirm the oms-mobile
# Keycloak client allows the redirect URI: omscrew://

npm run native      # Expo dev server (scan QR with Expo Go, or press a/i)
# or
npm run dev          # Vite web build at http://localhost:5173
```

## PostgreSQL photo storage

Photo uploads are handled by `server/index.js`. The service accepts the
existing `{ dataUrl, lat, lon, note }` payload, compresses the source image
to WebP with a maximum 1920px edge and quality 72, then stores the compressed
bytes in PostgreSQL `job_photos.image_data` as `bytea`.

For local development:

```bash
docker compose up -d postgres
# PowerShell
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/oms"
$env:DB_SSL = "false"
npm run server
```

The schema is mounted automatically by Docker Compose. Check the service at
`http://localhost:4000/health`. Do not use the example database password in
production; use a secret environment variable and put the photo route behind
the same Keycloak authorization middleware as the other mobile routes.
For a hosted PostgreSQL provider that requires TLS, set `$env:DB_SSL = "true"`.
PEM certificates do not need to be installed as packages. Point `DB_SSL_CA`
to the provider's `.pem` CA file; mutual TLS providers may also require
`DB_SSL_CERT` and `DB_SSL_KEY`. Keep `DB_SSL_REJECT_UNAUTHORIZED=true` when
using a trusted CA.

## Known follow-ups

- `expo-network`/`NetInfo` isn't wired to a live connectivity listener
  yet — the offline queue currently flushes on a timer (every 30s) and
  on failed requests, rather than immediately on reconnect. Swap in
  `expo-network`'s `addNetworkStateListener` if you want instant flush.
- Biometric unlock (`src/lib/biometric.js`) is written but not called
  anywhere yet — hook it in after `restoreSession()` succeeds if you
  want to require Face ID/fingerprint on relaunch.
- Ask the integration track (Akash) for the current LAN IP and confirm
  the `oms-mobile` Keycloak client's allowed redirect URIs include
  `omscrew://`.
