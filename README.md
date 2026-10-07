# OMS Platform

Runnable **Outage Management System** for the UPCL Ganga Corridor — a control-room web app, a mobile
crew app, and an event-driven backend with a live SCADA simulation. Built to the `OMS_SRS_v1.0` /
`OMS_SDP_v1.0` specification, with clean seams to the full production stack (PostgreSQL/PostGIS, Kafka,
TimescaleDB, Keycloak, Kong). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What's in the box

| App | Path | Port | What it is |
|---|---|---|---|
| **Backend** | `backend/` | 4000 | Express + PostgreSQL/PostGIS + socket.io, domain state machine, IEEE 1366 indices, SCADA sim |
| **Control-room web** | `frontend/` | 5173 | React — Dashboard, Incidents, Dispatch, Network map, Alarms, TCS, Analytics, Admin |
| **Mobile crew app** | repo root (`index.js` → `src/NativeApp.jsx`) | 5174 | Expo app — the same code runs as the Android APK and on the web (`npm run dev`). The old web prototypes (`src/App.jsx`, `mobile/`) are disabled |

## Quick start

**Requires Node 22.5 or newer** (Node 20 LTS users: upgrade to Node 22 LTS or 24) and Docker (for
Postgres/PostGIS/TimescaleDB, Redis, and — if you're running the Kafka event-bus driver — Kafka).

```bash
docker compose up -d postgres redis   # backing services (add kafka if EVENT_BUS_DRIVER=kafka)
cp backend/.env.example backend/.env  # then adjust if your ports differ
npm install          # installs all three workspaces
npm run seed         # load the Ganga Corridor demo data (idempotent)
npm start            # runs backend + web + mobile together
```

Then open:

- **Control room** → http://localhost:5173
- **Crew app** → http://localhost:5174  (open in a phone-sized window / device toolbar)
- Backend health → http://localhost:4000/api/health

Run the two UIs side by side: advance a job in the crew app and watch the incident, crew status,
map marker, and live event tape update in the control room in real time.

### Run apps individually

```bash
npm run dev:backend   # :4000
npm run dev:web       # :5173
npm run dev:mobile    # :5174
npm test              # backend self-test (state machine, dispatch, mobile round-trip)
```

## Demo script (2 minutes)

1. **Dashboard** — active incidents, live IEEE 1366 indices, crew status.
2. **TCS** → *Raise incident* on the unassigned customer call → a new incident appears everywhere.
3. **Dispatch** → assign a crew to it.
4. **Crew app** (:5174) → sign in as that crew → open the job → step it to **On Site** → **Work Complete**.
5. Back in the **control room** → the incident moved to *In-Progress* then *Pending Verification*, the
   crew relocated on the **Network map**, and every step is in the **Admin** audit log.
6. **Alarms** → acknowledge a SCADA alarm. **Analytics** → SAIDI/SAIFI/CAIDI + feeder breakdown.

## Event bus & cache (Phase 1 tail)

Two env vars in `backend/.env` control this — both are optional at runtime:

- `REDIS_URL` (default `redis://localhost:6379`) — real-time tag cache and a
  short-TTL read-through cache on `/indicators`. If Redis is unreachable the
  app logs a warning and serves everything straight from Postgres.
- `EVENT_BUS_DRIVER` — `memory` (default) uses an in-process EventEmitter;
  `kafka` uses a real KafkaJS producer/consumer against `KAFKA_BROKERS`
  (default `localhost:9092`), auto-creating the topic list on first connect.
  If the broker is unreachable at boot, it logs a warning and falls back to
  the memory driver for that run rather than crashing.

## Reset the demo

```bash
docker exec -it oms-postgres psql -U oms -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
npm run seed
```
