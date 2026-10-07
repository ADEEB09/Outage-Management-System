// src/lib/backgroundLocation.js
// Continuous crew location tracking, sent to the OMS backend even while
// the app is minimized, the screen is off, or the phone has no network.
// Requires a custom dev client / production build — this does NOT work in
// plain Expo Go, since background location needs native task registration.
//
// Store-and-forward: every fix goes into the on-device SQLite queue first
// (see locationQueue.js), then the queue is flushed to OMS when there is
// connectivity. GPS itself needs no internet, so tracking keeps recording
// through dead zones and the backlog uploads, in order, once back online.
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { enqueueLocations, flushLocations } from "./locationQueue";

const TASK_NAME = "oms-crew-location-task";
const CREW_ID_KEY = "oms-tracking-crew-id";
// Set when the crew switches tracking off themselves, so the automatic start
// on sign-in doesn't override that choice until the next sign-in.
const PAUSED_BY_CREW_KEY = "oms-tracking-paused-by-crew";
let currentCrewId = null;

// The OS delivers a fix every few seconds even when parked (distanceInterval
// is 0, see startCrewTracking). Only fixes that moved MIN_MOVE_M, or a
// heartbeat every HEARTBEAT_MS when standing still, are kept, so dispatch can
// tell "parked at the site" from "phone stopped reporting" (the backend
// flags a crew whose position goes stale).
const MIN_MOVE_M = 10;
const HEARTBEAT_MS = 60 * 1000;
let lastKept = null;

function metersBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function keepFix(loc) {
  const c = loc?.coords;
  if (!c) return false;
  if (lastKept && loc.timestamp - lastKept.timestamp < HEARTBEAT_MS && metersBetween(lastKept.coords, c) < MIN_MOVE_M) return false;
  lastKept = loc;
  return true;
}

// The background task must be defined at module scope (not inside a
// component), so it survives app restarts and can be found by the OS
// when it wakes the task up in the background.
TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.warn("[backgroundLocation] task error:", error?.message);
    return;
  }
  // The OS may batch several fixes into one wake-up (oldest first) —
  // keep all of them, not just one, so the trail has no gaps.
  const locations = (data?.locations || []).filter(keepFix);
  if (!locations.length) return;

  // `currentCrewId` is only set in memory by startCrewTracking(), so it's
  // gone if this fired in a fresh headless JS instance after the app
  // process was killed. Fall back to storage.
  const crewId = currentCrewId || (await AsyncStorage.getItem(CREW_ID_KEY).catch(() => null));
  if (!crewId) return;

  try {
    await enqueueLocations(crewId, locations);
  } catch (err) {
    console.warn("[backgroundLocation] failed to queue fix:", err?.message);
    return;
  }
  // Best-effort upload; if offline or it fails, the fixes stay queued and
  // go out on a later wake-up or when the app sees the network return.
  await flushLocations().catch(() => {});
});

// Call once the crew member has a real session. Asks for location permission
// if needed. Resolves to { on, reason } — reason says why it is off:
// "permission_denied" or "background_permission_denied".
export async function startCrewTracking(crewId) {
  currentCrewId = crewId;
  await AsyncStorage.setItem(CREW_ID_KEY, crewId).catch(() => {});

  // Already running (e.g. from an older app version): skip the permission
  // prompts but still re-start below, so the task picks up current options.
  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
  if (!alreadyRunning) {
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== "granted") return { on: false, reason: "permission_denied" };

    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== "granted") return { on: false, reason: "background_permission_denied" };
  }

  await Location.startLocationUpdatesAsync(TASK_NAME, {
    // High = satellite GPS. "Balanced" leans on Wi-Fi/cell-tower lookups,
    // which degrade badly exactly when the crew has no data connection.
    accuracy: Location.Accuracy.High,
    // Frequent enough for dispatch to watch the crew move live on the map.
    // distanceInterval 0 so a parked crew still gets fixes; keepFix() thins
    // them to moves of 10 m plus a once-a-minute heartbeat.
    timeInterval: 5000,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false, // iOS: don't silently stop when parked at a site
    activityType: Location.ActivityType.OtherNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "OMS Crew — location sharing active",
      notificationBody: "Your position is shared with dispatch while on duty, and saved offline when there is no signal.",
      killServiceOnDestroy: false,
    },
  });
  return { on: true };
}

export async function stopCrewTracking() {
  currentCrewId = null;
  await AsyncStorage.removeItem(CREW_ID_KEY).catch(() => {});
  const running = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
  if (running) await Location.stopLocationUpdatesAsync(TASK_NAME);
  // Anything still queued is kept (tagged with its crew id) and uploaded by
  // the next flush — stopping tracking must not discard recorded history.
  flushLocations().catch(() => {});
}

// Whether the phone's Location switch is on. Tracking keeps running while it
// is off (Android resumes the fixes by itself once it is back on), but no
// positions arrive, so the app warns the crew and tells dispatch.
export async function isLocationServiceOn() {
  return Location.hasServicesEnabledAsync().catch(() => true);
}

export async function isCrewTrackingActive() {
  return Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
}

export async function setTrackingPausedByCrew(paused) {
  if (paused) await AsyncStorage.setItem(PAUSED_BY_CREW_KEY, "1").catch(() => {});
  else await AsyncStorage.removeItem(PAUSED_BY_CREW_KEY).catch(() => {});
}

// Start tracking for a signed-in crew unless it is already running or the
// crew turned it off this session. Resolves to { on, reason } like
// startCrewTracking, with reason "turned_off" for the crew's own choice.
export async function autoStartCrewTracking(crewId) {
  if (await isCrewTrackingActive()) {
    // Running from before (it survives app restarts); make sure the task
    // reports for the crew that is signed in now.
    currentCrewId = crewId;
    await AsyncStorage.setItem(CREW_ID_KEY, crewId).catch(() => {});
    return { on: true };
  }
  if ((await AsyncStorage.getItem(PAUSED_BY_CREW_KEY).catch(() => null)) === "1") return { on: false, reason: "turned_off" };
  return startCrewTracking(crewId);
}
