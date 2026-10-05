import { useEffect, useState, useCallback } from 'react';
import { socket } from './api.js';

// minimal inline icon set (stroke, 20x20)
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
export const Icon = ({ name, size = 20 }) => {
  const paths = {
    dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" {...P} /><rect x="14" y="3" width="7" height="5" rx="1.5" {...P} /><rect x="14" y="12" width="7" height="9" rx="1.5" {...P} /><rect x="3" y="16" width="7" height="5" rx="1.5" {...P} /></>,
    map: <><path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2Z" {...P} /><path d="M9 3v16M15 5v16" {...P} /></>,
    bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" {...P} />,
    users: <><circle cx="9" cy="8" r="3.2" {...P} /><path d="M3 20a6 6 0 0 1 12 0" {...P} /><path d="M16 5.5a3 3 0 0 1 0 5.5M18 20a6 6 0 0 0-3-5" {...P} /></>,
    bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" {...P} /><path d="M10 20a2 2 0 0 0 4 0" {...P} /></>,
    phone: <path d="M6 3h3l1.5 5-2 1.5a12 12 0 0 0 5 5l1.5-2 5 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2Z" {...P} />,
    chart: <><path d="M4 20V4M4 20h16" {...P} /><rect x="7" y="12" width="3" height="5" {...P} /><rect x="12" y="8" width="3" height="9" {...P} /><rect x="17" y="5" width="3" height="12" {...P} /></>,
    gear: <><circle cx="12" cy="12" r="3" {...P} /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" {...P} /></>,
    x: <path d="M6 6l12 12M18 6 6 18" {...P} />,
    check: <path d="M4 12l5 5L20 6" {...P} />,
    plus: <path d="M12 5v14M5 12h14" {...P} />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" {...P} />,
    pin: <><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11Z" {...P} /><circle cx="12" cy="10" r="2.4" {...P} /></>,
    clock: <><circle cx="12" cy="12" r="8.5" {...P} /><path d="M12 7v5l3 2" {...P} /></>,
    inbox: <><path d="M3 13h5l1.5 3h5L16 13h5" {...P} /><path d="M4 13 6 5h12l2 8v6a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19Z" {...P} /></>,
  };
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">{paths[name]}</svg>;
};

export const SevBadge = ({ sev }) => <span className={`badge-sev sev-${sev}`}>{sev}</span>;
export const StatusBadge = ({ status }) => {
  const label = { in_progress: 'In Progress', pending: 'Pending Verification' }[status] ||
    status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`badge-st st-${status}`}>{label}</span>;
};

export const timeAgo = (iso) => {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
export const hhmm = (iso) => iso ? new Date(iso).toTimeString().slice(0, 5) : '—';

// subscribe to one or more socket topics; re-runs cb on any of them
export function useLiveRefresh(topics, cb) {
  useEffect(() => {
    const h = () => cb();
    topics.forEach((t) => socket.on(t, h));
    return () => topics.forEach((t) => socket.off(t, h));
  }, topics); // eslint-disable-line
}

export function useConnection() {
  const [up, setUp] = useState(socket.connected);
  useEffect(() => {
    const on = () => setUp(true), off = () => setUp(false);
    socket.on('connect', on); socket.on('disconnect', off);
    return () => { socket.off('connect', on); socket.off('disconnect', off); };
  }, []);
  return up;
}

// toast system
let pushExternal = () => {};
export function useToasts() {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = 'ok', ms = 3200) => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), ms);
  }, []);
  useEffect(() => { pushExternal = push; }, [push]);
  return { items, push };
}
export const toast = (msg, kind, ms) => pushExternal(msg, kind, ms);
