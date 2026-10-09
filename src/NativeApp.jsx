import { useEffect, useState, useCallback, useMemo, useRef, Component } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import {
  getDiscovery,
  redirectUri,
  login,
  restoreSession,
  logout as authLogout,
  isAuthenticated,
  myCrewId,
  isBiometricEnabled,
  setBiometricEnabled,
} from './lib/auth';
import { biometricUnlock } from './lib/biometric';
import { getLockoutStatus, recordFailedAttempt, resetAttempts as resetLoginAttempts, MAX_ATTEMPTS, LOCKOUT_MS } from './lib/lockout';
import { API_PORT, CLIENT_ID, KEYCLOAK_PORT } from './config';
import { reportTrackingState, getCurrentCrew, getMyJobs, updateJobStatus, getJobsLastSyncedAt, getJobMessages, getJobPhotos, getCrewMessages, saveAssetScan, getAssetScans } from './lib/api.js';
import { getLocation, getLastKnownLocation } from './lib/location';
import { uploadCapturedPhoto } from './lib/photos';
import { navigateTo } from './lib/navigate';
import { isOnlineState, distanceAndDirection } from './lib/offlineNavigation';
import { getRoadRoute, preloadRoadGraph, formatDistance, formatDuration } from './lib/roadRouting';
import { openMultiJobRoute } from './lib/routing';
import { queueUpdate, queueScan, isRetryable, flushQueue, getQueueLength, getQueueItems } from './lib/offlineQueue';
import { startCrewTracking, stopCrewTracking, autoStartCrewTracking, setTrackingPausedByCrew, isLocationServiceOn } from './lib/backgroundLocation';
import { flushLocations, getPendingLocationCount } from './lib/locationQueue';
import { downloadPack, cancelPackDownload, getInstalledPack, getPackStatus, subscribePackStatus } from './lib/offlineMap/areaStore';
import OfflineMap from './components/OfflineMap';
import NativeMapSpike from './components/NativeMapSpike'; // SPIKE: native vector map test (Profile tab)
import { usingMapTestServer } from './lib/mapServer';
import { checkServer, getServer, setServer } from './lib/server';
import SafetyChecklist from './components/SafetyChecklist';
import QrScanner from './components/QrScanner';
import * as PriorityChecklistModule from './components/PriorityChecklist';
const PriorityChecklist = PriorityChecklistModule.default || PriorityChecklistModule;
import FaultDiagnosisWizard from './components/FaultDiagnosisWizard';
import PartsPicker from './components/PartsPicker';
import CrewLeadSignOff from './components/CrewLeadSignOff';

WebBrowser.maybeCompleteAuthSession();

const FALLBACK_JOBS = [
  { id: 'JOB-1005', title: 'Pending Line Inspection', address: 'Mussoorie Road, Dehradun', coordinates: { lat: 30.3606, lon: 78.0647 }, severity: 'High', status: 'Pending Acceptance', customers: 386, distance: '1.6 km' },
  { id: 'JOB-1001', title: 'Transformer Failure', address: 'Rajpur Road, Dehradun', coordinates: { lat: 30.3476, lon: 78.0808 }, severity: 'Critical', status: 'Acknowledged', customers: 842, distance: '2.4 km' },
  { id: 'JOB-1002', title: 'Line Fault', address: 'Haridwar Road, Rishikesh', coordinates: { lat: 30.3136, lon: 78.0322 }, severity: 'High', status: 'En Route', customers: 531, distance: '5.8 km' },
];

const NEXT_STATUS = {
  'Pending Acceptance': 'Acknowledged',
  Acknowledged: 'En Route',
  'En Route': 'On Site',
  'On Site': 'Work Started',
  'Work Started': 'Work Finished',
  'Work Finished': null,
};

// The app's last step is 'Work Finished'; the server stores it as
// 'Work Complete', and dashboard-closed jobs come back Completed/Closed.
const DONE_STATUSES = ['work finished', 'work complete', 'completed', 'closed'];
const isJobDone = (job) => DONE_STATUSES.includes(String(job.status).toLowerCase());

// Pending = still to do, so Total = Pending + Done.
const JOB_FILTERS = {
  all: { section: 'ALL JOBS', empty: 'No jobs assigned.', test: () => true },
  pending: { section: 'PENDING JOBS', empty: 'No pending jobs.', test: (job) => !isJobDone(job) },
  done: { section: 'JOBS DONE', empty: 'No jobs done yet.', test: isJobDone },
};

// Severity color coding: High -> orange, Medium -> blue, Low -> green,
// Critical -> red. Kept local (not imported) so this file can never crash
// due to a missing/misnamed export in another file.
const severityColors = { Critical: '#d7382a', High: '#e08a1e', Medium: '#2f6fd6', Low: '#2a9d5c' };
const MAX_JOB_PHOTOS = 25;

// The offline map pack and GPS uploads need either a real login or the
// no-auth map test server (MAP_TEST_SERVER in config.js).
const canUseMapServer = () => isAuthenticated() || usingMapTestServer;

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}

export default function NativeApp() {
  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <NativeAppScreen />
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

// Catches render/runtime errors anywhere below it and shows the actual
// error message on screen instead of a silent blank page — makes it much
// easier to diagnose crashes that only happen after login.
class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('NativeApp crashed:', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={[styles.safe, styles.center, { padding: 24 }]}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: '#d7382a', marginBottom: 10 }}>
            App crashed
          </Text>
          <Text style={{ fontSize: 13, color: '#33465f', textAlign: 'center' }}>
            {String(this.state.error?.message || this.state.error)}
          </Text>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

