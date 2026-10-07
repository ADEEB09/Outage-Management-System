import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, SevBadge, StatusBadge, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';

// Priority order and chip colours: Medical > Critical > Premium-VIP > Normal.
const CATEGORIES = ['Medical', 'Critical', 'Premium-VIP', 'Normal'];
const CAT = { Medical: 'crit', Critical: 'major', 'Premium-VIP': 'merged', Normal: 'minor' };
const RANK = Object.fromEntries(CATEGORIES.map((c, i) => [c, i]));
const STATE_CHIP = { Unassigned: 'crit', Incident: 'major', Assigned: 'merged', Completed: 'ok', Rejected: 'neutral', Closed: 'muted' };

// Area of Responsibility = substation. The stored value looks like "33/11 kV X S/s".
const cleanArea = (a) => String(a || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim();
const NO_AREA = 'No area';

const TABS = [
  { key: 'Unassigned', match: (c) => c.state === 'Unassigned' },
  { key: 'Assigned', match: (c) => c.state === 'Assigned' },
  { key: 'Incident', match: (c) => c.state === 'Incident' },
  { key: 'Trouble Calls', match: () => true },
  { key: 'Outages' },
  { key: 'Completed', match: (c) => c.state === 'Completed' },
  { key: 'Rejected', match: (c) => c.state === 'Rejected' },
  { key: 'Closed', match: (c) => c.state === 'Closed' },
];

// rows -> [[areaName, rows[]]], "No area" last.
function groupByArea(rows, areaOf) {
  const m = new Map();
  rows.forEach((r) => { const k = cleanArea(areaOf(r)) || NO_AREA; (m.get(k) || m.set(k, []).get(k)).push(r); });
  return [...m.entries()].sort(([a], [b]) => (a === NO_AREA) - (b === NO_AREA) || a.localeCompare(b));
}

export default function TCS() {
  const [calls, setCalls] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [tab, setTab] = useState('Unassigned');
  const [busy, setBusy] = useState(null);
  const [logging, setLogging] = useState(false);
  const [rejecting, setRejecting] = useState(null);

  const load = () => {
    api.calls().then(setCalls).catch((e) => toast(e.message, 'err'));
    api.incidents().then(setIncidents).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  useLiveRefresh(['tcs.call.received', 'tcs.call.updated', 'oms.incident.created', 'oms.incident.updated'], load);

  const outages = useMemo(() => incidents.filter((i) => i.source === 'SCADA'), [incidents]);
  const count = (t) => (t.key === 'Outages' ? outages.length : calls.filter(t.match).length);

  const groups = useMemo(() => {
    if (tab === 'Outages') {
      return groupByArea([...outages].sort((a, b) => (b.opened_at || '').localeCompare(a.opened_at || '')), (i) => i.substation);
    }
    const t = TABS.find((x) => x.key === tab);
    const rows = calls.filter(t.match).sort((a, b) => (RANK[a.category] ?? 9) - (RANK[b.category] ?? 9) || (b.ts || '').localeCompare(a.ts || ''));
    return groupByArea(rows, (c) => c.area);
  }, [tab, calls, outages]);
  const total = groups.reduce((n, [, r]) => n + r.length, 0);

  const unassigned = calls.filter((c) => c.state === 'Unassigned').length;
  const medical = calls.filter((c) => c.category === 'Medical' && c.state === 'Unassigned').length;

  const promote = async (id) => {
    setBusy(id);
    try { const r = await api.callToIncident(id); toast(`Incident ${r.id || 'created'} raised from call`); load(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(null); }
  };

  const isOutages = tab === 'Outages';
  const cols = 7;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Customer Interface</div>
          <h2>Trouble call system</h2>
          <p>Inbound customer-reported outages from IVR, portal and call centre. Correlate and promote calls into tracked incidents.</p>
        </div>
        <button className="btn primary" onClick={() => setLogging(true)}><Icon name="plus" size={14} /> Log a call</button>
      </div>

      <div className="grid stat-row" style={{ marginBottom: 16 }}>
        <div className="stat prio-crit"><div className="stat-n">{unassigned}</div><div className="stat-l">Unassigned</div></div>
        <div className="stat prio-major"><div className="stat-n">{medical}</div><div className="stat-l">Medical priority</div></div>
        <div className="stat prio-neutral"><div className="stat-n">{calls.length}</div><div className="stat-l">Calls today</div></div>
        <div className="stat prio-minor"><div className="stat-n">{calls.filter((c) => c.linked_id).length}</div><div className="stat-l">Linked to incident</div></div>
      </div>

      <div className="seg" role="tablist" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.key} ({count(t)})
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-h">
          <h3>{isOutages ? 'SCADA-generated outages' : tab === 'Trouble Calls' ? 'All trouble calls' : `${tab} calls`}</h3>
          <span className="eyebrow">{total} {isOutages ? 'outages' : 'calls'} · by area of responsibility</span>
        </div>
        <div className="card-b" style={{ padding: 0 }}>
          <table className="tbl">
            <thead>
              {isOutages
                ? <tr><th>Incident</th><th>Source</th><th>Type</th><th>Severity</th><th>Status</th><th>Customers</th><th>Opened</th></tr>
                : <tr><th>Priority</th><th>Customer</th><th>Phone</th><th>Address</th><th>Status</th><th>Received</th><th></th></tr>}
            </thead>
            <tbody>
              {groups.map(([area, rows]) => [
                <tr key={`h-${area}`} className="area-head">
                  <td colSpan={cols} style={{ background: 'var(--paper-2)', fontWeight: 600, fontSize: 12.5 }}>
                    {area} <span className="muted" style={{ fontWeight: 500 }}>· {rows.length}</span>
                  </td>
                </tr>,
                ...rows.map((r) => (isOutages ? (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td><span className="chip chip-crit">SCADA</span></td>
                    <td>{r.type}</td>
                    <td><SevBadge sev={r.severity} /></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{r.customers}</td>
                    <td className="muted">{timeAgo(r.opened_at)}</td>
                  </tr>
                ) : (
                  <tr key={r.id} className={r.state === 'Unassigned' ? 'row-hot' : ''}>
                    <td><span className={`chip chip-${CAT[r.category] || 'minor'}`}>{r.category}</span></td>
                    <td>{r.customer}</td>
                    <td className="mono">{r.phone}</td>
                    <td style={{ maxWidth: 260 }} className="muted">{r.address}</td>
                    <td>
                      <span className={`chip chip-${STATE_CHIP[r.state] || 'muted'}`}>{r.state}</span>
                      {r.linked_id && <span className="mono muted" style={{ marginLeft: 6 }}>{r.linked_id}</span>}
                      {r.state_reason && <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>{r.state_reason}</div>}
                      {r.callback_at && <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>Callback sent {timeAgo(r.callback_at)}</div>}
                    </td>
                    <td className="muted">{timeAgo(r.ts)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.state === 'Unassigned' && (
                      <>
                        <button className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => promote(r.id)}>
                          <Icon name="plus" size={14} /> Raise incident
                        </button>{' '}
                        <button className="btn btn-sm danger" disabled={busy === r.id} onClick={() => setRejecting(r)}>Reject</button>
                      </>
                    )}</td>
                  </tr>
                ))),
              ])}
              {!total && <tr><td colSpan={cols} className="empty">{isOutages ? 'No SCADA outages.' : `No ${tab === 'Trouble Calls' ? '' : tab.toLowerCase() + ' '}calls.`}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {logging && <LogCall onClose={() => setLogging(false)} onDone={() => { setLogging(false); load(); }} />}
      {rejecting && <RejectCall call={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); load(); }} />}
    </>
  );
}

