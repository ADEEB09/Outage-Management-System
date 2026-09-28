-- Migration: fault-tolerant decryption for complaints.phone (fixes a real
-- crash: a single row whose phone can't be decrypted with the current
-- ENCRYPTION_KEY -- e.g. seeded/legacy data encrypted under a different
-- key -- throws inside pgp_sym_decrypt, and since Postgres evaluates that
-- per-row expression as part of one query, the whole SELECT (and, because
-- the calling route had no try/catch, the whole Node process) died.
--
-- safe_decrypt_text wraps pgp_sym_decrypt in a PL/pgSQL exception handler:
-- a row that fails to decrypt returns NULL instead of aborting the query.
-- This does not change how phone numbers are stored or encrypted, and it
-- does not attempt to recover the undecryptable value -- if the key is
-- genuinely wrong for a row, that row's phone number was already
-- unrecoverable; this migration only stops that one bad row from taking
-- the rest of the app down with it.
--
-- Safe to re-run (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION safe_decrypt_text(data bytea, key text)
RETURNS text AS $$
BEGIN
  RETURN pgp_sym_decrypt(data, key);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'safe_decrypt_text: could not decrypt a row (%), returning NULL', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
