// src/lib/offlineMap/mapPage.js
// The Leaflet page rendered inside the crew app's WebView. It is written to
// <documents>/offline-map/index.html (next to the tile folders) and loaded
// as a file:// URL, so tile images load straight from disk.
//
// Everything is inline — Leaflet included — and a strict CSP forbids any
// network request, so the map behaves identically with or without signal
// and can't be turned into a way to load remote content.
//
// The React Native side drives it with `window.OMS.update(state)` /
// `window.OMS.fit(kind)` via injectJavaScript, and the page reports marker
// taps back with postMessage.
import { File } from "expo-file-system";
import { LEAFLET_CSS, LEAFLET_JS } from "./leafletBundle";
import { mapRoot } from "./tileStore";

const PAGE_SCRIPT = `
(function () {
  window.onerror = function (msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: String(msg) }));
  };
  var DEFAULT_CENTER = [30.3165, 78.0322]; // Dehradun
  var map = L.map('map', { zoomControl: true, preferCanvas: true, minZoom: 6, maxZoom: 18, worldCopyJump: false })
    .setView(DEFAULT_CENTER, 11);
  map.attributionControl.setPrefix('Leaflet');
  // The WebView is often laid out after the page starts, so the map is first
  // measured at the wrong size and leaves an unfilled grey band. Re-measure
  // whenever the container actually changes size.
  if (window.ResizeObserver) {
    new ResizeObserver(function () { map.invalidateSize({ pan: false }); }).observe(map.getContainer());
  }

  var tileLayer = null, tileUrl = null, attribution = null;
  var jobLayer = L.layerGroup().addTo(map);
  var crewMarker = null, crewAccuracy = null;
  var guideLine = null; // dashed straight line from the crew to the selected job
  // Road route to the selected job, drawn under the markers in its own pane.
  map.createPane('route').style.zIndex = 350;
  var routeRenderer = L.canvas({ pane: 'route' });
  var routeCasing = null, routeLine = null, routeKey = null;
  var state = { pack: null, crew: null, jobs: [], route: null };
  var hasFramed = false;

  function post(msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function textNode(text) {
    var el = document.createElement('span');
    el.textContent = String(text == null ? '' : text);
    return el;
  }
  function finite(n) { return typeof n === 'number' && isFinite(n); }
  function packBounds(p) {
    var b = p && p.bounds;
    return b && b.length === 4 ? L.latLngBounds([b[1], b[0]], [b[3], b[2]]) : null;
  }

  // The pack only has street-level zooms inside the city regions; the
  // corridor between them stops at a lower zoom. A plain tile layer leaves
  // those areas blank, so a missing tile is drawn from the nearest ancestor
  // tile on disk instead, scaled up and cropped to this tile's quarter.
  var OfflineTiles = L.GridLayer.extend({
    initialize: function (url, options) {
      this._url = url;
      this._missing = {};
      L.GridLayer.prototype.initialize.call(this, options);
    },
    _src: function (z, x, y) {
      return this._url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    },
    createTile: function (coords, done) {
      var self = this, size = this.getTileSize(), minZ = this.options.minNativeZoom;
      var tile = document.createElement('div');
      tile.style.overflow = 'hidden';
      var img = document.createElement('img');
      img.alt = '';
      img.setAttribute('role', 'presentation');
      img.style.cssText = 'position:absolute;max-width:none;max-height:none;';
      tile.appendChild(img);
      var dz = 0, key = null;
      function attempt() {
        for (; coords.z - dz >= minZ; dz++) {
          key = (coords.z - dz) + '/' + (coords.x >> dz) + '/' + (coords.y >> dz);
          if (!self._missing[key]) break;
        }
        if (coords.z - dz < minZ) {
          if (!self._errorReported) { // one report is enough to diagnose
            self._errorReported = true;
            post({ type: 'tileerror', message: self._src(coords.z, coords.x, coords.y) });
          }
          return done(new Error('no tile'), tile);
        }
        var s = 1 << dz;
        img.style.width = size.x * s + 'px';
        img.style.height = size.y * s + 'px';
        img.style.left = -(coords.x - ((coords.x >> dz) << dz)) * size.x + 'px';
        img.style.top = -(coords.y - ((coords.y >> dz) << dz)) * size.y + 'px';
        img.src = self._src(coords.z - dz, coords.x >> dz, coords.y >> dz);
      }
      img.onload = function () { done(null, tile); };
      img.onerror = function () { self._missing[key] = true; dz++; attempt(); };
      attempt();
      return tile;
    }
  });

  function applyPack(p) {
    var url = p && p.tileUrl;
    if (url === tileUrl) return;
    if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
    if (attribution) { map.attributionControl.removeAttribution(attribution); attribution = null; }
    tileUrl = url || null;
    if (!url) return;
    var minNative = finite(p.minZoom) ? p.minZoom : 8;
    // Nothing exists below the pack's lowest zoom, so don't let the map go there.
    map.setMinZoom(Math.max(6, minNative));
    tileLayer = new OfflineTiles(url, {
      minNativeZoom: minNative,
      maxNativeZoom: finite(p.maxZoom) ? p.maxZoom : 16,
      maxZoom: 18,
      bounds: packBounds(p) || undefined,
      keepBuffer: 2,
      updateWhenIdle: true
    }).addTo(map);
    // addAttribution takes HTML; escape the server-provided text.
    attribution = textNode(p.attribution || '').innerHTML;
    if (attribution) map.attributionControl.addAttribution(attribution);
  }

  // ---- Live crew marker (Uber-style): an arrow that glides from one GPS fix
  // to the next instead of jumping, turned to the direction of travel.
  // "shown" is where it is drawn right now — the route trimming and guide
  // line follow it frame by frame, so they stay glued to the arrow.
  var shown = null, target = null, heading = 0, glide = null, lastFixAt = 0;

  // Distances here are short (one fix to the next, a point to a road
  // segment), so a flat projection around the point is accurate enough.
  function toXY(o, p) {
    return [(p[1] - o[1]) * 111320 * Math.cos(o[0] * Math.PI / 180), (p[0] - o[0]) * 110540];
  }
  function meters(a, b) { var d = toXY(a, b); return Math.sqrt(d[0] * d[0] + d[1] * d[1]); }
  function bearing(a, b) { var d = toXY(a, b); return (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360; }

  function crewIcon() {
    return L.divIcon({
      className: '', iconSize: [32, 32], iconAnchor: [16, 16],
      html: '<div class="crew-arrow"><svg viewBox="0 0 32 32" width="32" height="32">' +
        '<circle cx="16" cy="16" r="14" fill="#ffffff" stroke="#0e9f8e" stroke-width="2"/>' +
        '<path d="M16 5 L24 25 L16 20.5 L8 25 Z" fill="#0e9f8e"/></svg></div>'
    });
  }
  function turnTo(deg) {
    // Turn the short way round (350° → 10° is +20°, not -340°).
    heading += ((deg - heading) % 360 + 540) % 360 - 180;
    var el = crewMarker && crewMarker.getElement() && crewMarker.getElement().firstChild;
    if (el) el.style.transform = 'rotate(' + heading + 'deg)';
  }

  function applyCrew(c) {
    if (!c || !finite(c.lat) || !finite(c.lon)) {
      if (crewMarker) { map.removeLayer(crewMarker); map.removeLayer(crewAccuracy); crewMarker = crewAccuracy = null; }
      shown = target = glide = null;
      return;
    }
    var to = [c.lat, c.lon];
    var radius = finite(c.accuracy) ? Math.min(c.accuracy, 1000) : 0;
    if (!crewMarker) {
      shown = target = to;
      lastFixAt = Date.now();
      crewAccuracy = L.circle(to, { radius: radius, color: '#0e9f8e', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      crewMarker = L.marker(to, { icon: crewIcon(), zIndexOffset: 1000, keyboard: false })
        .bindTooltip(textNode('You'), { direction: 'top', offset: [0, -14] })
        .addTo(map);
      if (finite(c.heading) && c.heading >= 0) turnTo(c.heading);
      return;
    }
    crewAccuracy.setRadius(radius);
    // update() runs for every state change (jobs, route...), not only new fixes.
    if (target && target[0] === to[0] && target[1] === to[1]) return;
    target = to;
    // Prefer the GPS's own heading while really moving; otherwise point along
    // the step just taken (ignoring GPS jitter while standing still).
    if (finite(c.heading) && c.heading >= 0 && finite(c.speed) && c.speed > 1) turnTo(c.heading);
    else if (meters(shown, to) > 3) turnTo(bearing(shown, to));
    // Spread the glide over the time since the previous fix so the arrow is
    // always moving, never parked-then-jumping. A big jump (first fix after a
    // long gap, or a GPS glitch) snaps instead of crawling across the map.
    var now = Date.now();
    var dur = meters(shown, to) > 2000 ? 0 : Math.min(Math.max(now - lastFixAt, 300), 5000);
    lastFixAt = now;
    var startGlide = !glide;
    glide = { from: shown, to: to, t0: performance.now(), dur: dur };
    if (startGlide) requestAnimationFrame(tick);
  }

  function tick(t) {
    if (!glide || !crewMarker) { glide = null; return; }
    var k = glide.dur ? Math.min((t - glide.t0) / glide.dur, 1) : 1;
    var f = glide.from, g = glide.to;
    shown = [f[0] + (g[0] - f[0]) * k, f[1] + (g[1] - f[1]) * k];
    crewMarker.setLatLng(shown);
    crewAccuracy.setLatLng(shown);
    followArrow(k === 1);
    if (k < 1) requestAnimationFrame(tick);
    else glide = null;
  }

  // Every animation frame: trim the route behind the arrow and move the
  // straight guide line's start with it.
  function followArrow(settled) {
    trimRoute(settled);
    applyGuide();
  }

  function applyJobs(jobs) {
    jobLayer.clearLayers();
    (jobs || []).forEach(function (j) {
      if (!finite(j.lat) || !finite(j.lon)) return;
      L.circleMarker([j.lat, j.lon], {
        radius: j.selected ? 13 : 10,
        color: j.selected ? '#173355' : '#ffffff',
        weight: j.selected ? 4 : 2,
        fillColor: j.color || '#d13d2f',
        fillOpacity: 1
      })
        .bindTooltip(textNode(j.title), { direction: 'top', offset: [0, -10] })
        .on('click', function () { post({ type: 'select', id: String(j.id) }); })
        .addTo(jobLayer);
    });
  }

  function selectedJob() {
    return (state.jobs || []).filter(function (j) { return j.selected && finite(j.lat) && finite(j.lon); })[0] || null;
  }

  function routeCoords() {
    var r = state.route;
    return r && r.coords && r.coords.length >= 2 && selectedJob() ? r.coords : null;
  }

  // The part of the route already driven is removed as the crew goes, so
  // the blue line always runs from the arrow to the site — and the distance
  // left along it is reported to the app for the "x km to go" readout.
  var routeFull = null, routeCum = null, routeIdx = 0, lastPosted, lastPostAt = 0;
  var OFF_ROUTE_M = 60; // further than this from the road: show the whole route

  function applyRoute() {
    var coords = routeCoords();
    var key = coords ? coords.length + ':' + coords[0] + ':' + coords[coords.length - 1] : null;
    if (key === routeKey) return;
    routeKey = key;
    if (routeCasing) { map.removeLayer(routeCasing); map.removeLayer(routeLine); routeCasing = routeLine = null; }
    routeFull = routeCum = null;
    routeIdx = 0;
    if (!coords) { postProgress(null, true); return; }
    routeFull = coords;
    routeCum = [0];
    for (var i = 1; i < coords.length; i++) routeCum.push(routeCum[i - 1] + meters(coords[i - 1], coords[i]));
    routeCasing = L.polyline(coords, { renderer: routeRenderer, color: '#ffffff', weight: 9, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map);
    routeLine = L.polyline(coords, { renderer: routeRenderer, color: '#1a73e8', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map);
    trimRoute(true);
  }

  // Nearest point to p on route segments from..to-1.
  function nearestOnRoute(p, from, to) {
    var best = null;
    for (var i = from; i < to; i++) {
      var a = toXY(p, routeFull[i]), b = toXY(p, routeFull[i + 1]);
      var dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      var u = len2 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2)) : 0;
      var x = a[0] + u * dx, y = a[1] + u * dy, off = Math.sqrt(x * x + y * y);
      if (!best || off < best.off) best = { i: i, u: u, off: off };
    }
    return best;
  }

  function trimRoute(settled) {
    if (!routeFull || !routeLine) return;
    if (!shown) { postProgress(null, settled); return; }
    var last = routeFull.length - 1;
    // Look just around where the crew was last (keeps a route that doubles
    // back on itself from snapping ahead); search all of it if that misses.
    var near = nearestOnRoute(shown, Math.max(0, routeIdx - 3), Math.min(last, routeIdx + 300));
    if (!near || near.off > OFF_ROUTE_M) near = nearestOnRoute(shown, 0, last);
    if (!near || near.off > OFF_ROUTE_M) {
      // Mid-glide the arrow moves in a straight line, so it can briefly cut
      // a corner of the road; only judge "off route" once it has settled.
      if (!settled) return;
      // Off the road (or on one the route doesn't use): keep the whole route
      // on screen until the app fetches a fresh one from here.
      routeCasing.setLatLngs(routeFull);
      routeLine.setLatLngs(routeFull);
      postProgress(null, settled);
      return;
    }
    routeIdx = near.i;
    var a = routeFull[near.i], b = routeFull[near.i + 1];
    var pt = [a[0] + (b[0] - a[0]) * near.u, a[1] + (b[1] - a[1]) * near.u];
    var ahead = [pt].concat(routeFull.slice(near.i + 1));
    routeCasing.setLatLngs(ahead);
    routeLine.setLatLngs(ahead);
    var segLen = routeCum[near.i + 1] - routeCum[near.i];
    postProgress(routeCum[last] - routeCum[near.i] - segLen * near.u, settled);
  }

  // At most twice a second while gliding, plus once each time it settles.
  function postProgress(remaining, force) {
    var now = Date.now();
    var r = remaining == null ? null : Math.round(remaining);
    if (r === lastPosted) return;
    if (!force && now - lastPostAt < 500) return;
    lastPosted = r;
    lastPostAt = now;
    post({ type: 'progress', remaining: r });
  }

  // The dashed straight line is only the fallback when there is no road route.
  function applyGuide() {
    var sel = selectedJob();
    if (!shown || !sel || routeCoords()) {
      if (guideLine) { map.removeLayer(guideLine); guideLine = null; }
      return;
    }
    var pts = [shown, [sel.lat, sel.lon]];
    if (guideLine) guideLine.setLatLngs(pts);
    else guideLine = L.polyline(pts, { color: '#173355', weight: 3, opacity: 0.8, dashArray: '8 8', interactive: false }).addTo(map);
  }

  function jobBounds() {
    var pts = (state.jobs || []).filter(function (j) { return finite(j.lat) && finite(j.lon); })
      .map(function (j) { return [j.lat, j.lon]; });
    return pts.length ? L.latLngBounds(pts) : null;
  }

  function fit(kind) {
    var c = state.crew;
    if (kind === 'crew' && c && finite(c.lat)) return map.setView([c.lat, c.lon], Math.max(map.getZoom(), 15));
    var sel = selectedJob();
    if (kind === 'job' && sel) return map.setView([sel.lat, sel.lon], Math.max(map.getZoom(), 15));
    // Frame the whole road route, or both ends of the guide line.
    // Only the road still ahead, so the view closes in as the crew nears the site.
    var rc = routeCoords() && routeLine ? routeLine.getLatLngs() : null;
    if (kind === 'guide' && sel && rc) {
      var rb = L.latLngBounds(rc);
      if (shown) rb.extend(shown);
      return map.fitBounds(rb, { padding: [40, 40], maxZoom: 17 });
    }
    if (kind === 'guide' && sel) {
      if (shown) return map.fitBounds(L.latLngBounds([shown, [sel.lat, sel.lon]]), { padding: [48, 48], maxZoom: 17 });
      return map.setView([sel.lat, sel.lon], Math.max(map.getZoom(), 15));
    }
    var jb = jobBounds();
    if (kind === 'jobs' && jb) {
      if (c && finite(c.lat)) jb.extend([c.lat, c.lon]);
      return map.fitBounds(jb, { padding: [36, 36], maxZoom: 15 });
    }
    var pb = packBounds(state.pack);
    if (pb) map.fitBounds(pb);
  }

  // Tell the app when the crew moves the map themselves (pan or pinch), so
  // it stops auto-following. Programmatic fits never fire these.
  map.on('dragstart', function () { post({ type: 'gesture' }); });
  map.getContainer().addEventListener('touchstart', function (e) {
    if (e.touches && e.touches.length > 1) post({ type: 'gesture' });
  }, { passive: true });

  window.OMS = {
    update: function (next) {
      state = next || state;
      applyPack(state.pack);
      applyJobs(state.jobs);
      applyCrew(state.crew);
      applyRoute();
      applyGuide();
      if (!hasFramed) {
        var c = state.crew, pb = packBounds(state.pack);
        // A crew outside the downloaded area would just see blank map, so
        // frame the pack instead; "Center on me" still goes to them.
        var crewOnMap = c && finite(c.lat) && (!pb || pb.contains([c.lat, c.lon]));
        if (crewOnMap) { map.setView([c.lat, c.lon], 14); hasFramed = true; }
        else if (jobBounds()) { fit('jobs'); hasFramed = true; }
        else if (pb && c && finite(c.lat)) { map.fitBounds(pb); hasFramed = true; }
      }
    },
    fit: fit
  };
  post({ type: 'ready' });
})();
`;