const field = (label, node) => <label style={{ display: 'block', marginBottom: 12 }}><div className="eyebrow" style={{ marginBottom: 5 }}>{label}</div>{node}</label>;
const inp = { width: '100%', padding: '9px 11px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13.5 };

function Panel({ title, onClose, children }) {
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="drawer-h">
          <div style={{ fontFamily: 'var(--disp)', fontSize: 18, fontWeight: 600 }}>{title}</div>
          <button className="iconbtn" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="drawer-b">{children}</div>
      </aside>
    </>
  );
}

function LogCall({ onClose, onDone }) {
  const [f, setF] = useState({ customer: '', phone: '', address: '', category: 'Normal', area: '' });
  const [areas, setAreas] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.callAreas().then(setAreas).catch(() => setAreas([])); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (!f.customer.trim() || !f.phone.trim() || !f.address.trim()) { toast('Customer, phone and address are required', 'err'); return; }
    setBusy(true);
    try { const c = await api.createCall({ ...f, area: f.area || undefined }); toast(`Call ${c.id} logged`); onDone(); }
    catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Panel title="Log a call" onClose={onClose}>
      {field('Customer *', <input style={inp} value={f.customer} onChange={set('customer')} />)}
      {field('Phone *', <input style={inp} value={f.phone} onChange={set('phone')} />)}
      {field('Address *', <input style={inp} value={f.address} onChange={set('address')} />)}
      {field('Priority *', <select style={inp} value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>)}
      {field('Area of responsibility', <select style={inp} value={f.area} onChange={set('area')}>
        <option value="">No area</option>
        {areas.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
      </select>)}
      <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy} onClick={submit}>Log call</button>
    </Panel>
  );
}

function RejectCall({ call, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 3 && reason.trim().length <= 500;
  const submit = async () => {
    setBusy(true);
    try { await api.rejectCall(call.id, reason.trim()); toast(`Call ${call.id} rejected`); onDone(); }
    catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Panel title={`Reject call ${call.id}`} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>{call.customer} · {call.address}</p>
      {field('Reason * (3–500 characters)', <textarea style={{ ...inp, minHeight: 90 }} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus />)}
      <button className="btn danger" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy || !ok} onClick={submit}>Reject call</button>
    </Panel>
  );
}
