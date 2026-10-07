// src/lib/plannedOutage.js
// OMS-01 crew-app rules for planned outages, kept free of React Native
// imports so they can be tested in Node (backend/src/selftest-oms01.js).
// The server enforces every rule again; these decide what the crew sees.
//
// Two different offline stories, on purpose (docs/OMS-01-DESIGN.md §7):
//  - Permits are a handshake with the control room: online only, never stored.
//  - A switching step done with no signal may be recorded on the phone, but it
//    shows as UNSYNCED (never green, never ticked) and unlocks nothing until
//    the server acknowledges it. It never goes through offlineQueue.js.

// Server not reached (no network, timeout) or failed on its side: keep the
// item and try again later. Anything else is the server refusing it.
export function isUnreachable(err) {
  return !err?.status || err.status >= 500 || err.status === 408 || err.status === 429;
}

// What one step looks like in the crew app. `view` is the last
// GET /mobile/jobs/:id/planned-outage response; `pending` the confirmations
// stored on this phone for this outage (oldest first).
//   confirmed     server acknowledged it (green tick)
//   unsynced      done here, not acknowledged: the control room doesn't know
//   rejected      the server refused it: call the control room
//   actionable    the crew can confirm it now
//   control_room  someone else's step: context only
//   pending       not reachable yet
export function stepUiState(step, view, pending) {
  if (step.state === 'confirmed') return 'confirmed';
  const mine = pending.find((p) => p.step_id === step.id);
  if (mine) return mine.last_code ? 'rejected' : 'unsynced';
  if (!step.mine) return 'control_room';
  // Anything stored but unacknowledged locks every other step: the next one
  // must wait for the server, not for this phone's opinion.
  if (pending.length) return 'pending';
  return step.actionable ? 'actionable' : 'pending';
}

// The gates in requestAdvance, decided on the server's view only. Returns
// null when the job may move to `next`, else a message for the crew.
export function gateFor(view, next) {
  if (!view) return 'Needs a connection: permit status must come from the control room.';
  const permit = view.permit;
  if (next === 'Work Started') {
    const ownIsolation = view.steps.filter((s) => s.phase === 'isolate' && s.mine);
    const missing = ownIsolation.filter((s) => s.state !== 'confirmed');
    if (missing.length) return `Finish your isolation steps first (${missing.length} not confirmed by the control room).`;
    if (permit?.state !== 'issued') {
      return permit?.state === 'requested'
        ? 'Waiting for the control room to issue the permit.'
        : 'Request the work permit before starting work.';
    }
  }
  if (next === 'Work Finished' && permit?.state !== 'returned') {
    return 'Return the work permit before finishing the job.';
  }
  return null;
}

// Sends stored confirmations oldest first. Stops at the first one the server
// can't be reached for (order matters), and at the first one it refuses:
// that one is marked rejected and is never retried automatically -- the crew
// must talk to the control room. Nothing is removed without a 2xx.
// store: { list(), remove(id), markRejected(id, code, message), markAttempt(id, message) }
// send(item): resolves on 2xx, throws an error carrying .status/.code otherwise.
export async function flushConfirmations(store, send) {
  const items = await store.list();
  let sent = 0;
  for (const item of items) {
    if (item.last_code) break; // a refused one blocks everything after it
    try {
      await send(item);
      await store.remove(item.client_confirmation_id);
      sent++;
    } catch (err) {
      if (isUnreachable(err)) await store.markAttempt(item.client_confirmation_id, err?.message || 'no connection');
      else await store.markRejected(item.client_confirmation_id, err.code || `HTTP_${err.status}`, err.message || 'refused');
      break;
    }
  }
  return { sent, remaining: items.length - sent };
}
