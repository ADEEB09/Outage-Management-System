// src/components/NativeMapSpike.js
// SPIKE (branch spike/native-vector-map): the new native vector map
// (@maplibre/maplibre-react-native), tried out next to the old Map tab, which
// stays as it is until we swap them. It carries everything the old map does,
// plus the whole field picture:
//   - this crew's jobs as labelled pins (colour = severity)
//   - ALL open incidents (dots by severity) and ALL other crews (badges), from
//     the OMS every 15 s; the last copy is kept on the phone for no signal
//   - the crew as a live arrow that turns with the direction of travel, and a
//     camera that keeps following until the crew pans away
//   - Uber-style navigation to a job or incident: road route (server online,
//     phone's road graph offline), tilted camera on the arrow, the route
//     trimmed behind the crew, "x km · y min" counting down, arrival banner,
//     re-route when off the route
//   - Google Maps turn-by-turn and "Route all jobs", like the old map
//   - offline: the new map's own pack (download / resume / delete) and the
//     road directions download the old map uses
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import { Camera, GeoJSONSource, Layer, Map, Marker, NativeUserLocation, OfflineManager } from '@maplibre/maplibre-react-native';
import { mapApiBase, mapServerHeaders } from '../lib/mapServer';
import { startMapAuth, stopMapAuth, syncMapAuthHeader } from '../lib/offlineMap/nativeMapAuth';
import { getInstalledPack, downloadPack, cancelPackDownload, getPackStatus, subscribePackStatus } from '../lib/offlineMap/areaStore';
import { getRoadRoute, formatDistance, formatDuration } from '../lib/roadRouting';
import { isOnlineState } from '../lib/offlineNavigation';
import { navigateTo } from '../lib/navigate';
import { openMultiJobRoute } from '../lib/routing';

const PACK_NAME = 'spike-region';
const FLEET_CACHE_KEY = 'oms-newmap-fleet';
const FLEET_REFRESH_MS = 15000;
const DEHRADUN = [77.92, 30.22, 78.13, 30.42]; // used when the server has no region for this crew
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

const SEVERITY_COLORS = { Critical: '#d7382a', High: '#e08a1e', Medium: '#2f6fd6', Low: '#2a9d5c' };
const CREW_STATUS_COLORS = { available: '#2a9d5c', in_transit: '#2f6fd6', in_service: '#e08a1e', on_break: '#7c8da3' };
const DONE_JOB = ['work finished', 'work complete', 'completed', 'closed'];
const DONE_INCIDENT = ['resolved', 'closed', 'cancelled'];
const OFF_ROUTE_M = 50; // further than this from the route: ask for a new one
const REROUTE_GAP_MS = 10000;
const ARRIVED_M = 30;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const hasPoint = (p) => finite(p?.lat) && finite(p?.lon);
const severityName = (s) => {
  const v = String(s || 'medium').toLowerCase();
  return v.charAt(0).toUpperCase() + v.slice(1);
};
const shortCrew = (name) => String(name || '').replace(/^Crew\s+/i, '');

function timeAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

// Metres between two { lat, lon } points; flat-earth is plenty at street scale.
function meters(a, b) {
  const k = 111320;
  const dx = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const dy = (b.lat - a.lat) * k;
  return Math.hypot(dx, dy);
}

// Where the crew is along the route: the nearest point on it, how far off it
// they are, how much road is left, and the part still ahead (for drawing).
function progressOnRoute(coords, here) {
  if (!coords?.length || !hasPoint(here)) return null;
  const pts = coords.map(([lat, lon]) => ({ lat, lon }));
  let best = { off: Infinity, seg: 0, point: pts[0] };
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const kx = Math.cos(a.lat * (Math.PI / 180));
    const abx = (b.lon - a.lon) * kx;
    const aby = b.lat - a.lat;
    const len2 = abx * abx + aby * aby;
    const t = len2 ? Math.max(0, Math.min(1, (((here.lon - a.lon) * kx) * abx + (here.lat - a.lat) * aby) / len2)) : 0;
    const point = { lat: a.lat + aby * t, lon: a.lon + (b.lon - a.lon) * t };
    const off = meters(here, point);
    if (off < best.off) best = { off, seg: i, point };
  }
  let left = meters(best.point, pts[best.seg + 1] || best.point);
  for (let i = best.seg + 1; i < pts.length - 1; i += 1) left += meters(pts[i], pts[i + 1]);
  const ahead = [best.point, ...pts.slice(best.seg + 1)].map((p) => [p.lon, p.lat]);
  return { off: best.off, left, ahead };
}

