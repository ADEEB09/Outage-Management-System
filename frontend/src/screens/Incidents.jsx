import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, SevBadge, StatusBadge, timeAgo, hhmm, useLiveRefresh, toast } from '../lib/ui.jsx';
import { Drawer, DrawerContent } from '../components/ui/drawer.jsx';

const SEVS = ['all', 'critical', 'high', 'medium', 'low'];
const STATS = ['all', 'open', 'dispatched', 'in_progress', 'pending', 'resolved'];

export default function Incidents({ openId, focusIncidentId, clearFocus } = {}) {
  const [inc, setInc] = useState([]);
  const [sev, setSev] = useState('all');
  const [st, setSt] = useState('all');
  const [sel, setSel] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const load = () => api.incidents().then(setInc);
  useEffect(() => { load(); }, []);
      useEffect(() => {
    const idToOpen = openId || focusIncidentId;
    if (idToOpen) {
      api.incident(idToOpen).then(setSel);
      if (clearFocus) clearFocus();
    }
  }, [openId, focusIncidentId]);
  useLiveRefresh(['oms.incident.created', 'oms.incident.updated', 'crew.job.updated'], load);
  useEffect(() => { if (sel) api.incident(sel.id).then(setSel); }, [inc.length]); // eslint-disable-line

  // Deep-link from another screen (currently: Alarms → "view incident").
  // Opens the requested incident once, then clears the request so navigating
  // away and back to Incidents normally doesn't keep re-opening it.
  useEffect(() => {
    if (!focusIncidentId) return;
    api.incident(focusIncidentId).then(setSel).finally(() => clearFocus && clearFocus());
  }, [focusIncidentId]); // eslint-disable-line

  const rows = inc.filter((i) => (sev === 'all' || i.severity === sev) && (st === 'all' || i.status === st));

  const open = (i) => api.incident(i.id).then(setSel);

  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Lifecycle</div><h2>Incidents</h2>
          <p>Detect, classify, dispatch and restore - every transition audited.</p></div>
        <button className="btn primary" onClick={() => setShowNew(true)}><Icon name="plus" size={16} /> New incident</button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {SEVS.map((s) => <button key={s} className={`pill ${sev === s ? 'on' : ''}`} onClick={() => setSev(s)}>{s === 'all' ? 'All severities' : s}</button>)}
        <span style={{ width: 1, background: 'var(--line)', margin: '0 4px' }} />
        {STATS.map((s) => <button key={s} className={`pill ${st === s ? 'on' : ''}`} onClick={() => setSt(s)}>{s === 'all' ? 'All statuses' : s.replace('_', ' ')}</button>)}
      </div>

      <div className="card">
        <table>
          <thead><tr><th>ID</th><th>Severity</th><th>Type</th><th>Zone</th><th>Feeder</th><th>Customers</th><th>Opened</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="click" onClick={() => open(i)}>
                <td className="id-cell">{i.id}</td>
                <td><SevBadge sev={i.severity} /></td>
                <td>{i.type}</td>
                <td>{i.zone}</td>
                <td className="mono" style={{ fontSize: 12 }}>{i.feeder || '-'}</td>
                <td className="mono">{(i.customers || 0).toLocaleString()}</td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{timeAgo(i.opened_at)}</td>
                <td><StatusBadge status={i.status} /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8}><div className="empty"><span className="disp">Nothing matches</span>Adjust the filters above.</div></td></tr>}
          </tbody>
        </table>
      </div>

      {sel && <IncidentDrawer inc={sel} onClose={() => setSel(null)} onChange={load} />}
      {showNew && <NewIncident onClose={() => setShowNew(false)} onCreated={(i) => { setShowNew(false); load(); open(i); }} />}
    </>
  );
}

