// src/lib/safetyStore.js
// OMS-01: switching-step confirmations made with no signal. Deliberately NOT
// offlineQueue.js (fire-and-forget, AsyncStorage): a lost switching
// confirmation means the control room's picture of what is energised is
// wrong. So:
//  - each confirmation is one SQLite transaction (survives the app being
//    killed) with a client id the server de-duplicates on;
//  - it is removed only after the server acknowledges it (2xx);
//  - a confirmation the server refuses is kept and shown as rejected, never
//    retried automatically and never dropped without the crew's say-so;
//  - while anything is stored, the app unlocks no further step.
// Sending order and the rules are in plannedOutage.js (tested in Node).
import * as SQLite from "expo-sqlite";
import * as Crypto from "expo-crypto";
import { confirmSwitchingStep } from "./api";
import { flushConfirmations } from "./plannedOutage";

let dbPromise = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("oms-safety.db");
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS pending_confirmations (
          client_confirmation_id TEXT PRIMARY KEY NOT NULL,
          planned_outage_id TEXT NOT NULL,
          step_id      TEXT NOT NULL,
          step_label   TEXT NOT NULL,
          performed_at TEXT NOT NULL,
          lat          REAL,
          lon          REAL,
          created_at   INTEGER NOT NULL,
          attempts     INTEGER NOT NULL DEFAULT 0,
          last_error   TEXT,
          last_code    TEXT
        );
      `);
      return db;
    })().catch((err) => {
      dbPromise = null; // allow a retry on the next call
      throw err;
    });
  }
  return dbPromise;
}

// The crew says "done" for one step. Stored first, sent after.
export async function recordConfirmation({ plannedOutageId, stepId, stepLabel, lat = null, lon = null }) {
  const db = await getDb();
  const id = Crypto.randomUUID();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO pending_confirmations (client_confirmation_id, planned_outage_id, step_id, step_label, performed_at, lat, lon, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, plannedOutageId, stepId, stepLabel, new Date().toISOString(),
      Number.isFinite(lat) ? lat : null, Number.isFinite(lon) ? lon : null, Date.now()
    );
  });
  return id;
}

export async function pendingConfirmations(plannedOutageId) {
  const db = await getDb();
  return plannedOutageId
    ? db.getAllAsync("SELECT * FROM pending_confirmations WHERE planned_outage_id = ? ORDER BY created_at", plannedOutageId)
    : db.getAllAsync("SELECT * FROM pending_confirmations ORDER BY created_at");
}

const store = {
  list: () => pendingConfirmations(),
  remove: async (id) => (await getDb()).runAsync("DELETE FROM pending_confirmations WHERE client_confirmation_id = ?", id),
  markAttempt: async (id, message) => (await getDb()).runAsync(
    "UPDATE pending_confirmations SET attempts = attempts + 1, last_error = ? WHERE client_confirmation_id = ?", message, id),
  markRejected: async (id, code, message) => (await getDb()).runAsync(
    "UPDATE pending_confirmations SET attempts = attempts + 1, last_code = ?, last_error = ? WHERE client_confirmation_id = ?", code, message, id),
};

let flushing = null;
// Send what is stored, oldest first. Safe to call often; runs one at a time.
export function flushSafety() {
  if (!flushing) {
    flushing = flushConfirmations(store, (item) => confirmSwitchingStep(item.step_id, {
      clientConfirmationId: item.client_confirmation_id, performedAt: item.performed_at, lat: item.lat, lon: item.lon,
    })).finally(() => { flushing = null; });
  }
  return flushing;
}

// Only for a REJECTED confirmation, only when the crew chooses to after
// talking to the control room (the server's safety log already holds the
// rejected attempt).
export async function discardRejected(clientConfirmationId) {
  const db = await getDb();
  await db.runAsync("DELETE FROM pending_confirmations WHERE client_confirmation_id = ? AND last_code IS NOT NULL", clientConfirmationId);
}
