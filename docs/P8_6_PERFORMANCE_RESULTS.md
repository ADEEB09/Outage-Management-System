# Performance & availability testing (P8.6)

Test date: 2026-09-16
Tool: k6 v2.2.0
Target: dashboard endpoints (/api/incidents, /api/indicators, /api/alarms)
Load pattern: 500 concurrent virtual users, 1m45s sustained, ~93,000 total requests

## Result: dashboard target MET, with real margin

| Metric | Target | Actual result |
|---|---|---|
| p(95) response time | < 3000ms | **262ms** |
| Request failure rate | < 1% | **0%** (0 failures out of 92,832 requests) |
| Average response time | -- | 113.77ms |
| Max response time | -- | 377.5ms |

The 95th-percentile response time came in at roughly 9% of the 3-second
target, under sustained load from 500 concurrent simulated users. This is
a genuine, real result -- not an extrapolation -- against the actual
Kubernetes-deployed backend built in P8.1, hitting real Postgres, real
Redis, through a real authenticated request path.

## An important, honest finding along the way: rate limiting vs. load testing

The first test run showed a 99.89% failure rate -- which looked alarming,
but turned out to be Kong's rate-limiting plugin (P4.3, configured at 60
requests/minute) correctly doing its job against the load test's own
traffic, not a genuine backend performance problem. Confirmed by response
headers (X-RateLimit-Limit-Minute: 60) and by re-running the same test
directly against the backend service, bypassing Kong, which produced the
clean result above.

This is a real, useful finding in its own right: the rate limit
configured for abuse protection is, by design, far too strict for 500
legitimate concurrent users. This needs a deliberate decision before
production: either a much higher limit for authenticated/known clients,
or a different rate-limiting strategy (e.g. per-user limits high enough
for normal use, with a separate, stricter limit only for unauthenticated
or suspicious traffic).

## Honest scope of what this test does and does not prove

What it genuinely proves: the backend application code, database
queries, and Kubernetes deployment can handle 500 concurrent authenticated
users making realistic dashboard requests, with fast, reliable responses.

What it does not yet prove:
- This ran on a single developer laptop (24 CPUs, 7.6GB allocated to
  Docker), not the real DCC hardware -- the real servers may perform
  better or worse depending on their actual specification.
- The 10,000 concurrent mobile sessions target has not been tested at
  all -- this test only covered the web dashboard's 500-user target.
  Mobile session load has a different shape (more, lighter, more
  frequent small requests from the crew app) and needs its own test.
- The 99.9% uptime target is a long-duration availability measure,
  not something a 105-second load test can speak to -- that needs
  extended monitoring against a real deployment, not a load test.
- The RTO < 15 minutes target was indirectly exercised via the
  PostgreSQL replication failover test (P8.2), which completed well
  under that window, but that test was not run under simultaneous heavy
  load -- a real disaster during peak traffic is a harder scenario.

## Recommended next steps for full P8.6 completion

1. Build and run a comparable load test simulating mobile crew-app traffic
   at the 10,000-session target.
2. Revisit the Kong rate-limit configuration with a real, deliberate
   policy (not just raising the number until tests pass).
3. Once real DCC hardware is available, re-run this same test against it
   -- today's result is a strong signal, not a substitute for testing the
   real target environment.
