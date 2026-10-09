# In-house map server integration

The OMS gets its basemap from a separate **map server** (OpenStreetMap data for all of India, served from our own
Ubuntu machine, no paid map service). The map server knows nothing about the OMS. **The OMS decides which region is
needed** and asks for just that part.

```
 operator web app ──┐                       ┌── OMS GIS data (network.json / CIM) ──► regions
                    ├──► OMS backend ───────┤
 crew app (phone) ──┘     /api/map/*        └── infra/map-regions.json (named zones, divisions)
                              │  adds the map server's key; the apps never see it
                              ▼
                        map server  (any machine the backend can reach)
```

## Where things live

| What | File |
|---|---|
| Regions: built from substations + feeder lines (GIS) and the config below | `backend/src/infra/mapRegions.js` |
| **The regions the team edits** (zones, divisions, crew pinning) | `backend/src/infra/map-regions.json` |
| Region routes `GET /api/map/regions`, `GET /api/map/my-region`, `POST /api/map/regions/:id/export` | `backend/src/routes/mapRegions.js` |
| Everything else under `/api/map` (style, tiles, fonts, export status/download) is forwarded | `backend/src/routes/mapProxy.js` |
| Mounted in the (login-protected) API | `backend/src/routes/api.js` (search `/map`) |
| Operator map: basemap + "Go to region" selector | `frontend/src/screens/NetworkMap.jsx` |
| Crew phone: asks "which region is mine?", downloads one small file, answers tile requests | `src/lib/offlineMap/areaStore.js` |
| Crew map page (MapLibre inside the existing Leaflet page) | `src/lib/offlineMap/mapPage.js` |

## Settings

Backend (`backend/.env`):
- `MAP_SERVER_URL` where the map server is, e.g. `http://10.0.0.5:8095` (default `http://127.0.0.1:8095`)
- `MAP_API_KEY` the map server's key (same value as its `API_KEY`)

Map server: `API_KEY`, `HOST` (listen address), `SERVICE_AREA` (fallback area for older backends). It needs **no**
`PUBLIC_URL`: the backend tells it which address the client used (`x-forwarded-*`), so the OMS can move freely.

## Regions

`map-regions.json` is read on every request, so edits need no restart.
- A region is `{ id, name, kind, forCrews, lat, lon, radiusKm }` or `{ ..., bbox: [minLon, minLat, maxLon, maxLat] }`.
- `forCrews: true` means a crew phone may download it. Operators can use any region.
- Substation regions (`ss-<code>`) are generated from `network.json`; no config needed.
- A crew gets: its pinned region (`crewOverrides`) > the smallest crew region containing its last position >
  the nearest within `nearestMaxKm` > `defaultCrewRegion`.

## Quick checks (replace TOKEN with a real login token)

```
curl -H "Authorization: Bearer TOKEN" http://OMS:14000/api/map/regions
curl -H "Authorization: Bearer TOKEN" "http://OMS:14000/api/map/my-region?crewId=CREW-01"
curl -H "Authorization: Bearer TOKEN" -X POST -H "content-type: application/json" -d '{}' http://OMS:14000/api/map/regions/haridwar/export
```
The last returns `jobId`, `statusPath` and `filePath`; poll `statusPath` until `ready`, then download `filePath`.

## Connecting a development machine (`npm start`)

The map server lives on its own machine and listens only there. To use it from a developer machine:

1. Get from whoever runs the map server: your own **map key** and, if the server is not on your network,
   a **tunnel login** (a user name; your SSH public key gets added to it).
2. In `backend/.env` (template: `.env.example`):
   ```
   MAP_SERVER_URL=http://127.0.0.1:8095
   MAP_API_KEY=mk_...
   MAP_SSH_HOST=<map server address>     # only for the tunnel
   MAP_SSH_USER=mapdev                   # only for the tunnel
   ```
3. With a tunnel: run `npm run map:tunnel` in its own terminal and leave it open (it reconnects by itself;
   if your SSH key has a passphrase it asks for it there).
4. `npm run map:check` shows exactly what works and what does not (reachable? key accepted? style available?).
5. `npm start` as usual.

If the map server is directly reachable (same network / VPN), skip the tunnel: set `MAP_SERVER_URL` to its address
and run `npm run map:check`. `npm run map:config` prints the settings in use (the key is masked).

## Not yet verified
Real phone (Expo / WebView), real Keycloak, HTTPS, and a backend running in Docker (there `127.0.0.1` is the container,
so point `MAP_SERVER_URL` at the host or the map server's address).
