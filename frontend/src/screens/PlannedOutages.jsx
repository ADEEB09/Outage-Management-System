// OMS-01 Planned outages: schedule the outage, build and approve the
// switching plan, notify customers, operate control-room steps, issue and
// track work permits, and read the safety log. Every rule is enforced by the
// server (domain/plannedOutage.js); this screen shows what it allows and
// passes on its refusals verbatim. See docs/OMS-01-DESIGN.md.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { plannedApi } from '../lib/plannedApi.js';
import { StatusBadge, hhmm, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';

const TOPICS = ['oms.planned.updated', 'oms.permit.changed', 'oms.switching.confirmed', 'oms.switching.rejected', 'oms.incident.updated', 'crew.job.updated'];
const ACTION_TEXT = {
  open: 'OPEN', close: 'CLOSE', rack_out: 'Rack out', rack_in: 'Rack in', test_dead: 'Test dead',
  earth_apply: 'Apply earth', earth_remove: 'Remove earth', tag_apply: 'Apply danger tag', tag_remove: 'Remove danger tag',
};
const ACTIONS = Object.keys(ACTION_TEXT);
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
const inp = { width: '100%', padding: '8px 10px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13 };
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fail = (e) => toast(e.code ? `${e.message} (${e.code})` : e.message, 'err', 9000);

export default function PlannedOutages() {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  const [crews, setCrews] = useState([]);

  const load = () => plannedApi.list().then(setList).catch(fail);
  useEffect(() => { load(); api.crews().then(setCrews).catch(() => {}); }, []);
  useLiveRefresh(TOPICS, load);

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
      <div className="card">
        <div className="card-h">
          <h3>Planned outages</h3>
          <button className="btn sm primary" onClick={() => { setCreating(true); setSel(null); }}>New</button>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 8 }}>
          {!list.length && <div className="empty"><span className="disp">None scheduled</span>Create one with New.</div>}
          {list.map((p) => (
            <button key={p.id} onClick={() => { setSel(p.id); setCreating(false); }}
              style={{ textAlign: 'left', border: `1px solid ${sel === p.id ? 'var(--navy)' : 'var(--line)'}`, borderRadius: 9, padding: 10, background: 'var(--surface)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <b>{p.zone}</b><StatusBadge status={p.status} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{when(p.window_start)} - {hhmm(p.window_end)}</div>
              <div style={{ fontSize: 12, marginTop: 3 }}>
                Plan {p.plan_state} · {p.steps_confirmed}/{p.step_count} steps
                {p.open_permits > 0 && <span style={{ color: 'var(--crit)', fontWeight: 600 }}> · {p.open_permits} permit open</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
      {creating && <NewPlannedOutage onCancel={() => setCreating(false)} onCreated={(o) => { setCreating(false); load(); setSel(o.id); }} />}
      {sel && !creating && <OutageDetail key={sel} id={sel} crews={crews} onChanged={load} />}
      {!sel && !creating && <div className="card"><div className="card-b empty"><span className="disp">Select an outage</span>Its plan, permits and safety log appear here.</div></div>}
    </div>
  );
}

function NewPlannedOutage({ onCancel, onCreated }) {
  const start = new Date(Date.now() + 2 * 86400e3); start.setMinutes(0, 0, 0);
  const [f, setF] = useState({
    zone: '', substation: '', feeder: '', customers: 100, workDescription: '', workMrid: '',
    windowStart: toLocalInput(start), windowEnd: toLocalInput(new Date(start.getTime() + 4 * 3600e3)), noticeHours: 24,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true);
    try {
      const out = await plannedApi.create({
        zone: f.zone, substation: f.substation || null, feeder: f.feeder || null, customers: Number(f.customers) || 0,
        workDescription: f.workDescription, workMrid: f.workMrid || null,
        windowStart: new Date(f.windowStart).toISOString(), windowEnd: new Date(f.windowEnd).toISOString(),
        noticeLeadMinutes: Math.round(Number(f.noticeHours) * 60),
      });
      toast(`Planned outage ${out.outage.incident.id} scheduled`);
      onCreated(out.outage);
    } catch (e) { fail(e); setBusy(false); }
  };
  const field = (label, node) => <label style={{ display: 'block' }}><div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>{node}</label>;
  return (
    <div className="card">
      <div className="card-h"><h3>New planned outage</h3></div>
      <div className="card-b" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {field('Zone *', <input style={inp} value={f.zone} onChange={set('zone')} placeholder="e.g. Kankhal-2" />)}
        {field('Substation', <input style={inp} value={f.substation} onChange={set('substation')} placeholder="33/11 kV ... S/s" />)}
        {field('Feeder', <input style={inp} value={f.feeder} onChange={set('feeder')} />)}
        {field('Customers affected (estimate)', <input style={inp} type="number" value={f.customers} onChange={set('customers')} />)}
        {field('Supply off from *', <input style={inp} type="datetime-local" value={f.windowStart} onChange={set('windowStart')} />)}
        {field('Supply back by *', <input style={inp} type="datetime-local" value={f.windowEnd} onChange={set('windowEnd')} />)}
        <div style={{ gridColumn: '1 / -1' }}>{field('Work to be done *', <input style={inp} value={f.workDescription} onChange={set('workDescription')} placeholder="e.g. Replace DT-14 HT bushings" />)}</div>
        {field('Work equipment CIM mRID (for drafting the plan)', <input style={inp} value={f.workMrid} onChange={set('workMrid')} />)}
        {field('Notify customers this many hours before', <input style={inp} type="number" min="0" value={f.noticeHours} onChange={set('noticeHours')} />)}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Scheduling…' : 'Schedule outage'}</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function OutageDetail({ id, crews, onChanged }) {
  const [o, setO] = useState(null);
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState('plan');
  const load = () => Promise.all([plannedApi.get(id), plannedApi.safetyLog(id)]).then(([x, l]) => { setO(x); setLog(l); }).catch(fail);
  useEffect(() => { load(); }, [id]); // eslint-disable-line
  useLiveRefresh(TOPICS, load);
  if (!o) return <div className="card"><div className="card-b">Loading…</div></div>;

  const inc = o.incident;
  const anyConfirmed = o.steps.some((s) => s.state === 'confirmed');
  // Every action reloads from the server afterwards: the screen never
  // assumes an action worked.
  const act = async (fn, ok) => {
    try { await fn(); if (ok) toast(ok); } catch (e) { fail(e); }
    load(); onChanged();
  };
  const ask = (q) => { const v = window.prompt(q); return v && v.trim() ? v.trim() : null; };

  return (
    <div className="card">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3>{inc.zone} <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13 }}>{inc.id}</span></h3>
        <StatusBadge status={inc.status} />
      </div>
      <div className="card-b">
        <div className="kv-row"><span className="k">Work</span><span className="v">{o.work_description}</span></div>
        <div className="kv-row"><span className="k">Supply off</span><span className="v mono">{when(o.window_start)} - {when(o.window_end)}</span></div>
        <div className="kv-row"><span className="k">Customers</span><span className="v mono">{(inc.customers || 0).toLocaleString()}</span></div>
        <div className="kv-row"><span className="k">Customer notice</span><span className="v">
          {o.notice_sent_at ? `sent ${when(o.notice_sent_at)}` : o.notice_skipped_reason ? `skipped: ${o.notice_skipped_reason}` : `due ${when(o.notice_due_at)}`}
        </span></div>
        <div className="kv-row"><span className="k">Crew</span><span className="v">{inc.crew_id || <CrewAssign incidentId={inc.id} crews={crews} onDone={() => { load(); onChanged(); }} />}</span></div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
          {o.plan.state === 'draft' && <button className="btn sm primary" onClick={() => window.confirm('Approve this switching plan? You take responsibility for the order and content of every step.') && act(() => plannedApi.approve(id), 'Plan approved')}>Approve plan</button>}
          {o.plan.state === 'approved' && !anyConfirmed && <button className="btn sm" onClick={() => act(() => plannedApi.unapprove(id), 'Plan back to draft')}>Return plan to draft</button>}
          {inc.status === 'scheduled' && <button className="btn sm primary" onClick={() => act(() => plannedApi.notify(id), 'Customers notified')}>Send notice now</button>}
          {inc.status === 'scheduled' && <button className="btn sm" onClick={() => { const r = ask('Why is the customer notice being skipped?'); if (r) act(() => plannedApi.skipNotice(id, r), 'Notice skipped'); }}>Skip notice…</button>}
          {['scheduled', 'notified'].includes(inc.status) && !anyConfirmed && <Reschedule o={o} onDone={() => { load(); onChanged(); }} />}
          {['scheduled', 'notified'].includes(inc.status) && !anyConfirmed && <button className="btn sm danger" onClick={() => { const r = ask('Reason for cancelling this planned outage?'); if (r) act(() => plannedApi.cancel(id, r), 'Cancelled'); }}>Cancel outage…</button>}
          {inc.status === 'resolved' && <button className="btn sm primary" onClick={() => act(() => plannedApi.close(id), 'Work order closed')}>Close work order</button>}
        </div>

        <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--line)', marginBottom: 12 }}>
          {[['plan', 'Switching plan'], ['permits', `Permits (${o.permits.length})`], ['log', `Safety log (${log.length})`]].map(([k, label]) => (
            <button key={k} className="btn sm" style={{ borderBottom: tab === k ? '2px solid var(--navy)' : undefined, borderRadius: '6px 6px 0 0' }} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === 'plan' && (o.plan.state === 'draft'
          ? <PlanEditor o={o} crews={crews} onSaved={() => { load(); onChanged(); }} />
          : <StepList o={o} act={act} ask={ask} />)}
        {tab === 'permits' && <Permits o={o} act={act} ask={ask} />}
        {tab === 'log' && <SafetyLog log={log} />}
      </div>
    </div>
  );
}

function CrewAssign({ incidentId, crews, onDone }) {
  const [crewId, setCrewId] = useState('');
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <select style={{ ...inp, width: 'auto', padding: '4px 8px' }} value={crewId} onChange={(e) => setCrewId(e.target.value)}>
        <option value="">Assign crew…</option>
        {crews.map((c) => <option key={c.id} value={c.id}>{c.id} {c.name}</option>)}
      </select>
      <button className="btn sm" disabled={!crewId} onClick={async () => {
        try { await api.assign(incidentId, crewId, 'Normal'); toast(`Crew ${crewId} assigned`); onDone(); } catch (e) { fail(e); }
      }}>Assign</button>
    </span>
  );
}

function Reschedule({ o, onDone }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(toLocalInput(new Date(o.window_start)));
  const [e, setE] = useState(toLocalInput(new Date(o.window_end)));
  if (!open) return <button className="btn sm" onClick={() => setOpen(true)}>Reschedule…</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="datetime-local" style={{ ...inp, width: 'auto' }} value={s} onChange={(x) => setS(x.target.value)} />
      <input type="datetime-local" style={{ ...inp, width: 'auto' }} value={e} onChange={(x) => setE(x.target.value)} />
      <button className="btn sm primary" onClick={async () => {
        try {
          await plannedApi.reschedule(o.id, { windowStart: new Date(s).toISOString(), windowEnd: new Date(e).toISOString() });
          toast('Rescheduled; customers will be notified again'); setOpen(false); onDone();
        } catch (err) { fail(err); }
      }}>Save</button>
      <button className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

// Draft plan: an editable ordered list per phase. Order on screen = seq.
function PlanEditor({ o, crews, onSaved }) {
  const fromServer = (s) => ({ phase: s.phase, action: s.action, device_label: s.device_label, location: s.location, device_mrid: s.device_mrid, assignee: s.assignee, assignee_crew_id: s.assignee_crew_id || '' });
  const [rows, setRows] = useState(o.steps.map(fromServer));
  const [mrid, setMrid] = useState(o.work_mrid || '');
  const [traceCrew, setTraceCrew] = useState(o.incident.crew_id || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(o.steps.map(fromServer)); }, [o.steps.map((s) => s.id).join()]); // eslint-disable-line

  const upd = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= rows.length || rows[j].phase !== rows[i].phase) return;
    const next = [...rows]; [next[i], next[j]] = [next[j], next[i]]; setRows(next);
  };
  const add = (phase) => {
    const step = { phase, action: phase === 'isolate' ? 'open' : 'close', device_label: '', location: '', device_mrid: null, assignee: 'control_room', assignee_crew_id: '' };
    const lastOfPhase = rows.map((r) => r.phase).lastIndexOf(phase);
    const at = lastOfPhase >= 0 ? lastOfPhase + 1 : (phase === 'isolate' ? 0 : rows.length);
    setRows([...rows.slice(0, at), step, ...rows.slice(at)]);
  };
  const save = async () => {
    const steps = ['isolate', 'restore'].flatMap((phase) => rows.filter((r) => r.phase === phase).map((r, i) => ({
      ...r, seq: i + 1, assignee_crew_id: r.assignee === 'crew' ? r.assignee_crew_id : null,
    })));
    setBusy(true);
    try { await plannedApi.saveSteps(o.id, steps); toast('Plan saved'); onSaved(); } catch (e) { fail(e); }
    setBusy(false);
  };
  const draft = async () => {
    setBusy(true);
    try { await plannedApi.draftFromTrace(o.id, { workMrid: mrid, crewId: traceCrew }); toast('Draft built from the network trace - review every step'); onSaved(); } catch (e) { fail(e); }
    setBusy(false);
  };

  return (
    <div>
      {o.plan.trace_caveat && <Caveat text={o.plan.trace_caveat} />}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5 }}>
        <span className="eyebrow">Draft from network trace</span>
        <input style={{ ...inp, width: 180 }} placeholder="work equipment mRID" value={mrid} onChange={(e) => setMrid(e.target.value)} />
        <select style={{ ...inp, width: 'auto' }} value={traceCrew} onChange={(e) => setTraceCrew(e.target.value)}>
          <option value="">crew for line steps…</option>
          {crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
        </select>
        <button className="btn sm" disabled={busy || !mrid || !traceCrew} onClick={draft}>Build draft</button>
      </div>
      {['isolate', 'restore'].map((phase) => (
        <div key={phase} style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>{phase === 'isolate' ? 'Isolate (in this order)' : 'Restore (in this order)'}</div>
          {rows.map((r, i) => r.phase !== phase ? null : (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '24px 120px 1fr 1fr 130px 90px 64px', gap: 6, alignItems: 'center', marginBottom: 5 }}>
              <span className="mono" style={{ color: 'var(--muted)' }}>{rows.slice(0, i + 1).filter((x) => x.phase === phase).length}</span>
              <select style={inp} value={r.action} onChange={(e) => upd(i, 'action', e.target.value)}>{ACTIONS.map((a) => <option key={a} value={a}>{ACTION_TEXT[a]}</option>)}</select>
              <input style={inp} placeholder="device" value={r.device_label} onChange={(e) => upd(i, 'device_label', e.target.value)} />
              <input style={inp} placeholder="location" value={r.location} onChange={(e) => upd(i, 'location', e.target.value)} />
              <select style={inp} value={r.assignee} onChange={(e) => upd(i, 'assignee', e.target.value)}>
                <option value="control_room">Control room</option><option value="crew">Crew</option>
              </select>
              {r.assignee === 'crew'
                ? <select style={inp} value={r.assignee_crew_id} onChange={(e) => upd(i, 'assignee_crew_id', e.target.value)}><option value="">crew…</option>{crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select>
                : <span />}
              <span style={{ display: 'flex', gap: 2 }}>
                <button className="btn sm" title="Move up" onClick={() => move(i, -1)}>↑</button>
                <button className="btn sm" title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
              </span>
            </div>
          ))}
          <button className="btn sm" onClick={() => add(phase)}>+ {phase} step</button>
        </div>
      ))}
      <button className="btn primary" disabled={busy} onClick={save}>Save plan</button>
    </div>
  );
}

