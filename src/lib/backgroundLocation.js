// src/lib/backgroundLocation.js
// Continuous crew location tracking, sent to the OMS backend even while
// the app is minimized or the screen is off. Requires a custom dev
// client / production build — this does NOT work in plain Expo Go,
// since background location needs native task registration.
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { API_BASE } from "../config";
import { authHeader } from "./auth";

const TASK_NAME = "oms-crew-location-task";
let currentCrewId = null;

// The background task must be defined at module scope (not inside a
// component), so it survives app restarts and can be found by the OS
// when it wakes the task up in the background.
TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
  console.log("[backgroundLocation] task fired. currentCrewId:", currentCrewId);
  if (error) {
    console.error("[backgroundLocation] task error:", error);
    return;
  }
  const { locations } = data || {};
  const latest = locations?.[0];
  if (!latest || !currentCrewId) return;

  try {
    const url = `${API_BASE}/mobile/crews/${currentCrewId}/location`;
    console.log("[backgroundLocation] sending ping to:", url, "coords:", latest.coords.latitude, latest.coords.longitude);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({
        lat: latest.coords.latitude,
        lon: latest.coords.longitude,
      }),
    });
    console.log("[backgroundLocation] response status:", response.status);
  } catch (err) {
    console.warn("[backgroundLocation] failed to send ping:", err?.message);
  }
});

// Call once, after the crew member has a real session and has granted
// background location permission (see requestBackgroundLocationPermission).
export async function startCrewTracking(crewId) {
  currentCrewId = crewId;

  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
  if (alreadyRunning) return true;

  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
  if (fgStatus !== "granted") return false;

  const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
  if (bgStatus !== "granted") return false;

  await Location.startLocationUpdatesAsync(TASK_NAME, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 30000, // every 30 seconds
    distanceInterval: 50, // or every 50 meters moved, whichever comes first
    foregroundService: {
      notificationTitle: "OMS Crew — location sharing active",
      notificationBody: "Your position is being shared with dispatch while on duty.",
    },
  });
  return true;
}

export async function stopCrewTracking() {
  currentCrewId = null;
  const running = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
  if (running) await Location.stopLocationUpdatesAsync(TASK_NAME);
}

export async function isCrewTrackingActive() {
  return Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
}
