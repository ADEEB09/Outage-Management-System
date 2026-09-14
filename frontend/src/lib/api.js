import { io } from 'socket.io-client';
import { authHeader } from './auth.js';

const BASE = '/api';
async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { data, status: r.status });
  return data;
}
async function exportReliabilityReport(format, filters = {}) {
  const params = new URLSearchParams({ format, ...filters });
  const r = await fetch(`${BASE}/reports/reliability?${params}`, {
    method: 'GET',
    headers: { ...authHeader() },
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || r.statusText), { data, status: r.status });
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reliability-report.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
export const api = {
  incidents: () => req('GET', '/incidents'),
  incident: (id) => req('GET', `/incidents/${id}`),
  createIncident: (b) => req('POST', '/incidents', b),
  setStatus: (id, status, note) => req('PATCH', `/incidents/${id}/status`, { status, note }),
  assign: (id, crewId, priority) => req('POST', `/incidents/${id}/assign`, { crewId, priority }),
  messages: (id) => req('GET', `/incidents/${id}/messages`),
  postMessage: (id, body) => req('POST', `/incidents/${id}/messages`, { body }),
  setErt: (id, ert) => req('PATCH', `/incidents/${id}/ert`, { ert }),
  crews: () => req('GET', '/crews'),
  nearestCrews: (incidentId) => req('GET', `/incidents/${incidentId}/nearest-crews`),
  alarms: () => req('GET', '/alarms'),
  ackAlarm: (id) => req('POST', `/alarms/${id}/ack`),
  ackAll: () => req('POST', '/alarms/ack-all'),
  calls: () => req('GET', '/calls'),
  callToIncident: (id) => req('POST', `/calls/${id}/to-incident`),
  indicators: () => req('GET', '/indicators'),
  monthly: () => req('GET', '/analytics/monthly'),
  exportReliabilityReport,
  audit: () => req('GET', '/audit'),
  network: () => req('GET', '/network'),
  complaints: () => req('GET', '/complaints'),
  complaintTrace: (qid) => req('GET', `/complaints/${qid}/trace`),
  simulateComplaint: () => req('POST', '/complaints/simulate'),
  
};

// singleton socket
export const socket = io('/', { transports: ['websocket', 'polling'], autoConnect: true });