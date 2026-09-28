-- Migration: encrypt complaints.phone at rest (P8.5)
--
-- Run this once against any environment that still has phone as plain
-- text. Safe to re-run: the pgcrypto extension creation is idempotent,
-- and this only needs to run once per database (dev, staging, prod).
--
-- REQUIRES: ENCRYPTION_KEY must be set to the same value the application
-- uses (backend/.env), passed in here via psql variable substitution:
--   psql -U oms -d oms -v key="'$ENCRYPTION_KEY'" -f encrypt_phone_at_rest.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'complaints' AND column_name = 'phone' AND data_type = 'text'
  ) THEN
    ALTER TABLE complaints ADD COLUMN phone_encrypted bytea;
    UPDATE complaints SET phone_encrypted = pgp_sym_encrypt(phone, :key) WHERE phone IS NOT NULL;
    ALTER TABLE complaints DROP COLUMN phone;
    ALTER TABLE complaints RENAME COLUMN phone_encrypted TO phone;
    RAISE NOTICE 'complaints.phone migrated to encrypted storage.';
  ELSE
    RAISE NOTICE 'complaints.phone is already encrypted (or does not exist) -- nothing to do.';
  END IF;
END $$;
