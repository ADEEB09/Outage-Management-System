// Trouble-call helpers (OMS-02). Pure functions, no DB access.

export const CALL_CATEGORIES = ['Normal', 'Critical', 'Premium-VIP', 'Medical'];

// Severity of the incident raised from a call.
export const CALL_SEVERITY = { Medical: 'critical', Critical: 'critical', 'Premium-VIP': 'high', Normal: 'medium' };

// Same display cleanup the complaint engine applies to incidents.substation.
export const cleanSubstation = (name) => String(name || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim();

// The state a call is displayed in. Derived at read time from the linked
// incident so it can never drift. Terminal incident states are checked before
// the "has a crew" test because a resolved incident keeps its crew_id.
export function deriveCallState(call, incident) {
  if (call.status === 'rejected') return { state: 'Rejected', reason: call.reject_reason || null };
  if (!call.linked_id || !incident) return { state: 'Unassigned', reason: null };
  const s = incident.status;
  if (s === 'cancelled') return { state: 'Rejected', reason: 'Incident cancelled (false alarm)' };
  if (s === 'closed') return { state: 'Closed', reason: null };
  if (s === 'resolved') return { state: 'Completed', reason: null };
  if (['dispatched', 'in_progress', 'pending'].includes(s) || incident.crew_id) return { state: 'Assigned', reason: null };
  return { state: 'Incident', reason: null };
}
