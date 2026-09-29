-- Migration: real network topology schema (Option B-lite from the CIM/PostGIS
-- discussion). Replaces the flat network.json + in-memory haversine search
-- (backend/src/infra/geo.js) with real Postgres/PostGIS tables and genuine
-- CIM ConnectivityNode/Terminal topology -- the graph a sectionalizing trace
-- (down to FPI level) actually needs, which a flat JSON file cannot express.
--
-- Lives in its own `network` schema, separate from the existing `public`
-- schema (incidents/crews/complaints etc.) -- matches the schema-per-domain
-- separation already named in OMS_SDP (oms, dms, scada, ...). Nothing here
-- touches or renames anything in `public`.
--
-- FPI scoping decision (2026-09-29): no CIM export we have today populates
-- FaultIndicator/ProtectionEquipment -- protection_assets exists anyway, so
-- that data slots in later with zero schema change and zero importer change.
-- RMUs already sitting in network.json ARE backfilled now, as kind='FRTU'
-- rows (see backfillRmusToProtectionAssets.js) -- see decision in chat.
--
-- Safe to re-run: every CREATE is IF NOT EXISTS.

CREATE SCHEMA IF NOT EXISTS network;

-- Level 1 -- Geographic Region
CREATE TABLE IF NOT EXISTS network.geo_regions (
  id       BIGSERIAL PRIMARY KEY,
  cim_mrid TEXT UNIQUE NOT NULL,
  name     TEXT
);

-- Level 1b -- SubGeographical Region
CREATE TABLE IF NOT EXISTS network.sub_geo_regions (
  id        BIGSERIAL PRIMARY KEY,
  cim_mrid  TEXT UNIQUE NOT NULL,
  name      TEXT,
  region_id BIGINT REFERENCES network.geo_regions(id)
);

-- Level 2 -- Substation
CREATE TABLE IF NOT EXISTS network.substations (
  id                 BIGSERIAL PRIMARY KEY,
  cim_mrid           TEXT UNIQUE NOT NULL,
  name               TEXT,
  code               TEXT,              -- e.g. 'UPCL-BW' -- the code/name split
  sub_geo_region_id  BIGINT REFERENCES network.sub_geo_regions(id),
  geog               geography(Point, 4326),
  raw_attrs          JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_network_substations_geog ON network.substations USING GIST (geog);
CREATE INDEX IF NOT EXISTS idx_network_substations_code ON network.substations (code);

-- Level 3 -- Voltage Level
CREATE TABLE IF NOT EXISTS network.voltage_levels (
  id             BIGSERIAL PRIMARY KEY,
  cim_mrid       TEXT UNIQUE NOT NULL,
  name           TEXT,
  nominal_kv     NUMERIC,
  substation_id  BIGINT REFERENCES network.substations(id)
);

-- Level 5 -- Feeder (Level 4 "Bay" folded in as a nullable column on Feeder
-- for now, since no source file we have populates Bay-level detail; adding a
-- real network.bays table later is additive, not a rework, if that changes)
CREATE TABLE IF NOT EXISTS network.feeders (
  id                BIGSERIAL PRIMARY KEY,
  cim_mrid          TEXT UNIQUE NOT NULL,
  name              TEXT,
  code              TEXT,
  bay_name          TEXT,
  voltage_level_id  BIGINT REFERENCES network.voltage_levels(id),
  substation_id     BIGINT REFERENCES network.substations(id),  -- direct FK too: importer often only knows this, not the voltage level
  raw_attrs         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_network_feeders_code ON network.feeders (code);

-- Level 6 -- Conducting Equipment (ONE table for every CIM equipment class --
-- PowerTransformer, ACLineSegment, Breaker, Fuse, FaultIndicator's *host*
-- device, etc. -- discriminated by cim_class, so a class we've never seen
-- before still imports with zero migration. Every original attribute, cim:
-- and vendor sedms: alike, is kept verbatim in raw_attrs.)
CREATE TABLE IF NOT EXISTS network.conducting_equipment (
  id           BIGSERIAL PRIMARY KEY,
  cim_mrid     TEXT UNIQUE NOT NULL,
  cim_class    TEXT NOT NULL,
  name         TEXT,
  feeder_id    BIGINT REFERENCES network.feeders(id),
  geog         geography(Point, 4326),
  raw_attrs    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_network_ce_geog  ON network.conducting_equipment USING GIST (geog);
CREATE INDEX IF NOT EXISTS idx_network_ce_class ON network.conducting_equipment (cim_class);
CREATE INDEX IF NOT EXISTS idx_network_ce_feeder ON network.conducting_equipment (feeder_id);

-- Level 8 -- Connectivity Node (created before terminals since terminals FK to it)
CREATE TABLE IF NOT EXISTS network.connectivity_nodes (
  id         BIGSERIAL PRIMARY KEY,
  cim_mrid   TEXT UNIQUE NOT NULL,
  feeder_id  BIGINT REFERENCES network.feeders(id)
);
CREATE INDEX IF NOT EXISTS idx_network_cn_feeder ON network.connectivity_nodes (feeder_id);

-- Level 7 -- Terminal (the edge between equipment and a connectivity node --
-- this is the actual graph a sectionalizing trace walks)
CREATE TABLE IF NOT EXISTS network.terminals (
  id                    BIGSERIAL PRIMARY KEY,
  cim_mrid              TEXT UNIQUE NOT NULL,
  equipment_id          BIGINT REFERENCES network.conducting_equipment(id),
  connectivity_node_id  BIGINT REFERENCES network.connectivity_nodes(id),
  sequence_number       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_network_terminals_equipment ON network.terminals (equipment_id);
CREATE INDEX IF NOT EXISTS idx_network_terminals_cn        ON network.terminals (connectivity_node_id);

-- Level 10 -- Assets and Protection: RTU/FRTU, ProtectionEquipment, and
-- FaultIndicator (FPI) all land here, discriminated by `kind`. This is the
-- table scoped in now for future FPI data (see migration header). geog is
-- included directly (not only via terminal_id) because the one real source
-- we have today for this level -- RMUs in network.json -- carries only
-- lat/lon with no feeder/equipment linkage at all (confirmed thin source
-- data during the earlier CIM-conversion work); a real FPI import, once one
-- exists, will normally set terminal_id/equipment_id instead and can leave
-- geog null (it's derivable from the terminal's equipment).
CREATE TABLE IF NOT EXISTS network.protection_assets (
  id            BIGSERIAL PRIMARY KEY,
  cim_mrid      TEXT UNIQUE NOT NULL,
  kind          TEXT NOT NULL,   -- 'RTU' | 'FRTU' | 'ProtectionEquipment' | 'FaultIndicator'
  name          TEXT,
  terminal_id   BIGINT REFERENCES network.terminals(id),
  equipment_id  BIGINT REFERENCES network.conducting_equipment(id),
  geog          geography(Point, 4326),
  raw_attrs     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_network_pa_geog     ON network.protection_assets USING GIST (geog);
CREATE INDEX IF NOT EXISTS idx_network_pa_kind     ON network.protection_assets (kind);
CREATE INDEX IF NOT EXISTS idx_network_pa_terminal ON network.protection_assets (terminal_id);

-- Auto-populate geog from lat/lon-shaped raw_attrs is deliberately NOT done
-- here -- the importer computes geog explicitly from real coordinates
-- (DiagramObjectPoint for CIM XML, lat/lon fields for the RMU backfill)
-- before insert, so there's one obvious place a bad coordinate would be
-- caught, rather than a trigger silently accepting whatever raw_attrs holds.