const line = (lngLats) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: lngLats } });

// Every crew and open incident in the OMS (any signed-in crew may read them).
async function fetchFleet() {
  const headers = await mapServerHeaders();
  if (!headers) throw new Error('not signed in');
  const get = async (path) => {
    const response = await fetch(`${mapApiBase()}${path}`, { headers });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
  };
  const [crews, incidents] = await Promise.all([get('/crews'), get('/incidents')]);
  return { crews: Array.isArray(crews) ? crews : [], incidents: Array.isArray(incidents) ? incidents : [], at: Date.now() };
}

export default function NativeMapSpike({ jobs = [], crew = null, initialJobId = null, onClose }) {
  const [authed, setAuthed] = useState(null);
  const [region, setRegion] = useState({ id: 'dehradun', bbox: DEHRADUN });
  const [mapState, setMapState] = useState('loading');
  const [pack, setPack] = useState(null);
  const [fps, setFps] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const frames = useRef(0);
  const styleUrl = `${mapApiBase()}/map/style.json`;
  const cameraRef = useRef(null);

  const [here, setHere] = useState(null);
  const [online, setOnline] = useState(true);
  const [oldPack, setOldPack] = useState(null);
  const [oldPackStatus, setOldPackStatus] = useState(getPackStatus);
  const [fleet, setFleet] = useState({ crews: [], incidents: [], at: null });
  const [fleetError, setFleetError] = useState(null);
  const [show, setShow] = useState({ jobs: true, incidents: true, crews: true });
  // What is selected: { kind: 'job' | 'incident' | 'crew', id }
  const [selected, setSelected] = useState(initialJobId ? { kind: 'job', id: initialJobId } : null);
  const [navigating, setNavigating] = useState(Boolean(initialJobId));
  const [follow, setFollow] = useState(Boolean(initialJobId));
  const [route, setRoute] = useState(null);
  const [routingAll, setRoutingAll] = useState(false);
  const routeReq = useRef({ key: null, at: 0, seq: 0 });
  const roadsUri = oldPack?.roadsUri || null;

  // ---- data on the map ------------------------------------------------------------------------

  const myJobs = useMemo(
    () => jobs.filter((job) => hasPoint(job.coordinates) && !DONE_JOB.includes(String(job.status).toLowerCase())),
    [jobs]
  );
  const myIncidentIds = useMemo(() => new Set(jobs.map((job) => job.incidentId).filter(Boolean)), [jobs]);
  const openIncidents = useMemo(
    () => fleet.incidents.filter((inc) =>
      finite(inc.lat) && finite(inc.lon)
      && !DONE_INCIDENT.includes(String(inc.status).toLowerCase())
      && !myIncidentIds.has(inc.id)), // already shown as this crew's job pin
    [fleet.incidents, myIncidentIds]
  );
  const otherCrews = useMemo(
    () => fleet.crews.filter((c) => finite(c.lat) && finite(c.lon) && c.id !== crew?.id),
    [fleet.crews, crew?.id]
  );

  const incidentShapes = useMemo(() => ({
    type: 'FeatureCollection',
    features: openIncidents.map((inc) => ({
      type: 'Feature',
      properties: { id: inc.id, severity: severityName(inc.severity), selected: selected?.kind === 'incident' && selected.id === inc.id },
      geometry: { type: 'Point', coordinates: [inc.lon, inc.lat] },
    })),
  }), [openIncidents, selected]);

  // The selected thing as one shape: { kind, id, title, lines[], lat, lon, address, routable }
  const target = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'job') {
      const job = jobs.find((j) => j.id === selected.id);
      if (!job) return null;
      return {
        kind: 'job', id: job.id, title: `${job.id} · ${job.title}`, address: job.address,
        lines: [job.address, `${job.severity || 'Medium'} · ${job.status}${job.customers ? ` · ${job.customers} customers` : ''}`],
        ...(hasPoint(job.coordinates) ? job.coordinates : {}), routable: hasPoint(job.coordinates),
      };
    }
    if (selected.kind === 'incident') {
      const inc = fleet.incidents.find((i) => i.id === selected.id);
      if (!inc) return null;
      const assigned = fleet.crews.find((c) => c.id === inc.crew_id);
      return {
        kind: 'incident', id: inc.id, title: `${inc.id} · ${inc.type || 'Incident'}`,
        address: [inc.zone, inc.substation].filter(Boolean).join(', '),
        lines: [
          [inc.zone, inc.feeder].filter(Boolean).join(' · ') || 'No zone',
          `${severityName(inc.severity)} · ${inc.status} · ${inc.customers || 0} customers`,
          assigned ? `Crew: ${assigned.name}` : 'No crew assigned',
        ],
        lat: inc.lat, lon: inc.lon, routable: true, color: SEVERITY_COLORS[severityName(inc.severity)] || SEVERITY_COLORS.Medium,
      };
    }
    const c = fleet.crews.find((x) => x.id === selected.id);
    if (!c) return null;
    return {
      kind: 'crew', id: c.id, title: `${c.name} (${c.id})`,
      lines: [`${String(c.status || '').replace(/_/g, ' ')}${c.job_id ? ` · job ${c.job_id}` : ''}`, `Position ${timeAgo(c.location_updated_at)}${c.tracking_state === 'off' ? ' · tracking off' : ''}`],
      lat: c.lat, lon: c.lon, routable: false,
    };
  }, [selected, jobs, fleet]);
  const site = target?.routable && hasPoint(target) ? { lat: target.lat, lon: target.lon } : null;

  // ---- effects --------------------------------------------------------------------------------

  // Header first, then the map: the style request itself needs the token.
  useEffect(() => {
    startMapAuth().then(setAuthed).catch(() => setAuthed(false));
    return () => stopMapAuth();
  }, []);

  // The region the OMS assigns to this crew (same route areaStore.js uses).
  useEffect(() => {
    (async () => {
      const headers = await mapServerHeaders();
      if (!headers) return;
      const response = await fetch(`${mapApiBase()}/map/my-region`, { headers });
      const body = response.ok ? await response.json() : null;
      if (body?.region?.bbox?.length === 4) setRegion({ id: body.region.id, bbox: body.region.bbox });
    })().catch(() => {});
  }, []);

  // The old map's offline pack: its road graph routes with no signal.
  useEffect(() => {
    getInstalledPack().then(setOldPack).catch(() => {});
    let lastPhase = getPackStatus().phase;
    return subscribePackStatus((next) => {
      setOldPackStatus(next);
      if (next.phase !== lastPhase) getInstalledPack().then(setOldPack).catch(() => {});
      lastPhase = next.phase;
    });
  }, []);

  useEffect(() => {
    Network.getNetworkStateAsync().then((s) => setOnline(isOnlineState(s))).catch(() => {});
    const subscription = Network.addNetworkStateListener((s) => setOnline(isOnlineState(s)));
    return () => subscription.remove();
  }, []);

  // All crews and incidents: the last copy first (works offline), then live.
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(FLEET_CACHE_KEY)
      .then((raw) => {
        const cached = raw ? JSON.parse(raw) : null;
        if (alive && cached?.at) setFleet((cur) => (cur.at ? cur : cached));
      })
      .catch(() => {});
    const load = () => fetchFleet()
      .then((next) => {
        if (!alive) return;
        setFleet(next);
        setFleetError(null);
        AsyncStorage.setItem(FLEET_CACHE_KEY, JSON.stringify(next)).catch(() => {});
      })
      .catch((err) => alive && setFleetError(err.message));
    load();
    const timer = setInterval(load, FLEET_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Live position for the route maths (the arrow itself is drawn natively).
  useEffect(() => {
    let sub = null;
    let cancelled = false;
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => {
        if (cancelled || status !== 'granted') return null;
        return Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 3 },
          (pos) => setHere({ lat: pos.coords.latitude, lon: pos.coords.longitude })
        );
      })
      .then((subscription) => {
        if (cancelled) subscription?.remove();
        else sub = subscription;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setFps(frames.current);
      frames.current = 0;
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const progress = useMemo(() => progressOnRoute(route?.coords, here), [route, here]);

  // Route to the selected job/incident; asked again when the target, signal or
  // road graph changes, or when the crew has left the route.
  const targetKey = site ? `${target.kind}:${target.id}` : null;
  useEffect(() => {
    const req = routeReq.current;
    if (!site) {
      req.key = null;
      setRoute(null);
      return;
    }
    if (!hasPoint(here)) return;
    const key = `${targetKey}|${online}|${roadsUri || ''}`;
    const offRoute = progress && progress.off > OFF_ROUTE_M;
    if (key === req.key && !(offRoute && Date.now() - req.at > REROUTE_GAP_MS)) return;
    if (key !== req.key) setRoute(null);
    req.key = key;
    req.at = Date.now();
    const seq = ++req.seq;
    getRoadRoute(here, site, { online, roadsUri })
      .then((next) => {
        if (seq === routeReq.current.seq) setRoute(next);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, site?.lat, site?.lon, here, online, roadsUri]);

  const fitPoints = useCallback((pts, bottom = 230) => {
    const good = pts.filter(hasPoint);
    if (!good.length) return;
    const lons = good.map((p) => p.lon);
    const lats = good.map((p) => p.lat);
    const pad = 0.002;
    cameraRef.current?.fitBounds(
      [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad],
      { padding: { top: 70, bottom, left: 40, right: 40 }, duration: 800 }
    );
  }, []);

  // Frame crew + target when something is picked (not while navigating: the
  // camera is following the arrow then).
  useEffect(() => {
    if (!target || navigating || !hasPoint(target)) return;
    setFollow(false);
    fitPoints([here, target].filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.kind, selected?.id, navigating, Boolean(here)]);

  // Navigation camera: close in and tilted, then follow the arrow.
  useEffect(() => {
    if (!navigating) return;
    setFollow(true);
    cameraRef.current?.setStop({ zoom: 17, pitch: 55, duration: 800 }).catch(() => {});
  }, [navigating]);

  // ---- actions --------------------------------------------------------------------------------

  const startNavigation = () => site && setNavigating(true);
  const stopNavigation = () => {
    setNavigating(false);
    setFollow(false);
    cameraRef.current?.setStop({ pitch: 0, bearing: 0, duration: 600 }).catch(() => {});
  };
  const recenter = () => {
    setFollow(true);
    if (navigating) cameraRef.current?.setStop({ zoom: 17, pitch: 55, duration: 600 }).catch(() => {});
  };
  const fitAll = () => {
    setFollow(false);
    fitPoints([
      here,
      ...(show.jobs ? myJobs.map((j) => j.coordinates) : []),
      ...(show.incidents ? openIncidents : []),
      ...(show.crews ? otherCrews : []),
    ].filter(Boolean), 120);
  };
  const routeAllJobs = async () => {
    setRoutingAll(true);
    try {
      await openMultiJobRoute(myJobs);
    } finally {
      setRoutingAll(false);
    }
  };
  const select = (next) => {
    if (navigating) return; // stay on the job being navigated to
    setSelected(next);
  };

  // ---- the new map's own offline pack ---------------------------------------------------------

  const showStatus = (status) =>
    setPack({ state: status.state, percent: Math.round(status.percentage), bytes: status.completedResourceSize, tiles: status.completedTileCount, resources: `${status.completedResourceCount}/${status.requiredResourceCount}` });

  const refreshPack = useCallback(async () => {
    const existing = (await OfflineManager.getPacks()).find((p) => p.metadata?.name === PACK_NAME);
    if (existing) showStatus(await existing.status());
    else setPack(null);
    return existing;
  }, []);

  useEffect(() => {
    refreshPack().catch(() => {});
  }, [refreshPack]);

  const download = async () => {
    await syncMapAuthHeader();
    const existing = await refreshPack();
    if (existing) {
      // Resume an interrupted download (native keeps what it already has).
      await OfflineManager.addListener(existing.id, (_, s) => showStatus(s), (_, e) => setPack((p) => ({ ...p, error: e.message })));
      await existing.resume();
      return;
    }
    await OfflineManager.createPack(
      { mapStyle: styleUrl, bounds: region.bbox, minZoom: 8, maxZoom: 14, metadata: { name: PACK_NAME, region: region.id } },
      (_, status) => showStatus(status),
      (_, error) => setPack((p) => ({ ...p, error: error.message })),
    );
  };

  const remove = async () => {
    const existing = await refreshPack();
    if (existing) await OfflineManager.deletePack(existing.id);
    setPack(null);
  };

  // ---- derived for display --------------------------------------------------------------------

  const routeLine = site && progress ? line(progress.ahead) : null;
  const straightLine = !routeLine && site && hasPoint(here) ? line([[here.lon, here.lat], [site.lon, site.lat]]) : null;
  const straight = site && hasPoint(here) ? meters(here, site) : null;
  const left = progress ? progress.left : null;
  const arrived = Boolean(site) && ((finite(left) && left < ARRIVED_M) || (finite(straight) && straight < ARRIVED_M + 10));
  const eta = route && finite(left) && route.meters > 0 ? (route.seconds * left) / route.meters : null;
  const oldDownloading = oldPackStatus.phase === 'downloading' || oldPackStatus.phase === 'checking';

  const distanceLine = (() => {
    if (!site) return null;
    if (arrived) return 'You have reached the site';
    if (route && finite(left)) return `${formatDistance(left)} to go · about ${formatDuration(eta ?? route.seconds)}${route.source === 'device' ? ' · offline directions' : ''}`;
    if (finite(straight)) return `${formatDistance(straight)} away (straight line${!online && !roadsUri ? ' — download road directions for a road route' : ''})`;
    return 'Waiting for GPS…';
  })();

  const [w, s, e, n] = region.bbox;
  return (
    // Inside the safe area so nothing sits under the status bar or the
    // phone's navigation buttons.
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.bar}>
        <Text style={styles.title}>{navigating ? 'Navigating to site' : 'Outage map (new)'}</Text>
        <View style={styles.row}>
          <Text style={[styles.badge, online ? styles.badgeOn : styles.badgeOff]}>{online ? 'Online' : 'Offline'}</Text>
          <Pressable onPress={onClose} style={styles.btn}><Text style={styles.btnText}>Close</Text></Pressable>
        </View>
      </View>

      {!navigating ? (
        <View style={styles.chips}>
          {[
            ['jobs', `My jobs ${myJobs.length}`],
            ['incidents', `Incidents ${openIncidents.length}`],
            ['crews', `Crews ${otherCrews.length}`],
          ].map(([key, label]) => (
            <Pressable key={key} onPress={() => setShow((cur) => ({ ...cur, [key]: !cur[key] }))} style={[styles.chip, show[key] && styles.chipOn]}>
              <Text style={[styles.chipText, show[key] && styles.chipTextOn]}>{label}</Text>
            </Pressable>
          ))}
          <Text style={styles.chipNote}>{fleet.at ? `updated ${timeAgo(fleet.at)}` : fleetError ? 'not loaded' : 'loading…'}</Text>
        </View>
      ) : null}

      <View style={styles.mapWrap}>
        {authed === null ? (
          <View style={[styles.map, styles.center]}><Text>Signing map requests...</Text></View>
        ) : (
          <Map
            style={styles.map}
            mapStyle={styleUrl}
            attribution
            logo={false}
            onDidFinishLoadingMap={() => setMapState('loaded')}
            onDidFailLoadingMap={() => setMapState('FAILED (check backend log for 401 / map server)')}
            onDidFinishRenderingFrame={() => { frames.current += 1; }}
          >
            <Camera
              ref={cameraRef}
              initialViewState={{ bounds: [w, s, e, n] }}
              trackUserLocation={follow ? (navigating ? 'course' : 'default') : undefined}
              onTrackUserLocationChange={(event) => {
                if (!event.nativeEvent.trackUserLocation) setFollow(false); // the crew panned the map
              }}
            />

            {routeLine ? (
              <GeoJSONSource id="route" data={routeLine}>
                <Layer id="route-casing" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': '#0b3d91', 'line-width': 10 }} />
                <Layer id="route-line" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': '#2f80ed', 'line-width': 6 }} />
              </GeoJSONSource>
            ) : null}
            {straightLine ? (
              <GeoJSONSource id="straight" data={straightLine}>
                <Layer id="straight-line" type="line" paint={{ 'line-color': '#173355', 'line-width': 3, 'line-dasharray': [2, 2] }} />
              </GeoJSONSource>
            ) : null}

            {/* All open incidents: dots by severity, tap for details. */}
            {show.incidents && !navigating ? (
              <GeoJSONSource
                id="incidents"
                data={incidentShapes}
                onPress={(event) => {
                  const id = event.nativeEvent.features?.[0]?.properties?.id;
                  if (id) select({ kind: 'incident', id });
                }}
              >
                <Layer
                  id="incident-dots"
                  type="circle"
                  paint={{
                    'circle-radius': ['case', ['get', 'selected'], 10, 6],
                    'circle-color': ['match', ['get', 'severity'], 'Critical', SEVERITY_COLORS.Critical, 'High', SEVERITY_COLORS.High, 'Low', SEVERITY_COLORS.Low, SEVERITY_COLORS.Medium],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                  }}
                />
              </GeoJSONSource>
            ) : null}

            {/* Other crews: name badges coloured by status. */}
            {show.crews && !navigating ? otherCrews.map((c) => (
              <Marker key={c.id} id={`crew-${c.id}`} lngLat={[c.lon, c.lat]} anchor="center" onPress={() => select({ kind: 'crew', id: c.id })}>
                <View style={[styles.crewBadge, selected?.kind === 'crew' && selected.id === c.id && styles.crewBadgeSelected]}>
                  <View style={[styles.crewDot, { backgroundColor: CREW_STATUS_COLORS[c.status] || '#7c8da3' }]} />
                  <Text style={styles.crewText}>{shortCrew(c.name)}</Text>
                </View>
              </Marker>
            )) : null}

            {/* This crew's jobs: labelled pins (only the target while navigating). */}
            {(show.jobs || navigating ? myJobs : [])
              .filter((job) => !navigating || (selected?.kind === 'job' && job.id === selected.id))
              .map((job) => {
                const isSel = selected?.kind === 'job' && job.id === selected.id;
                const color = SEVERITY_COLORS[job.severity] || SEVERITY_COLORS.Medium;
                return (
                  <Marker key={job.id} id={`job-${job.id}`} lngLat={[job.coordinates.lon, job.coordinates.lat]} anchor="bottom" onPress={() => select({ kind: 'job', id: job.id })}>
                    <View style={styles.pinWrap}>
                      <View style={[styles.pinLabel, isSel && { backgroundColor: color }]}>
                        <Text style={[styles.pinText, isSel && { color: '#fff' }]}>{job.id}</Text>
                      </View>
                      <View style={[styles.pin, { backgroundColor: color }, isSel && styles.pinSelected]} />
                    </View>
                  </Marker>
                );
              })}

            {/* An incident being navigated to keeps a marker of its own. */}
            {navigating && target?.kind === 'incident' && site ? (
              <Marker id="nav-incident" lngLat={[site.lon, site.lat]} anchor="center">
                <View style={[styles.pin, styles.pinSelected, { backgroundColor: target.color }]} />
              </Marker>
            ) : null}

            {/* This crew: a blue arrow that turns with the direction of travel. */}
            <NativeUserLocation mode="course" />
          </Map>
        )}

        {navigating && site ? (
          <View style={[styles.navCard, arrived && styles.navCardArrived]}>
            <Text style={styles.navBig}>
              {arrived
                ? 'You have reached the site'
                : `${finite(left) ? formatDistance(left) : finite(straight) ? formatDistance(straight) : '…'}${finite(eta) ? ` · ${formatDuration(eta)}` : ''}`}
            </Text>
            <Text style={styles.navSmall} numberOfLines={1}>{target.title}</Text>
            <Text style={styles.navSmall}>
              {route ? (route.source === 'device' ? 'Road route (offline directions)' : 'Road route') : hasPoint(here) ? 'Straight line: no road route yet' : 'Waiting for GPS…'}
              {!online ? ' · no internet, map still works' : ''}
            </Text>
          </View>
        ) : null}

        <View style={styles.fabs}>
          {!follow && authed !== null ? (
            <Pressable style={styles.fab} onPress={recenter}>
              <Text style={styles.fabText}>{navigating ? 'Re-centre' : 'Centre on me'}</Text>
            </Pressable>
          ) : null}
          {!navigating ? (
            <Pressable style={styles.fab} onPress={fitAll}><Text style={styles.fabText}>Fit all</Text></Pressable>
          ) : null}
        </View>
      </View>

      {!navigating ? (
        <Text style={styles.legend}>
          ▲ You  ● My jobs  • Incidents (by severity)  ▭ Crews{route ? '  ━ Road route' : straightLine ? '  - - Straight line' : ''}
        </Text>
      ) : null}

      {target && !navigating ? (
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle} numberOfLines={1}>{target.title}</Text>
          {target.lines.filter(Boolean).map((text) => (
            <Text key={text} style={styles.sheetLine} numberOfLines={1}>{text}</Text>
          ))}
          {distanceLine ? <Text style={[styles.sheetLine, styles.sheetStrong, arrived && styles.arrivedText]}>{distanceLine}</Text> : null}
          {!online && site ? (
            <Text style={styles.offlineNote}>
              No internet: follow the map. {route ? 'The blue line is the road route.' : 'The dashed line points to the site.'} Your position keeps updating without signal.
            </Text>
          ) : null}
          <View style={styles.row}>
            {site ? (
              <Pressable style={[styles.btn, styles.btnWide]} onPress={startNavigation}>
                <Text style={styles.btnText}>Start navigation</Text>
              </Pressable>
            ) : null}
            {site ? (
              <Pressable style={[styles.btn, styles.btnLight]} onPress={() => navigateTo(target.address, site)}>
                <Text style={styles.btnLightText}>Google Maps</Text>
              </Pressable>
            ) : null}
            <Pressable style={[styles.btn, styles.btnLight]} onPress={() => setSelected(null)}>
              <Text style={styles.btnLightText}>Clear</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {navigating ? (
        <View style={styles.sheet}>
          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.btnStop, styles.btnWide]} onPress={stopNavigation}>
              <Text style={styles.btnText}>End navigation</Text>
            </Pressable>
            {site ? (
              <Pressable style={[styles.btn, styles.btnLight]} onPress={() => navigateTo(target.address, site)}>
                <Text style={styles.btnLightText}>{online ? 'Google Maps' : 'Try Google Maps'}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {!target && !navigating ? (
        <View style={styles.sheet}>
          <Text style={styles.sheetLine}>Tap a job, incident or crew on the map.</Text>
          {myJobs.length > 1 && online ? (
            <Pressable style={[styles.btn, styles.btnLight, { alignSelf: 'flex-start' }]} disabled={routingAll} onPress={routeAllJobs}>
              <Text style={styles.btnLightText}>{routingAll ? 'Opening route…' : `Route all ${myJobs.length} jobs (Google Maps)`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Pressable onPress={() => setPanelOpen((v) => !v)} style={styles.panelToggle}>
        <Text style={styles.panelToggleText}>
          Offline map {pack ? `· ${pack.state} ${pack.percent}%` : '· not downloaded'} · road directions {roadsUri ? 'ready' : 'not downloaded'} {panelOpen ? '▲' : '▼'}
        </Text>
      </Pressable>
      {panelOpen ? (
        <ScrollView style={styles.panel} contentContainerStyle={styles.info}>
          <Text style={styles.line}>
            {hasPoint(here) ? `Your position ${here.lat.toFixed(4)}, ${here.lon.toFixed(4)}` : 'Waiting for GPS fix…'}
          </Text>
          <Text style={styles.line}>
            Pack: {pack ? `${pack.state} ${pack.percent}% · ${mb(pack.bytes)} · ${pack.tiles} tiles · ${pack.resources} resources` : 'none'} (region {region.id}, z8-14)
          </Text>
          {pack?.error ? <Text style={[styles.line, styles.err]}>Pack error: {pack.error}</Text> : null}
          <View style={styles.row}>
            <Pressable onPress={() => download().catch((err) => setPack((p) => ({ ...p, error: err.message })))} style={styles.btn}>
              <Text style={styles.btnText}>{pack && pack.state !== 'complete' ? 'Resume pack' : 'Download pack'}</Text>
            </Pressable>
            <Pressable onPress={() => remove().catch(() => {})} style={styles.btn}><Text style={styles.btnText}>Delete pack</Text></Pressable>
          </View>
          <Text style={styles.line}>
            Road directions offline: {roadsUri ? 'ready' : oldDownloading ? `downloading ${oldPackStatus.total ? Math.floor((oldPackStatus.done / oldPackStatus.total) * 100) : 0}%` : oldPackStatus.phase === 'error' ? oldPackStatus.error : 'not downloaded'}
          </Text>
          {!roadsUri ? (
            <View style={styles.row}>
              {oldDownloading ? (
                <Pressable onPress={cancelPackDownload} style={styles.btn}><Text style={styles.btnText}>Pause</Text></Pressable>
              ) : (
                <Pressable onPress={() => downloadPack().catch(() => {})} style={styles.btn}>
                  <Text style={styles.btnText}>Download road directions</Text>
                </Pressable>
              )}
            </View>
          ) : null}
          <Text style={styles.line}>Map: {mapState} · {fps} fps · auth {authed === null ? '...' : authed ? 'set' : 'NO TOKEN (sign in again)'}</Text>
          <Text style={styles.line}>Crews/incidents: {fleet.at ? `as of ${timeAgo(fleet.at)}` : 'not loaded'}{fleetError && fleet.at ? ' (showing the last copy)' : ''}</Text>
          <Text style={styles.hint}>Offline test: download the pack, turn on airplane mode, close and reopen this screen. Labels, jobs, incidents and crews (last copy) must still show.</Text>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 6 },
  title: { fontSize: 16, fontWeight: '700', color: '#173355' },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingBottom: 6, flexWrap: 'wrap' },
  chip: { borderRadius: 14, borderWidth: 1, borderColor: '#d5deea', paddingHorizontal: 9, paddingVertical: 4 },
  chipOn: { backgroundColor: '#173355', borderColor: '#173355' },
  chipText: { fontSize: 12, fontWeight: '600', color: '#173355' },
  chipTextOn: { color: '#fff' },
  chipNote: { fontSize: 11, color: '#7c8da3' },
  mapWrap: { flex: 1 },
  map: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  badge: { fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, overflow: 'hidden' },
  badgeOn: { backgroundColor: '#e3f4ea', color: '#2a9d5c' },
  badgeOff: { backgroundColor: '#fde8e6', color: '#d7382a' },
  pinWrap: { alignItems: 'center' },
  pinLabel: { backgroundColor: '#fff', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2, marginBottom: 2, borderWidth: 1, borderColor: '#d5deea' },
  pinText: { fontSize: 10, fontWeight: '700', color: '#173355' },
  pin: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: '#fff' },
  pinSelected: { width: 22, height: 22, borderRadius: 11 },
  crewBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#173355', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 3, borderWidth: 2, borderColor: '#fff' },
  crewBadgeSelected: { borderColor: '#2f80ed' },
  crewDot: { width: 8, height: 8, borderRadius: 4 },
  crewText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  navCard: { position: 'absolute', top: 8, left: 8, right: 8, backgroundColor: '#173355', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, gap: 1 },
  navCardArrived: { backgroundColor: '#2a9d5c' },
  navBig: { color: '#fff', fontSize: 19, fontWeight: '800' },
  navSmall: { color: '#c9d6e6', fontSize: 12 },
  fabs: { position: 'absolute', right: 10, bottom: 10, gap: 8, alignItems: 'flex-end' },
  fab: { backgroundColor: '#fff', borderRadius: 22, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#d5deea' },
  fabText: { color: '#173355', fontWeight: '700', fontSize: 13 },
  legend: { fontSize: 11, color: '#7c8da3', paddingHorizontal: 10, paddingTop: 4 },
  sheet: { paddingHorizontal: 10, paddingVertical: 8, gap: 2, borderTopWidth: 1, borderTopColor: '#e6ecf3' },
  sheetTitle: { fontSize: 14, fontWeight: '700', color: '#173355' },
  sheetLine: { fontSize: 12, color: '#33465f' },
  sheetStrong: { fontWeight: '700', color: '#173355' },
  arrivedText: { color: '#2a9d5c' },
  offlineNote: { fontSize: 11, color: '#8a5a00', backgroundColor: '#fff7ea', borderRadius: 6, padding: 6, marginTop: 2 },
  panelToggle: { paddingHorizontal: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: '#e6ecf3' },
  panelToggleText: { fontSize: 12, fontWeight: '600', color: '#173355' },
  panel: { maxHeight: 220 },
  info: { paddingHorizontal: 10, paddingBottom: 8, gap: 2 },
  line: { fontSize: 12, color: '#173355' },
  err: { color: '#b91c1c' },
  hint: { fontSize: 11, color: '#7c8da3', marginTop: 4 },
  row: { flexDirection: 'row', gap: 8, marginTop: 4, alignItems: 'center' },
  btn: { backgroundColor: '#173355', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  btnWide: { flex: 1, alignItems: 'center' },
  btnStop: { backgroundColor: '#d7382a' },
  btnLight: { backgroundColor: '#eef2f7' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnLightText: { color: '#173355', fontWeight: '600', fontSize: 13 },
});
