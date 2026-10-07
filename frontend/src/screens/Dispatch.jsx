import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, SevBadge, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';

// Why a crew's continuous tracking is off (reported by the crew app).
const TRACKING_OFF_TEXT = {
  permission_denied: 'location permission was denied',
  background_permission_denied: 'background location ("Allow all the time") was denied',
  turned_off: 'the crew turned tracking off',
  location_services_off: "the phone's Location is switched off",
  start_failed: 'tracking failed to start on the phone',
};

// Tracking is on but no position for this long: the phone has gone quiet
// (matches the backend's stale-location monitor; the app sends a fix at
// least once a minute, even when parked).
const STALE_MS = 5 * 60 * 1000;
const isStale = (c, now) => {
  if (c.tracking_state !== 'on') return false;
  const since = Math.max(c.location_updated_at ? Date.parse(c.location_updated_at) : 0, c.tracking_changed_at ? Date.parse(c.tracking_changed_at) : 0);
  return since > 0 && now - since > STALE_MS;
};

export default function Dispatch() {
  const [inc, setInc] = useState([]);
  const [crews, setCrews] = useState([]);
  const [pick, setPick] = useState({});
  const [now, setNow] = useState(Date.now());

  const load = () => { api.incidents().then(setInc); api.crews().then(setCrews); };
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  useLiveRefresh(['oms.incident.updated', 'oms.incident.created', 'crew.updated', 'crew.job.updated', 'crew.tracking.changed', 'crew.location.stale'], load);

  const unassigned = inc.filter((i) => !i.crew_id && ['open', 'dispatched'].includes(i.status));
  const available = crews.filter((c) => c.status === 'available');

  const assign = async (incId) => {
    const crewId = pick[incId] || available[0]?.id;
    if (!crewId) { toast('No crew selected', 'err'); return; }
    try { await api.assign(incId, crewId, 'Normal'); toast('Crew dispatched'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Field Operations</div><h2>Dispatch console</h2>
          <p>Match unassigned outages to crews by location, skill and availability.</p></div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <div className="card-h"><h3>Unassigned jobs</h3><span className="eyebrow">{unassigned.length} waiting</span></div>
          <div className="card-b" style={{ display: 'grid', gap: 10 }}>
            {unassigned.map((i) => (
              <div key={i.id} style={{ border: '1px solid var(--line)', borderRadius: 9, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <SevBadge sev={i.severity} />
                      <span className="id-cell">{i.id.slice(-6)}</span>
                    </div>
                    <div style={{ fontWeight: 500, marginTop: 5 }}>{i.zone}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{i.feeder || 'no feeder'} · {(i.customers || 0).toLocaleString()} customers · {timeAgo(i.opened_at)}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
                 <NearestCrewPicker incId={i.id} pick={pick} setPick={setPick} /> 
                  <button className="btn primary sm" disabled={!available.length} onClick={() => assign(i.id)}>
                    <Icon name="arrow" size={14} /> Dispatch
                  </button>
                </div>
              </div>
            ))}
            {!unassigned.length && <div className="empty"><span className="disp">Queue clear</span>Every open incident has a crew.</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Crew roster</h3><span className="eyebrow">{available.length} available</span></div>
          <div className="card-b" style={{ display: 'grid', gap: 10 }}>
            {crews.map((c) => (
              <div key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 9, padding: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', flex: '0 0 auto', background: { available: 'var(--live)', in_service: 'var(--med)', in_transit: 'var(--high)', on_break: 'var(--faint)' }[c.status] }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>
                    {c.name} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>· {c.lead}</span>
                    {c.tracking_state === 'off' && TRACKING_OFF_TEXT[c.tracking_reason] && (
                      <span title={`${TRACKING_OFF_TEXT[c.tracking_reason]}, ${timeAgo(c.tracking_changed_at)}`} style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: 'var(--crit)', background: 'var(--crit-bg)', borderRadius: 4, padding: '1px 6px' }}>Tracking off</span>
                    )}
                    {isStale(c, now) && (
                      <span title={`Tracking is on but no position since ${c.location_updated_at ? timeAgo(c.location_updated_at) : 'tracking started'}: Location off, no signal, or the app was stopped`} style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: 'var(--crit)', background: 'var(--crit-bg)', borderRadius: 4, padding: '1px 6px' }}>No GPS · {c.location_updated_at ? timeAgo(c.location_updated_at) : 'none yet'}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="pin" size={13} />{c.location}{c.job_id && ` · on ${c.job_id.slice(-6)}`}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 130 }}>
                  {c.skills.map((s) => <span key={s} style={{ fontSize: 10.5, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 4, padding: '1px 6px', color: 'var(--ink-2)' }}>{s}</span>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
function NearestCrewPicker({ incId, pick, setPick }) {
  const [nearest, setNearest] = useState([]);
  useEffect(() => { api.nearestCrews(incId).then(setNearest).catch(() => setNearest([])); }, [incId]);
  useEffect(() => { if (!pick[incId] && nearest.length) setPick((p) => ({ ...p, [incId]: nearest[0].id })); }, [nearest]); // eslint-disable-line
  return (
    <select className="btn sm" style={{ flex: 1 }} aria-label="Select nearest crew to assign" value={pick[incId] || ''} onChange={(e) => setPick({ ...pick, [incId]: e.target.value })}>
      <option value="">{nearest.length ? 'Select crew…' : 'No crews available'}</option>
      {nearest.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} · {c.meters_away < 1000 ? `${Math.round(c.meters_away)} m` : `${(c.meters_away / 1000).toFixed(1)} km`}
        </option>
      ))}
    </select>
  );
}
