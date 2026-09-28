# Testing the crew mobile app on a real phone (Keycloak login)

The crew app (`src/NativeApp.jsx`, package `com.omscrew.mobile`) signs in with
Keycloak (realm `oms-upcl`, client `oms-mobile`) and then talks to the OMS
backend with the crew's bearer token. Jobs, status updates, photos, messages,
asset scans, background GPS tracking and the offline map pack all go through
the same authenticated `/api` routes the backend already protects.

Everything below runs on **one PC** (the "server"). The phone must be on the
same Wi-Fi network.

## 1. Start the stack with Keycloak reachable from the LAN

```sh
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.mobile.yml up -d
cd backend && npm start
```

`docker-compose.mobile.yml` re-binds Keycloak from `127.0.0.1:18080` to
`0.0.0.0:18080` so the phone can open the sign-in page. It also exposes the
Keycloak admin console to the LAN, so use it on a trusted network only.

The backend listens on port 4000 on all interfaces. On Windows, allow **Node.js**
and **Docker** through the firewall for private networks when prompted, or
open TCP 4000 and 18080 inbound.

## 2. Set up Keycloak for the app (once per Keycloak database)

```sh
cd backend
npm run keycloak:mobile                         # crew password: crew123
CREW_PASSWORD='Something-Better1' npm run keycloak:mobile
```

This is idempotent. It creates the `oms-mobile` client (public, PKCE), a
`crew_id` token claim, the `field_crew` role, and six test crew logins:

| Login  | Crew | Lead         |
|--------|------|--------------|
| crew01 | C001 | Rajesh Kumar |
| crew02 | C002 | Amit Sharma  |
| crew03 | C003 | Priya Singh  |
| crew04 | C004 | Suresh Patel |
| crew05 | C005 | Meena Rao    |
| crew06 | C006 | Vijay Nair   |

It also sets the realm's `sslRequired` to `none`, because Keycloak otherwise
refuses sign-ins over plain HTTP from anything but localhost. That setting is
for LAN testing only; production needs HTTPS and `external`.

## 3. Offline map pack (optional)

The map downloads its tiles from the backend (`GET /api/tiles/*`, served from
`backend/tiles/`). That folder is not in git (about 120 MB: WebP tiles
rendered at 2x so the map stays sharp on phone screens). Either copy it
from a machine that has it, or generate it with `backend/tile-server/`
(see the comments in its `docker-compose.yml`). Without it, everything else
works; the Map tab just says the server has no offline map pack yet.

Road directions (the blue route along the roads, with road distance and ETA)
need the road graph, also in `backend/tiles/` (about 6 MB, built in ~10 s):

```sh
cd backend
curl -L -o tile-server/uttarakhand.osm.pbf https://download.openstreetmap.fr/extracts/asia/india/uttarakhand-latest.osm.pbf
npm run roads:build
```

With signal the app asks the backend (`GET /api/route`); without signal it
routes on the phone from the copy downloaded with the offline map. Without
the graph the map falls back to the dashed straight line.

## 4. Install the app

Build the APK with the **`test`** profile. It is the only profile that allows
plain-HTTP traffic, which the LAN setup needs:

```sh
eas build --profile test --platform android
```

The `preview` and `production` profiles block HTTP, so sign-in will fail with
a network error if you install one of those against a LAN server.

## 5. Sign in

1. On the sign-in screen, enter the server PC's LAN IP under **OMS SERVER**
   (`ipconfig` on Windows, the Wi-Fi adapter's IPv4 address) and tap **Check**.
   Both *Backend :4000* and *Keycloak :18080* should show ✓. The address is
   saved on the phone.
2. Tap **Sign in with Keycloak** and log in as e.g. `crew03` / `crew123`.
3. You should see crew C003's real jobs from the backend. There is no
   "DEMO MODE" badge when you are signed in.

## What to test

- Jobs list and job detail; advance a job's status (Acknowledged → En Route → …)
  and check it shows up in the control-room web app.
- Photos, asset QR scans and job messages on a job.
- Start location tracking; the crew's position moves on the dispatch map.
  Turn on airplane mode for a few minutes, then turn it off: the queued
  trail uploads (`GET /api/mobile/crews/C003/track`).
- Map tab: download the offline map, then use it in airplane mode.
- Sign out, sign in as a different crew: you see only that crew's jobs.

## Troubleshooting

| Symptom | Cause |
|---|---|
| **Check** shows ✗ for both | Wrong IP, phone on a different network, or firewall. |
| ✗ Keycloak only | Stack started without `docker-compose.mobile.yml` (Keycloak on localhost only). |
| ✗ Backend only | `npm start` isn't running in `backend/`. |
| Keycloak page says "HTTPS required" | `npm run keycloak:mobile` hasn't been run against this Keycloak. |
| Keycloak says "Client not found" / "Invalid redirect uri" | Same: run `npm run keycloak:mobile`. |
| Signed in but no jobs | That crew has no jobs assigned in the backend. |
| Sign-in fails with a network error | APK was not built with the `test` profile (HTTP blocked). |
