import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useLiveRefresh } from '../lib/ui.jsx';

const MONTHS = ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan'];

function Sparkbars({ data }) {
  const max = Math.max(...data, 1);
  const W = 640, H = 180, pad = 28, bw = (W - pad * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Monthly SAIDI trend">
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line key={g} x1={pad} x2={W - pad} y1={H - pad - (H - pad * 2) * g} y2={H - pad - (H - pad * 2) * g} className="grid-line" />
      ))}
      {data.map((v, i) => {
        const h = (H - pad * 2) * (v / max);
        const x = pad + i * bw + bw * 0.18, w = bw * 0.64, y = H - pad - h;
        const last = i === data.length - 1;
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} rx={3} className={last ? 'bar bar-live' : 'bar'} />
            <text x={x + w / 2} y={H - pad + 14} className="bar-x">{MONTHS[i]}</text>
            {last && <text x={x + w / 2} y={y - 6} className="bar-v">{v}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default function Analytics() {
  const [ind, setInd] = useState(null);
  const [monthly, setMonthly] = useState([]);
  const [inc, setInc] = useState([]);
  const [mttr, setMttr] = useState([]);
  const [sla, setSla] = useState(null);
  const [crewProd, setCrewProd] = useState([]);
  const [outageFreq, setOutageFreq] = useState([]);
  const [drillZone, setDrillZone] = useState(null);
  const [activeTab, setActiveTab] = useState('feeders');

  const load = () => {
    api.indicators().then(setInd);
    api.monthly().then((m) => setMonthly(m.saidi || []));
    api.incidents().then(setInc);
    api.mttr().then(setMttr);
    api.slaCompliance().then(setSla);
    api.crewProductivity().then(setCrewProd);
    api.outageFrequency().then(setOutageFreq);
  };
  useEffect(() => { load(); }, []);
  useLiveRefresh(['oms.indices.updated', 'oms.incident.updated', 'oms.incident.created'], load);

  const feeders = useMemo(() => {
    const map = {};
    for (const i of inc) {
      const k = i.feeder || 'Unknown';
      map[k] = map[k] || { feeder: k, zone: i.zone, count: 0, customers: 0, open: 0 };
      map[k].count++; map[k].customers += i.customers || 0;
      if (!['resolved', 'closed'].includes(i.status)) map[k].open++;
    }
    return Object.values(map).sort((a, b) => b.customers - a.customers);
  }, [inc]);

  const cards = ind ? [
    { k: 'SAIDI', v: ind.saidi, u: 'min/cust', target: ind.saidiTarget, hint: 'System Avg Interruption Duration' },
    { k: 'SAIFI', v: ind.saifi, u: 'int/cust', target: ind.saifiTarget, hint: 'System Avg Interruption Frequency' },
    { k: 'CAIDI', v: ind.caidi, u: 'min', hint: 'Customer Avg Interruption Duration' },
    { k: 'MAIFI', v: ind.maifi, u: 'events', hint: 'Momentary Avg Interruption Frequency' },
  ] : [];

  const TABS = [
    { key: 'feeders', label: 'Feeder breakdown' },
    { key: 'mttr', label: 'MTTR by zone' },
    { key: 'sla', label: 'SLA compliance' },
    { key: 'crew', label: 'Crew productivity' },
    { key: 'freq', label: 'Outage frequency' },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Reporting</div>
          <h2>Reliability analytics</h2>
          <p>IEEE 1366 regulatory indices computed live over {ind?.customersServed?.toLocaleString() || '-'} customers served.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => api.exportReliabilityReport('csv').catch((e) => alert('Export failed: ' + e.message))}>Export CSV</button>
          <button className="btn" onClick={() => api.exportReliabilityReport('pdf').catch((e) => alert('Export failed: ' + e.message))}>Export PDF</button>
        </div>
      </div>

      <div className="grid stat-row" style={{ marginBottom: 16 }}>
        {cards.map((c) => {
          const over = c.target != null && c.v > c.target;
          return (
            <div key={c.k} className="stat kpi">
              <div className="kpi-top"><span className="stat-l">{c.k}</span>{c.target != null && (
                <span className={`chip ${over ? 'chip-crit' : 'chip-ok'}`}>{over ? 'over' : 'within'} target</span>
              )}</div>
              <div className="stat-n">{c.v}<span className="kpi-u"> {c.u}</span></div>
              <div className="kpi-hint">{c.hint}{c.target != null ? ` - target ${c.target}` : ''}</div>
            </div>
          );
        })}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <div className="card">
          <div className="card-h"><h3>SAIDI trend - trailing 12 months</h3><span className="eyebrow">min/customer</span></div>
          <div className="card-b">{monthly.length ? <Sparkbars data={monthly} /> : <div className="empty">Loading...</div>}</div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Customers affected</h3><span className="eyebrow">current</span></div>
          <div className="card-b">
            <div className="donut-wrap">
              <div className="big-metric">{(ind?.customersAffected || 0).toLocaleString()}</div>
              <div className="muted">of {ind?.customersServed?.toLocaleString() || '-'} served</div>
              <div className="meter"><span style={{ width: `${Math.min(100, ((ind?.customersAffected || 0) / (ind?.customersServed || 1)) * 100).toFixed(1)}%` }} /></div>
              <div className="muted" style={{ fontSize: 12 }}>{(((ind?.customersAffected || 0) / (ind?.customersServed || 1)) * 100).toFixed(2)}% of network currently interrupted</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--line-2)', paddingBottom: 0 }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              className="btn sm"
              onClick={() => setActiveTab(t.key)}
              style={{
                borderRadius: '8px 8px 0 0',
                background: activeTab === t.key ? 'var(--navy, #0f2847)' : 'transparent',
                color: activeTab === t.key ? '#fff' : 'inherit',
                border: 'none',
                fontWeight: activeTab === t.key ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="card-b" style={{ padding: 0 }}>
          {activeTab === 'feeders' && (
            <table className="tbl">
              <thead><tr><th>Feeder</th><th>Zone</th><th>Incidents</th><th>Open</th><th>Customers affected</th></tr></thead>
              <tbody>
                {feeders.map((f) => (
                  <tr key={f.feeder}>
                    <td className="mono">{f.feeder}</td>
                    <td>{f.zone}</td>
                    <td>{f.count}</td>
                    <td>{f.open ? <span className="chip chip-crit">{f.open}</span> : <span className="muted">0</span>}</td>
                    <td>{f.customers.toLocaleString()}</td>
                  </tr>
                ))}
                {!feeders.length && <tr><td colSpan={5} className="empty">No incident data.</td></tr>}
              </tbody>
            </table>
          )}

          {activeTab === 'mttr' && (
            <table className="tbl">
              <thead><tr><th>Zone</th><th>MTTR (min)</th><th>Incidents resolved</th></tr></thead>
              <tbody>
                {mttr.map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td>{z.zone}</td>
                    <td className="mono">{z.mttrMinutes}</td>
                    <td>{z.incidentCount}</td>
                  </tr>
                ))}
                {!mttr.length && <tr><td colSpan={3} className="empty">No resolved incidents yet.</td></tr>}
              </tbody>
            </table>
          )}

          {activeTab === 'sla' && (
            <table className="tbl">
              <thead><tr><th>Zone</th><th>Compliant</th><th>Breached</th><th>At risk</th></tr></thead>
              <tbody>
                {(sla?.byZone || []).map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td>{z.zone}</td>
                    <td>{z.compliant}</td>
                    <td>{z.breached ? <span className="chip chip-crit">{z.breached}</span> : <span className="muted">0</span>}</td>
                    <td>{z.atRisk ? <span className="chip chip-crit">{z.atRisk}</span> : <span className="muted">0</span>}</td>
                  </tr>
                ))}
                {!sla?.byZone?.length && <tr><td colSpan={4} className="empty">No SLA data yet.</td></tr>}
              </tbody>
            </table>
          )}

          {activeTab === 'crew' && (
            <table className="tbl">
              <thead><tr><th>Crew</th><th>Jobs total</th><th>Jobs completed</th><th>Avg minutes/job</th></tr></thead>
              <tbody>
                {crewProd.map((c) => (
                  <tr key={c.crewId}>
                    <td>{c.crewName}</td>
                    <td>{c.jobsTotal}</td>
                    <td>{c.jobsCompleted}</td>
                    <td className="mono">{c.avgMinutesPerJob ?? '-'}</td>
                  </tr>
                ))}
                {!crewProd.length && <tr><td colSpan={4} className="empty">No job data yet.</td></tr>}
              </tbody>
            </table>
          )}

          {activeTab === 'freq' && (
            <table className="tbl">
              <thead><tr><th>Zone</th><th>Total</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th></tr></thead>
              <tbody>
                {outageFreq.map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td>{z.zone}</td>
                    <td>{z.total}</td>
                    <td>{z.critical || 0}</td>
                    <td>{z.high || 0}</td>
                    <td>{z.medium || 0}</td>
                    <td>{z.low || 0}</td>
                  </tr>
                ))}
                {!outageFreq.length && <tr><td colSpan={6} className="empty">No outage data yet.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {drillZone && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-h">
            <h3>Incidents in {drillZone}</h3>
            <button className="btn sm" onClick={() => setDrillZone(null)}>Close</button>
          </div>
          <div className="card-b" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>ID</th><th>Severity</th><th>Status</th><th>Cause</th><th>Customers</th></tr></thead>
              <tbody>
                {inc.filter((i) => i.zone === drillZone).map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td>
                    <td>{i.severity}</td>
                    <td>{i.status}</td>
                    <td>{i.cause}</td>
                    <td>{i.customers}</td>
                  </tr>
                ))}
                {!inc.filter((i) => i.zone === drillZone).length && <tr><td colSpan={5} className="empty">No incidents found for this zone.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
