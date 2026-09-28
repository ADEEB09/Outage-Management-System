# Audit log retention policy (P8.4)

Status: immutability trigger built and tested (real DELETE and UPDATE
attempts confirmed blocked, 2026-09-16). Automated purge NOT yet built --
see "Purge" section below for why, and what's needed before it should be.

## What "7-year retention" actually requires

Two genuinely separate things, often conflated as one:

1. **Immutability** -- once written, a record can't be altered or deleted
   before its retention period ends. This is the part that makes an audit
   trail *trustworthy*. Built and tested.
2. **Purge after the retention period** -- what happens to records once
   they're genuinely past 7 years old. Not yet built -- see below.

## Immutability -- how it works

A PostgreSQL trigger (`trg_audit_log_immutable`) on the `audit_log` table
rejects any `UPDATE` or `DELETE` at the database level, before it ever
executes -- regardless of which user or role issues it, including a
superuser running raw SQL directly against the database. This is
deliberately stronger than an application-level check (e.g. "the API
doesn't expose a delete-audit-log endpoint"), because it can't be
bypassed by connecting to the database directly.

Tested by directly attempting both a DELETE and an UPDATE against a real
audit record; both were rejected with a clear error identifying this as
the P8.4 retention policy, not a generic database error.

Migration file: `db/migrations/audit_log_immutable.sql`

## Purge -- deliberately not automated yet, and why

Building an automatic "delete anything older than 7 years" job today would
be premature for a few real reasons:

- The system has only been running for a matter of weeks -- there is no
  data anywhere near 7 years old to test a purge against yet.
- The exact purge behavior needs a real decision, not a default: hard
  delete vs. archive-then-delete (moving old records to cold storage
  first), and whether the 7-year clock starts from record creation or
  from some other regulatory-defined event.
- Given the immutability trigger above would also block an automated
  purge job's own DELETE statements, a real purge mechanism needs a
  deliberate, audited exception path (e.g. a scheduled job running with
  a specific, logged, time-restricted privilege) -- not just disabling
  the trigger, which would defeat its purpose.

**Recommendation**: revisit this specifically once either (a) the system
has been in real production use for long enough that purge is a genuine
near-term concern, or (b) UPCL/PFC's regulatory contact confirms the exact
required behavior (hard delete vs. archive) -- building the wrong one now
risks having to redo it later against real, sensitive audit data.

## What genuinely satisfies P8.4 today

Every operator action is already logged with actor, action, target, and
timestamp (`repo.audit()`, called throughout `api.js`), viewable via the
admin-only `/audit` endpoint -- this was already true before today's work,
per the existing tracker note.

What today's work adds: those records, once written, are now genuinely
tamper-proof at the database level -- not just "nobody built a delete
button," but "the database itself refuses to allow it."