function IncidentDrawer({ inc, onClose, onChange }) {
  const [busy, setBusy] = useState(false);
  const [nearest, setNearest] = useState([]);
  useEffect(() => { api.nearestCrews(inc.id).then(setNearest).catch(() => setNearest([])); }, [inc.id]);

  const doStatus = async (status) => {
    setBusy(true);
    try { await api.setStatus(inc.id, status); toast(`${inc.id} -> ${status.replace('_', ' ')}`); onChange(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const doAssign = async (crewId) => {
    setBusy(true);
    try { await api.assign(inc.id, crewId, 'Normal'); toast('Crew assigned'); onChange(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const [ertInput, setErtInput] = useState('');
  const doSetErt = async () => {
    if (!ertInput) { toast('Pick a date/time first', 'err'); return; }
    setBusy(true);
    try {
      await api.setErt(inc.id, new Date(ertInput).toISOString());
      toast('Restoration estimate updated - customers notified if it moved significantly');
      onChange();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Drawer direction="right" open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DrawerContent style={{ width: 'min(440px, 94vw)', height: '100vh', borderRadius: 0 }}>
        <div className="drawer-h">
          <div>
            <div className="id-cell" style={{ fontSize: 13 }}>{inc.id}</div>
            <div style={{ fontFamily: 'var(--disp)', fontSize: 18, fontWeight: 600, marginTop: 3 }}>{inc.type}</div>
            <div style={{ display: 'flex', gap: 7, marginTop: 8 }}><SevBadge sev={inc.severity} /><StatusBadge status={inc.status} /></div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="drawer-b">
          <div className="kv-row"><span className="k">Zone</span><span className="v">{inc.zone}</span></div>
          <div className="kv-row"><span className="k">Feeder</span><span className="v mono">{inc.feeder || '-'}</span></div>
          <div className="kv-row"><span className="k">Customers affected</span><span className="v mono">{(inc.customers || 0).toLocaleString()}</span></div>
          <div className="kv-row"><span className="k">Cause</span><span className="v">{inc.cause}</span></div>
          <div className="kv-row"><span className="k">Source</span><span className="v mono">{inc.source}</span></div>
          <div className="kv-row"><span className="k">Opened</span><span className="v mono">{hhmm(inc.opened_at)} - {timeAgo(inc.opened_at)}</span></div>
          <div className="kv-row"><span className="k">SLA due</span><span className="v mono">{hhmm(inc.sla_due_at)}</span></div>

          <div className="kv-row">
            <span className="k">Est. restoration</span>
            <span className="v mono">{inc.ert ? hhmm(inc.ert) : 'Not set'}</span>
          </div>
          <div className="kv-row" style={{ alignItems: 'center', gap: 8 }}>
            <input
              type="datetime-local"
              value={ertInput}
              onChange={(e) => setErtInput(e.target.value)}
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13 }}
            />
            <button className="btn sm" disabled={busy} onClick={doSetErt}>Update ETA</button>
          </div>

          <div style={{ margin: '18px 0 8px' }} className="eyebrow">Advance lifecycle</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(inc.nextStates || []).map((s) => (
              <button key={s} className={`btn sm ${s === 'cancelled' ? 'danger' : 'primary'}`} disabled={busy} onClick={() => doStatus(s)}>
                {s === 'cancelled' ? 'Cancel' : `-> ${(inc.stateLabels?.[s] || s)}`}
              </button>
            ))}
            {!inc.nextStates?.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Terminal state - no further transitions.</span>}
          </div>

          {!inc.crew_id && ['open', 'dispatched'].includes(inc.status) && (
            <>
              <div style={{ margin: '18px 0 8px' }} className="eyebrow">Assign crew - nearest first</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {nearest.map((c) => (
                  <button key={c.id} className="btn sm" disabled={busy} onClick={() => doAssign(c.id)}>
                    {c.name} - {c.meters_away < 1000 ? `${Math.round(c.meters_away)} m` : `${(c.meters_away / 1000).toFixed(1)} km`}
                  </button>
                ))}
                {!nearest.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No crews available right now.</span>}
              </div>
            </>
          )}

          <div style={{ margin: '20px 0 10px' }} className="eyebrow">Status timeline</div>
          <ul className="timeline">
            {(inc.events || []).map((e) => (
              <li key={e.id} className={e.actor === 'SCADA' ? 'scada' : e.actor === 'Crew' ? 'crew' : ''}>
                <span className="node" />
                <div className="k">{e.actor} - {e.kind}</div>
                <div className="n">{e.note}</div>
                <div className="t">{hhmm(e.ts)}</div>
              </li>
            ))}
          </ul>
          <MessagePanel incidentId={inc.id} />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function NewIncident({ onClose, onCreated }) {
  const [f, setF] = useState({ zone: '', severity: 'high', type: 'Power Outage', feeder: '', customers: 100, cause: 'Unknown' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (!f.zone) { toast('Zone is required', 'err'); return; }
    setBusy(true);
    try { const i = await api.createIncident({ ...f, customers: Number(f.customers) }); toast('Incident created'); onCreated(i); }
    catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  const field = (label, node) => <label style={{ display: 'block', marginBottom: 12 }}><div className="eyebrow" style={{ marginBottom: 5 }}>{label}</div>{node}</label>;
  const inp = { width: '100%', padding: '9px 11px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13.5 };

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="New incident">
        <div className="drawer-h">
          <div style={{ fontFamily: 'var(--disp)', fontSize: 18, fontWeight: 600 }}>New incident</div>
          <button className="iconbtn" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="drawer-b">
          {field('Zone *', <input style={inp} value={f.zone} onChange={set('zone')} placeholder="e.g. Dehradun Central" />)}
          {field('Severity', <select style={inp} value={f.severity} onChange={set('severity')}>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s}>{s}</option>)}</select>)}
          {field('Type', <select style={inp} value={f.type} onChange={set('type')}>{['Power Outage', 'Partial Power', 'Scheduled'].map((s) => <option key={s}>{s}</option>)}</select>)}
          {field('Feeder', <input style={inp} value={f.feeder} onChange={set('feeder')} placeholder="FDR-SE01-F02" />)}
          {field('Customers affected', <input style={inp} type="number" value={f.customers} onChange={set('customers')} />)}
          {field('Cause', <input style={inp} value={f.cause} onChange={set('cause')} />)}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy} onClick={submit}>Create incident</button>
        </div>
      </aside>
    </>
  );
}  
function MessagePanel({ incidentId }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.messages(incidentId).then(setMsgs).catch(() => setMsgs([]));
  useEffect(() => { load(); }, [incidentId]); // eslint-disable-line

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await api.postMessage(incidentId, text.trim()); setText(''); await load(); }
    catch { toast('Could not send message'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">Crew and dispatcher messages</div>
      <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' }}>
        {msgs.length === 0 && <div style={{ fontSize: 13, opacity: 0.6 }}>No messages yet.</div>}
        {msgs.map((m) => (
          <div key={m.id} style={{ background: '#f2f5f9', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
              {m.sender} - {m.sender_role} - {hhmm(m.ts)}
            </div>
            <div style={{ fontSize: 14 }}>{m.body}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Message the crew..."
          style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }}
        />
        <button onClick={send} disabled={busy} style={{ padding: '8px 14px', borderRadius: 8, border: 0, background: '#12325a', color: '#fff', cursor: 'pointer' }}>
          Send
        </button>
      </div>
    </div>
  );
}