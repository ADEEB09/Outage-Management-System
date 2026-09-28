-- Migration: replace COUNT(*)-based ID minting with real Postgres sequences (P8.6)
--
-- Run once against any environment whose incident/complaint IDs are still
-- being minted from SELECT COUNT(*). Safe to re-run, and safe to run before
-- or after the application has created its tables: every statement is
-- guarded, and the sequences are only ever moved FORWARD, never reset
-- backwards onto IDs that already exist.
--
--   psql -U oms -d oms -f sequence_based_id_generation.sql
--
-- WHY: backend/src/infra/repo.js's nextIncidentId()/nextQueryId() used
--   SELECT COUNT(*) c FROM <table>   ->   'INC-2026-' + pad(c + 1)
-- which is a read-then-write race. Two concurrent requests read the same
-- count, mint the same ID, and the second INSERT violates the primary key.
-- That error was unhandled and killed the entire backend process -- see
-- docs/P8_6_CROSS_SOURCE_CORRELATION_RESULTS.md, where a burst test of
-- 800 SCADA events/s + ~200 complaints/s crashed the backend ~1.2s in and
-- left the Kafka consumer permanently stalled at 6,384 messages of lag.
--
-- nextval() is atomic and never hands the same value to two callers, so the
-- collision cannot occur regardless of concurrency. The external ID format
-- is deliberately UNCHANGED (INC-2026-000164, QRY-2026-000100) because these
-- IDs appear in regulatory reports and are read aloud by control-room
-- operators -- this is a transparent fix, not a format change.
--
-- NOTE: sequences are non-transactional by design, so a rolled-back insert
-- burns its number. IDs may therefore contain gaps. That is correct and
-- expected -- an ID is an identifier, not a count. Anything that needs a
-- genuine total must use COUNT(*) on the table, not the highest ID.

CREATE SEQUENCE IF NOT EXISTS incident_id_seq   AS bigint MINVALUE 1;
CREATE SEQUENCE IF NOT EXISTS complaint_qid_seq AS bigint MINVALUE 1;

DO $$
DECLARE
  max_suffix bigint;
  cur_value  bigint;
  target     bigint;
BEGIN
  -- ---- incidents.id : 'INC-<year>-<6-digit suffix>' ----
  IF to_regclass('public.incidents') IS NOT NULL THEN
    SELECT COALESCE(MAX((substring(id from '[0-9]+$'))::bigint), 0)
      INTO max_suffix
      FROM incidents
     WHERE id ~ '^INC-[0-9]{4}-[0-9]+$';
  ELSE
    max_suffix := 0;
  END IF;

  SELECT COALESCE(last_value, 0) INTO cur_value
    FROM pg_sequences
   WHERE schemaname = 'public' AND sequencename = 'incident_id_seq';

  -- GREATEST() is what makes this safe to re-run: if the app has already
  -- advanced the sequence past the highest existing row, keep the sequence.
  target := GREATEST(COALESCE(max_suffix, 0), COALESCE(cur_value, 0));
  IF target < 1 THEN
    PERFORM setval('incident_id_seq', 1, false);   -- next nextval() = 1
  ELSE
    PERFORM setval('incident_id_seq', target, true); -- next nextval() = target + 1
  END IF;
  RAISE NOTICE 'incident_id_seq set so the next incident id suffix is %', target + 1;

  -- ---- complaints.qid : 'QRY-<year>-<6-digit suffix>' ----
  IF to_regclass('public.complaints') IS NOT NULL THEN
    SELECT COALESCE(MAX((substring(qid from '[0-9]+$'))::bigint), 0)
      INTO max_suffix
      FROM complaints
     WHERE qid ~ '^QRY-[0-9]{4}-[0-9]+$';
  ELSE
    max_suffix := 0;
  END IF;

  SELECT COALESCE(last_value, 0) INTO cur_value
    FROM pg_sequences
   WHERE schemaname = 'public' AND sequencename = 'complaint_qid_seq';

  target := GREATEST(COALESCE(max_suffix, 0), COALESCE(cur_value, 0));
  IF target < 1 THEN
    PERFORM setval('complaint_qid_seq', 1, false);
  ELSE
    PERFORM setval('complaint_qid_seq', target, true);
  END IF;
  RAISE NOTICE 'complaint_qid_seq set so the next complaint qid suffix is %', target + 1;
END $$;