function Caveat({ text }) {
  return (
    <div style={{ background: 'var(--high-bg)', color: 'var(--ink)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, marginBottom: 12 }}>
      <b>Drafted from the network trace.</b> {text} Check every step's device, order and earthing before approving.
    </div>
  );
}

// Approved plan: steps in order. Only the next step of a phase can be
// confirmed; the server refuses anything else and the refusal is shown.
function StepList({ o, act, ask }) {
  const nextOf = (phase) => o.steps.find((s) => s.phase === phase && s.state !== 'confirmed');
  const confirmStep = (s) => {
    const what = `${ACTION_TEXT[s.action]} ${s.device_label} at ${s.location}`;
    if (s.assignee === 'crew') {
      const note = ask(`Crew step: ${what}\n\nRecord it ON BEHALF of crew ${s.assignee_crew_id}? Enter who reported it and how (e.g. "crew03 lead by radio 14:05"):`);
      if (note) act(() => plannedApi.confirmStep(s.id, { onBehalfNote: note }), 'Crew step recorded');
    } else if (window.confirm(`Confirm DONE: ${what}?\n\nOnly confirm after the operation has actually been carried out.`)) {
      act(() => plannedApi.confirmStep(s.id, {}), 'Step confirmed');
    }
  };
  return (
    <div>
      {o.plan.trace_caveat && <Caveat text={o.plan.trace_caveat} />}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Approved by {o.plan.approved_by} {timeAgo(o.plan.approved_at)}</div>
      {['isolate', 'restore'].map((phase) => {
        const next = nextOf(phase);
        return (
          <div key={phase} style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{phase === 'isolate' ? 'Isolate' : 'Restore'}</div>
            {o.steps.filter((s) => s.phase === phase).map((s) => (
              <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 8, alignItems: 'center', padding: '7px 9px', marginBottom: 4, borderRadius: 7,
                border: `1px solid ${next?.id === s.id ? 'var(--navy)' : 'var(--line)'}`, background: s.state === 'confirmed' ? 'var(--low-bg)' : 'var(--surface)' }}>
                <span className="mono">{s.seq}</span>
                <span>
                  <b>{ACTION_TEXT[s.action]}</b> {s.device_label} <span style={{ color: 'var(--muted)' }}>· {s.location}</span>
                  <span style={{ marginLeft: 6, fontSize: 11, border: '1px solid var(--line-2)', borderRadius: 4, padding: '0 5px' }}>{s.assignee === 'crew' ? `Crew ${s.assignee_crew_id}` : 'Control room'}</span>
                  {s.state === 'confirmed' && (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      ✓ {s.confirmed_by} · done {when(s.performed_at)}{s.received_at && Math.abs(new Date(s.received_at) - new Date(s.performed_at)) > 60000 ? ` (received ${hhmm(s.received_at)})` : ''}
                      {s.on_behalf_note && ` · on behalf: ${s.on_behalf_note}`}
                    </div>
                  )}
                </span>
                {s.state !== 'confirmed' && next?.id === s.id
                  ? <button className="btn sm primary" onClick={() => confirmStep(s)}>{s.assignee === 'crew' ? 'Record on behalf…' : 'Confirm done'}</button>
                  : <span style={{ fontSize: 12, color: s.state === 'confirmed' ? 'var(--low)' : 'var(--muted)' }}>{s.state === 'confirmed' ? 'Confirmed' : 'Pending'}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Permits({ o, act, ask }) {
  const isolationSummary = o.steps.filter((s) => s.phase === 'isolate' && ['open', 'rack_out'].includes(s.action)).map((s) => `${s.device_label} ${ACTION_TEXT[s.action]}`).join('; ');
  const earthSummary = o.steps.filter((s) => s.phase === 'isolate' && s.action === 'earth_apply').map((s) => `${s.device_label} (${s.location})`).join('; ');
  if (!o.permits.length) return <div className="empty"><span className="disp">No permit requested</span>The crew requests the permit from the app once their isolation steps are done.</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {o.permits.map((p) => (
        <div key={p.id} style={{ border: '1px solid var(--line)', borderRadius: 9, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b className="mono">{p.permit_no}</b>
            <span className={`badge-st st-${{ requested: 'open', issued: 'in_progress', returned: 'resolved' }[p.state] || 'cancelled'}`}>{p.state}</span>
          </div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>Crew {p.crew_id} · job {p.job_id} · requested by {p.requested_by} {when(p.requested_at)}</div>
          {p.issued_at && <div style={{ fontSize: 12.5 }}>Issued by {p.issued_by} {when(p.issued_at)} · isolation: {p.isolation_points} · earths: {p.earthing_points}</div>}
          {p.returned_at && <div style={{ fontSize: 12.5 }}>Returned by {p.returned_by} {when(p.returned_at)}{p.on_behalf_note ? ` (on behalf: ${p.on_behalf_note})` : ''}</div>}
          {p.refusal_reason && <div style={{ fontSize: 12.5 }}>Refused: {p.refusal_reason}</div>}
          {p.state === 'requested' && <IssueForm p={p} act={act} ask={ask} isolation={isolationSummary} earthing={earthSummary} />}
          {p.state === 'issued' && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => {
              const note = ask(`Record the RETURN of ${p.permit_no} on behalf of crew ${p.crew_id}?\n\nOnly if the crew has confirmed all men withdrawn, all earths removed and tools clear. Enter who confirmed it and how:`);
              if (note) act(() => plannedApi.returnOnBehalf(p.id, { onBehalfNote: note, declaration: { menWithdrawn: true, earthsRemoved: true, toolsClear: true } }), 'Permit returned');
            }}>Record return on behalf…</button>
          )}
        </div>
      ))}
    </div>
  );
}

function IssueForm({ p, act, ask, isolation, earthing }) {
  const [iso, setIso] = useState(isolation);
  const [earth, setEarth] = useState(earthing);
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
      <label><div className="eyebrow">Points of isolation</div><textarea style={inp} rows={2} value={iso} onChange={(e) => setIso(e.target.value)} /></label>
      <label><div className="eyebrow">Earths applied at</div><textarea style={inp} rows={2} value={earth} onChange={(e) => setEarth(e.target.value)} /></label>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm primary" onClick={() => window.confirm(`Issue ${p.permit_no} to crew ${p.crew_id}? Only if the line is isolated and earthed as stated.`)
          && act(() => plannedApi.issuePermit(p.id, { isolationPoints: iso, earthingPoints: earth }), 'Permit issued')}>Issue permit</button>
        <button className="btn sm danger" onClick={() => { const r = ask('Reason for refusing this permit?'); if (r) act(() => plannedApi.refusePermit(p.id, r), 'Permit refused'); }}>Refuse…</button>
      </div>
    </div>
  );
}

function SafetyLog({ log }) {
  if (!log.length) return <div className="empty">Nothing recorded yet.</div>;
  return (
    <div style={{ maxHeight: 420, overflow: 'auto' }}>
      <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Change</th><th>Detail</th></tr></thead>
        <tbody>
          {log.map((l) => (
            <tr key={l.id} style={l.action.endsWith('.rejected') ? { color: 'var(--crit)' } : undefined}>
              <td className="mono">{when(l.occurred_at || l.ts)}</td>
              <td>{l.actor}<div style={{ color: 'var(--muted)', fontSize: 11 }}>{l.actor_role}</div></td>
              <td>{l.action}</td>
              <td>{l.from_state || l.to_state ? `${l.from_state || '-'} → ${l.to_state || '-'}` : ''}</td>
              <td style={{ maxWidth: 260 }}>{l.details?.code ? `${l.details.code}: ${l.details.message}` : l.details?.device ? `${l.details.phase} ${l.details.seq} ${l.details.device}` : l.details?.permitNo || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
