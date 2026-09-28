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
let currentCrewId = null;

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
  const locations = data?.locations;
  if (!locations?.length) return;

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

// Call once, after the crew member has a real session and has granted
// background location permission.
export async function startCrewTracking(crewId) {
  currentCrewId = crewId;
  await AsyncStorage.setItem(CREW_ID_KEY, crewId).catch(() => {});

  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
  if (alreadyRunning) return true;

  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
  if (fgStatus !== "granted") return false;

  const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
  if (bgStatus !== "granted") return false;

  await Location.startLocationUpdatesAsync(TASK_NAME, {
    // High = satellite GPS. "Balanced" leans on Wi-Fi/cell-tower lookups,
    // which degrade badly exactly when the crew has no data connection.
    accuracy: Location.Accuracy.High,
    timeInterval: 30000, // every 30 seconds
    distanceInterval: 50, // or every 50 meters moved, whichever comes first
    pausesUpdatesAutomatically: false, // iOS: don't silently stop when parked at a site
    activityType: Location.ActivityType.OtherNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "OMS Crew — location sharing active",
      notificationBody: "Your position is shared with dispatch while on duty, and saved offline when there is no signal.",
      killServiceOnDestroy: false,
    },
  });
  return true;
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

export async function isCrewTrackingActive() {
  return Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
}