function NativeAppScreen() {
  const insets = useSafeAreaInsets();
  const [checkingSession, setCheckingSession] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [needsBiometric, setNeedsBiometric] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState('');
  const [biometricOn, setBiometricOn] = useState(false);
  const [trackingOn, setTrackingOn] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [pendingLocations, setPendingLocations] = useState(0);
  const [crew, setCrew] = useState({ name: 'Crew Gamma-2', role: 'Field Technician', id: 'C003' });
  const [jobs, setJobs] = useState(FALLBACK_JOBS);
  const [tab, setTab] = useState('Dashboard');
  const [jobFilter, setJobFilter] = useState('all');
  const [activeJob, setActiveJob] = useState(null);
  const [mapJobId, setMapJobId] = useState(null);
  // Set by a job's "Navigate to site": the Map tab then guides to that one
  // incident instead of showing every job. Cleared from the Map tab or nav bar.
  const [navJobId, setNavJobId] = useState(null);
  // SPIKE: the new native map, opened from Profile (no job) or a job's
  // "Navigate (new map)" (navigates straight to that job).
  const [nativeMap, setNativeMap] = useState(null); // null | { jobId }
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingItems, setPendingItems] = useState([]);
  const [crewMessages, setCrewMessages] = useState([]);
  const [messagesVisible, setMessagesVisible] = useState(false);
  const [backStack, setBackStack] = useState([]);
  const [forwardStack, setForwardStack] = useState([]);
  const pageRef = useRef({ tab: 'Dashboard', jobId: null });

  const openPage = useCallback((page) => {
    const current = pageRef.current;
    if (current.tab === page.tab && current.jobId === page.jobId) return;
    setBackStack((stack) => [...stack, current]);
    setForwardStack([]);
    pageRef.current = page;
    setTab(page.tab);
    setActiveJob(page.jobId ? jobs.find((job) => job.id === page.jobId) || null : null);
  }, [jobs]);

  const goBack = useCallback(() => {
    setBackStack((stack) => {
      const previous = stack[stack.length - 1];
      if (!previous) return stack;
      setForwardStack((forward) => [...forward, pageRef.current]);
      pageRef.current = previous;
      setTab(previous.tab);
      setActiveJob(previous.jobId ? jobs.find((job) => job.id === previous.jobId) || null : null);
      return stack.slice(0, -1);
    });
  }, [jobs]);

  const goForward = useCallback(() => {
    setForwardStack((stack) => {
      const next = stack[stack.length - 1];
      if (!next) return stack;
      setBackStack((back) => [...back, pageRef.current]);
      pageRef.current = next;
      setTab(next.tab);
      setActiveJob(next.jobId ? jobs.find((job) => job.id === next.jobId) || null : null);
      return stack.slice(0, -1);
    });
  }, [jobs]);

  // Try to resume a previous Keycloak session on cold start. Guarded so a
  // slow/unavailable native module (e.g. secure storage on web) can never
  // leave the app stuck on the loading spinner. If the crew member has
  // opted in to biometric unlock, a restored session is held behind a
  // Face ID/fingerprint prompt rather than granted automatically.
  useEffect(() => {
    let settled = false;
    const finish = async (restored) => {
      if (settled) return;
      settled = true;
      if (restored && (await isBiometricEnabled().catch(() => false))) {
        setNeedsBiometric(true);
        setCheckingSession(false);
        return;
      }
      setAuthenticated(restored);
      setCheckingSession(false);
    };
    restoreSession()
      .then(finish)
      .catch(() => finish(false));
    const timeout = setTimeout(() => finish(false), 4000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (authenticated) isBiometricEnabled().then(setBiometricOn).catch(() => {});
  }, [authenticated]);

  // Tracking starts by itself once a crew is signed in (asking for location
  // permission the first time), so dispatch sees every crew on duty without
  // anyone having to remember the Tracking button. The crew can still switch
  // it off; that holds until they sign in again. Demo mode never tracks.
  // Why tracking is not running (null while it runs): a reason reported to
  // dispatch, plus the error text when starting failed, shown in a banner.
  const [trackingReason, setTrackingReason] = useState(null);
  const [trackingError, setTrackingError] = useState('');
  const trackingRef = useRef({ on: false, reason: null });
  const startingRef = useRef(false);
  const applyTracking = useCallback((on, reason = null, error = '') => {
    trackingRef.current = { on, reason: on ? null : reason };
    setTrackingOn(on);
    setTrackingReason(on ? null : reason);
    setTrackingError(on ? '' : error);
  }, []);

  const runAutoStart = useCallback(async () => {
    if (!isAuthenticated() || startingRef.current) return;
    startingRef.current = true;
    setTrackingBusy(true);
    const crewId = myCrewId();
    let error = '';
    const { on, reason } = await autoStartCrewTracking(crewId).catch((err) => {
      // Not a permission problem (those come back as a reason): e.g. Android
      // refusing to start the foreground service. Keep the real message.
      error = err?.message || String(err);
      console.warn('[tracking] start failed:', error);
      return { on: false, reason: 'start_failed' };
    });
    // Re-reported on every start so dispatch's view heals after an offline
    // report was lost; the backend only alerts on a change.
    reportTrackingState(crewId, on ? 'on' : 'off', reason).catch(() => {});
    applyTracking(on, reason, error);
    setTrackingBusy(false);
    startingRef.current = false;
  }, [applyTracking]);

  useEffect(() => {
    if (authenticated) runAutoStart();
  }, [authenticated, runAutoStart]);

  // Whenever signed in (every 20 s and when the app comes back to the
  // front): warn the crew and dispatch if the phone's Location switch is off,
  // and retry tracking that failed to start, e.g. after the crew granted the
  // permission in Settings. A crew who switched tracking off is left alone.
  const [locationOff, setLocationOff] = useState(false);
  const locationOffRef = useRef(null);
  useEffect(() => {
    if (!authenticated || !isAuthenticated()) {
      locationOffRef.current = null;
      setLocationOff(false);
      return undefined;
    }
    const crewId = myCrewId();
    // Retries only on returning to the app or Location coming back, never on
    // the timer, so a permission prompt can't pop up every 20 s.
    const check = async (returned = false) => {
      const off = !(await isLocationServiceOn());
      const wasKnown = locationOffRef.current !== null;
      const changed = off !== locationOffRef.current;
      locationOffRef.current = off;
      setLocationOff(off);
      const { on, reason } = trackingRef.current;
      if (off) {
        if (changed) reportTrackingState(crewId, 'off', 'location_services_off').catch(() => {});
      } else if (!on && reason !== 'turned_off') {
        if (returned || (changed && wasKnown)) runAutoStart();
      } else if (changed && wasKnown && on) {
        reportTrackingState(crewId, 'on').catch(() => {});
      }
    };
    check();
    const timer = setInterval(() => check(), 20000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check(true); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [authenticated, runAutoStart]);

  const openAppSettings = useCallback(() => { Linking.openSettings().catch(() => {}); }, []);

  const openLocationSettings = useCallback(() => {
    if (Platform.OS === 'android') {
      Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS').catch(() => Linking.openSettings());
    } else {
      Linking.openSettings().catch(() => {});
    }
  }, []);

  const handleBiometricUnlock = useCallback(async () => {
    setBiometricBusy(true);
    setBiometricError('');
    try {
      const ok = await biometricUnlock();
      if (ok) {
        setNeedsBiometric(false);
        setAuthenticated(true);
      } else {
        setBiometricError('Unlock failed or was cancelled.');
      }
    } catch {
      setBiometricError('Biometric unlock is unavailable on this device.');
    } finally {
      setBiometricBusy(false);
    }
  }, []);

  // Auto-prompt once as soon as the lock screen appears.
  useEffect(() => {
    if (needsBiometric) handleBiometricUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsBiometric]);

  const toggleBiometric = useCallback(async () => {
    if (biometricOn) {
      await setBiometricEnabled(false);
      setBiometricOn(false);
      return;
    }
    const ok = await biometricUnlock().catch(() => false);
    if (ok) {
      await setBiometricEnabled(true);
      setBiometricOn(true);
    }
  }, [biometricOn]);

  const toggleTracking = useCallback(async () => {
    if (trackingBusy) return;
    console.log('[toggleTracking] pressed, current state:', trackingOn);
    setTrackingBusy(true);
    try {
      if (trackingOn) {
        console.log('[toggleTracking] stopping...');
        await stopCrewTracking();
        await setTrackingPausedByCrew(true);
        console.log('[toggleTracking] stopped.');
        applyTracking(false, 'turned_off');
        reportTrackingState(crew.id, 'off', 'turned_off').catch(() => {});
        return;
      }
      console.log('[toggleTracking] starting, crew.id =', crew.id);
      await setTrackingPausedByCrew(false);
      const { on, reason } = await startCrewTracking(crew.id);
      console.log('[toggleTracking] startCrewTracking returned:', on, reason);
      applyTracking(on, reason);
      reportTrackingState(crew.id, on ? 'on' : 'off', reason).catch(() => {});
    } catch (err) {
      const error = err?.message || String(err);
      console.log('[toggleTracking] ERROR:', error);
      applyTracking(false, 'start_failed', error);
      reportTrackingState(crew.id, 'off', 'start_failed').catch(() => {});
    } finally {
      setTrackingBusy(false);
    }
  }, [trackingOn, trackingBusy, crew.id]);

  // Off duty = not tracked: signing out stops tracking (points already
  // recorded still upload) and the next sign-in starts it again.
  const signOut = useCallback(async () => {
    // Report before the token is cleared, but never let a dead network hold
    // up signing out.
    await Promise.race([
      reportTrackingState(myCrewId(), 'off', 'signed_out').catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await stopCrewTracking().catch(() => {});
    await setTrackingPausedByCrew(false);
    applyTracking(false, 'signed_out');
    await authLogout();
    setAuthenticated(false);
  }, [applyTracking]);

  const refresh = useCallback(() => {
    if (!authenticated) return;
    getCurrentCrew().then(setCrew).catch(() => {});
    getMyJobs().then((items) => items?.length && setJobs(items)).catch(() => {});
  }, [authenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // OMS messages are polled while the authenticated crew app is connected.
  useEffect(() => {
    if (!authenticated || !isAuthenticated() || !crew.id) {
      setCrewMessages([]);
      return undefined;
    }
    let cancelled = false;
    const loadMessages = () => {
      getCrewMessages(crew.id)
        .then((items) => {
          if (!cancelled) setCrewMessages(Array.isArray(items) ? items : []);
        })
        .catch(() => {});
    };
    loadMessages();
    const interval = setInterval(loadMessages, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [authenticated, crew.id]);

  const reloadPending = useCallback(() => getQueueItems()
    .then((items) => {
      setPendingItems(items);
      setPendingCount(items.length);
    })
    .catch(() => {}), []);

  // Send pending-sync items (status changes, photos, QR scans made without
  // signal): on sign-in, as soon as the network comes back, and every 30 s.
  const syncPending = useCallback(() => {
    if (!authenticated) return Promise.resolve();
    // Demo mode has no real backend to flush against, and re-fetching demo
    // jobs would just overwrite locally-advanced statuses — only refresh the
    // pending list for display.
    if (!isAuthenticated()) return reloadPending();
    return flushQueue()
      .then(reloadPending)
      .then(refresh)
      .catch(() => {});
  }, [authenticated, refresh, reloadPending]);

  useEffect(() => {
    if (!authenticated) return undefined;
    syncPending();
    const interval = setInterval(syncPending, 30000);
    const subscription = Network.addNetworkStateListener((state) => {
      // isConnected, not internet reachability: the server may be on a
      // local network (the PC hotspot) with no internet behind it.
      if (state.isConnected) syncPending();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [authenticated, syncPending]);

  // Upload GPS fixes recorded while offline: immediately when the network
  // comes back, plus a periodic retry. The background task also flushes on
  // each new fix; this covers the "app open, crew parked at a site" case
  // where no new fix arrives to trigger it.
  useEffect(() => {
    if (!authenticated || !canUseMapServer()) return undefined;
    const flush = () => flushLocations().then((r) => setPendingLocations(r.remaining)).catch(() => {});
    getPendingLocationCount().then(setPendingLocations).catch(() => {});
    flush();
    const interval = setInterval(flush, 60000);
    const subscription = Network.addNetworkStateListener((state) => {
      if (state.isConnected) flush(); // flushLocations re-checks reachability itself
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [authenticated]);

  // Fetch/refresh the offline map pack automatically, but only on Wi-Fi
  // (it's tens of MB). A no-op when the installed pack is already current.
  useEffect(() => {
    if (!authenticated || !canUseMapServer()) return;
    Network.getNetworkStateAsync()
      .then((state) => {
        if (state.type === Network.NetworkStateType.WIFI) {
          downloadPack().catch(() => {});
        }
      })
      .catch(() => {});
  }, [authenticated]);

  const handleAdvance = useCallback(async (job, nextStatus) => {
    const location = await getLocation();
    setJobs((current) => current.map((j) => (j.id === job.id ? { ...j, status: nextStatus } : j)));
    setActiveJob((current) => current?.id === job.id ? { ...current, status: nextStatus } : current);

    // Demo mode has no real backend to sync with — queue immediately so
    // the pending-sync section actually shows something, instead of the
    // update silently "succeeding" against nothing.
    const enqueue = async () => {
      await queueUpdate({ id: job.id, status: nextStatus, location, queuedAt: Date.now() });
      await reloadPending();
    };
    if (!isAuthenticated()) {
      await enqueue();
      return;
    }

    // Older updates still waiting: this one goes behind them, so the server
    // gets them in the order the crew made them.
    if ((await getQueueLength()) > 0) {
      await enqueue();
      syncPending();
      return;
    }
    try {
      await updateJobStatus(job.id, nextStatus, location);
    } catch {
      await enqueue();
    }
  }, [reloadPending, syncPending]);

  if (checkingSession) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        <ActivityIndicator size="large" color="#1F3864" />
      </SafeAreaView>
    );
  }

  if (needsBiometric) {
    return (
      <SafeAreaView style={[styles.loginSafe, styles.center, { padding: 24 }]}>
        <Text style={styles.loginTitle}>🔒</Text>
        <Text style={[styles.loginTitle, { fontSize: 20, marginTop: 12 }]}>Unlock OMS Crew</Text>
        <Text style={[styles.loginSubtitle, { textAlign: 'center' }]}>
          Confirm it's you with Face ID / fingerprint to resume your session.
        </Text>
        {biometricError ? <Text style={styles.error}>{biometricError}</Text> : null}
        <Pressable style={[styles.signIn, { marginTop: 20 }]} disabled={biometricBusy} onPress={handleBiometricUnlock}>
          <Text style={styles.signInText}>{biometricBusy ? 'Checking…' : 'Try again'}</Text>
          <Text style={styles.signInArrow}>→</Text>
        </Pressable>
        <Pressable
          style={styles.demoBtn}
          onPress={async () => {
            await signOut();
            setNeedsBiometric(false);
          }}
        >
          <Text style={styles.demoBtnText}>Sign out instead</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!authenticated) {
    return <CrewLogin onSuccess={() => setAuthenticated(true)} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor="#173355" />
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerIdentity}>
            <Text style={styles.kicker}>OMS CREW</Text>
            <Text style={styles.crewName} numberOfLines={1}>{crew.name}</Text>
            <Text style={styles.role} numberOfLines={1}>{crew.role} · {crew.id}</Text>
          </View>
          <View style={styles.headerRight}>
            <View style={styles.historyControls}>
              <Pressable style={[styles.historyButton, !backStack.length && styles.historyButtonOff]} disabled={!backStack.length} onPress={goBack} accessibilityLabel="Go back">
                <Text style={styles.historyButtonText}>‹</Text>
              </Pressable>
              <Pressable style={[styles.historyButton, !forwardStack.length && styles.historyButtonOff]} disabled={!forwardStack.length} onPress={goForward} accessibilityLabel="Go forward">
                <Text style={styles.historyButtonText}>›</Text>
              </Pressable>
            </View>
            {!isAuthenticated() && (
              <View style={styles.demoBadge}>
                <Text style={styles.demoBadgeText}>DEMO MODE</Text>
              </View>
            )}
            {pendingCount > 0 && (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingText}>{pendingCount} queued</Text>
              </View>
            )}
          </View>
        </View>
        <View style={styles.actionBar}>
          {isAuthenticated() && (
            <HeaderAction
              label="Messages"
              count={crewMessages.length}
              onPress={() => setMessagesVisible(true)}
              accessibilityLabel="Open OMS messages"
            />
          )}
          {isAuthenticated() && (
            <HeaderAction
              label="Biometric"
              on={biometricOn}
              onPress={toggleBiometric}
              accessibilityLabel={biometricOn ? 'Biometric unlock is on, tap to turn off' : 'Turn on biometric unlock'}
            />
          )}
          <HeaderAction
            label={trackingBusy ? 'Updating…' : 'Tracking'}
            on={trackingOn}
            count={pendingLocations}
            onPress={toggleTracking}
            disabled={trackingBusy}
            accessibilityLabel={
              (trackingOn ? 'Location tracking is on, tap to turn off' : 'Turn on location tracking') +
              (pendingLocations > 0 ? `, ${pendingLocations} locations saved offline` : '')
            }
          />
          <HeaderAction
            label="Sign out"
            danger
            onPress={signOut}
            accessibilityLabel="Sign out"
          />
        </View>
      </View>
      {(() => {
        // One warning at a time, most fixable first. None when the crew
        // switched tracking off themselves (the Tracking button shows that).
        let banner = null;
        if (locationOff) {
          banner = { title: 'Location is off', text: "Dispatch can't see where you are. Tap to turn on Location.", onPress: openLocationSettings };
        } else if (trackingReason === 'permission_denied' || trackingReason === 'background_permission_denied') {
          banner = {
            title: 'Location permission needed',
            text: trackingReason === 'background_permission_denied'
              ? 'Tap, open Permissions > Location and choose "Allow all the time".'
              : 'Tap, open Permissions > Location and allow location.',
            onPress: openAppSettings,
          };
        } else if (trackingReason === 'start_failed') {
          banner = { title: "Tracking couldn't start", text: `${trackingError || 'Unknown error'}. Tap to try again.`, onPress: runAutoStart };
        }
        if (!banner || (trackingBusy && !locationOff)) return null;
        return (
          <Pressable style={styles.locationOffBanner} onPress={banner.onPress} accessibilityRole="button" accessibilityLabel={`${banner.title}. ${banner.text}`}>
            <Text style={styles.locationOffTitle}>{banner.title}</Text>
            <Text style={styles.locationOffText}>{banner.text}</Text>
          </Pressable>
        );
      })()}
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 100 + insets.bottom }]}>
        {tab === 'Dashboard' ? (
          <>
            <Text style={styles.title}>Today&apos;s field work</Text>
            <Text style={styles.subtitle}>Priority outages assigned to your crew.</Text>
            <JobStats
              jobs={jobs}
              onSelect={(filter) => {
                setJobFilter(filter);
                openPage({ tab: 'Jobs' });
              }}
            />

            {pendingItems.length > 0 && (
              <View style={styles.pendingSection}>
                <View style={styles.pendingSectionHeader}>
                  <Text style={styles.pendingSectionTitle}>PENDING SYNC</Text>
                  <View style={styles.pendingCountPill}>
                    <Text style={styles.pendingCountPillText}>{pendingItems.length}</Text>
                  </View>
                </View>
                <Text style={styles.pendingSectionSubtitle}>
                  Saved on the phone with no signal. They're sent automatically, with the time you made them, once there is signal.
                </Text>
                {pendingItems.map((item, i) => (
                  <View key={`${item.id}-${item.queuedAt ?? i}`} style={styles.pendingItemRow}>
                    <View style={styles.pendingDot} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pendingItemTitle}>
                        {item.type === 'photo' ? `${item.id} · Photo` : item.type === 'scan' ? `${item.id} · QR scan ${item.scan?.assetId ?? ''}` : `${item.id} → ${item.status}`}
                      </Text>
                      <Text style={styles.pendingItemMeta}>
                        {item.queuedAt ? `Queued ${timeAgo(item.queuedAt)}` : 'Queued offline'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            <Text style={styles.section}>MY JOBS</Text>
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} onPress={() => openPage({ tab: 'Dashboard', jobId: job.id })} />
            ))}
          </>
        ) : tab === 'Jobs' ? (
          <NativeJobsPage
            jobs={jobs}
            filter={jobFilter}
            onFilter={setJobFilter}
            onPressJob={(job) => openPage({ tab: 'Jobs', jobId: job.id })}
          />
        ) : tab === 'Map' ? (
          <MapScreen
            jobs={jobs}
            selectedJobId={mapJobId}
            onSelect={setMapJobId}
            crew={crew}
            navJobId={navJobId}
            onExitNav={() => setNavJobId(null)}
          />
        ) : tab === 'Profile' ? (
          <ProfileScreen crew={crew} jobs={jobs} onLogout={signOut} onOpenNativeMap={() => setNativeMap({ jobId: null })} />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.title}>{tab}</Text>
            <Text style={styles.subtitle}>This field workspace is ready for your next assignment.</Text>
          </View>
        )}
      </ScrollView>
      <View style={[styles.nav, { paddingBottom: 12 + insets.bottom }]}>
        {['Dashboard', 'Jobs', 'Map', 'Profile'].map((item) => (
          <Pressable
            key={item}
            onPress={() => {
              setNavJobId(null);
              openPage({ tab: item, jobId: null });
            }}
            style={styles.navItem}
          >
            <Text style={[styles.navText, tab === item && styles.navActive]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>

      <Modal visible={!!activeJob} animationType="slide" onRequestClose={goBack}>
        {activeJob && (
          <JobDetail
            job={activeJob}
            crew={crew}
            onClose={goBack}
            onAdvance={handleAdvance}
            onQueued={reloadPending}
            onNavigateNative={(job) => setNativeMap({ jobId: job.id })}
            onNavigate={(job) => {
              setMapJobId(job.id);
              setNavJobId(job.id);
              openPage({ tab: 'Map', jobId: null });
            }}
          />
        )}
      </Modal>
      <Modal visible={!!nativeMap} animationType="slide" onRequestClose={() => setNativeMap(null)}>
        {nativeMap ? <NativeMapSpike jobs={jobs} crew={crew} initialJobId={nativeMap.jobId} onClose={() => setNativeMap(null)} /> : null}
      </Modal>
      <Modal visible={messagesVisible} animationType="slide" onRequestClose={() => setMessagesVisible(false)}>
        <SafeAreaView style={styles.detailSafe}>
          <View style={styles.detailHeader}>
            <Text style={styles.detailId}>OMS messages</Text>
            <Pressable onPress={() => setMessagesVisible(false)}>
              <Text style={styles.detailBack}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.detailContent}>
            <Text style={styles.subtitle}>Messages for {crew.name}&apos;s assigned jobs.</Text>
            {!crewMessages.length ? <Text style={styles.mapEmpty}>No OMS messages yet.</Text> : null}
            {crewMessages.map((item) => (
              <View key={item.id} style={styles.messageRow}>
                <Text style={styles.messageBody}>{item.body}</Text>
                <Text style={styles.messageMeta}>{item.sender} · {item.job_id} · {new Date(item.ts).toLocaleString()}</Text>
              </View>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function JobStats({ jobs, active, onSelect }) {
  const count = (filter) => String(jobs.filter(JOB_FILTERS[filter].test).length);
  return (
    <View style={styles.stats}>
      <Stat value={count('all')} label="Total jobs" active={active === 'all'} onPress={() => onSelect('all')} />
      <Stat value={count('pending')} label="Pending jobs" active={active === 'pending'} onPress={() => onSelect('pending')} />
      <Stat value={count('done')} label="Jobs done" active={active === 'done'} onPress={() => onSelect('done')} />
    </View>
  );
}

function NativeJobsPage({ jobs, filter, onFilter, onPressJob }) {
  const { section, empty, test } = JOB_FILTERS[filter] || JOB_FILTERS.all;
  const shown = jobs.filter(test);

  return (
    <>
      <Text style={styles.title}>Jobs</Text>
      <Text style={styles.subtitle}>Track every assignment and its current status.</Text>
      <JobStats jobs={jobs} active={filter} onSelect={onFilter} />
      <Text style={styles.section}>{section}</Text>
      {!shown.length ? <Text style={styles.mapEmpty}>{empty}</Text> : null}
      {shown.map((job) => (
        <JobCard key={job.id} job={job} onPress={() => onPressJob(job)} />
      ))}
    </>
  );
}

function CrewLogin({ onSuccess }) {
  // The server was loaded from storage before this screen (restoreSession).
  const [server, setServerHost] = useState(getServer);
  const [serverDraft, setServerDraft] = useState(getServer);
  const [serverCheck, setServerCheck] = useState(null); // null | 'checking' | { api, keycloak } | { error }
  const discovery = useMemo(() => getDiscovery(), [server]);
  const [request, , promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: CLIENT_ID,
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      scopes: ['openid', 'profile'],
    },
    discovery
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lockStatus, setLockStatus] = useState({ locked: false, remainingMs: 0, attempts: 0 });
  const [enableBiometricNext, setEnableBiometricNext] = useState(false);

  useEffect(() => {
    getLockoutStatus().then(setLockStatus);
  }, []);

  // Keep the countdown fresh while locked.
  useEffect(() => {
    if (!lockStatus.locked) return;
    const interval = setInterval(() => getLockoutStatus().then(setLockStatus), 1000);
    return () => clearInterval(interval);
  }, [lockStatus.locked]);

  const submit = async () => {
    if (!request || busy) return;
    const current = await getLockoutStatus();
    if (current.locked) {
      setLockStatus(current);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const loginResult = await login(promptAsync, request);
      if (!loginResult?.success) {
        if (!loginResult?.countFailure) {
          setError('Sign-in was cancelled.');
          return;
        }
        const status = await recordFailedAttempt();
        setLockStatus(status);
        setError(
          status.locked
            ? `Too many failed attempts. Locked for ${Math.ceil(LOCKOUT_MS / 60000)} minutes.`
            : `Sign-in was cancelled or failed. ${MAX_ATTEMPTS - status.attempts} attempt(s) left.`
        );
        return;
      }
      await resetLoginAttempts();
      if (enableBiometricNext) {
        const bOk = await biometricUnlock().catch(() => false);
        if (bOk) await setBiometricEnabled(true);
      }
      onSuccess();
    } catch {
      const status = await recordFailedAttempt();
      setLockStatus(status);
      setError(`Could not reach the sign-in server at ${server}. Tap "Check" below to see what is unreachable.`);
    } finally {
      setBusy(false);
    }
  };

  const saveAndCheckServer = async () => {
    setServerCheck('checking');
    try {
      const host = await setServer(serverDraft);
      setServerHost(host);
      setServerDraft(host);
      setServerCheck(await checkServer());
    } catch (err) {
      setServerCheck({ error: err.message });
    }
  };

  const lockedMinutes = Math.ceil(lockStatus.remainingMs / 60000);

  return (
    <SafeAreaView style={styles.loginSafe}>
      <StatusBar barStyle="light-content" backgroundColor="#10201d" />
      <ScrollView contentContainerStyle={styles.login} keyboardShouldPersistTaps="handled">
        <Text style={styles.loginKicker}>OMS CREW</Text>
        <Text style={styles.loginTitle}>Crew sign in</Text>
        <Text style={styles.loginSubtitle}>Access your field operations workspace.</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {lockStatus.locked ? (
          <Text style={styles.error}>
            Account locked after {MAX_ATTEMPTS} failed attempts. Try again in {lockedMinutes} min.
          </Text>
        ) : null}

        <Pressable
          style={styles.checkboxRow}
          onPress={() => setEnableBiometricNext((v) => !v)}
        >
          <View style={[styles.checkbox, enableBiometricNext && styles.checkboxOn]} />
          <Text style={styles.checkboxLabel}>Enable biometric unlock next time</Text>
        </Pressable>

        <Pressable
          style={[styles.signIn, (!request || lockStatus.locked) && styles.btnOff]}
          disabled={!request || busy || lockStatus.locked}
          onPress={submit}
        >
          <Text style={styles.signInText}>
            {lockStatus.locked ? `Locked (${lockedMinutes} min)` : busy ? 'Signing in…' : 'Sign in with Keycloak'}
          </Text>
          <Text style={styles.signInArrow}>→</Text>
        </Pressable>

        <Pressable style={styles.demoBtn} onPress={onSuccess}>
          <Text style={styles.demoBtnText}>Continue in demo mode</Text>
        </Pressable>
        <Text style={styles.demoBtnHint}>
          No backend/Keycloak reachable yet? Skip sign-in and explore the app with sample jobs.
        </Text>

        <View style={styles.demo}>
          <Text style={styles.demoLabel}>OMS SERVER</Text>
          <View style={styles.serverRow}>
            <TextInput
              style={styles.serverInput}
              value={serverDraft}
              onChangeText={(text) => {
                setServerDraft(text);
                setServerCheck(null);
              }}
              placeholder="192.168.1.20"
              placeholderTextColor="#5f7b74"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={saveAndCheckServer}
              editable={!busy}
            />
            <Pressable style={styles.serverBtn} onPress={saveAndCheckServer} disabled={busy || serverCheck === 'checking'}>
              <Text style={styles.serverBtnText}>{serverCheck === 'checking' ? '…' : 'Check'}</Text>
            </Pressable>
          </View>
          {serverCheck && serverCheck !== 'checking' ? (
            serverCheck.error ? (
              <Text style={styles.error}>{serverCheck.error}</Text>
            ) : (
              <>
                <Text style={styles.demoPassword}>
                  {serverCheck.api ? '✓' : '✗'} Backend :{API_PORT}   {serverCheck.keycloak ? '✓' : '✗'} Keycloak :{KEYCLOAK_PORT}
                </Text>
                {!serverCheck.api || !serverCheck.keycloak ? (
                  <Text style={styles.error}>Not reachable — check the IP, that the service is running, and the PC firewall.</Text>
                ) : null}
              </>
            )
          ) : null}
          <Text style={styles.demoPassword}>Realm: oms-upcl · Client: oms-mobile</Text>
        </View>
        <Text style={styles.loginFooter}>Crew access only · Offline capable</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// One chip in the header's action bar. `on` shows a status dot (green = on),
// `count` a small bubble, `danger` the red sign-out style.
function HeaderAction({ label, on, count, danger, onPress, disabled, accessibilityLabel }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.action,
        on && styles.actionOn,
        danger && styles.actionDanger,
        pressed && styles.actionPressed,
        disabled && styles.actionDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
    >
      {on !== undefined && <View style={[styles.actionDot, on && styles.actionDotOn]} />}
      <Text style={[styles.actionText, danger && styles.actionTextDanger]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {label}
      </Text>
      {count > 0 && (
        <View style={styles.actionCount}>
          <Text style={styles.actionCountText}>{count > 99 ? '99+' : count}</Text>
        </View>
      )}
    </Pressable>
  );
}

function Stat({ value, label, active, onPress }) {
  const content = (
    <>
      <Text style={[styles.statValue, active && styles.statValueActive]}>{value}</Text>
      <Text style={[styles.statLabel, active && styles.statLabelActive]}>{label}</Text>
    </>
  );
  if (!onPress) return <View style={styles.stat}>{content}</View>;
  return (
    <Pressable
      style={({ pressed }) => [styles.stat, active && styles.statActive, pressed && { opacity: 0.7 }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={`${label}: ${value}`}
    >
      {content}
    </Pressable>
  );
}

function JobCard({ job, onPress }) {
  const severity = job.severity || 'Medium';
  const color = (severityColors && severityColors[severity]) || '#2f6fd6';
  return (
    <Pressable onPress={onPress} style={styles.card}>
      <View style={[styles.severity, { backgroundColor: color }]} />
      <View style={styles.cardBody}>
        <View style={styles.row}>
          <Text style={styles.jobId}>{job.id || 'JOB-—'}</Text>
          <Text style={styles.status}>{job.status || 'Unknown status'}</Text>
        </View>
        <View style={[styles.severityBadge, { backgroundColor: color }]}>
          <Text style={styles.severityBadgeText}>{severity.toUpperCase()}</Text>
        </View>
        <Text style={styles.jobTitle}>{job.title || 'Untitled job'}</Text>
        <Text style={styles.address}>{job.address || 'Location not available'}</Text>
        <View style={styles.row}>
          <Text style={styles.meta}>{job.distance || 'Distance unknown'}</Text>
          <Text style={styles.meta}>{job.customers ?? 0} customers</Text>
        </View>
      </View>
    </Pressable>
  );
}

function PhotoCamera({ onCapture, onClose }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!permission) return <Text style={styles.assetValue}>Loading camera…</Text>;
  if (!permission.granted) {
    return (
      <View style={styles.photoCameraPermission}>
        <Text style={styles.assetValue}>Camera access is required to capture job evidence.</Text>
        <Pressable style={styles.primaryBtn} onPress={requestPermission}>
          <Text style={styles.primaryBtnText}>Allow camera</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={onClose}>
          <Text style={styles.secondaryBtnText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const capture = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    setError('');
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      await onCapture(photo);
    } catch (err) {
      setError(err?.message || 'Could not capture the photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.photoCamera}>
      <CameraView ref={cameraRef} style={styles.photoCameraPreview} facing="back" />
      {error ? <Text style={styles.photoCameraError}>{error}</Text> : null}
      <View style={styles.photoCameraActions}>
        <Pressable style={styles.secondaryBtn} onPress={onClose} disabled={busy}>
          <Text style={styles.secondaryBtnText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.primaryBtn} onPress={capture} disabled={busy}>
          <Text style={styles.primaryBtnText}>{busy ? 'Saving…' : 'Capture photo'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function JobDetail({ job, crew, onClose, onAdvance, onQueued, onNavigate, onNavigateNative }) {
  const [showSafety, setShowSafety] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showPhotoCamera, setShowPhotoCamera] = useState(false);
  const [assetId, setAssetId] = useState('');
  const [assetDetails, setAssetDetails] = useState(null);
  const [assetScans, setAssetScans] = useState([]);
  const [assetScanSaving, setAssetScanSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [photoCount, setPhotoCount] = useState(0);
  const [omsMessages, setOmsMessages] = useState([]);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [checklistDone, setChecklistDone] = useState(false);

  // Completion flow: fault diagnosis -> parts used -> crew-lead sign-off.
  // Gates the final "Work Started" -> "Work Complete" transition.
  const [completionStep, setCompletionStep] = useState(null); // null | 'diagnosis' | 'parts' | 'signoff'
  const [diagnosis, setDiagnosis] = useState(null);
  const [partsUsed, setPartsUsed] = useState(null);
  const [signOff, setSignOff] = useState(null);

  useEffect(() => {
    // Photos still waiting in Pending sync count too, so a crew with no
    // signal on site is not blocked by the photo rule below.
    Promise.all([
      getJobPhotos(job.id).then((photos) => (Array.isArray(photos) ? photos.length : 0)).catch(() => 0),
      getQueueItems().then((items) => items.filter((i) => i.type === 'photo' && i.id === job.id).length).catch(() => 0),
    ]).then(([sent, queued]) => setPhotoCount(sent + queued));
    getAssetScans(job.id).then((scans) => setAssetScans(Array.isArray(scans) ? scans : [])).catch(() => {});
  }, [job.id]);

  const next = NEXT_STATUS[job.status];

  const requestAdvance = async () => {
    if (!next || !checklistDone) return;
    if (job.status === 'On Site') {
      // At least one site photo before work can start; asset scans stay optional.
      if (photoCount < 1) {
        setMessage('Take at least one site photo before starting work. Scanning the asset QR is optional.');
        return;
      }
      setShowSafety(true);
      return;
    }
    if (job.status === 'Work Started') {
      setCompletionStep('diagnosis');
      return;
    }
    setAdvancing(true);
    try {
      await onAdvance(job, next);
    } finally {
      setAdvancing(false);
    }
  };

  const finishCompletion = (finalSignOff) => {
    setSignOff(finalSignOff);
    setCompletionStep(null);
    // Diagnosis / parts / sign-off aren't sent to the backend yet — the
    // OMS mobile contract only defines status + photo endpoints. They're
    // captured here and shown in-app; ask the integration track for a
    // completion-details endpoint if this should be persisted server-side.
    setAdvancing(true);
    Promise.resolve(onAdvance(job, next)).finally(() => setAdvancing(false));
  };

  const takePhoto = () => {
    if (photoCount >= MAX_JOB_PHOTOS) {
      setMessage(`Photo limit reached: ${MAX_JOB_PHOTOS} photos for this job.`);
      return;
    }
    setMessage('');
    setShowPhotoCamera(true);
  };

  const saveCapturedPhoto = async (photo) => {
    setUploading(true);
    try {
      const result = await uploadCapturedPhoto(job.id, photo, assetId ? `Asset: ${assetId}` : undefined, crew);
      setPhotoCount((count) => count + 1);
      if (result?.queued) {
        onQueued?.();
        setMessage(`No signal: photo ${photoCount + 1} of ${MAX_JOB_PHOTOS} saved on the phone. It uploads by itself once there is signal (see Pending sync).`);
      } else {
        setMessage(`Photo ${photoCount + 1} of ${MAX_JOB_PHOTOS} stored as compressed WebP.`);
      }
      setShowPhotoCamera(false);
    } catch (err) {
      setMessage(err?.message || 'Photo upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const loadMessages = async () => {
    setMessagesOpen(true);
    setMessagesLoading(true);
    try {
      const items = await getJobMessages(job.id);
      setOmsMessages(Array.isArray(items) ? items : []);
    } catch (err) {
      setMessage(err?.message || 'Could not load OMS messages.');
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleAssetScan = async (rawValue) => {
    setAssetScanSaving(true);
    setMessage('Saving asset scan…');
    try {
      let parsedDetails = {};
      try {
        const parsed = JSON.parse(rawValue);
        if (parsed && typeof parsed === 'object') parsedDetails = parsed;
      } catch {
        parsedDetails = { value: rawValue };
      }
      const location = await getLocation({ allowCached: false });
      if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon)) {
        throw new Error('Location not available. Asset scan was not stored. Enable GPS and try again.');
      }
      const scan = {
        rawValue,
        assetId: parsedDetails.assetId || parsedDetails.asset_id || parsedDetails.id || parsedDetails.tag || rawValue,
        assetDetails: parsedDetails,
        lat: location.lat,
        lon: location.lon,
        crewId: crew?.id,
      };
      let saved;
      let queued = false;
      try {
        saved = await saveAssetScan(job.id, scan);
      } catch (err) {
        // No signal: keep the scan for pending sync instead of losing it.
        if (!isRetryable(err)) throw err;
        await queueScan(job.id, scan);
        onQueued?.();
        queued = true;
        saved = { id: `pending-${Date.now()}`, asset_id: scan.assetId, asset_details: parsedDetails, lat: scan.lat, lon: scan.lon, scanned_at: new Date().toISOString(), pending: true };
      }
      setAssetId(saved.asset_id || saved.assetId || rawValue);
      setAssetDetails(saved.asset_details || parsedDetails);
      setAssetScans((current) => [saved, ...current]);
      setShowScanner(false);
      setMessage(queued
        ? 'No signal: asset scan saved on the phone. It uploads by itself once there is signal (see Pending sync).'
        : 'Asset QR details stored in the database.');
    } catch (err) {
      setMessage(err?.message || 'Asset scan could not be stored.');
    } finally {
      setAssetScanSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.detailSafe}>
      <View style={styles.detailHeader}>
        <Pressable onPress={onClose}>
          <Text style={styles.detailBack}>← Back</Text>
        </Pressable>
        <Text style={styles.detailId}>{job.id}</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.detailContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={[styles.jobTitle, { fontSize: 22 }]}>{job.title}</Text>
        <Text style={styles.address}>📍 {job.address}</Text>
        <View style={styles.detailStats}>
          <View>
            <Text style={styles.statLabel}>Feeder</Text>
            <Text style={styles.statValue}>{job.feeder ?? '—'}</Text>
          </View>
          <View>
            <Text style={styles.statLabel}>Customers</Text>
            <Text style={styles.statValue}>{job.customers ?? '—'}</Text>
          </View>
          <View>
            <Text style={styles.statLabel}>Status</Text>
            <Text style={styles.statValue}>{job.status}</Text>
          </View>
        </View>

        <PriorityChecklist severity={job.severity} onChange={setChecklistDone} />

        {!checklistDone && (
          <View style={styles.checklistLock}>
            <Text style={styles.checklistLockText}>
              Complete the priority checklist above to unlock the rest of this job.
            </Text>
          </View>
        )}

        {checklistDone && showSafety && (
          <SafetyChecklist
            onPass={() => {
              setShowSafety(false);
              setAdvancing(true);
              Promise.resolve(onAdvance(job, next)).finally(() => setAdvancing(false));
            }}
            onCancel={() => setShowSafety(false)}
          />
        )}

        {checklistDone && completionStep === 'diagnosis' && (
          <FaultDiagnosisWizard
            onComplete={(answers) => {
              setDiagnosis(answers);
              setCompletionStep('parts');
            }}
            onCancel={() => setCompletionStep(null)}
          />
        )}

        {checklistDone && completionStep === 'parts' && (
          <PartsPicker
            onComplete={(parts) => {
              setPartsUsed(parts);
              setCompletionStep('signoff');
            }}
            onCancel={() => setCompletionStep('diagnosis')}
          />
        )}

        {checklistDone && completionStep === 'signoff' && (
          <CrewLeadSignOff
            onComplete={finishCompletion}
            onCancel={() => setCompletionStep('parts')}
          />
        )}

        {checklistDone && signOff && (
          <View style={styles.completionSummary}>
            <Text style={styles.completionSummaryTitle}>Job closed out</Text>
            {diagnosis && (
              <Text style={styles.completionSummaryLine}>
                Cause: {diagnosis.cause} · Action: {diagnosis.action}
              </Text>
            )}
            {partsUsed && partsUsed.length > 0 && (
              <Text style={styles.completionSummaryLine}>
                Parts: {partsUsed.map((p) => `${p.name} ×${p.qty}`).join(', ')}
              </Text>
            )}
            <Text style={styles.completionSummaryLine}>
              Signed off by {signOff.name} at {new Date(signOff.signedAt).toLocaleTimeString()}
            </Text>
          </View>
        )}

        {checklistDone && (
        <Pressable style={styles.secondaryBtn} onPress={() => {
          onNavigate(job);
        }}>
          <Text style={styles.secondaryBtnText}>Navigate to site</Text>
        </Pressable>
        )}
        {checklistDone && onNavigateNative && (
        <Pressable style={styles.secondaryBtn} onPress={() => onNavigateNative(job)}>
          <Text style={styles.secondaryBtnText}>Navigate (new map)</Text>
        </Pressable>
        )}

        {checklistDone && (
        <Pressable style={styles.secondaryBtn} onPress={loadMessages}>
          <Text style={styles.secondaryBtnText}>Messages from OMS server</Text>
        </Pressable>
        )}
        {checklistDone && messagesOpen && (
          <View style={styles.messagesPanel}>
            <View style={styles.messagesHeader}>
              <Text style={styles.sectionSmall}>OMS JOB MESSAGES</Text>
              <Pressable onPress={() => setMessagesOpen(false)}>
                <Text style={styles.messagesClose}>Close</Text>
              </Pressable>
            </View>
            {messagesLoading ? <Text style={styles.assetValue}>Fetching messages…</Text> : null}
            {!messagesLoading && !omsMessages.length ? <Text style={styles.assetValue}>No messages from OMS yet.</Text> : null}
            {omsMessages.map((item) => (
              <View key={item.id} style={styles.messageRow}>
                <Text style={styles.messageBody}>{item.body}</Text>
                <Text style={styles.messageMeta}>{item.sender} · {new Date(item.ts).toLocaleString()}</Text>
              </View>
            ))}
          </View>
        )}

        {checklistDone && (
        <View style={styles.assetRow}>
          <Text style={styles.sectionSmall}>ASSET SCAN</Text>
          {assetId ? <Text style={styles.assetValue}>Attached asset: {assetId}</Text> : null}
          {assetDetails ? <Text style={styles.assetValue}>QR details: {JSON.stringify(assetDetails)}</Text> : null}
          <Text style={styles.assetValue}>Saved scans: {assetScans.length}</Text>
          <Pressable style={styles.secondaryBtn} onPress={() => setShowScanner(true)} disabled={assetScanSaving}>
            <Text style={styles.secondaryBtnText}>Scan QR asset tag</Text>
          </Pressable>
        </View>
        )}

        {checklistDone && showScanner && (
          <View style={styles.scannerWrap}>
            <QrScanner
              onScan={handleAssetScan}
              onClose={() => setShowScanner(false)}
            />
          </View>
        )}

        {checklistDone && (
        <Pressable style={styles.secondaryBtn} onPress={takePhoto} disabled={uploading || photoCount >= MAX_JOB_PHOTOS}>
          <Text style={styles.secondaryBtnText}>{uploading ? 'Compressing and storing…' : `Open camera (${photoCount}/${MAX_JOB_PHOTOS})`}</Text>
        </Pressable>
        )}
        {checklistDone && showPhotoCamera && <PhotoCamera onCapture={saveCapturedPhoto} onClose={() => setShowPhotoCamera(false)} />}
        {message ? <Text style={styles.assetValue}>{message}</Text> : null}

        {checklistDone && job.status === 'On Site' && photoCount < 1 && (
          <View style={styles.checklistLock}>
            <Text style={styles.checklistLockText}>
              Photo required: take at least one site photo to start work. Scanning the asset QR is optional.
            </Text>
          </View>
        )}

        {checklistDone && next && !completionStep && (
          <Pressable
            style={[styles.primaryBtn, job.status === 'On Site' && photoCount < 1 && { opacity: 0.5 }]}
            onPress={requestAdvance}
            disabled={advancing}
          >
            <Text style={styles.primaryBtnText}>
              {advancing ? 'Updating status…' : job.status === 'Pending Acceptance' ? 'Accept task' : `${next} →`}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatMb(bytes) {
  return `${Math.max(1, Math.round((bytes || 0) / 1048576))} MB`;
}

function MapScreen({ jobs, selectedJobId, onSelect, crew, navJobId, onExitNav }) {
  // Navigation mode: only the job being navigated to is shown and selected.
  const navJob = navJobId ? jobs.find((job) => job.id === navJobId) || null : null;
  const visibleJobs = navJob ? [navJob] : jobs;
  const selectedJob = navJob || jobs.find((job) => job.id === selectedJobId);
  const selectedId = selectedJob?.id;
  const mapRef = useRef(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [mapLocation, setMapLocation] = useState(null);
  const [pack, setPack] = useState(null);
  const [packStatus, setPackStatus] = useState(getPackStatus);
  const [routing, setRouting] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    Network.getNetworkStateAsync().then((state) => setOnline(isOnlineState(state))).catch(() => {});
    const subscription = Network.addNetworkStateListener((state) => setOnline(isOnlineState(state)));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    getJobsLastSyncedAt().then(setLastSyncedAt).catch(() => {});
    getInstalledPack().then(setPack).catch(() => {});
    let lastPhase = getPackStatus().phase;
    return subscribePackStatus((next) => {
      setPackStatus(next);
      // Re-read on phase changes so the map picks up a newly-activated pack
      // (first tiles of a fresh install, or a completed upgrade).
      if (next.phase !== lastPhase) getInstalledPack().then(setPack).catch(() => {});
      lastPhase = next.phase;
    });
  }, []);

  // Live GPS dot while the map is open. GPS needs no internet; falls back
  // to the last cached fix, then the crew record from the server.
  useEffect(() => {
    let sub = null;
    let cancelled = false;
    getLastKnownLocation().then((cached) => {
      if (cancelled) return;
      if (Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) setMapLocation((cur) => cur || cached);
      else if (Number.isFinite(Number(crew?.lat)) && Number.isFinite(Number(crew?.lon))) {
        setMapLocation((cur) => cur || { lat: Number(crew.lat), lon: Number(crew.lon) });
      }
    }).catch(() => {});
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => {
        if (cancelled || status !== 'granted') return null;
        return Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 10 },
          (pos) => setMapLocation({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            // lets the map point the crew arrow the way they are driving
            heading: pos.coords.heading,
            speed: pos.coords.speed,
          })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mapJobs = useMemo(
    () => visibleJobs
      .filter((job) => Number.isFinite(job.coordinates?.lat) && Number.isFinite(job.coordinates?.lon))
      .map((job) => ({
        id: job.id,
        title: `${job.title} · ${job.id}`,
        lat: job.coordinates.lat,
        lon: job.coordinates.lon,
        color: severityColors[job.severity] || severityColors.Critical,
        selected: job.id === selectedId,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, navJobId, selectedId]
  );

  const hasLocation = Number.isFinite(mapLocation?.lat) && Number.isFinite(mapLocation?.lon);
  const downloading = packStatus.phase === 'downloading' || packStatus.phase === 'checking';
  const canDownload = canUseMapServer() && !downloading;

  // In navigation mode the map follows the crew, keeping both them and the
  // site in view, until they pan the map themselves ("Show route" resumes).
  const [following, setFollowing] = useState(Boolean(navJobId));
  useEffect(() => {
    setFollowing(Boolean(navJobId));
  }, [navJobId]);

  // A marker tap or arriving from "Navigate to site": frame both the crew and
  // the job so the dashed guide line shows the whole way there.
  useEffect(() => {
    if (selectedId) mapRef.current?.fit('guide');
  }, [selectedId]);

  useEffect(() => {
    if (navJob && following && hasLocation) mapRef.current?.fit('guide');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLocation, following]);

  const showRoute = () => {
    setFollowing(Boolean(navJob));
    mapRef.current?.fit('guide');
  };

  const guide = selectedJob ? distanceAndDirection(mapLocation, selectedJob.coordinates) : null;

  // Road route to the selected job: from the server when online, else from
  // the road graph on the phone. Recomputed when the crew has moved ~75 m,
  // the job changes, or connectivity changes.
  const [route, setRoute] = useState(null);
  // Metres left along the road from where the map draws the crew arrow, so the
  // readout counts down while driving (null when off the route or none yet).
  const [routeLeft, setRouteLeft] = useState(null);
  const routeRequest = useRef({ seq: 0, key: null, from: null });
  useEffect(() => {
    preloadRoadGraph(pack?.roadsUri);
  }, [pack?.roadsUri]);
  const target = selectedJob?.coordinates;
  useEffect(() => {
    const req = routeRequest.current;
    if (!selectedId || !hasLocation || !Number.isFinite(target?.lat) || !Number.isFinite(target?.lon)) {
      req.key = null;
      setRoute(null);
      return;
    }
    const key = `${selectedId}|${online}|${pack?.roadsUri || ''}`;
    const moved = req.from ? distanceAndDirection(req.from, mapLocation)?.meters ?? Infinity : Infinity;
    if (key === req.key && moved < 75) return;
    if (key !== req.key) setRoute(null); // never show another job's route
    req.key = key;
    req.from = { lat: mapLocation.lat, lon: mapLocation.lon };
    const seq = ++req.seq;
    getRoadRoute(req.from, target, { online, roadsUri: pack?.roadsUri })
      .then((next) => {
        if (seq === routeRequest.current.seq) setRoute(next);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, target?.lat, target?.lon, mapLocation, online, pack?.roadsUri]);

  // Live "x km to go": the map's figure while the crew is on the route, else
  // the length of the whole route as last computed.
  const roadLeft = route ? (Number.isFinite(routeLeft) ? routeLeft : route.meters) : null;
  const arrived = Boolean(selectedJob) && ((route && Number.isFinite(routeLeft) && routeLeft < 30) || (guide && guide.meters < 40));

  // Frame the route the first time it arrives for a job.
  const framedRouteFor = useRef(null);
  useEffect(() => {
    if (route && framedRouteFor.current !== selectedId) {
      framedRouteFor.current = selectedId;
      mapRef.current?.fit('guide');
    }
  }, [route, selectedId]);

  const startDownload = () => {
    downloadPack().catch(() => {}); // errors surface through packStatus
  };

  const startMultiJobRoute = async () => {
    setRouting(true);
    try {
      await openMultiJobRoute(jobs);
    } finally {
      setRouting(false);
    }
  };

  let packLine;
  if (pack?.web) {
    packLine = 'Online map · needs internet (the offline map is in the phone app)';
  } else if (downloading) {
    packLine = packStatus.total
      ? `Downloading offline map · ${Math.floor((packStatus.done / packStatus.total) * 100)}% (${packStatus.done}/${packStatus.total} tiles)`
      : 'Checking for offline map…';
  } else if (packStatus.phase === 'error') {
    packLine = packStatus.error;
  } else if (pack?.complete) {
    packLine = `Offline map ready · ${(pack.regions || []).filter((r) => r.id !== 'corridor').map((r) => r.name).join(', ') || 'service area'} · works without internet`;
  } else if (pack) {
    packLine = 'Offline map partially downloaded — resume to finish.';
  } else {
    packLine = canUseMapServer()
      ? 'Offline map not downloaded yet. Download it on Wi-Fi before heading out.'
      : 'Sign in to download the offline map.';
  }

  return (
    <View>
      <Text style={styles.title}>{navJob ? 'Navigating to site' : 'Outage map'}</Text>
      <Text style={styles.subtitle}>
        {hasLocation
          ? `Your position ${mapLocation.lat.toFixed(4)}, ${mapLocation.lon.toFixed(4)}`
          : lastSyncedAt
            ? `Job locations cached ${timeAgo(lastSyncedAt)}`
            : 'Waiting for GPS fix…'}
      </Text>

      <View style={styles.offlineBadgeRow}>
        <View style={[styles.offlineDot, pack?.complete ? styles.offlineDotOn : styles.offlineDotOff]} />
        <Text style={styles.offlineBadgeText}>{packLine}</Text>
      </View>
      {downloading && packStatus.total > 0 && (
        <View style={styles.packProgressTrack}>
          <View style={[styles.packProgressFill, { width: `${(packStatus.done / packStatus.total) * 100}%` }]} />
        </View>
      )}
      {!pack?.complete && canDownload && (
        <Pressable style={styles.routeAllBtn} onPress={startDownload}>
          <Text style={styles.routeAllBtnText}>
            {pack ? 'Resume offline map download' : 'Download offline map (Dehradun · Rishikesh · Haridwar)'}
          </Text>
        </Pressable>
      )}
      {downloading && (
        <Pressable style={[styles.mapControlButton, styles.packPauseBtn]} onPress={cancelPackDownload}>
          <Text style={styles.mapControlText}>Pause download</Text>
        </Pressable>
      )}

      {pack?.complete && !pack.web && !pack.roadsUri && canDownload && (
        <Pressable style={styles.routeAllBtn} onPress={startDownload}>
          <Text style={styles.routeAllBtnText}>Download offline road directions</Text>
        </Pressable>
      )}

      {!navJob && jobs.length > 1 && (
        <Pressable style={styles.routeAllBtn} disabled={routing} onPress={startMultiJobRoute}>
          <Text style={styles.routeAllBtnText}>
            {routing ? 'Opening route…' : `Route all ${jobs.length} jobs (turn-by-turn)`}
          </Text>
        </Pressable>
      )}

      <View style={styles.mapPanel}>
        <OfflineMap
          ref={mapRef}
          pack={pack}
          crew={mapLocation}
          jobs={mapJobs}
          route={route}
          onSelectJob={onSelect}
          onUserGesture={() => setFollowing(false)}
          onRouteProgress={setRouteLeft}
        />
        <Text style={styles.mapLegend}>
          ● You  ● {navJob ? (route ? 'Site  ━ Road route' : 'Site  - - Straight line to site') : 'Incidents (by severity)'}{pack?.complete && pack.totalBytes ? ` · ${formatMb(pack.totalBytes)} on device` : ''}
        </Text>
      </View>
      <View style={styles.mapControls}>
        <Pressable
          style={styles.mapControlButton}
          onPress={() => {
            setFollowing(false);
            mapRef.current?.fit('crew');
          }}
          disabled={!hasLocation}
        >
          <Text style={[styles.mapControlText, !hasLocation && styles.mapControlDisabled]}>Center on me</Text>
        </Pressable>
        {navJob ? (
          <Pressable style={styles.mapControlButton} onPress={showRoute}>
            <Text style={styles.mapControlText}>{following ? 'Following route' : 'Show route'}</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.mapControlButton} onPress={() => mapRef.current?.fit('jobs')} disabled={!mapJobs.length}>
            <Text style={[styles.mapControlText, !mapJobs.length && styles.mapControlDisabled]}>Fit jobs</Text>
          </Pressable>
        )}
      </View>
      {selectedJob ? (
        <View style={styles.mapSelectedCard}>
          <Text style={styles.mapSelectedTitle}>{selectedJob.title}</Text>
          <Text style={styles.mapSelectedMeta}>{selectedJob.id} · {selectedJob.address}</Text>
          {arrived ? (
            <Text style={[styles.mapGuideText, styles.mapArrivedText]}>You have reached the site</Text>
          ) : route ? (
            <Text style={styles.mapGuideText}>
              {formatDistance(roadLeft)} to go · about {formatDuration(route.meters > 0 ? (route.seconds * roadLeft) / route.meters : route.seconds)}
              {route.source === 'device' ? ' · offline directions' : ''}
            </Text>
          ) : guide ? (
            <Text style={styles.mapGuideText}>
              {guide.label} {guide.direction} of you (straight line{hasLocation && !pack?.roadsUri && !online ? ' — download road directions for a road route' : ''})
            </Text>
          ) : null}
          {navJob ? (
            <>
              {!online && (
                <View style={styles.mapOfflineNote}>
                  <Text style={styles.mapOfflineNoteTitle}>No internet — the offline map still works</Text>
                  <Text style={styles.mapOfflineNoteText}>Your position keeps updating without signal.</Text>
                </View>
              )}
              <Pressable style={styles.secondaryBtn} onPress={() => navigateTo(selectedJob.address, selectedJob.coordinates)}>
                <Text style={styles.secondaryBtnText}>
                  {online ? 'Turn-by-turn in Google Maps' : 'Try Google Maps (works if this area is downloaded offline)'}
                </Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={onExitNav}>
                <Text style={styles.secondaryBtnText}>Show all incidents</Text>
              </Pressable>
            </>
          ) : online ? (
            <Pressable style={styles.primaryBtn} onPress={() => navigateTo(selectedJob.address, selectedJob.coordinates)}>
              <Text style={styles.primaryBtnText}>Start turn-by-turn navigation</Text>
            </Pressable>
          ) : (
            <>
              <View style={styles.mapOfflineNote}>
                <Text style={styles.mapOfflineNoteTitle}>No internet — follow the offline map</Text>
                <Text style={styles.mapOfflineNoteText}>
                  {hasLocation
                    ? route
                      ? 'Follow the blue road route to the site; your position keeps updating without signal.'
                      : 'The dashed line points from you to the site. Use the streets on the map to get there; your position keeps updating without signal.'
                    : 'Waiting for a GPS fix to show the way from you to the site.'}
                </Text>
              </View>
              <Pressable style={styles.secondaryBtn} onPress={() => navigateTo(selectedJob.address, selectedJob.coordinates)}>
                <Text style={styles.secondaryBtnText}>Try Google Maps (works if this area is downloaded offline)</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : (
        <Text style={styles.mapEmpty}>Tap an incident marker to view its site.</Text>
      )}
    </View>
  );
}

function ProfileScreen({ crew, jobs, onLogout, onOpenNativeMap }) {
  const activeJobs = jobs.filter((job) => !isJobDone(job));
  return (
    <View>
      <Text style={styles.title}>My profile</Text>
      <Text style={styles.subtitle}>Crew identity and field assignment details.</Text>
      <View style={styles.profilePanel}>
        <View style={styles.profileAvatar}><Text style={styles.profileAvatarText}>{crew.name?.charAt(5) || 'C'}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName}>{crew.name}</Text>
          <Text style={styles.profileRole}>{crew.role} · {crew.id}</Text>
          <Text style={styles.profileLead}>Lead: {crew.lead || 'Assigned crew lead'}</Text>
        </View>
      </View>
      <View style={styles.profileGrid}>
        <Stat value={crew.shift || 'Day shift'} label="Shift" />
        <Stat value={String(activeJobs.length)} label="Active jobs" />
      </View>
      <View style={styles.profileDetails}>
        <Text style={styles.sectionSmall}>CREW DETAILS</Text>
        <Text style={styles.profileDetailLine}>Skills: {(crew.skills || ['Field operations']).join(', ')}</Text>
        <Text style={styles.profileDetailLine}>Status: Ready for assignment</Text>
        <Text style={styles.profileDetailLine}>Session: Offline capable</Text>
      </View>
      <Pressable style={styles.logoutBtn} onPress={onOpenNativeMap}>
        <Text style={styles.logoutBtnText}>New map (test)</Text>
      </Pressable>
      <Pressable style={styles.logoutBtn} onPress={onLogout}>
        <Text style={styles.logoutBtnText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  loginSafe: { flex: 1, backgroundColor: '#10201d' },
  login: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 48 },
  loginKicker: { color: '#27c7b2', fontSize: 13, fontWeight: '800', letterSpacing: 2 },
  loginTitle: { color: '#fff', fontSize: 32, fontWeight: '800', marginTop: 40 },
  loginSubtitle: { color: '#a8c0ba', fontSize: 14, marginTop: 8, marginBottom: 36 },
  label: { color: '#d8e7e2', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 16, marginBottom: 8 },
  error: { color: '#ffb5a8', fontSize: 12, marginTop: 10 },
  signIn: { backgroundColor: '#55d7be', borderRadius: 12, padding: 15, marginTop: 18, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  signInText: { color: '#062b24', fontSize: 14, fontWeight: '800' },
  signInArrow: { color: '#062b24', fontSize: 22, lineHeight: 18 },
  btnOff: { opacity: 0.5 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20 },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 2, borderColor: '#55d7be' },
  checkboxOn: { backgroundColor: '#55d7be' },
  checkboxLabel: { color: '#d8e7e2', fontSize: 13 },
  demoBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 10 },
  demoBtnText: { color: '#a8c0ba', fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  demoBtnHint: { color: '#5f7b74', fontSize: 11, textAlign: 'center', marginTop: 4 },
  demo: { backgroundColor: 'rgba(255,255,255,.06)', borderRadius: 12, padding: 14, marginTop: 24 },
  demoLabel: { color: '#7f9b94', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  demoText: { color: '#d8e7e2', fontSize: 13, fontWeight: '700', marginTop: 8 },
  demoPassword: { color: '#8eaaa2', fontSize: 12, marginTop: 4 },
  serverRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  serverInput: { flex: 1, color: '#fff', fontSize: 14, borderWidth: 1, borderColor: '#2f4a44', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  serverBtn: { backgroundColor: '#2f4a44', borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  serverBtnText: { color: '#d8e7e2', fontSize: 13, fontWeight: '800' },
  loginFooter: { color: '#77938c', fontSize: 11, textAlign: 'center', marginTop: 'auto', paddingBottom: 24 },
  safe: { flex: 1, backgroundColor: '#f2f5f9' },
  center: { alignItems: 'center', justifyContent: 'center' },
  locationOffBanner: { backgroundColor: '#B42318', marginHorizontal: 14, marginTop: 10, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  locationOffTitle: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  locationOffText: { color: '#FFE4E1', fontSize: 13, marginTop: 2 },
  header: { backgroundColor: '#173355', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14, borderBottomLeftRadius: 18, borderBottomRightRadius: 18 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerIdentity: { flex: 1, marginRight: 12 },
  actionBar: { flexDirection: 'row', gap: 8, marginTop: 14 },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 36, paddingHorizontal: 6, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  actionOn: { backgroundColor: 'rgba(39,199,178,0.16)', borderColor: 'rgba(39,199,178,0.45)' },
  actionDanger: { backgroundColor: 'rgba(240,110,98,0.12)', borderColor: 'rgba(240,110,98,0.4)' },
  actionPressed: { opacity: 0.7 },
  actionDisabled: { opacity: 0.5 },
  actionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#6f8aa8', marginRight: 6 },
  actionDotOn: { backgroundColor: '#27c7b2' },
  actionText: { color: '#e3eef9', fontSize: 12, fontWeight: '700', flexShrink: 1 },
  actionTextDanger: { color: '#ffb3ab' },
  actionCount: { minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 4, marginLeft: 5, backgroundColor: '#e08a1e', alignItems: 'center', justifyContent: 'center' },
  actionCountText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  historyControls: { flexDirection: 'row', gap: 6 },
  historyButton: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#245675', alignItems: 'center', justifyContent: 'center' },
  historyButtonOff: { opacity: 0.35 },
  historyButtonText: { color: '#b9fff3', fontSize: 25, lineHeight: 25, fontWeight: '500' },
  headerRight: { alignItems: 'flex-end', gap: 6 },
  demoBadge: { backgroundColor: '#5a3fa6', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  demoBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  kicker: { color: '#27c7b2', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  crewName: { color: '#fff', fontSize: 21, fontWeight: '700', marginTop: 4 },
  role: { color: '#a7bdd6', fontSize: 12, marginTop: 3 },
  pendingBadge: { backgroundColor: '#e08a1e', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  pendingText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  content: { padding: 20, paddingBottom: 100 },
  title: { color: '#0f1b2d', fontSize: 26, fontWeight: '800' },
  subtitle: { color: '#7c8da3', fontSize: 14, marginTop: 5, marginBottom: 20 },
  stats: { flexDirection: 'row', gap: 9, marginBottom: 28 },
  stat: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 13, borderWidth: 1, borderColor: '#e6ecf3' },
  statValue: { color: '#173355', fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#7c8da3', fontSize: 11, marginTop: 4 },
  statActive: { backgroundColor: '#173355', borderColor: '#173355' },
  statValueActive: { color: '#fff' },
  statLabelActive: { color: '#c9d6e6' },
  section: { color: '#7c8da3', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 11 },
  pendingSection: { backgroundColor: '#fff7ea', borderRadius: 12, borderWidth: 1, borderColor: '#f2d9a8', padding: 14, marginBottom: 24, gap: 10 },
  pendingSectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pendingSectionTitle: { color: '#a8710f', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  pendingSectionSubtitle: { color: '#8a6a33', fontSize: 12, marginTop: -4 },
  pendingCountPill: { backgroundColor: '#e08a1e', borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  pendingCountPillText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  pendingItemRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pendingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#e08a1e' },
  pendingItemTitle: { color: '#5a3d10', fontSize: 13, fontWeight: '700' },
  pendingItemMeta: { color: '#8a6a33', fontSize: 11, marginTop: 1 },
  sectionSmall: { color: '#7c8da3', fontSize: 10, fontWeight: '800', letterSpacing: 1.2, marginBottom: 8 },
  card: { backgroundColor: '#fff', borderRadius: 13, flexDirection: 'row', marginBottom: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#e6ecf3' },
  severity: { width: 5 },
  cardBody: { flex: 1, padding: 15 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  jobId: { color: '#7c8da3', fontSize: 11, fontWeight: '700' },
  status: { color: '#33465f', backgroundColor: '#f2f5f9', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, fontWeight: '700' },
  severityBadge: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, marginTop: 8 },
  severityBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  jobTitle: { color: '#0f1b2d', fontSize: 16, fontWeight: '800', marginTop: 10 },
  address: { color: '#7c8da3', fontSize: 13, marginTop: 4 },
  meta: { color: '#33465f', fontSize: 12, fontWeight: '600', marginTop: 13 },
  empty: { paddingTop: 40 },
  nav: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e6ecf3', flexDirection: 'row', paddingTop: 10, paddingBottom: 12 },
  navItem: { flex: 1, alignItems: 'center' },
  navText: { color: '#7c8da3', fontSize: 12, fontWeight: '700' },
  navActive: { color: '#0e9f8e' },
  detailSafe: { flex: 1, backgroundColor: '#f2f5f9' },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 18, backgroundColor: '#173355' },
  detailBack: { color: '#b9fff3', fontWeight: '700' },
  detailId: { color: '#fff', fontWeight: '800' },
  detailContent: { padding: 20, gap: 14, paddingBottom: 80 },
  detailStats: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e6ecf3' },
  checklistLock: { backgroundColor: '#fff7ea', borderRadius: 10, borderWidth: 1, borderColor: '#f2d9a8', padding: 12 },
  checklistLockText: { color: '#8a6a33', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  secondaryBtn: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#1F3864', borderRadius: 10, padding: 12, alignItems: 'center' },
  secondaryBtnText: { color: '#1F3864', fontWeight: '700' },
  messagesPanel: { backgroundColor: '#eef5fb', borderRadius: 12, padding: 13, gap: 9 },
  messagesHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  messagesClose: { color: '#1F3864', fontSize: 12, fontWeight: '800' },
  messageRow: { backgroundColor: '#fff', borderRadius: 9, padding: 10, borderWidth: 1, borderColor: '#d8e4ef' },
  messageBody: { color: '#243b56', fontSize: 13, lineHeight: 18 },
  messageMeta: { color: '#7c8da3', fontSize: 10, marginTop: 5 },
  assetRow: { gap: 8 },
  assetValue: { color: '#33465f', fontSize: 13, fontWeight: '600' },
  scannerWrap: { minHeight: 560, marginBottom: 12, borderRadius: 12, overflow: 'hidden' },
  photoCamera: { backgroundColor: '#0f1b2d', borderRadius: 12, overflow: 'hidden', padding: 10, gap: 10 },
  photoCameraPreview: { height: 360, borderRadius: 9, overflow: 'hidden' },
  photoCameraError: { color: '#ffb5a8', fontSize: 12, paddingHorizontal: 4 },
  photoCameraActions: { flexDirection: 'row', gap: 9 },
  photoCameraPermission: { backgroundColor: '#eef5fb', borderRadius: 12, padding: 14, gap: 10 },
  primaryBtn: { backgroundColor: '#1F3864', borderRadius: 10, padding: 14, alignItems: 'center' },
  completionSummary: { backgroundColor: '#eafaf1', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#a9e3c4', gap: 4 },
  completionSummaryTitle: { color: '#1b7a4a', fontSize: 13, fontWeight: '800' },
  completionSummaryLine: { color: '#2f5d47', fontSize: 12 },
  primaryBtnText: { color: '#fff', fontWeight: '800' },
  offlineBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 14 },
  offlineDot: { width: 8, height: 8, borderRadius: 4 },
  offlineDotOn: { backgroundColor: '#2a9d5c' },
  offlineDotOff: { backgroundColor: '#c7d0dc' },
  offlineBadgeText: { color: '#7c8da3', fontSize: 12, flex: 1 },
  routeAllBtn: { backgroundColor: '#1F3864', borderRadius: 10, padding: 13, alignItems: 'center', marginBottom: 16 },
  routeAllBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  mapPanel: { backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#e6ecf3' },
  packProgressTrack: { height: 6, borderRadius: 3, backgroundColor: '#e6ecf3', overflow: 'hidden', marginTop: -6, marginBottom: 12 },
  packProgressFill: { height: 6, borderRadius: 3, backgroundColor: '#0e9f8e' },
  mapLegend: { color: '#7c8da3', fontSize: 11, marginTop: 10 },
  mapControls: { flexDirection: 'row', gap: 9, marginTop: 10 },
  mapControlButton: { flex: 1, backgroundColor: '#fff', borderRadius: 9, borderWidth: 1, borderColor: '#d5e0eb', paddingVertical: 10, alignItems: 'center' },
  mapControlText: { color: '#1F3864', fontSize: 12, fontWeight: '800' },
  mapControlDisabled: { color: '#aab6c4' },
  packPauseBtn: { flex: 0, marginBottom: 16 },
  mapSelectedCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginTop: 12, borderWidth: 1, borderColor: '#b9dcd3', gap: 8 },
  mapSelectedTitle: { color: '#173355', fontSize: 15, fontWeight: '800' },
  mapSelectedMeta: { color: '#7c8da3', fontSize: 12 },
  mapGuideText: { color: '#173355', fontSize: 14, fontWeight: '700' },
  mapArrivedText: { color: '#0e9f8e' },
  mapOfflineNote: { backgroundColor: '#fff7e6', borderRadius: 9, borderWidth: 1, borderColor: '#f0c36d', padding: 10, gap: 3 },
  mapOfflineNoteTitle: { color: '#8a5a00', fontSize: 13, fontWeight: '800' },
  mapOfflineNoteText: { color: '#6b5a3a', fontSize: 12 },
  mapEmpty: { color: '#7c8da3', fontSize: 13, marginTop: 16, textAlign: 'center' },
  profilePanel: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: '#fff', borderRadius: 13, padding: 16, borderWidth: 1, borderColor: '#e6ecf3' },
  profileAvatar: { width: 58, height: 58, borderRadius: 18, backgroundColor: '#173355', alignItems: 'center', justifyContent: 'center' },
  profileAvatarText: { color: '#fff', fontSize: 24, fontWeight: '800' },
  profileName: { color: '#0f1b2d', fontSize: 18, fontWeight: '800' },
  profileRole: { color: '#0e9f8e', fontSize: 12, fontWeight: '700', marginTop: 3 },
  profileLead: { color: '#7c8da3', fontSize: 12, marginTop: 5 },
  profileGrid: { flexDirection: 'row', gap: 9, marginTop: 12 },
  profileDetails: { backgroundColor: '#fff', borderRadius: 12, padding: 15, marginTop: 12, borderWidth: 1, borderColor: '#e6ecf3', gap: 10 },
  profileDetailLine: { color: '#33465f', fontSize: 13 },
  logoutBtn: { marginTop: 18, padding: 14, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: '#efc9c4', backgroundColor: '#fff' },
  logoutBtnText: { color: '#bd3e32', fontWeight: '800' },
});
