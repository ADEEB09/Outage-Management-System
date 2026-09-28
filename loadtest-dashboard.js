// k6 load test for P8.6: prove the dashboard genuinely responds in under
// 3 seconds with 500 concurrent users hitting it.
//
// Run: k6 run --env TOKEN=<real_bearer_token> loadtest-dashboard.js
//
// The token needs to be a real, currently-valid Keycloak token (same as
// used throughout today's testing) -- grab one from the browser's Network
// tab the same way, since a load test against an unauthenticated endpoint
// wouldn't prove anything about the real, authenticated dashboard path.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const dashboardLatency = new Trend('dashboard_latency', true);

export const options = {
  scenarios: {
    dashboard_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 500 },  // ramp up to 500 concurrent "users"
        { duration: '1m', target: 500 },   // hold at 500 for a real, sustained window
        { duration: '15s', target: 0 },    // ramp down
      ],
    },
  },
  thresholds: {
    // The actual P8.6 target: 95% of requests must complete under 3000ms.
    // A load test that only reports an AVERAGE would hide a real problem --
    // some real users would still see slow responses even if the average
    // looked fine. p(95) is the honest bar.
    'dashboard_latency': ['p(95)<3000'],
    'http_req_failed': ['rate<0.01'],  // fewer than 1% of requests should fail outright
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8091';
const TOKEN = __ENV.TOKEN;

export default function () {
  const headers = { Authorization: `Bearer ${TOKEN}` };

  // The actual set of calls a real dashboard load makes -- not just one
  // endpoint. Hitting only /health would prove nothing about real load.
  const incidentsRes = http.get(`${BASE_URL}/api/incidents`, { headers });
  dashboardLatency.add(incidentsRes.timings.duration);
  check(incidentsRes, { 'incidents: status 200': (r) => r.status === 200 });

  const indicatorsRes = http.get(`${BASE_URL}/api/indicators`, { headers });
  dashboardLatency.add(indicatorsRes.timings.duration);
  check(indicatorsRes, { 'indicators: status 200': (r) => r.status === 200 });

  const alarmsRes = http.get(`${BASE_URL}/api/alarms`, { headers });
  dashboardLatency.add(alarmsRes.timings.duration);
  check(alarmsRes, { 'alarms: status 200': (r) => r.status === 200 });

  sleep(1); // a real dashboard user isn't hammering the API in a tight loop
}
