# PostgreSQL streaming replication - setup and failover runbook

Status: built and tested end-to-end on 2026-09-15 (primary write -> replica
receipt confirmed in under 3 seconds; full failover -> promotion -> write
confirmed working).

## What this is

`oms-postgres` (primary, host port 15432) continuously streams every change to
`oms-postgres-replica` (standby, host port 15433). If the primary genuinely goes
down, the replica already holds a near-complete copy of the database and can
be promoted to take over as the new primary in under a minute.

This satisfies the SDP's RPO <= 1 hour target with wide margin -- in testing,
replication lag was consistently under 3 seconds.

## Important: this image's real data path

`timescale/timescaledb-ha:pg16` does NOT use `/var/lib/postgresql/data` as
its actual data directory, despite that being the conventional Postgres
path. Its real path is `/home/postgres/pgdata/data`. Every command below
uses the correct path -- if extending this setup, always verify the real
path first with:

    docker exec -it oms-postgres psql -U oms -d oms -c "SHOW data_directory;"

## One-time setup (already done on this repo's docker-compose.yml)

1. Create a dedicated replication role on the primary:

       docker exec -it oms-postgres psql -U oms -d oms -c \
         "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'repl_pass_2026';"

2. Add a rule to the primary's pg_hba.conf allowing that role to connect for
   replication from anywhere on the Docker network. Edit via `docker cp`
   (direct in-container edits are blocked by this image's permissions):

       docker cp oms-postgres:/home/postgres/pgdata/data/pg_hba.conf .\pg_hba.conf
       # Add this line:
       # host    replication     replicator      0.0.0.0/0               scram-sha-256
       docker cp .\pg_hba.conf oms-postgres:/home/postgres/pgdata/data/pg_hba.conf
       docker exec -it oms-postgres psql -U oms -d oms -c "SELECT pg_reload_conf();"

   Note: the ADDRESS column requires real CIDR notation (0.0.0.0/0 for
   "anywhere"). The literal word "all" is NOT valid there -- it only works
   in the DATABASE and USER columns. Using "all" in ADDRESS silently fails
   to match anything.

3. The `postgres-replica` service in docker-compose.yml handles the rest
   automatically: on first start, it clones the primary via `pg_basebackup`
   and configures itself to stream continuously (`-R` flag writes the
   standby connection info automatically).

## Starting the replica

    docker compose up -d postgres-replica
    docker logs -f oms-postgres-replica

Watch for `started streaming WAL from primary` -- that confirms it's live.

## Verifying replication is genuinely working

    # Write to primary
    docker exec -it oms-postgres psql -U oms -d oms -c \
      "INSERT INTO incidents (id, type, severity, status, zone, feeder, customers, cause, opened_at, source) \
       VALUES ('TEST-001', 'Power Outage', 'high', 'open', 'Test Zone', 'TEST', 1, 'test', now(), 'manual');"

    # Confirm it appears on the replica within a few seconds
    docker exec -it oms-postgres-replica psql -U oms -d oms -c \
      "SELECT id FROM incidents WHERE id = 'TEST-001';"

## FAILOVER PROCEDURE - if the primary genuinely goes down

This is the real, tested sequence to follow during an actual outage.

1. Confirm the primary is genuinely unreachable (not just slow) before
   promoting -- promoting while the old primary is still partially alive
   risks two writable databases diverging ("split brain").

2. Promote the replica to become a real, writable primary:

       docker exec -it oms-postgres-replica psql -U oms -d oms -c "SELECT pg_promote();"

3. Wait a few seconds, then confirm it accepts writes:

       docker exec -it oms-postgres-replica psql -U oms -d oms -c \
         "INSERT INTO incidents (id, ...) VALUES (...);"

   If this succeeds (rather than erroring "read-only transaction"), the
   promotion is genuinely complete.

4. Point the application at the promoted database. In this dev setup, that
   means updating `DATABASE_URL` in `backend/.env` (or the Kubernetes
   secret, per `helm-oms/values.yaml`) from host port 15432 to host port 15433, then
   restarting the backend.

   In a real production deployment with a fixed hostname (not raw ports),
   this step would instead be a DNS or load-balancer change pointing the
   `postgres` hostname at the newly-promoted server -- decide this
   concretely once the real DCC/DR server hostnames are known.

5. Once the old primary is repaired, it must be rebuilt as a NEW replica of
   the newly-promoted database (via the same pg_basebackup clone process)
   before it can safely rejoin -- it cannot simply be restarted as-is, since
   its data has now diverged from the promoted server's timeline.

## Known gaps -- not yet built

- No automatic failure detection or automatic promotion. This is a MANUAL
  procedure right now: a human decides the primary is down and runs the
  promote command. Automating this (e.g. with Patroni or repmgr) is a
  reasonable future improvement once the two real UPCL servers are in place.
- No automatic re-pointing of the application's DATABASE_URL. Step 4 above
  is a manual edit + restart in this dev setup.
- This has only been tested with Docker Compose on one machine. The real
  production test -- two genuinely separate physical servers, replicating
  over a real network link -- has not yet been done, and should be a
  priority once the UPCL hardware arrives.
