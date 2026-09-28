-- reset-demo.sql
-- Run this before every demo to get a clean, predictable starting state:
-- all crews free, no leftover jobs cluttering the crew app, and no pile-up
-- of old test incidents cluttering the Dispatch/Incidents screens.
--
-- Safe to run repeatedly. Does NOT touch users, roles, or Keycloak config --
-- only crew status, job records, and incident status.

-- 1. Every crew back to available, so any incident you create live can
--    actually be assigned to whichever crew you're logged into on the phone.
UPDATE crews SET status = 'available';

-- 2. Clear out job records entirely. This is what the crew app's "My Jobs"
--    list actually reads from -- wiping it gives you a genuinely empty list
--    to demo INTO, instead of old stale/completed jobs cluttering it.
DELETE FROM job_photos;
DELETE FROM job_updates;
DELETE FROM jobs;

-- 3. Close out old open/dispatched incidents so the Dashboard and Dispatch
--    screens aren't showing dozens of leftover test incidents. Keeps
--    everything from the last 10 minutes untouched, in case you're mid-demo
--    and just re-running this between two separate sessions today.
UPDATE incidents
SET status = 'closed'
WHERE status NOT IN ('closed', 'cancelled')
  AND opened_at < now() - interval '10 minutes';

-- Quick confirmation of the clean state:
SELECT 'crews available' AS check, count(*) FROM crews WHERE status = 'available'
UNION ALL
SELECT 'active jobs', count(*) FROM jobs
UNION ALL
SELECT 'open incidents', count(*) FROM incidents WHERE status NOT IN ('closed', 'cancelled');