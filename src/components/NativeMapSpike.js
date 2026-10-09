// src/components/NativeMapSpike.js
// SPIKE (branch spike/native-vector-map): a test screen for native vector map
// rendering with @maplibre/maplibre-react-native. It does not replace the real
// Map tab. It answers three questions on a real phone:
//   1. Does the native map build and render on our React Native version?
//   2. Does the login header reach the map server, including offline pack downloads?
//   3. How big is a region pack, and how smooth is panning (frames per second)?
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, Map, OfflineManager } from '@maplibre/maplibre-react-native';
import { mapApiBase, mapServerHeaders } from '../lib/mapServer';
import { startMapAuth, stopMapAuth, syncMapAuthHeader } from '../lib/offlineMap/nativeMapAuth';

const PACK_NAME = 'spike-region';
const DEHRADUN = [77.92, 30.22, 78.13, 30.42]; // used when the server has no region for this crew
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export default function NativeMapSpike({ onClose }) {
  const [authed, setAuthed] = useState(null);
  const [region, setRegion] = useState({ id: 'dehradun', bbox: DEHRADUN });
  const [mapState, setMapState] = useState('loading');
  const [pack, setPack] = useState(null);
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  const styleUrl = `${mapApiBase()}/map/style.json`;

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

  useEffect(() => {
    const timer = setInterval(() => {
      setFps(frames.current);
      frames.current = 0;
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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

  const [w, s, e, n] = region.bbox;
  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Text style={styles.title}>Native map test</Text>
        <Pressable onPress={onClose} style={styles.btn}><Text style={styles.btnText}>Close</Text></Pressable>
      </View>
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
          <Camera initialViewState={{ bounds: [w, s, e, n] }} />
        </Map>
      )}
      <View style={styles.info}>
        <Text style={styles.line}>Auth header: {authed === null ? '...' : authed ? 'set' : 'NO TOKEN (sign in again)'}</Text>
        <Text style={styles.line}>Map: {mapState} · {fps} fps while moving</Text>
        <Text style={styles.line}>Region: {region.id} [{region.bbox.map((v) => v.toFixed(2)).join(', ')}] z8-14</Text>
        <Text style={styles.line}>
          Pack: {pack ? `${pack.state} ${pack.percent}% · ${mb(pack.bytes)} · ${pack.tiles} tiles · ${pack.resources} resources` : 'none'}
        </Text>
        {pack?.error ? <Text style={[styles.line, styles.err]}>Pack error: {pack.error}</Text> : null}
        <View style={styles.row}>
          <Pressable onPress={() => download().catch((err) => setPack((p) => ({ ...p, error: err.message })))} style={styles.btn}>
            <Text style={styles.btnText}>{pack && pack.state !== 'complete' ? 'Resume pack' : 'Download pack'}</Text>
          </Pressable>
          <Pressable onPress={() => remove().catch(() => {})} style={styles.btn}><Text style={styles.btnText}>Delete pack</Text></Pressable>
        </View>
        <Text style={styles.hint}>Offline test: download the pack, turn on airplane mode, close and reopen this screen. Labels and icons must still show.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12 },
  title: { fontSize: 18, fontWeight: '700', color: '#173355' },
  map: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  info: { padding: 12, gap: 4 },
  line: { fontSize: 13, color: '#173355' },
  err: { color: '#b91c1c' },
  hint: { fontSize: 12, color: '#7c8da3', marginTop: 6 },
  row: { flexDirection: 'row', gap: 8, marginTop: 6 },
  btn: { backgroundColor: '#173355', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '600' },
});
