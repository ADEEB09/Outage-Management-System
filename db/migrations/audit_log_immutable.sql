-- P8.4: audit_log immutability trigger
-- Once written, an audit record can never be modified or deleted by
-- anyone -- not even a superuser doing raw SQL -- for the duration of
-- its retention period. This is the actual mechanism that makes a
-- 7-year retention policy trustworthy rather than just a stated intent.

CREATE OR REPLACE FUNCTION prevent_audit_tampering() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log records are immutable and cannot be modified or deleted (P8.4 retention policy)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
CREATE TRIGGER trg_audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
