// src/lib/api.js
//
// The SINGLE file that talks to the backend. The UI (App.jsx / NativeApp.jsx
// and their screens) should never call fetch() directly — only these
// functions. That keeps the backend swappable without touching any screen.
//
// Both builds call the same /api/mobile/... routes with a Keycloak bearer
// token (lib/session.js: expo-auth-session natively, keycloak-js on web):
//   - Web (Vite):        relative "/api/..." calls through the dev/nginx proxy
//   - Native (Expo/RN):  absolute calls to the configured server (lib/server.js)
// Signed out, both fall back to the demo crew and jobs below.
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiBase, loadServer } from "./server";
const IS_WEB = Platform.OS === "web";
const WEB_API_URL = "/api";
const JOBS_CACHE_KEY = "oms-jobs-cache";
const JOBS_CACHE_SYNCED_AT_KEY = "oms-jobs-cache-synced-at";

async function session() {
  return import("./session");
}

// Cache the last successfully-fetched job list, including coordinates, so
// the native map can render the last known work area without a network.
async function cacheJobs(jobs) {
  try {
    await AsyncStorage.setItem(JOBS_CACHE_KEY, JSON.stringify(jobs));
    await AsyncStorage.setItem(JOBS_CACHE_SYNCED_AT_KEY, String(Date.now()));
  } catch {
    // best-effort — a caching failure shouldn't block the fetch result
  }
}

