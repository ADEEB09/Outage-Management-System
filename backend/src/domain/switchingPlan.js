// OMS-01: turn a sectionalizing trace (domain/sectionalize.js traceSection)
// into a DRAFT switching plan. No graph walking here -- the trace already
// found the switches that bound the section around the work equipment.
//
// What the draft cannot know, and why it is only a draft: the trace does not
// know which switches are open or closed today, nor which side of a boundary
// switch the supply comes from (see sectionalize.js caveats). So it can name
// the right devices but not prove which must open, in what electrical order,
// or where earths go. The operator edits and approves it, and approval is a
// named act in the safety log.

// Substation-class devices are operated by the control room; line devices
// (pole-mounted isolators, AB switches, fuses) by the crew on site.
const CONTROL_ROOM_CLASSES = ['Breaker', 'Recloser'];

export function defaultAssignee(cimClass) {
  return CONTROL_ROOM_CLASSES.includes(cimClass) ? 'control_room' : 'crew';
}

// trace: traceSection() result. crewId: the crew doing the line work (crew
// steps need one). workLabel: the equipment being worked on, for earth steps.
export function draftFromTrace(trace, { crewId, workLabel }) {
  const switches = [...(trace.boundarySwitches || [])].sort((a, b) => a.hops - b.hops || String(a.cim_mrid).localeCompare(String(b.cim_mrid)));
  const label = (s) => s.name || `${s.cim_class} ${s.cim_mrid}`;
  const site = workLabel || trace.origin?.name || trace.origin?.cim_mrid || 'work site';
  const asStep = (s, action) => {
    const assignee = defaultAssignee(s.cim_class);
    return { action, device_mrid: s.cim_mrid, device_label: label(s), location: `${s.cim_class}, ${s.hops} hop(s) from work site`, assignee, assignee_crew_id: assignee === 'crew' ? crewId : null };
  };
  const crewStep = (action, device_label) => ({ action, device_mrid: null, device_label, location: site, assignee: 'crew', assignee_crew_id: crewId });

  const isolate = [
    ...switches.map((s) => asStep(s, 'open')),
    crewStep('test_dead', `Work site - ${site}`),
    crewStep('earth_apply', `Work site - ${site}`),
  ];
  const restore = [
    crewStep('earth_remove', `Work site - ${site}`),
    ...[...switches].reverse().map((s) => asStep(s, 'close')),
  ];
  return [
    ...isolate.map((s, i) => ({ ...s, phase: 'isolate', seq: i + 1 })),
    ...restore.map((s, i) => ({ ...s, phase: 'restore', seq: i + 1 })),
  ];
}
