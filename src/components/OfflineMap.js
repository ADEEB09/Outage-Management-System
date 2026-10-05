// src/components/OfflineMap.js
// Leaflet map in a WebView, reading raster tiles from the offline pack on
// disk (see lib/offlineMap). Works with no network at all once the pack
// has been downloaded.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { ensureMapPage } from '../lib/offlineMap/mapPage';
import { mapRoot } from '../lib/offlineMap/tileStore';
import { usingMapTestServer } from '../lib/mapServer';

const OfflineMap = forwardRef(function OfflineMap({ pack, crew, jobs, onSelectJob, onUserGesture, style }, ref) {
  const webRef = useRef(null);
  const [pageUri, setPageUri] = useState(null);
  const [pageError, setPageError] = useState(null);
  const [ready, setReady] = useState(false);
  // A fit requested before the page is ready (e.g. arriving from a job's
  // Navigate button while the WebView is still loading) runs once it is.
  const pendingFit = useRef(null);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    ensureMapPage().then(setPageUri).catch((err) => setPageError(err?.message || 'Map failed to load'));
  }, []);

  const run = useCallback((js) => {
    // Report failures back instead of swallowing them, so they show up in
    // the device log (logcat) as [OfflineMap] warnings.
    webRef.current?.injectJavaScript(
      `try { ${js} } catch (e) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: String(e && e.message || e) })); } true;`
    );
  }, []);

  useImperativeHandle(ref, () => ({
    fit: (kind) => {
      if (ready) run(`window.OMS && OMS.fit(${JSON.stringify(String(kind))});`);
      else pendingFit.current = String(kind);
    },
  }), [run, ready]);

  // Push the full state whenever it changes; the page diffs cheaply.
  useEffect(() => {
    if (!ready) return;
    const state = {
      pack: pack
        ? { tileUrl: pack.tileUrl, minZoom: pack.minZoom, maxZoom: pack.maxZoom, bounds: pack.bounds, attribution: pack.attribution }
        : null,
      crew: crew && Number.isFinite(crew.lat) && Number.isFinite(crew.lon) ? crew : null,
      jobs,
    };
    run(`window.OMS && OMS.update(${JSON.stringify(state)});`);
    if (pendingFit.current) {
      run(`window.OMS && OMS.fit(${JSON.stringify(pendingFit.current)});`);
      pendingFit.current = null;
    }
  }, [ready, pack, crew, jobs, run]);

  const onMessage = useCallback((event) => {
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg?.type === 'ready') setReady(true);
    else if (msg?.type === 'select' && typeof msg.id === 'string') onSelectJob?.(msg.id);
    else if (msg?.type === 'gesture') onUserGesture?.();
    else if (msg?.type === 'error' || msg?.type === 'tileerror') console.warn('[OfflineMap]', msg.type, String(msg.message || ''));
  }, [onSelectJob, onUserGesture]);

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.box, styles.center, style]}>
        <Text style={styles.note}>The offline map is available in the mobile app.</Text>
      </View>
    );
  }
  if (pageError) {
    return (
      <View style={[styles.box, styles.center, style]}>
        <Text style={styles.note}>{pageError}</Text>
      </View>
    );
  }
  if (!pageUri) {
    return (
      <View style={[styles.box, styles.center, style]}>
        <ActivityIndicator color="#173355" />
      </View>
    );
  }

  const rootUri = mapRoot().uri;
  return (
    <View style={[styles.box, style]}>
      <WebView
        ref={webRef}
        source={{ uri: pageUri }}
        originWhitelist={['file://*']}
        // Only our own local page may ever load in this WebView.
        onShouldStartLoadWithRequest={(req) => req.url.startsWith(rootUri) || req.url === 'about:blank'}
        onMessage={onMessage}
        // The page also posts 'ready', but either signal is enough — never
        // reset it on load events (their order vs. onMessage isn't guaranteed).
        onLoadEnd={() => setReady(true)}
        // Android: read the page + tiles from app storage. No XHR/universal
        // file access is granted — tiles load as plain <img> elements.
        allowFileAccess
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        // iOS: scope file access to the offline-map folder only.
        allowingReadAccessToURL={rootUri}
        javaScriptEnabled
        // chrome://inspect for dev and map-test builds only.
        webviewDebuggingEnabled={__DEV__ || usingMapTestServer}
        domStorageEnabled={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        // Let the map own pan/pinch gestures inside the parent ScrollView.
        nestedScrollEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        style={styles.web}
      />
    </View>
  );
});

export default OfflineMap;

const styles = StyleSheet.create({
  box: { height: 360, borderRadius: 9, overflow: 'hidden', backgroundColor: '#e8eef3' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  web: { flex: 1, backgroundColor: '#e8eef3' },
  note: { color: '#7c8da3', fontSize: 13, textAlign: 'center' },
});
