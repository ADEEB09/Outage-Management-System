// Incident state machine — FR-OMS-006 / SDP §2.3 OMS Lifecycle State Machine.
// Open → Dispatched → In-Progress → Pending Verification → Resolved → Closed
// with Cancelled and Scheduled branches.
export const TRANSITIONS = {
  scheduled:   ['open', 'cancelled'],
  open:        ['dispatched', 'cancelled'],
  dispatched:  ['in_progress', 'open', 'cancelled'],
  in_progress: ['pending', 'cancelled'],
  pending:     ['resolved', 'in_progress'],   // FR-OMS-010: needs restoration confirmation
  resolved:    ['closed'],
  closed:      [],
  cancelled:   [],
};

// Planned outages (OMS-01): supply is switched off on purpose. Most moves are
// driven by the switching plan and the work permit (domain/plannedOutage.js
// decides when), not by an operator button. Once isolation has started the
// only way out is through restoring: there is deliberately no
// isolating/in_progress -> cancelled.
export const PLANNED_TRANSITIONS = {
  scheduled:   ['notified', 'cancelled'],
  notified:    ['isolating', 'scheduled', 'cancelled'], // back to scheduled = rescheduled, notify again
  isolating:   ['in_progress', 'restoring'],            // restoring from here = abort before work
  in_progress: ['restoring'],
  restoring:   ['resolved'],
  resolved:    ['closed'],
  closed:      [],
  cancelled:   [],
};

export const LABELS = {
  scheduled: 'Scheduled', open: 'Open', dispatched: 'Dispatched',
  in_progress: 'In Progress', pending: 'Pending Verification',
  resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled',
  notified: 'Customers notified', isolating: 'Isolating', restoring: 'Restoring',
};

// Which table applies. `planned` means the incident has a planned_outages
// row, not merely type 'Scheduled': incidents of that type created before
// OMS-01 (by the generic form, as status 'open') stay on the fault table.
export function transitionsFor(planned = false) {
  return planned ? PLANNED_TRANSITIONS : TRANSITIONS;
}

// `planned` is optional: existing callers (fault incidents) are unchanged.
export function canTransition(from, to, planned = false) {
  return (transitionsFor(planned)[from] || []).includes(to);
}

export function nextStates(from, planned = false) {
  return transitionsFor(planned)[from] || [];
}

// SCADA restoration (OMS-02): the tripped device reported closed again, so
// supply is back regardless of where the incident is in the crew workflow.
// Used ONLY by realtime/scada.js; operators still go through TRANSITIONS.
const SCADA_RESTORABLE = ['open', 'dispatched', 'in_progress', 'pending'];
export function canScadaRestore(from) {
  return SCADA_RESTORABLE.includes(from);
}
