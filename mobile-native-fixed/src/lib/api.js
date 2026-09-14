// src/lib/api.js
//
// The SINGLE file that talks to the backend. The UI (App.jsx / NativeApp.jsx
// and their screens) should never call fetch() directly — only these
// functions. That keeps the backend swappable without touching any screen.
//
// This file works for BOTH builds:
//   - Web (Vite):        relative "/api/..." calls, cookie session (credentials: include)
//   - Native (Expo/RN):  absolute API_BASE calls, Keycloak bearer token
// `Platform.OS` (via react-native-web on the web build) tells us which mode
// we're in, so screens can share the exact same function signatures.
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE } from "../config";

const IS_WEB = Platform.OS === "web";
const WEB_API_URL = "/api";
const JOBS_CACHE_KEY = "oms-jobs-cache";
const JOBS_CACHE_SYNCED_AT_KEY = "oms-jobs-cache-synced-at";

async function nativeAuth() {
  return import("./auth");
}

// Cache the last successfully-fetched job list (with locations/addresses)
// to disk, so the Jobs list and Map screen still have real, last-known
// data to show when the device has no connectivity — this is what
// "offline maps" means here: cached job/location data, not offline map
// *tiles*. Rendering actual pannable/zoomable map tiles without a network
// connection needs a dedicated mapping SDK (e.g. react-native-maps with
// Mapbox/Google offline packs) and API keys, which is a separate scope
// addition from this caching layer.
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

/* =========================================================
   DEMO FALLBACK DATA
   Used only when the real backend can't be reached, so the app is still
   demoable without a live backend/Keycloak instance.
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
  { id: "JOB-1005", title: "Pending Line Inspection", address: "Mussoorie Road, Dehradun", feeder: "FDR-17", severity: "High", priority: "Urgent", customers: 386, status: "Pending Acceptance", distance: "1.6 km", eta: "6 min", assignedCrewId: "C003", assignedDistance: "1.6 km" },
  { id: "JOB-1001", title: "Transformer Failure", address: "Rajpur Road, Dehradun", feeder: "FDR-12", severity: "Critical", priority: "Urgent", customers: 842, status: "Acknowledged", distance: "2.4 km", eta: "7 min" },
  { id: "JOB-1002", title: "Line Fault", address: "Haridwar Road, Rishikesh", feeder: "FDR-08", severity: "High", priority: "Urgent", customers: 531, status: "En Route", distance: "5.8 km", eta: "14 min" },
  { id: "JOB-1003", title: "Fuse Failure", address: "Clock Tower, Dehradun", feeder: "FDR-03", severity: "Medium", priority: "Normal", customers: 214, status: "On Site", distance: "8.2 km", eta: "21 min" },
  { id: "JOB-1004", title: "Cable Fault", address: "Prem Nagar, Dehradun", feeder: "FDR-21", severity: "Low", priority: "Planned", customers: 93, status: "Work Started", distance: "11.4 km", eta: "28 min" },
];

/* =========================================================
   LOW-LEVEL REQUEST HELPERS
========================================================= */

// Web: same-origin, cookie-authenticated session (existing behaviour).
async function webReq(path, method = "GET", body) {
  const response = await fetch(WEB_API_URL + path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

// Native: absolute backend URL, Keycloak bearer token (per the OMS mobile guide).
async function nativeReq(path, method = "GET", body) {
  const { authHeader } = await nativeAuth();
  const response = await fetch(API_BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function normalizeOmsJob(job) {
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
  };
}

/* =========================================================
   PUBLIC API — same function names/shapes on web and native
========================================================= */

// GET current crew record.
// Web:    GET /api/me                         (cookie session)
// Native: GET /api/mobile/crews/:crewId        (Keycloak bearer token)
export async function getCurrentCrew() {
  try {
    if (IS_WEB) return await webReq("/me");
    const { isAuthenticated, myCrewId } = await nativeAuth();
    if (!isAuthenticated()) return DEMO_CREW;
    return await nativeReq("/mobile/crews/" + myCrewId());
  } catch {
    return DEMO_CREW;
  }
}

// GET this crew's jobs + incidents.
// Web:    GET /api/jobs
// Native: GET /api/mobile/crews/:crewId/jobs
export async function getMyJobs() {
  try {
    if (IS_WEB) {
      const payload = await webReq("/jobs");
      const jobs = Array.isArray(payload) ? payload : payload.jobs ?? [];
      const result = jobs.length ? jobs : demoJobs;
      if (jobs.length) await cacheJobs(result);
      return result;
    }
    const { isAuthenticated, myCrewId } = await nativeAuth();
    if (!isAuthenticated()) return demoJobs;
    const jobs = await nativeReq("/mobile/crews/" + myCrewId() + "/jobs");
    const mapped = (jobs ?? []).map(normalizeOmsJob);
    await cacheJobs(mapped);
    return mapped;
  } catch {
    // No connectivity / backend unreachable — prefer the last real
    // synced job list (offline-ready data) over the static demo set,
    // so the crew still sees their actual last-known assignments.
    const cached = await readCachedJobs();
    return cached && cached.length ? cached : demoJobs;
  }
}

export async function updateMyJob(id, job) {
  return webReq(`/jobs/${id}`, "PUT", job);
}

// PATCH status + GPS for a job.
// Web:    PUT  /api/jobs/:id                 (whole job object, existing behaviour)
// Native: PATCH /api/mobile/jobs/:id/status  { status, lat, lon }
export async function updateJobStatus(id, status, location = {}, job) {
  if (IS_WEB) {
    const updatedJob = { ...job, status, location };
    demoJobs = demoJobs.map((item) => (item.id === id ? updatedJob : item));
    try {
      return await updateMyJob(id, updatedJob);
    } catch {
      return updatedJob;
    }
  }
  return nativeReq(`/mobile/jobs/${id}/status`, "PATCH", {
    status,
    lat: location.lat ?? null,
    lon: location.lon ?? null,
  });
}

// POST a photo for a job (native only — the web app uses local object URLs).
// Native: POST /api/mobile/jobs/:id/photos  { dataUrl, lat, lon, note }
export async function uploadJobPhoto(id, dataUrl, location = {}, note) {
  if (IS_WEB) {
    return webReq(`/mobile/jobs/${id}/photos`, "POST", {
      dataUrl,
      lat: location.lat ?? null,
      lon: location.lon ?? null,
      note: note ?? null,
    });
  }
  return nativeReq(`/mobile/jobs/${id}/photos`, "POST", {
    dataUrl,
    lat: location.lat ?? null,
    lon: location.lon ?? null,
    note: note ?? null,
  });
}

export async function logout() {
  if (IS_WEB) {
    window.location.reload();
    return;
  }
  const { logout: authLogout } = await import("./auth");
  await authLogout();
}