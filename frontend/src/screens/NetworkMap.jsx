import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../lib/api.js';
import { Icon, SevBadge, StatusBadge, useLiveRefresh } from '../lib/ui.jsx';

const SEVC = { critical: '#e23b2e', high: '#ef9021', medium: '#3b82f6', low: '#22b06b' };
const CREWC = { available: '#0fb39d', in_service: '#3b82f6', in_transit: '#ef9021', on_break: '#9fb0c4', off_shift: '#9fb0c4' };
const PALETTE = ['#3b82f6', '#0fb39d', '#e0742b', '#8b5cf6', '#22b06b', '#e0447a', '#d1a017', '#2fa3a3', '#7a9e2e', '#c2622a', '#5b6ee0', '#c94f9a'];
const feederColor = (name) => { if (!name) return '#9fb0c4'; let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff; return PALETTE[h % PALETTE.length]; };
const hav = (a, b) => { const R = 6371, dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const clean = (n) => (n || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim();

const LAYER_GROUPS = [
  ['Network', [['htLines', 'HT network', true], ['feeders', 'Feeder lines', true], ['substations', 'Substations', true],
    ['powerTx', 'Power transformers', false], ['distTx', 'Distribution txr', false],
    ['switches', 'Switches', false], ['rmus', 'RMUs', false], ['fuses', 'Drop-out fuses', false]]],
  ['Operations', [['incidents', 'Incidents', true], ['crews', 'Crews', true]]],
];
// CIM topology (network.* PostGIS schema) -- real connectivity data, imported
// from a CIM RDF/XML export. Separate from the Haridwar layers above, which
// still come from network.json.
LAYER_GROUPS.splice(1, 0, ['Topology · CIM (Dehradun)', [
  ['topoLines', 'Lines (ACLineSegment)', true],
  ['topoStruct', 'Poles & junctions', true],
  ['topoEquip', 'Transformers, fuses, switches', true],
]]);
const ALL = LAYER_GROUPS.flatMap(([, ls]) => ls);
const TOPO_STYLE = {
  PowerTransformer: { color: '#2563eb', r: 6.5 }, Fuse: { color: '#ea8a12', r: 5 },
  Breaker: { color: '#7c3aed', r: 6.5 }, ProtectedSwitch: { color: '#7c3aed', r: 6.5 }, CurrentTransformer: { color: '#0d9488', r: 5 },
  Structure: { color: '#6b7a90', r: 3 }, Junction: { color: '#6b7a90', r: 4.5 }, Meter: { color: '#6b7a90', r: 4.5 },
};
const topoGroupOf = (cls) => (cls === 'ACLineSegment' ? 'topoLines' : ['Structure', 'Junction', 'Meter'].includes(cls) ? 'topoStruct' : 'topoEquip');
const SECTION_COLOR = '#ff6a00';

export default function NetworkMap() {
  const [net, setNet] = useState(null);
  const [inc, setInc] = useState([]);
  const [crews, setCrews] = useState([]);
  const [sel, setSel] = useState(null);
  const [selFeeder, setSelFeeder] = useState(null);
  const [layers, setLayers] = useState(Object.fromEntries(ALL.map(([k, , on]) => [k, on])));
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [openResults, setOpenResults] = useState(false);
  const [topo, setTopo] = useState(null);       // GeoJSON from /api/network/topology (null = loading)
  const [trace, setTrace] = useState(null);     // result of /api/network/section/:mrid
  const [traceBusy, setTraceBusy] = useState(false);

  const boxRef = useRef();
  const mapRef = useRef(null);
  const groups = useRef({});
  const feederIdx = useRef({});
  const hiRef = useRef(null);
  const topoIdx = useRef({});       // mrid -> { layer, isLine, base, latlng }
  const traceLayer = useRef(null);  // origin / boundary markers for the active trace
  const selRef = useRef(null); selRef.current = sel;

  useEffect(() => { api.network().then(setNet).catch(() => setNet({ error: true })); }, []);
  useEffect(() => { api.networkTopology().then(setTopo).catch(() => setTopo({ error: true })); }, []);
  const loadLive = () => { api.incidents().then(setInc); api.crews().then(setCrews); };
  useEffect(() => { loadLive(); }, []);
  useLiveRefresh(['crew.updated', 'oms.incident.updated', 'oms.incident.created'], loadLive);
  useEffect(() => { if (sel && sel.kind === 'incident') setSel((s) => ({ ...s, ...(inc.find((i) => i.id === s.id) || {}) })); }, [inc]); // eslint-disable-line

  const topoOk = !!(topo && !topo.error && topo.features && topo.features.length);
  const topoCounts = useMemo(() => {
    const m = { topoLines: 0, topoStruct: 0, topoEquip: 0 };
    if (topoOk) topo.features.forEach((f) => { m[topoGroupOf(f.properties.cls)]++; });
    return m;
  }, [topo, topoOk]);

  const feeders = useMemo(() => {
    if (!net || !net.feederLines) return {};
    const m = {};
    net.feederLines.forEach((l) => {
      const k = l.feeder || '—';
      if (!m[k]) m[k] = { name: k, kv: l.kv, ss: l.ss, segs: 0, km: 0, color: feederColor(k), minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };
      m[k].segs++;
      for (let i = 0; i < l.path.length; i++) {
        const [la, lo] = l.path[i];
        m[k].minLat = Math.min(m[k].minLat, la); m[k].maxLat = Math.max(m[k].maxLat, la);
        m[k].minLon = Math.min(m[k].minLon, lo); m[k].maxLon = Math.max(m[k].maxLon, lo);
        if (i < l.path.length - 1) m[k].km += hav(l.path[i], l.path[i + 1]);
      }
    });
    return m;
  }, [net]);

  // searchable index over every dataset — assets, circuits, plus live incidents & crews
  const searchIndex = useMemo(() => {
    if (!net) return [];
    const out = [];
    const push = (type, kind, label, ref, sub) => label && out.push({ type, kind, label: String(label), sub, lat: ref.lat, lon: ref.lon, ref });
    net.substations.forEach((s) => push('Substation', 'ss', clean(s.name) || s.name, s, s.name));
    net.powerTx.forEach((a) => push('Power Txr', 'ptx', a.name || 'Power transformer', a));
    net.distTx.forEach((a) => push('DTR', 'dt', a.name || a.id, a, a.feeder));
    net.switches.forEach((a) => push('Switch', 'switch', a.name || a.id, a));
    net.rmus.forEach((a) => push('RMU', 'rmu', a.id || a.name, a));
    net.fuses.forEach((a) => push('Fuse', 'fuse', a.id || a.name, a));
    if (topoOk) topo.features.forEach((f) => {
      const p = f.properties; if (!p.name || p.name === p.mrid) return; // numeric-only names are not useful to search
      const [lo, la] = f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.coordinates[0];
      push('CIM', 'topo', p.name, { ...p, lat: la, lon: lo }, p.cls);
    });
    Object.values(feeders).forEach((f) => out.push({ type: 'Feeder', kind: 'feeder', label: f.name, sub: (f.kv || 11) + ' kV', ref: f }));
    return out;
  }, [net, feeders, topo]); // eslint-disable-line

  const liveIndex = useMemo(() => {
    const out = [];
    inc.forEach((i) => i.lat && i.lon && out.push({ type: 'Incident', kind: 'incident', label: i.id, sub: i.zone, lat: i.lat, lon: i.lon, ref: i }));
    crews.forEach((c) => c.lat && c.lon && out.push({ type: 'Crew', kind: 'crew', label: c.name, sub: (c.status || '').replace('_', ' '), lat: c.lat, lon: c.lon, ref: c }));
    return out;
  }, [inc, crews]);

  const RANK = { Substation: 0, Feeder: 1, Incident: 2, Crew: 3, CIM: 3.5, 'Power Txr': 4, DTR: 5, Switch: 6, RMU: 7, Fuse: 8 };
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const it of [...liveIndex, ...searchIndex]) {
      const l = it.label.toLowerCase();
      const i = l.indexOf(q);
      if (i !== -1) hits.push({ ...it, starts: i === 0 });
    }
    hits.sort((a, b) => (b.starts - a.starts) || ((RANK[a.type] ?? 9) - (RANK[b.type] ?? 9)) || a.label.localeCompare(b.label));
    return hits.slice(0, 30);
  }, [query, searchIndex, liveIndex]); // eslint-disable-line

  // create the Leaflet map once
  useEffect(() => {
    if (!net || net.error || mapRef.current || !boxRef.current) return;
    const b = net.bounds;
    const bounds = L.latLngBounds([b.minLat, b.minLon], [b.maxLat, b.maxLon]);
    const map = L.map(boxRef.current, { preferCanvas: true, zoomControl: false, attributionControl: true, maxZoom: 19, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 });
    map.fitBounds(bounds.pad(0.05));
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap', opacity: 0.92 }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    mapRef.current = map;
    map.__bounds = bounds;
    setReady(true);
    return () => { map.remove(); mapRef.current = null; };
  }, [net]);

  // build static network layers once the map exists
  useEffect(() => {
    if (!ready || !mapRef.current || !net || groups.current.built) return;
    const map = mapRef.current;
    const mk = () => L.layerGroup();
    ['htLines', 'feeders', 'substations', 'powerTx', 'distTx', 'switches', 'rmus', 'fuses'].forEach((k) => (groups.current[k] = mk()));

    net.htLines.forEach((l) => L.polyline(l.path, { color: '#3f5a86', weight: 2, opacity: 0.9, interactive: false }).addTo(groups.current.htLines));

    feederIdx.current = {};
    net.feederLines.forEach((l) => {
      const col = feederColor(l.feeder);
      // wide, invisible "hit" line so the feeder is easy to hover/click...
      const hit = L.polyline(l.path, { color: col, weight: 14, opacity: 0, interactive: true });
      hit.on('click', () => pickFeeder(l.feeder));
      hit.bindTooltip(`${l.feeder || 'Feeder'} · ${l.kv || 11} kV`, { sticky: true });
      hit.addTo(groups.current.feeders);
      // ...and the thin, visible line drawn on top
      const pl = L.polyline(l.path, { color: col, weight: 3, opacity: 0.92, interactive: false });
      pl.addTo(groups.current.feeders);
      (feederIdx.current[l.feeder] = feederIdx.current[l.feeder] || []).push(pl);
    });

    net.fuses.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 2.5, color: '#b98a5e', weight: 0, fillOpacity: 0.85 }).addTo(groups.current.fuses));
    net.rmus.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 3, color: '#7a9e2e', weight: 0, fillOpacity: 0.9 }).on('click', () => select('rmu', a, 'RMU')).addTo(groups.current.rmus));
    net.switches.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 2.8, color: '#8b5cf6', weight: 0, fillOpacity: 0.85 }).on('click', () => select('switch', a, a.name || 'Switch')).addTo(groups.current.switches));
    net.distTx.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 3, color: '#3b82f6', weight: 0, fillOpacity: 0.85 }).bindTooltip(a.name || 'DTR').on('click', () => select('dt', a, a.name || 'DTR')).addTo(groups.current.distTx));
    net.powerTx.forEach((a) => L.marker([a.lat, a.lon], { icon: L.divIcon({ className: '', html: '<div class="mk-ptx"></div>', iconSize: [12, 12] }) }).on('click', () => select('ptx', a, a.name || 'Power Txr')).addTo(groups.current.powerTx));
    net.substations.forEach((s) => L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-ss"><span class="mk-ss-d"></span><span class="mk-ss-l">${clean(s.name)}</span></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: 500 }).on('click', () => select('ss', s, s.name)).addTo(groups.current.substations));

    groups.current.incidents = mk();
    groups.current.crews = mk();
    groups.current.built = true;
    // add the default-on layers
    ALL.forEach(([k, , on]) => { if (on && groups.current[k]) groups.current[k].addTo(map); });
  }, [ready, net]); // eslint-disable-line

  // build the CIM topology layers once both the map and the GeoJSON exist
  useEffect(() => {
    if (!ready || !mapRef.current || !topoOk || groups.current.topoBuilt) return;
    const map = mapRef.current;
    ['topoLines', 'topoStruct', 'topoEquip'].forEach((k) => (groups.current[k] = L.layerGroup()));
    topoIdx.current = {};
    const bounds = L.latLngBounds([]);
    topo.features.forEach((f) => {
      const p = f.properties, grp = groups.current[topoGroupOf(p.cls)];
      if (f.geometry.type === 'LineString') {
        const latlngs = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
        latlngs.forEach((ll) => bounds.extend(ll));
        const base = { color: '#0e7490', weight: 3, opacity: 0.9 };
        // wide invisible line so a thin cable is easy to click, thin visible line on top
        const hit = L.polyline(latlngs, { color: '#0e7490', weight: 14, opacity: 0, interactive: true });
        hit.on('click', () => selectTopo(p, latlngs[0]));
        hit.bindTooltip(`${p.cls} · ${p.name || p.mrid}`, { sticky: true });
        hit.addTo(grp);
        const pl = L.polyline(latlngs, { ...base, interactive: false }).addTo(grp);
        topoIdx.current[p.mrid] = { layer: pl, isLine: true, base, latlng: latlngs[0] };
      } else {
        const [lo, la] = f.geometry.coordinates;
        bounds.extend([la, lo]);
        const st = TOPO_STYLE[p.cls] || { color: '#6b7a90', r: 3.5 };
        const base = { radius: st.r, color: '#ffffff', weight: 1.4, fillColor: st.color, fillOpacity: 0.95, opacity: 1 };
        const m = L.circleMarker([la, lo], base);
        m.bindTooltip(`${p.cls} · ${p.name || p.mrid}`);
        m.on('click', () => selectTopo(p, [la, lo]));
        m.addTo(grp);
        topoIdx.current[p.mrid] = { layer: m, isLine: false, base, latlng: [la, lo] };
      }
    });
    map.__topoBounds = bounds.isValid() ? bounds : null;
    groups.current.topoBuilt = true;
    ['topoLines', 'topoStruct', 'topoEquip'].forEach((k) => { if (layers[k]) groups.current[k].addTo(map); });
  }, [ready, topo]); // eslint-disable-line

  // section trace: highlight the electrical section, mark the origin and boundary switches, dim the rest
  useEffect(() => {
    const map = mapRef.current; if (!map || !groups.current.topoBuilt) return;
    if (traceLayer.current) { map.removeLayer(traceLayer.current); traceLayer.current = null; }
    const idx = topoIdx.current;
    const active = !!(trace && trace.found);
    const inSection = new Set(active ? trace.sectionEquipment.map((e) => e.cim_mrid) : []);
    const bound = new Set(active ? trace.boundarySwitches.map((e) => e.cim_mrid) : []);
    Object.entries(idx).forEach(([mrid, t]) => {
      if (!active) { t.layer.setStyle(t.base); return; }
      const hit = inSection.has(mrid) || bound.has(mrid) || mrid === trace.origin.cim_mrid;
      if (t.isLine) t.layer.setStyle(hit ? { color: SECTION_COLOR, weight: 6, opacity: 1 } : { ...t.base, opacity: 0.2 });
      else t.layer.setStyle(hit ? { ...t.base, fillColor: SECTION_COLOR, radius: t.base.radius + 2, fillOpacity: 1 } : { ...t.base, fillOpacity: 0.2, opacity: 0.3 });
      if (hit && t.layer.bringToFront) t.layer.bringToFront();
    });
    if (!active) return;
    const g = L.layerGroup();
    const mkIcon = (cls, size) => L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    const o = idx[trace.origin.cim_mrid];
    if (o) L.marker(o.latlng, { icon: mkIcon('mk-origin', 22), zIndexOffset: 3000 }).bindTooltip('Trace origin').addTo(g);
    trace.boundarySwitches.forEach((b) => { const t = idx[b.cim_mrid]; if (t) L.marker(t.latlng, { icon: mkIcon('mk-bound', 20), zIndexOffset: 2500 }).bindTooltip(`Boundary · ${b.cim_class} ${b.name || b.cim_mrid}`).addTo(g); });
    g.addTo(map); traceLayer.current = g;
    const pts = [...inSection, ...bound, trace.origin.cim_mrid].map((m) => idx[m]).filter(Boolean).flatMap((t) => (t.isLine ? t.layer.getLatLngs() : [t.latlng]));
    if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 19, duration: 0.6 });
  }, [trace, ready, topo]);

  // rebuild incident markers on live updates
  useEffect(() => {
    const g = groups.current.incidents; if (!g) return;
    g.clearLayers();
    inc.filter((i) => i.lat && i.lon).forEach((i) => {
      const active = !['resolved', 'closed', 'cancelled'].includes(i.status);
      const m = L.marker([i.lat, i.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-inc ${active ? 'live' : ''}" style="--c:${SEVC[i.severity]}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 });
      m.on('click', () => select('incident', i, i.id)); m.addTo(g);
    });
  }, [inc, ready]);

  // rebuild crew markers on live updates
  useEffect(() => {
    const g = groups.current.crews; if (!g) return;
    g.clearLayers();
    crews.filter((c) => c.lat && c.lon).forEach((c) => {
      const m = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-crew" style="--c:${CREWC[c.status] || '#9fb0c4'}"></div>`, iconSize: [16, 14], iconAnchor: [8, 10] }), zIndexOffset: 900 });
      m.on('click', () => select('crew', c, c.name)); m.addTo(g);
    });
  }, [crews, ready]);

  // toggle layers on/off
  useEffect(() => {
    const map = mapRef.current; if (!map || !groups.current.built) return;
    Object.entries(layers).forEach(([k, on]) => {
      const g = groups.current[k]; if (!g) return;
      if (on && !map.hasLayer(g)) g.addTo(map);
      if (!on && map.hasLayer(g)) map.removeLayer(g);
    });
  }, [layers, ready]);

  // highlight the selected feeder circuit
  useEffect(() => {
    Object.entries(feederIdx.current).forEach(([name, arr]) => {
      const on = !selFeeder || name === selFeeder;
      arr.forEach((pl) => pl.setStyle({ weight: name === selFeeder ? 5.5 : 3, opacity: on ? 0.95 : 0.12 }));
    });
  }, [selFeeder]);

  function select(kind, obj, label) { setTrace(null); setSel({ kind, label, ...obj }); if (kind !== 'feeder') setSelFeeder(null); }
  function selectTopo(p, latlng) { setTrace(null); setSel({ kind: 'topo', label: p.name || p.mrid, ...p, lat: latlng[0], lon: latlng[1] }); setSelFeeder(null); }
  async function runTrace(mrid) {
    setTraceBusy(true);
    try { setTrace(await api.networkSection(mrid)); }
    catch (e) { setTrace({ found: false, reason: e.message || 'Trace failed' }); }
    finally { setTraceBusy(false); }
  }
  const fitTopo = () => { const m = mapRef.current; if (m && m.__topoBounds) m.flyToBounds(m.__topoBounds.pad(0.15), { duration: 0.6 }); };
  function pickFeeder(name) { setSelFeeder(name); setSel({ kind: 'feeder', ...feeders[name] }); }
  const fitAll = () => { const m = mapRef.current; if (m && m.__bounds) m.flyToBounds(m.__bounds.pad(0.05), { duration: 0.5 }); };

  function highlight(lat, lon) {
    const map = mapRef.current; if (!map) return;
    if (hiRef.current) { map.removeLayer(hiRef.current); hiRef.current = null; }
    if (lat == null) return;
    hiRef.current = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="mk-find"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 2000 }).addTo(map);
  }
  // fly the map to a searched item and reveal / highlight it
  function goTo(item) {
    const map = mapRef.current; if (!map) return;
    const layerKey = { ss: 'substations', ptx: 'powerTx', dt: 'distTx', switch: 'switches', rmu: 'rmus', fuse: 'fuses', feeder: 'feeders', incident: 'incidents', crew: 'crews' }[item.kind];
    if (layerKey && !layers[layerKey]) setLayers((l) => ({ ...l, [layerKey]: true }));
    setQuery(''); setOpenResults(false);
    if (item.kind === 'feeder') {
      const f = feeders[item.label]; pickFeeder(item.label); highlight(null);
      if (f) map.flyToBounds(L.latLngBounds([f.minLat, f.minLon], [f.maxLat, f.maxLon]).pad(0.25), { maxZoom: 16, duration: 0.6 });
      return;
    }
    if (item.lat && item.lon) {
      map.flyTo([item.lat, item.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
      highlight(item.lat, item.lon);
    }
    select(item.kind, item.ref, item.label);
  }

  if (!net) return <div className="empty"><span className="disp">Loading network…</span>Reading the Haridwar GIS model.</div>;
  if (net.error) return <div className="screen-error"><h2>Network unavailable</h2><p>Could not load the topology from the backend.</p></div>;
  const c = net.counts || {};
  const plottedInc = inc.filter((i) => i.lat && i.lon);

  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Geospatial · Haridwar</div><h2>Network map</h2>
          <p>{c.substations} substations · {c.distTx ? c.distTx.toLocaleString() : 0} DTRs · {c.feederLines} feeder spans · {Object.keys(feeders).length} circuits</p></div>
      </div>

      <div className="map-wrap">
        <div className="layer-panel">
          {LAYER_GROUPS.filter(([group]) => topoOk || !group.startsWith('Topology')).map(([group, ls]) => (
            <div key={group} className="lp-group">
              <div className="lp-h">{group}</div>
              {group.startsWith('Topology') && <div className="lp-sub">From CIM import · click any item, then “Trace electrical section”</div>}
              {ls.map(([k, label]) => {
                const n = k.startsWith('topo') ? topoCounts[k] : k === 'incidents' ? plottedInc.length : k === 'crews' ? crews.length : (c[k === 'feeders' ? 'feederLines' : k] || 0);
                return (
                  <label key={k} className={`lp-row ${layers[k] ? 'on' : ''}`}>
                    <input type="checkbox" checked={!!layers[k]} onChange={() => setLayers((l) => ({ ...l, [k]: !l[k] }))} />
                    <span className={`lp-swatch sw-${k}`} /><span className="lp-label">{label}</span>
                    <span className="lp-count">{n && n.toLocaleString ? n.toLocaleString() : n}</span>
                  </label>
                );
              })}
            </div>
          ))}
          {selFeeder && <button className="lp-clear" onClick={() => { setSelFeeder(null); setSel(null); }}>Clear feeder highlight</button>}

          <div className="lp-group lp-key">
            <div className="lp-h">Key</div>
            <div className="lp-kt">Incident severity</div>
            <div className="lp-kgrid">
              <span className="lp-krow"><Sym shape="dot" color="#e23b2e" /> Critical</span>
              <span className="lp-krow"><Sym shape="dot" color="#ef9021" /> High</span>
              <span className="lp-krow"><Sym shape="dot" color="#3b82f6" /> Medium</span>
              <span className="lp-krow"><Sym shape="dot" color="#22b06b" /> Low</span>
            </div>
            <div className="lp-kt">Crew status</div>
            <div className="lp-kgrid">
              <span className="lp-krow"><Sym shape="tri" color="#0fb39d" /> Available</span>
              <span className="lp-krow"><Sym shape="tri" color="#ef9021" /> In transit</span>
              <span className="lp-krow"><Sym shape="tri" color="#3b82f6" /> In service</span>
              <span className="lp-krow"><Sym shape="tri" color="#9fb0c4" /> On break</span>
            </div>
            <div className="lp-knote">Active incidents show a pulsing ring. Feeder colour identifies its circuit.</div>
          </div>

          <div className="lp-hint">Drag to pan · scroll to zoom · click a feeder to trace its circuit</div>
        </div>

        <div className="card map-stage">
          <div ref={boxRef} className="leaflet-host" />

          <div className="map-search">
            <div className="ms-box">
              <Icon name="pin" size={15} />
              <input value={query} placeholder="Search feeders, substations, DTRs, crews…"
                onChange={(e) => { setQuery(e.target.value); setOpenResults(true); }}
                onFocus={() => setOpenResults(true)}
                onBlur={() => setTimeout(() => setOpenResults(false), 150)}
                onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) goTo(results[0]); if (e.key === 'Escape') { setQuery(''); setOpenResults(false); } }} />
              {query && <button className="ms-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => setQuery('')}><Icon name="x" size={13} /></button>}
            </div>
            {openResults && query && (
              <div className="ms-results">
                {results.length === 0 && <div className="ms-empty">No matches for “{query}”.</div>}
                {results.map((r, i) => (
                  <button key={r.kind + r.label + i} className="ms-item" onMouseDown={(e) => e.preventDefault()} onClick={() => goTo(r)}>
                    <span className={`ms-tag tag-${r.kind}`}>{r.type}</span>
                    <span className="ms-label">{r.label}</span>
                    {r.sub && <span className="ms-sub">{r.sub}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="map-tools">
            <button className="map-fit" onClick={fitAll} title="Fit whole network"><Icon name="map" size={15} /> Fit</button>
            {topoOk && <button className="map-fit topo" onClick={fitTopo} title="Jump to the CIM topology (Dehradun Ring Road)"><Icon name="pin" size={15} /> Dehradun</button>}
          </div>

          {sel && (
            <div className="map-detail card">
              <div className="card-h"><h3>{sel.kind === 'incident' ? sel.id : sel.kind === 'feeder' ? 'Feeder' : sel.label}</h3>
                <button className="iconbtn" aria-label="Close" onClick={() => { setSel(null); setSelFeeder(null); setTrace(null); highlight(null); }}><Icon name="x" size={15} /></button></div>
              <div className="card-b">
                {sel.kind === 'incident' && <><div style={{ display: 'flex', gap: 7, marginBottom: 12 }}><SevBadge sev={sel.severity} /><StatusBadge status={sel.status} /></div>
                  <KV k="Substation" v={sel.substation} /><KV k="Zone" v={sel.zone} /><KV k="Feeder" v={sel.feeder} mono /><KV k="Customers" v={(sel.customers || 0).toLocaleString()} mono /><KV k="Cause" v={sel.cause} /><KV k="Crew" v={sel.crew_id || 'unassigned'} /></>}
                {sel.kind === 'feeder' && <><div className="feeder-tag" style={{ background: sel.color }}>{sel.name}</div>
                  <KV k="Voltage" v={sel.kv ? sel.kv + ' kV' : '11 kV'} /><KV k="Substation" v={sel.ss} /><KV k="Segments" v={sel.segs} mono /><KV k="Route length" v={sel.km ? sel.km.toFixed(2) + ' km' : '—'} mono /></>}
                {sel.kind === 'ss' && <><span className="chip chip-soft">Substation</span><KV k="Voltage" v={sel.ratio} /><KV k="Capacity" v={sel.mva ? sel.mva + ' MVA' : '—'} /><KV k="Status" v={sel.status} /><KV k="Outgoing feeders" v={sel.feeders} /></>}
                {sel.kind === 'ptx' && <><span className="chip chip-soft">Power transformer</span><KV k="HV" v={sel.hv ? sel.hv + ' kV' : '—'} /><KV k="LV" v={sel.lv ? sel.lv + ' kV' : '—'} /><KV k="Capacity" v={sel.mva ? sel.mva + ' MVA' : '—'} /><KV k="Status" v={sel.status} /></>}
                {sel.kind === 'dt' && <><span className="chip chip-soft">Distribution transformer</span><KV k="Capacity" v={sel.kva ? sel.kva + ' kVA' : '—'} /><KV k="Feeder" v={sel.feeder} mono /><KV k="Substation code" v={sel.ss} mono /><KV k="Status" v={sel.status} /></>}
                {sel.kind === 'switch' && <><span className="chip chip-soft">Switch</span><KV k="Type" v={sel.type} /><KV k="Voltage" v={sel.kv ? sel.kv + ' kV' : '—'} /><KV k="Status" v={sel.status} /></>}
                {sel.kind === 'rmu' && <><span className="chip chip-soft">Ring main unit</span><KV k="ID" v={sel.id} mono /><KV k="Status" v={sel.status} /></>}
                {sel.kind === 'topo' && <>
                  <span className="chip chip-soft">{sel.cls} · CIM</span>
                  <KV k="mRID" v={sel.mrid} mono /><KV k="Name" v={sel.name} /><KV k="Feeder" v={sel.feeder} />
                  <KV k="Rated voltage" v={sel.ratedVoltage ? (Number(sel.ratedVoltage) / 1000) + ' kV' : null} />
                  {!(trace && trace.found && trace.origin.cim_mrid === sel.mrid) && (
                    <button className="trace-btn" disabled={traceBusy} onClick={() => runTrace(sel.mrid)}>{traceBusy ? 'Tracing…' : 'Trace electrical section'}</button>)}
                  {trace && trace.found === false && <div className="trace-note">{trace.reason}</div>}
                  {trace && trace.found && trace.origin.cim_mrid === sel.mrid && (
                    <div className="trace-box">
                      <h4>Section trace</h4>
                      <div className="trace-stat">
                        <div><b>{trace.sectionEquipment.length}</b><span>in section</span></div>
                        <div><b>{trace.boundarySwitches.length}</b><span>boundary switches</span></div>
                      </div>
                      <KV k="Protection ≤ 2 km" v={trace.nearbyProtectionAssets.length ? trace.nearbyProtectionAssets.map((a) => `${a.kind} ${a.name}`).join(', ') : 'none'} />
                      {trace.sectionEquipment.length === 1 && trace.boundarySwitches.length === 0 && (
                        <div className="trace-note">Nothing else shares this device's connectivity node in the source data, so its section is just itself.</div>)}
                      {trace.truncated && <div className="trace-note" style={{ color: '#b91c1c', fontWeight: 600 }}>Safety limit reached — the real section may be larger than shown.</div>}
                      <div className="trace-note">{trace.caveat}</div>
                      <button className="trace-btn ghost" onClick={() => setTrace(null)}>Clear trace</button>
                    </div>)}
                </>}
                {sel.kind === 'crew' && <><span className="chip chip-soft">Field crew</span><KV k="Lead" v={sel.lead} /><KV k="Status" v={sel.status ? sel.status.replace('_', ' ') : ''} /><KV k="Location" v={sel.location} /><KV k="Skills" v={sel.skills} /></>}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function KV({ k, v, mono }) { return <div className="kv-row"><span className="k">{k}</span><span className={`v ${mono ? 'mono' : ''}`}>{v || '—'}</span></div>; }

function Sym({ shape, color }) {
  if (shape === 'line') return <span className="lg-sym lg-line" style={{ background: color }} />;
  if (shape === 'dia') return <span className="lg-sym lg-dia" style={{ background: color }} />;
  if (shape === 'sq') return <span className="lg-sym lg-sq" style={{ background: color }} />;
  if (shape === 'tri') return <span className="lg-sym lg-tri" style={{ borderBottomColor: color }} />;
  return <span className="lg-sym lg-dot" style={{ background: color }} />;
}
