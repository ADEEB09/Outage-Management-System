import { useEffect, useState, useCallback, Component } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import LoginWebView from './components/LoginWebView';
import {
  restoreSession,
  logout as authLogout,
  isAuthenticated,
  isBiometricEnabled,
  setBiometricEnabled,
} from './lib/auth';
import { biometricUnlock } from './lib/biometric';
import { getLockoutStatus, recordFailedAttempt, resetAttempts as resetLoginAttempts, MAX_ATTEMPTS, LOCKOUT_MS } from './lib/lockout';
import { getCurrentCrew, getMyJobs, updateJobStatus, getJobsLastSyncedAt } from './lib/api.js';
import { getLocation } from './lib/location';
import { captureAndUpload } from './lib/photos';
import { navigateTo } from './lib/navigate';
import { openMultiJobRoute } from './lib/routing';
import { queueUpdate, flushQueue, getQueueLength, getQueueItems } from './lib/offlineQueue';
import SafetyChecklist from './components/SafetyChecklist';
import QrScanner from './components/QrScanner';
import * as PriorityChecklistModule from './components/PriorityChecklist';
const PriorityChecklist = PriorityChecklistModule.default || PriorityChecklistModule;
import FaultDiagnosisWizard from './components/FaultDiagnosisWizard';
import PartsPicker from './components/PartsPicker';
import CrewLeadSignOff from './components/CrewLeadSignOff';

const FALLBACK_JOBS = [
  { id: 'JOB-1005', title: 'Pending Line Inspection', address: 'Mussoorie Road, Dehradun', severity: 'High', status: 'Pending Acceptance', customers: 386, distance: '1.6 km' },
  { id: 'JOB-1001', title: 'Transformer Failure', address: 'Rajpur Road, Dehradun', severity: 'Critical', status: 'Acknowledged', customers: 842, distance: '2.4 km' },
  { id: 'JOB-1002', title: 'Line Fault', address: 'Haridwar Road, Rishikesh', severity: 'High', status: 'En Route', customers: 531, distance: '5.8 km' },
];

const NEXT_STATUS = {
  'Pending Acceptance': 'Acknowledged',
  Acknowledged: 'En Route',
  'En Route': 'On Site',
  'On Site': 'Work Started',
  'Work Started': 'Work Complete',
};