// Web build: the same page runs in a sandboxed iframe (components/OfflineMap.js).
// This stands in for the WebView bridge — messages go to the parent window,
// and commands arrive as { omsCmd } messages instead of injected JS.
const WEB_BRIDGE = `
window.ReactNativeWebView = { postMessage: function (m) { parent.postMessage({ omsMap: m }, '*'); } };
window.addEventListener('message', function (e) {
  var d = e.data;
  if (e.source !== parent || !d || !window.OMS) return;
  if (d.omsCmd === 'update') OMS.update(d.state);
  else if (d.omsCmd === 'fit') OMS.fit(d.kind);
});
`;

export function buildHtml({ web = false } = {}) {
  // Native: tiles only from disk. Web: live OpenStreetMap tiles.
  const imgSrc = web ? "https://tile.openstreetmap.org data:" : "file: data:";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
${web ? '<meta name="referrer" content="strict-origin-when-cross-origin" />' : ""}
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>${LEAFLET_CSS}</style>
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; }
  #map { background: #e8eef3; }
  .leaflet-control-attribution { font-size: 10px; }
  .crew-arrow { width: 32px; height: 32px; transition: transform .6s ease-out; filter: drop-shadow(0 1px 2px rgba(15,27,45,.45)); }
  .crew-arrow svg { display: block; }
</style>
</head>
<body>
<div id="map"></div>
${web ? `<script>${WEB_BRIDGE}</script>` : ""}
<script>${LEAFLET_JS}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

let pagePromise = null;

// Writes the page once per app launch (cheap, and guarantees it matches the
// running app version) and returns its file:// URI.
export function ensureMapPage() {
  if (!pagePromise) {
    pagePromise = (async () => {
      const root = mapRoot();
      root.create({ intermediates: true, idempotent: true });
      const page = new File(root, "index.html");
      page.write(buildHtml());
      return page.uri;
    })().catch((err) => {
      pagePromise = null;
      throw err;
    });
  }
  return pagePromise;
}
