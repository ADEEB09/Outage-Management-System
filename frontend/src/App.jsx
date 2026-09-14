import { useEffect, useState, useRef, Component } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { socket } from './lib/api.js';
import { Icon, useConnection, useToasts, hhmm } from './lib/ui.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Incidents from './screens/Incidents.jsx';
import NetworkMap from './screens/NetworkMap.jsx';
import Dispatch from './screens/Dispatch.jsx';
import Alarms from './screens/Alarms.jsx';
import TCS from './screens/TCS.jsx';
import Complaints from './screens/Complaints.jsx';
import Analytics from './screens/Analytics.jsx';
import Admin from './screens/Admin.jsx';
import IncidentSearch from './components/IncidentSearch.jsx';
import ProfileMenu from './components/ProfileMenu.jsx';

// Isolates a screen crash so it shows an inline message instead of blanking the
// whole app. Resets when you navigate to another screen (keyed by `tab`).
class ScreenBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div className="screen-error">
          <h2>This screen hit an error</h2>
          <p>The rest of the app is still working - pick another tab, or reload.</p>
          <pre>{String(this.state.err.message || this.state.err)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const NAV = [
  ['dashboard', 'Dashboard', 'dashboard', Dashboard],
  ['map', 'Network Map', 'map', NetworkMap],
  ['incidents', 'Incidents', 'bolt', Incidents],
  ['dispatch', 'Dispatch', 'users', Dispatch],
  ['alarms', 'Alarms', 'bell', Alarms],
  ['tcs', 'TCS / IVR', 'phone', TCS],
  ['complaints', 'Complaints', 'inbox', Complaints],
  ['analytics', 'Analytics', 'chart', Analytics],
  ['admin', 'Admin', 'gear', Admin],
];

const TAPE_LABEL = {
  'oms.incident.created': ['NEW INCIDENT', 'crit'],
  'oms.incident.updated': ['INCIDENT', ''],
  'scada.alarm.raised': ['SCADA ALARM', 'crit'],
  'scada.alarm.acked': ['ALARM ACK', 'ok'],
  'tcs.call.received': ['TROUBLE CALL', ''],
  'crew.updated': ['CREW', ''],
  'crew.job.updated': ['JOB', 'ok'],
};

function LiveTape() {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    const topics = Object.keys(TAPE_LABEL);
    const mk = (topic) => (p) => {
      const [label, cls] = TAPE_LABEL[topic];
      let detail = '';
      if (topic.startsWith('oms.incident')) detail = `${p.id} . ${p.zone} . ${p.status}`;
      else if (topic.startsWith('scada')) detail = `${p.tag} . ${p.condition}`;
      else if (topic === 'tcs.call.received') detail = `${p.customer} . ${p.category}`;
      else if (topic === 'crew.updated') detail = `${p.name} . ${p.status}`;
      else if (topic === 'crew.job.updated') detail = `${p.id} . ${p.status}`;
      setEvents((e) => [{ id: Math.random(), label, cls, detail, t: hhmm(new Date().toISOString()) }, ...e].slice(0, 14));
    };
    const hs = topics.map((t) => { const h = mk(t); socket.on(t, h); return [t, h]; });
    return () => hs.forEach(([t, h]) => socket.off(t, h));
  }, []);

  const feed = events.length ? events : [{ id: 0, label: 'SYSTEM', cls: 'ok', detail: 'Field telemetry stream connected - awaiting events', t: hhmm(new Date().toISOString()) }];
  const doubled = [...feed, ...feed];
  return (
    <div className="tape" role="status" aria-label="Live event feed">
      <div className="badge"><i />Live</div>
      <div className="track">
        {doubled.map((e, idx) => (
          <span className={`ev ${e.cls}`} key={e.id + '-' + idx}>
            <span className="t">{e.t}</span><b>{e.label}</b> {e.detail}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [focusIncidentId, setFocusIncidentId] = useState(null);
  const up = useConnection();
  const { items } = useToasts();
  const [clock, setClock] = useState('');
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toTimeString().slice(0, 8)), 1000);
    return () => clearInterval(t);
  }, []);

  // Jump to the Incidents screen with a specific incident pre-selected -
  // used by the Alarms table so an operator can go straight from "this alarm
  // fired" to "here's the incident it created" in one click.
  const openIncident = (id) => { setFocusIncidentId(id); setTab('incidents'); };

  const active = NAV.find((n) => n[0] === tab);
  const Screen = active[3];

  return (
    <div className="shell">
      <nav className="rail" aria-label="Primary">
        <div className="brand" title="GridQ"><img src="/gridq-mark.png" alt="GridQ" className="brand-img" /></div>
        {NAV.map(([id, label, icon]) => (
          <button key={id} className={`navbtn ${tab === id ? 'on' : ''}`}
            onClick={() => setTab(id)} aria-current={tab === id} aria-label={label}>
            <Icon name={icon} />
            <span className="tip">{label}</span>
          </button>
        ))}
        <div className="spacer" />
      </nav>

      <div className="main">
        <div className="masthead">
          <div className="masthead-brand">
            <div className="masthead-text">
              <div className="masthead-word">GridQ</div>
              {/* Real tagline - update here if it changes */}
              <div className="masthead-tag">Predict. Prevent. Power.</div>
            </div>
          </div>
          <div className="grow" />
          <div className="masthead-brand masthead-brand-right">
            <div className="masthead-text masthead-text-right">
              <div className="masthead-tag">Uttarakhand Power Corporation Limited</div>
            </div>
            <img src="/upcl-logo.png" alt="UPCL" className="masthead-logo" />
          </div>
        </div>

        <header className="cmd">
          <div>
            <h1>{active[1]}</h1>
            <div className="sub">Uttarakhand Power Corp . Ganga Corridor Control Centre</div>
          </div>
          <div className="grow" />
          <div className="conn" title={up ? 'Live link to control-room backend' : 'ReconnectingΓÇª'}>
            <span className={`dot ${up ? 'up' : 'down'}`} />
            {up ? 'SCADA link live' : 'Reconnecting'}
          </div>
          <div className="clock mono">{clock}</div>
             <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 12 }}>
               <div style={{ marginLeft: 12, width: 260, position: 'relative', display: 'flex', alignItems: 'center' }}>
                 <IncidentSearch onOpen={(inc) => openIncident(inc.id)} />
               </div>
               <ProfileMenu />
             </div>
           </header>

        <LiveTape />

        <div className="content">
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
            >
              <ScreenBoundary key={tab}>
                <Screen go={setTab} openIncident={openIncident} focusIncidentId={tab === 'incidents' ? focusIncidentId : null} clearFocus={() => setFocusIncidentId(null)} />
              </ScreenBoundary>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`}>
            <Icon name={t.kind === 'err' ? 'x' : 'check'} size={16} />{t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