// Severity color coding: High -> orange, Medium -> blue, Low -> green,
// Critical -> red. Kept local (not imported) so this file can never crash
// due to a missing/misnamed export in another file.
const severityColors = { Critical: '#d7382a', High: '#e08a1e', Medium: '#2f6fd6', Low: '#2a9d5c' };

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
    <AppErrorBoundary>
      <NativeAppScreen />
    </AppErrorBoundary>
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
  const [checkingSession, setCheckingSession] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [needsBiometric, setNeedsBiometric] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState('');
  const [biometricOn, setBiometricOn] = useState(false);
  const [crew, setCrew] = useState({ name: 'Crew Gamma-2', role: 'Field Technician', id: 'C003' });
  const [jobs, setJobs] = useState(FALLBACK_JOBS);
  const [tab, setTab] = useState('Jobs');
  const [activeJob, setActiveJob] = useState(null);
  const [mapJobId, setMapJobId] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingItems, setPendingItems] = useState([]);

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

  const refresh = useCallback(() => {
    if (!authenticated) return;
    getCurrentCrew().then(setCrew).catch(() => {});
    getMyJobs().then((items) => items?.length && setJobs(items)).catch(() => {});
  }, [authenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Flush any status updates that were queued while offline whenever we
  // have a session, and again periodically.
  useEffect(() => {
    if (!authenticated) return;
    const sync = () => {
      if (!isAuthenticated()) {
        // Demo mode has no real backend to flush against, and re-fetching
        // demo jobs would just overwrite locally-advanced statuses — only
        // refresh the pending list for display.
        getQueueItems()
          .then((items) => {
            setPendingItems(items);
            setPendingCount(items.length);
          })
          .catch(() => {});
        return;
      }
      flushQueue()
        .then(() => getQueueItems())
        .then((items) => {
          setPendingItems(items);
          setPendingCount(items.length);
        })
        .then(refresh)
        .catch(() => {});
    };
    sync();
    const interval = setInterval(sync, 30000);
    return () => clearInterval(interval);
  }, [authenticated, refresh]);

  const handleAdvance = useCallback(async (job, nextStatus) => {
    const location = await getLocation();
    setJobs((current) => current.map((j) => (j.id === job.id ? { ...j, status: nextStatus } : j)));

    // Demo mode has no real backend to sync with — queue immediately so
    // the pending-sync section actually shows something, instead of the
    // update silently "succeeding" against nothing.
    if (!isAuthenticated()) {
      const queued = { id: job.id, status: nextStatus, location, queuedAt: Date.now() };
      await queueUpdate(queued);
      setPendingItems((current) => [...current, queued]);
      setPendingCount((n) => n + 1);
      return;
    }

    try {
      await updateJobStatus(job.id, nextStatus, location);
    } catch {
      const queued = { id: job.id, status: nextStatus, location, queuedAt: Date.now() };
      await queueUpdate(queued);
      setPendingItems((current) => [...current, queued]);
      setPendingCount((n) => n + 1);
    }
  }, []);;

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
            await authLogout();
            setNeedsBiometric(false);
            setAuthenticated(false);
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
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#173355" />
      <View style={styles.header}>
        <View>
          <Text style={styles.kicker}>OMS CREW</Text>
          <Text style={styles.crewName}>{crew.name}</Text>
          <Text style={styles.role}>{crew.role} · {crew.id}</Text>
        </View>
        <View style={styles.headerRight}>
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
          {isAuthenticated() && (
            <Pressable style={styles.online} onPress={toggleBiometric}>
              <Text style={styles.onlineText}>{biometricOn ? 'Biometric: On' : 'Enable biometric'}</Text>
            </Pressable>
          )}
          <Pressable
            style={styles.online}
            onPress={async () => {
              await authLogout();
              setAuthenticated(false);
            }}
          >
            <View style={styles.dot} />
            <Text style={styles.onlineText}>Sign out</Text>
          </Pressable>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {tab === 'Jobs' ? (
          <>
            <Text style={styles.title}>Today&apos;s field work</Text>
            <Text style={styles.subtitle}>Priority outages assigned to your crew.</Text>
            <View style={styles.stats}>
              <Stat value={String(jobs.length)} label="Active jobs" />
              <Stat value={jobs[0]?.distance ?? '—'} label="Next location" />
              <Stat value={String(jobs.reduce((sum, j) => sum + (j.customers || 0), 0))} label="Customers" />
            </View>

            {pendingItems.length > 0 && (
              <View style={styles.pendingSection}>
                <View style={styles.pendingSectionHeader}>
                  <Text style={styles.pendingSectionTitle}>PENDING SYNC</Text>
                  <View style={styles.pendingCountPill}>
                    <Text style={styles.pendingCountPillText}>{pendingItems.length}</Text>
                  </View>
                </View>
                <Text style={styles.pendingSectionSubtitle}>
                  These status updates didn't reach the server yet. They'll retry automatically.
                </Text>
                {pendingItems.map((item, i) => (
                  <View key={`${item.id}-${item.queuedAt ?? i}`} style={styles.pendingItemRow}>
                    <View style={styles.pendingDot} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pendingItemTitle}>{item.id} → {item.status}</Text>
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
              <JobCard key={job.id} job={job} onPress={() => setActiveJob(job)} />
            ))}
          </>
        ) : tab === 'Map' ? (
          <MapScreen jobs={jobs} selectedJobId={mapJobId} onSelect={setMapJobId} />
        ) : tab === 'Profile' ? (
          <ProfileScreen crew={crew} jobs={jobs} onLogout={async () => {
            await authLogout();
            setAuthenticated(false);
          }} />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.title}>{tab}</Text>
            <Text style={styles.subtitle}>This field workspace is ready for your next assignment.</Text>
          </View>
        )}
      </ScrollView>
      <View style={styles.nav}>
        {['Dashboard', 'Jobs', 'Map', 'Profile'].map((item) => (
          <Pressable
            key={item}
            onPress={() => setTab(item === 'Dashboard' ? 'Jobs' : item)}
            style={styles.navItem}
          >
            <Text style={[styles.navText, tab === (item === 'Dashboard' ? 'Jobs' : item) && styles.navActive]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>

      <Modal visible={!!activeJob} animationType="slide" onRequestClose={() => setActiveJob(null)}>
        {activeJob && (
          <JobDetail
            job={activeJob}
            onClose={() => setActiveJob(null)}
            onAdvance={handleAdvance}
            onNavigate={(job) => {
              setMapJobId(job.id);
              setActiveJob(null);
              setTab('Map');
            }}
          />
        )}
      </Modal>
    </SafeAreaView>
  );
}

function CrewLogin({ onSuccess }) {
  const [showWebView, setShowWebView] = useState(false);
  const [error, setError] = useState('');
  const [lockStatus, setLockStatus] = useState({ locked: false, remainingMs: 0, attempts: 0 });
  const [enableBiometricNext, setEnableBiometricNext] = useState(false);
  const busy = false; // WebView modal owns its own in-flight state now

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
    const current = await getLockoutStatus();
    if (current.locked) {
      setLockStatus(current);
      return;
    }
    setError('');
    setShowWebView(true);
  };

  const handleWebViewSuccess = async () => {
    setShowWebView(false);
    await resetLoginAttempts();
    if (enableBiometricNext) {
      const bOk = await biometricUnlock().catch(() => false);
      if (bOk) await setBiometricEnabled(true);
    }
    onSuccess();
  };

  const handleWebViewCancel = async () => {
    setShowWebView(false);
    const status = await recordFailedAttempt();
    setLockStatus(status);
    setError(
      status.locked
        ? `Too many failed attempts. Locked for ${Math.ceil(LOCKOUT_MS / 60000)} minutes.`
        : `Sign-in was cancelled or failed. ${MAX_ATTEMPTS - status.attempts} attempt(s) left.`
    );
  };

  const lockedMinutes = Math.ceil(lockStatus.remainingMs / 60000);

  return (
    <SafeAreaView style={styles.loginSafe}>
      <StatusBar barStyle="light-content" backgroundColor="#10201d" />
      <View style={styles.login}>
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
          style={[styles.signIn, lockStatus.locked && styles.btnOff]}
          disabled={lockStatus.locked}
          onPress={submit}
        >
          <Text style={styles.signInText}>
            {lockStatus.locked ? `Locked (${lockedMinutes} min)` : 'Sign in with Keycloak'}
          </Text>
          <Text style={styles.signInArrow}>→</Text>
        </Pressable>

        <LoginWebView
          visible={showWebView}
          onSuccess={handleWebViewSuccess}
          onCancel={handleWebViewCancel}
        />

        <Pressable style={styles.demoBtn} onPress={onSuccess}>
          <Text style={styles.demoBtnText}>Continue in demo mode</Text>
        </Pressable>
        <Text style={styles.demoBtnHint}>
          No backend/Keycloak reachable yet? Skip sign-in and explore the app with sample jobs.
        </Text>

        <View style={styles.demo}>
          <Text style={styles.demoLabel}>USES YOUR OMS ACCOUNT</Text>
          <Text style={styles.demoText}>Realm: oms-upcl · Client: oms-mobile</Text>
          <Text style={styles.demoPassword}>Configured in src/config.js</Text>
        </View>
        <Text style={styles.loginFooter}>Crew access only · Offline capable</Text>
      </View>
    </SafeAreaView>
  );
}

function Stat({ value, label }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
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

function JobDetail({ job, onClose, onAdvance, onNavigate }) {
  const [showSafety, setShowSafety] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [assetId, setAssetId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');

  // Completion flow: fault diagnosis -> parts used -> crew-lead sign-off.
  // Gates the final "Work Started" -> "Work Complete" transition.
  const [completionStep, setCompletionStep] = useState(null); // null | 'diagnosis' | 'parts' | 'signoff'
  const [diagnosis, setDiagnosis] = useState(null);
  const [partsUsed, setPartsUsed] = useState(null);
  const [signOff, setSignOff] = useState(null);

  const next = NEXT_STATUS[job.status];

  const requestAdvance = () => {
    if (!next) return;
    if (job.status === 'On Site') {
      setShowSafety(true);
      return;
    }
    if (job.status === 'Work Started') {
      setCompletionStep('diagnosis');
      return;
    }
    onAdvance(job, next);
  };

  const finishCompletion = (finalSignOff) => {
    setSignOff(finalSignOff);
    setCompletionStep(null);
    // Diagnosis / parts / sign-off aren't sent to the backend yet — the
    // OMS mobile contract only defines status + photo endpoints. They're
    // captured here and shown in-app; ask the integration track for a
    // completion-details endpoint if this should be persisted server-side.
    onAdvance(job, next);
  };

  const takePhoto = async () => {
    setUploading(true);
    setMessage('');
    try {
      await captureAndUpload(job.id, assetId ? `Asset: ${assetId}` : undefined);
      setMessage('Photo uploaded.');
    } catch (err) {
      setMessage(err?.message || 'Photo upload failed.');
    } finally {
      setUploading(false);
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
      <ScrollView contentContainerStyle={styles.detailContent}>
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

        <PriorityChecklist severity={job.severity} />

        {showSafety && (
          <SafetyChecklist
            onPass={() => {
              setShowSafety(false);
              onAdvance(job, next);
            }}
            onCancel={() => setShowSafety(false)}
          />
        )}

        {completionStep === 'diagnosis' && (
          <FaultDiagnosisWizard
            onComplete={(answers) => {
              setDiagnosis(answers);
              setCompletionStep('parts');
            }}
            onCancel={() => setCompletionStep(null)}
          />
        )}

        {completionStep === 'parts' && (
          <PartsPicker
            onComplete={(parts) => {
              setPartsUsed(parts);
              setCompletionStep('signoff');
            }}
            onCancel={() => setCompletionStep('diagnosis')}
          />
        )}

        {completionStep === 'signoff' && (
          <CrewLeadSignOff
            onComplete={finishCompletion}
            onCancel={() => setCompletionStep('parts')}
          />
        )}

        {signOff && (
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

        <Pressable style={styles.secondaryBtn} onPress={() => {
          onNavigate(job);
          navigateTo(job.address);
        }}>
          <Text style={styles.secondaryBtnText}>Navigate to site</Text>
        </Pressable>

        <View style={styles.assetRow}>
          <Text style={styles.sectionSmall}>ASSET SCAN</Text>
          {assetId ? <Text style={styles.assetValue}>Attached asset: {assetId}</Text> : null}
          <Pressable style={styles.secondaryBtn} onPress={() => setShowScanner(true)}>
            <Text style={styles.secondaryBtnText}>Scan QR asset tag</Text>
          </Pressable>
        </View>

        {showScanner && (
          <View style={styles.scannerWrap}>
            <QrScanner
              onScan={(data) => {
                setAssetId(data);
                setShowScanner(false);
              }}
              onClose={() => setShowScanner(false)}
            />
          </View>
        )}

        <Pressable style={styles.secondaryBtn} onPress={takePhoto} disabled={uploading}>
          <Text style={styles.secondaryBtnText}>{uploading ? 'Uploading to PostgreSQL…' : 'Upload photo to PostgreSQL'}</Text>
        </Pressable>
        {message ? <Text style={styles.assetValue}>{message}</Text> : null}

        {next && !completionStep && (
          <Pressable style={styles.primaryBtn} onPress={requestAdvance}>
            <Text style={styles.primaryBtnText}>
              {job.status === 'Pending Acceptance' ? 'Accept task' : `${next} →`}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function MapScreen({ jobs, selectedJobId, onSelect }) {
  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [routing, setRouting] = useState(false);

  useEffect(() => {
    getJobsLastSyncedAt().then(setLastSyncedAt).catch(() => {});
  }, [jobs]);

  const startMultiJobRoute = async () => {
    setRouting(true);
    try {
      await openMultiJobRoute(jobs);
    } finally {
      setRouting(false);
    }
  };

  return (
    <View>
      <Text style={styles.title}>Outage map</Text>
      <Text style={styles.subtitle}>Tap an incident to focus the crew route.</Text>

      <View style={styles.offlineBadgeRow}>
        <View style={[styles.offlineDot, lastSyncedAt ? styles.offlineDotOn : styles.offlineDotOff]} />
        <Text style={styles.offlineBadgeText}>
          {lastSyncedAt
            ? `Offline-ready · locations cached ${timeAgo(lastSyncedAt)}`
            : 'Not cached yet — connect once to enable offline job locations'}
        </Text>
      </View>

      {jobs.length > 1 && (
        <Pressable style={styles.routeAllBtn} disabled={routing} onPress={startMultiJobRoute}>
          <Text style={styles.routeAllBtnText}>
            {routing ? 'Opening route…' : `Route all ${jobs.length} jobs (turn-by-turn)`}
          </Text>
        </Pressable>
      )}

      <View style={styles.mapPanel}>
        <View style={styles.mapGrid}>
          <View style={styles.mapRoadOne} />
          <View style={styles.mapRoadTwo} />
          <View style={styles.mapRiver} />
          <View style={styles.mapCrewMarker}>●</View>
          {jobs.map((job, index) => (
            <Pressable
              key={job.id}
              style={[styles.mapJobMarker, styles[`mapMarker${index % 4}`], selectedJobId === job.id && styles.mapJobMarkerSelected]}
              onPress={() => onSelect(job.id)}
              accessibilityLabel={`Focus ${job.title}`}
            >
              <Text style={styles.mapMarkerText}>!</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.mapLegend}>● Crew  • Incidents  • Selected task</Text>
      </View>
      {selectedJob ? (
        <View style={styles.mapSelectedCard}>
          <Text style={styles.mapSelectedTitle}>{selectedJob.title}</Text>
          <Text style={styles.mapSelectedMeta}>{selectedJob.id} · {selectedJob.address}</Text>
          <Pressable style={styles.primaryBtn} onPress={() => navigateTo(selectedJob.address)}>
            <Text style={styles.primaryBtnText}>Start turn-by-turn navigation</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.mapEmpty}>Select a task marker to view its site.</Text>
      )}
    </View>
  );
}

function ProfileScreen({ crew, jobs, onLogout }) {
  const activeJobs = jobs.filter((job) => !['Work Complete', 'Completed', 'Closed'].includes(job.status));
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
      <Pressable style={styles.logoutBtn} onPress={onLogout}>
        <Text style={styles.logoutBtnText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  loginSafe: { flex: 1, backgroundColor: '#10201d' },
  login: { flex: 1, paddingHorizontal: 24, paddingTop: 64 },
  loginKicker: { color: '#27c7b2', fontSize: 13, fontWeight: '800', letterSpacing: 2 },
  loginTitle: { color: '#fff', fontSize: 32, fontWeight: '800', marginTop: 70 },
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
  loginFooter: { color: '#77938c', fontSize: 11, textAlign: 'center', marginTop: 'auto', paddingBottom: 24 },
  safe: { flex: 1, backgroundColor: '#f2f5f9' },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { backgroundColor: '#173355', paddingHorizontal: 22, paddingVertical: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerRight: { alignItems: 'flex-end', gap: 8 },
  demoBadge: { backgroundColor: '#5a3fa6', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  demoBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  kicker: { color: '#27c7b2', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  crewName: { color: '#fff', fontSize: 21, fontWeight: '700', marginTop: 4 },
  role: { color: '#a7bdd6', fontSize: 12, marginTop: 3 },
  online: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#245675', borderRadius: 18, paddingHorizontal: 11, paddingVertical: 7 },
  pendingBadge: { backgroundColor: '#e08a1e', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  pendingText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#27c7b2', marginRight: 6 },
  onlineText: { color: '#b9fff3', fontSize: 12, fontWeight: '700' },
  content: { padding: 20, paddingBottom: 100 },
  title: { color: '#0f1b2d', fontSize: 26, fontWeight: '800' },
  subtitle: { color: '#7c8da3', fontSize: 14, marginTop: 5, marginBottom: 20 },
  stats: { flexDirection: 'row', gap: 9, marginBottom: 28 },
  stat: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 13, borderWidth: 1, borderColor: '#e6ecf3' },
  statValue: { color: '#173355', fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#7c8da3', fontSize: 11, marginTop: 4 },
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
  detailContent: { padding: 20, gap: 14, paddingBottom: 60 },
  detailStats: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e6ecf3' },
  secondaryBtn: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#1F3864', borderRadius: 10, padding: 12, alignItems: 'center' },
  secondaryBtnText: { color: '#1F3864', fontWeight: '700' },
  assetRow: { gap: 8 },
  assetValue: { color: '#33465f', fontSize: 13, fontWeight: '600' },
  scannerWrap: { height: 320 },
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
  mapGrid: { height: 300, overflow: 'hidden', borderRadius: 9, backgroundColor: '#dcebe3', position: 'relative' },
  mapRoadOne: { position: 'absolute', width: '130%', height: 12, top: '28%', left: '-10%', backgroundColor: 'rgba(255,255,255,.82)', transform: [{ rotate: '-25deg' }] },
  mapRoadTwo: { position: 'absolute', width: '130%', height: 10, top: '64%', left: '-10%', backgroundColor: 'rgba(255,255,255,.82)', transform: [{ rotate: '19deg' }] },
  mapRiver: { position: 'absolute', height: '130%', width: 28, top: '-10%', right: '25%', backgroundColor: '#acd6d5', transform: [{ rotate: '17deg' }], opacity: 0.8 },
  mapCrewMarker: { position: 'absolute', top: '52%', left: '53%', width: 30, height: 30, borderRadius: 15, backgroundColor: '#0e9f8e', color: '#fff', textAlign: 'center', lineHeight: 30, fontSize: 18 },
  mapJobMarker: { position: 'absolute', width: 30, height: 30, borderRadius: 15, backgroundColor: '#d13d2f', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  mapMarkerText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  mapMarker0: { top: '20%', left: '20%' },
  mapMarker1: { top: '40%', right: '18%', backgroundColor: '#e08a1e' },
  mapMarker2: { bottom: '18%', left: '38%', backgroundColor: '#2f6fd6' },
  mapMarker3: { bottom: '10%', right: '28%', backgroundColor: '#2a9d5c' },
  mapJobMarkerSelected: { transform: [{ scale: 1.25 }], borderColor: '#173355' },
  mapLegend: { color: '#7c8da3', fontSize: 11, marginTop: 10 },
  mapSelectedCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginTop: 12, borderWidth: 1, borderColor: '#b9dcd3', gap: 8 },
  mapSelectedTitle: { color: '#173355', fontSize: 15, fontWeight: '800' },
  mapSelectedMeta: { color: '#7c8da3', fontSize: 12 },
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