async function readCachedJobs() {
  try {
    const stored = await AsyncStorage.getItem(JOBS_CACHE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

// When the cached job list was last successfully synced, or null if
// nothing has ever synced. Shown in the UI as an "offline-ready" note.
export async function getJobsLastSyncedAt() {
  try {
    const stored = await AsyncStorage.getItem(JOBS_CACHE_SYNCED_AT_KEY);
    return stored ? Number(stored) : null;
  } catch {
    return null;
  }
}

/* ========================================================
   DEMO FALLBACK DATA
   Used only when nobody is signed in, so the app is still demoable without
   a live backend/Keycloak instance. A signed-in crew never sees it.
========================================================= */

const DEMO_CREW = {
  id: "C003",
  name: "Crew Gamma-2",
  lead: "Priya Singh",
  role: "Field Technician",
  shift: "06:00–18:00",
  skills: ["HV", "Transformer"],
};

let demoJobs = [
  { id: "JOB-1005", title: "Pending Line Inspection", address: "Mussoorie Road, Dehradun", feeder: "FDR-17", severity: "High", priority: "Urgent", customers: 386, status: "Pending Acceptance", distance: "1.6 km", eta: "6 min", assignedCrewId: "C003", assignedDistance: "1.6 km", coordinates: { lat: 30.3606, lon: 78.0647 } },
  { id: "JOB-1001", title: "Transformer Failure", address: "Rajpur Road, Dehradun", feeder: "FDR-12", severity: "Critical", priority: "Urgent", customers: 842, status: "Acknowledged", distance: "2.4 km", eta: "7 min", coordinates: { lat: 30.3476, lon: 78.0808 } },
  { id: "JOB-1002", title: "Line Fault", address: "Haridwar Road, Rishikesh", feeder: "FDR-08", severity: "High", priority: "Urgent", customers: 531, status: "En Route", distance: "5.8 km", eta: "14 min", coordinates: { lat: 30.0869, lon: 78.2676 } },
  { id: "JOB-1003", title: "Fuse Failure", address: "Clock Tower, Dehradun", feeder: "FDR-03", severity: "Medium", priority: "Normal", customers: 214, status: "On Site", distance: "8.2 km", eta: "21 min", coordinates: { lat: 30.3243, lon: 78.0418 } },
  { id: "JOB-1004", title: "Cable Fault", address: "Prem Nagar, Dehradun", feeder: "FDR-21", severity: "Low", priority: "Planned", customers: 93, status: "Work Started", distance: "11.4 km", eta: "28 min", coordinates: { lat: 30.335, lon: 77.961 } },
];

/* =========================================================
   LOW-LEVEL REQUEST HELPERS
========================================================= */

async function req(path, method = "GET", body) {
  const { freshAuthHeader } = await session();
  if (!IS_WEB) await loadServer();
  const response = await fetch((IS_WEB ? WEB_API_URL : apiBase()) + path, {
    method,
    headers: { "Content-Type": "application/json", ...(await freshAuthHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function normalizeOmsJob(job) {
  const lat = Number(job.lat ?? job.latitude ?? job.location?.lat ?? job.location?.latitude ?? job.incident?.lat ?? job.incident?.latitude);
  const lon = Number(job.lon ?? job.lng ?? job.longitude ?? job.location?.lon ?? job.location?.longitude ?? job.incident?.lon ?? job.incident?.longitude);
  return {
    id: job.id ?? job.jobId,
    title: job.title ?? job.incident?.type ?? "Priority outage",
    address: job.address ?? job.incident?.zone ?? job.location ?? "Location unavailable",
    feeder: job.feeder ?? job.incident?.feeder ?? job.feederId ?? "—",
    severity: job.severity ?? job.incident?.severity ?? "Medium",
    priority: job.priority ?? "Urgent",
    customers: job.customers ?? job.incident?.customers ?? job.affectedCustomers ?? 0,
    status: job.status ?? "Pending Acceptance",
    distance: job.distance ?? (job.distanceKm ? `${job.distanceKm} km` : "—"),
    eta: job.eta ?? "—",
    assignedCrewId: job.assignedCrewId ?? job.crewId ?? null,
    assignedDistance: job.assignedDistance ?? job.distance ?? "Nearest available",
    incidentId: job.incident_id ?? job.incidentId ?? null,
    // OMS-01: a job on a planned outage gets the permit / switching gates.
    planned: (job.incident?.type ?? job.incidentType) === "Scheduled",
    coordinates: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
  };
}

/* =========================================================
   PUBLIC API — same function names/shapes on web and native
========================================================= */

// GET /api/mobile/crews/:crewId — the signed-in crew's record.
export async function getCurrentCrew() {
  const { isAuthenticated, myCrewId, currentUsername } = await session();
  if (!isAuthenticated()) return DEMO_CREW;
  try {
    return await req("/mobile/crews/" + myCrewId());
  } catch {
    // Signed in but the backend is unreachable: keep the real identity
    // (so tracking and uploads still go to the right crew) rather than
    // passing the demo crew off as the tester's own.
    return { ...DEMO_CREW, id: myCrewId(), name: currentUsername() || myCrewId(), lead: "", skills: [] };
  }
}

// GET /api/mobile/crews/:crewId/jobs — this crew's jobs + incidents.
export async function getMyJobs() {
  const { isAuthenticated, myCrewId } = await session();
  if (!isAuthenticated()) return demoJobs;
  try {
    const jobs = await req("/mobile/crews/" + myCrewId() + "/jobs");
    const mapped = (jobs ?? []).map(normalizeOmsJob);
    await cacheJobs(mapped);
    return mapped;
  } catch {
    // No connectivity / backend unreachable — show the last real synced
    // job list (offline-ready data) so the crew still sees their actual
    // last-known assignments. A signed-in crew never gets the demo set:
    // sample jobs would look like real work and hide the outage.
    const cached = await readCachedJobs();
    return cached ?? [];
  }
}

// PATCH /api/mobile/jobs/:id/status  { status, lat, lon }
export async function updateJobStatus(id, status, location = {}) {
  const { isAuthenticated } = await session();
  if (!isAuthenticated()) {
    // Demo mode: keep the change locally so the demo flow still advances.
    demoJobs = demoJobs.map((item) => (item.id === id ? { ...item, status } : item));
    return demoJobs.find((item) => item.id === id);
  }
  return req(`/mobile/jobs/${id}/status`, "PATCH", {
    status,
    lat: location.lat ?? null,
    lon: location.lon ?? null,
  });
}

// POST /api/mobile/jobs/:id/photos  { dataUrl, lat, lon, note }
export async function uploadJobPhoto(id, dataUrl, location = {}, note, metadata = {}) {
  // Demo mode has no account to upload as; the photo stays on the device.
  if (!(await session()).isAuthenticated()) return { id: "demo-photo", job_id: id, demo: true };
  return req(`/mobile/jobs/${id}/photos`, "POST", {
    dataUrl,
    lat: location.lat ?? null,
    lon: location.lon ?? null,
    note: note ?? null,
    ...metadata,
  });
}

// POST /api/mobile/crews/:crewId/tracking  { state: "on" | "off", reason }
// Tells dispatch whether continuous tracking is running; an unexpected "off"
// raises an alert on the OMS dashboard. Demo mode reports nothing.
export async function reportTrackingState(crewId, state, reason) {
  if (!(await session()).isAuthenticated()) return null;
  return req(`/mobile/crews/${crewId}/tracking`, "POST", { state, reason: reason ?? null });
}

export async function getJobMessages(jobId) {
  return req(`/mobile/jobs/${jobId}/messages`);
}

export async function getCrewMessages(crewId) {
  return req(`/mobile/crews/${crewId}/messages`);
}

export async function getJobPhotos(jobId) {
  return req(`/mobile/jobs/${jobId}/photos`);
}

export async function saveAssetScan(jobId, scan) {
  return req(`/mobile/jobs/${jobId}/assets/scans`, "POST", scan);
}

export async function getAssetScans(jobId) {
  return req(`/mobile/jobs/${jobId}/assets/scans`);
}

export async function logout() {
  // The cached job list belongs to the crew that is signing out.
  await AsyncStorage.multiRemove([JOBS_CACHE_KEY, JOBS_CACHE_SYNCED_AT_KEY]).catch(() => {});
  const { logout: sessionLogout } = await session();
  await sessionLogout(); // on web this redirects through Keycloak's logout
}

/* =========================================================
   OMS-01 PLANNED OUTAGES
   Permit calls are online-only: a failure is thrown, never queued.
   Switching confirmations recorded offline are sent by safetyStore.js.
========================================================= */

// Like req(), but keeps what the caller needs to tell "no signal" from "the
// server refused": err.status (none if the server wasn't reached) and the
// server's rule code (e.g. PREDECESSOR_UNCONFIRMED).
async function plannedReq(path, method = "GET", body) {
  const { freshAuthHeader } = await session();
  if (!IS_WEB) await loadServer();
  const response = await fetch((IS_WEB ? WEB_API_URL : apiBase()) + path, {
    method,
    headers: { "Content-Type": "application/json", ...(await freshAuthHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.message || data.error || `HTTP ${response.status}`), { status: response.status, code: data.code });
  }
  return data;
}

const newRequestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// The job's outage as this crew sees it: steps (with "actionable"), permit.
export function getPlannedOutage(jobId) {
  return plannedReq(`/mobile/jobs/${jobId}/planned-outage`);
}

export function requestPermit(jobId) {
  return plannedReq(`/mobile/jobs/${jobId}/permit/request`, "POST", { clientRequestId: newRequestId() });
}

export function withdrawPermit(permitId) {
  return plannedReq(`/mobile/permits/${permitId}/withdraw`, "POST", {});
}

// declaration: { menWithdrawn, earthsRemoved, toolsClear, remarks }
export function returnPermit(permitId, declaration) {
  return plannedReq(`/mobile/permits/${permitId}/return`, "POST", { clientRequestId: newRequestId(), declaration });
}

// { clientConfirmationId, performedAt, lat, lon }; sentAt lets the server
// correct a phone clock that is off.
export function confirmSwitchingStep(stepId, body) {
  return plannedReq(`/mobile/switching-steps/${stepId}/confirm`, "POST", { ...body, sentAt: new Date().toISOString() });
}

// Gated status change for a planned job (Work Started / Work Finished):
// online only, so a refused or unsent change is reported, never queued.
export function updatePlannedJobStatus(id, status, location = {}) {
  return plannedReq(`/mobile/jobs/${id}/status`, "PATCH", { status, lat: location.lat ?? null, lon: location.lon ?? null });
}
