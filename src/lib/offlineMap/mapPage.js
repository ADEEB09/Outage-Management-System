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
  var state = { pack: null, crew: null, jobs: [] };
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

  function applyCrew(c) {
    if (!c || !finite(c.lat) || !finite(c.lon)) {
      if (crewMarker) { map.removeLayer(crewMarker); map.removeLayer(crewAccuracy); crewMarker = crewAccuracy = null; }
      return;
    }
    var ll = [c.lat, c.lon];
    var radius = finite(c.accuracy) ? Math.min(c.accuracy, 1000) : 0;
    if (!crewMarker) {
      crewAccuracy = L.circle(ll, { radius: radius, color: '#0e9f8e', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      crewMarker = L.circleMarker(ll, { radius: 9, color: '#ffffff', weight: 3, fillColor: '#0e9f8e', fillOpacity: 1 })
        .bindTooltip(textNode('You'), { direction: 'top', offset: [0, -8] })
        .addTo(map);
    } else {
      crewMarker.setLatLng(ll);
      crewAccuracy.setLatLng(ll).setRadius(radius);
    }
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

  function applyGuide() {
    var c = state.crew, sel = selectedJob();
    if (!c || !finite(c.lat) || !finite(c.lon) || !sel) {
      if (guideLine) { map.removeLayer(guideLine); guideLine = null; }
      return;
    }
    var pts = [[c.lat, c.lon], [sel.lat, sel.lon]];
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
    // Frame both ends of the guide line so the crew sees the whole way there.
    if (kind === 'guide' && sel) {
      if (c && finite(c.lat)) return map.fitBounds(L.latLngBounds([[c.lat, c.lon], [sel.lat, sel.lon]]), { padding: [48, 48], maxZoom: 16 });
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

function buildHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>${LEAFLET_CSS}</style>
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; }
  #map { background: #e8eef3; }
  .leaflet-control-attribution { font-size: 10px; }
</style>
</head>
<body>
<div id="map"></div>
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
