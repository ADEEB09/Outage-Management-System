// src/lib/offlineQueue.js
// "Pending sync": job status changes, photos and QR asset scans made while
// the server can't be reached are kept on the phone and sent, in order, once
// it can. Each item carries when it really happened, so the server records
// that time, not the time it finally synced.
//
// Item shapes (older app versions stored status items without `type`):
//   { type: 'status', id, status, location, queuedAt }
//   { type: 'photo',  id, file, location, note, extra, queuedAt }   image in `file`
//   { type: 'scan',   id, scan, queuedAt }
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { updateJobStatus, uploadJobPhoto, saveAssetScan } from "./api";

const KEY = "oms-status-queue";
// Photos are several hundred KB of base64, too big for AsyncStorage (about
// 2 MB per entry on Android), so each one waits in its own file.
const photoDir = () => new Directory(Paths.document, "pending-photos");

async function readQueue() {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  } catch {
    return [];
  }
}

const writeQueue = (q) => AsyncStorage.setItem(KEY, JSON.stringify(q));

async function push(item) {
  const q = await readQueue();
  q.push({ ...item, queuedAt: item.queuedAt || Date.now() });
  await writeQueue(q);
}

// Worth queueing and retrying: the server wasn't reached (no network, DNS,
// timeout: fetch throws without a status) or failed on its side (5xx).
// A 4xx is the server refusing this request, which retrying won't change.
export function isRetryable(err) {
  return !err?.status || err.status >= 500 || err.status === 408 || err.status === 429;
}

export async function queueUpdate(update) {
  await push({ type: "status", ...update });
}

export async function queuePhoto(jobId, dataUrl, location, note, extra) {
  const dir = photoDir();
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, `${jobId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  file.write(dataUrl);
  await push({ type: "photo", id: jobId, file: file.uri, location, note: note ?? null, extra: extra ?? {} });
}

export async function queueScan(jobId, scan) {
  await push({ type: "scan", id: jobId, scan });
}

export async function getQueueLength() {
  return (await readQueue()).length;
}

// Full queued items (job id, what is waiting and since when), for the
// "pending sync" list on the dashboard.
export async function getQueueItems() {
  return readQueue();
}

async function send(item) {
  const ts = new Date(item.queuedAt).toISOString();
  if (item.type === "photo") {
    const file = new File(item.file);
    if (!file.exists) return; // lost (e.g. app data cleared): nothing to send
    const dataUrl = await file.text();
    await uploadJobPhoto(item.id, dataUrl, item.location || {}, item.note, { ...item.extra, capturedAt: ts });
    try { file.delete(); } catch { /* already gone */ }
  } else if (item.type === "scan") {
    await saveAssetScan(item.id, { ...item.scan, scannedAt: ts });
  } else {
    await updateJobStatus(item.id, item.status, item.location || {}, ts);
  }
}

let flushing = null;

// Sends queued items oldest first. Stops at the first one the server can't
// be reached for (the rest would fail too, and order matters: "On Site" must
// not arrive before "En Route"). One the server refuses stays queued.
export function flushQueue() {
  if (!flushing) {
    flushing = (async () => {
      const q = await readQueue();
      if (!q.length) return { flushed: 0, remaining: 0 };
      const remaining = [];
      let offline = false;
      for (const item of q) {
        if (offline) { remaining.push(item); continue; }
        try {
          await send(item);
        } catch (err) {
          if (isRetryable(err)) offline = true;
          remaining.push(item);
        }
      }
      // Anything queued while this flush ran goes after what is left.
      const added = (await readQueue()).slice(q.length);
      await writeQueue([...remaining, ...added]);
      return { flushed: q.length - remaining.length, remaining: remaining.length + added.length };
    })().finally(() => { flushing = null; });
  }
  return flushing;
}
