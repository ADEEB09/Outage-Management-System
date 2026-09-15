// src/lib/offlineQueue.js
// Native offline handling with AsyncStorage. Status updates made while
// offline are queued and flushed once connectivity returns.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { updateJobStatus } from "./api";

const KEY = "oms-status-queue";

export async function queueUpdate(update) {
  const q = JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  q.push({ ...update, queuedAt: update.queuedAt || Date.now() });
  await AsyncStorage.setItem(KEY, JSON.stringify(q));
}

export async function getQueueLength() {
  const q = JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  return q.length;
}

// Full queued items (job id, status they're stuck trying to sync, and
// when they were queued) — used to render a "pending sync" list on the
// dashboard, not just a count badge.
export async function getQueueItems() {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  } catch {
    return [];
  }
}

export async function flushQueue() {
  const q = JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  if (!q.length) return { flushed: 0, remaining: 0 };

  const remaining = [];
  for (const u of q) {
    try {
      await updateJobStatus(u.id, u.status, u.location || {});
    } catch {
      remaining.push(u);
    }
  }
  await AsyncStorage.setItem(KEY, JSON.stringify(remaining));
  return { flushed: q.length - remaining.length, remaining: remaining.length };
}
