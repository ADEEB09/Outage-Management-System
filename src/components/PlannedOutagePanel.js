// src/components/PlannedOutagePanel.js
// OMS-01: the planned-outage part of a job — switching steps in order (own
// steps actionable, control-room steps read-only), and the work permit.
// Shown in JobDetail only for planned jobs; fault jobs never render it.
//
// What the crew sees is the SERVER's state. A step done with no signal is
// stored by safetyStore.js and shown as NOT SENT (never green) until the
// server acknowledges it; nothing after it unlocks meanwhile. Permit
// request/return need a connection: there is no offline version.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { getPlannedOutage, requestPermit, withdrawPermit, returnPermit } from '../lib/api';
import { recordConfirmation, pendingConfirmations, flushSafety, discardRejected } from '../lib/safetyStore';
import { stepUiState, isUnreachable } from '../lib/plannedOutage';
import { getLocation } from '../lib/location';

const POLL_MS = 10000;
const ACTION_TEXT = {
  open: 'OPEN', close: 'CLOSE', rack_out: 'Rack out', rack_in: 'Rack in', test_dead: 'Test dead',
  earth_apply: 'Apply earth', earth_remove: 'Remove earth', tag_apply: 'Apply danger tag', tag_remove: 'Remove danger tag',
};
const hhmm = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '');
const notSent = (err) => (isUnreachable(err)
  ? 'NOT SENT - no connection. The control room has NOT received this.'
  : `Refused by the control room: ${err.message}`);

export default function PlannedOutagePanel({ job }) {
  const [view, setView] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [returning, setReturning] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    // Send anything stored first, so the view below already includes it.
    await flushSafety().catch(() => {});
    try {
      const v = await getPlannedOutage(job.id);
      if (!alive.current) return;
      setView(v); setLoadedAt(new Date()); setOffline(false);
      setPending(await pendingConfirmations(v.plannedOutageId).catch(() => []));
    } catch (err) {
      if (!alive.current) return;
      setOffline(isUnreachable(err));
      if (!isUnreachable(err)) setMessage(err.message);
      if (view?.plannedOutageId) setPending(await pendingConfirmations(view.plannedOutageId).catch(() => []));
    }
  }, [job.id, view?.plannedOutageId]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  const confirmStep = (step) => {
    const what = `${ACTION_TEXT[step.action] || step.action} ${step.deviceLabel}\nat ${step.location}`;
    Alert.alert('Confirm switching step', `${what}\n\nOnly confirm after you have actually done it.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Done', style: 'destructive', onPress: async () => {
          setBusy(true);
          try {
            const loc = await getLocation().catch(() => ({}));
            await recordConfirmation({ plannedOutageId: view.plannedOutageId, stepId: step.id, stepLabel: `${ACTION_TEXT[step.action]} ${step.deviceLabel}`, lat: loc.lat, lon: loc.lon });
            await load();
          } finally { setBusy(false); }
        },
      },
    ]);
  };

  const permitAction = async (fn, okText) => {
    setBusy(true); setMessage('');
    try { await fn(); if (okText) setMessage(okText); } catch (err) { setMessage(notSent(err)); }
    await load(); setBusy(false);
  };

  if (!view) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>PLANNED OUTAGE</Text>
        {offline
          ? <Text style={styles.warn}>Needs a connection to load the switching plan and permit from the control room.</Text>
          : <ActivityIndicator color="#1F3864" />}
        {message ? <Text style={styles.warn}>{message}</Text> : null}
      </View>
    );
  }

  const unsynced = pending.filter((p) => !p.last_code);
  const rejected = pending.filter((p) => p.last_code);
  const permit = view.permit;
  const ownIsolationDone = view.steps.filter((s) => s.phase === 'isolate' && s.mine).every((s) => s.state === 'confirmed');
  const canRequest = !offline && ownIsolationDone && !pending.length && ['isolating', 'in_progress'].includes(view.status)
    && (!permit || ['refused', 'withdrawn', 'returned'].includes(permit.state)) && permit?.state !== 'returned';

  return (
    <View style={styles.card}>
      <Text style={styles.title}>PLANNED OUTAGE · {String(view.statusLabel || view.status).toUpperCase()}</Text>
      <Text style={styles.meta}>{view.workDescription}</Text>
      <Text style={styles.meta}>Supply off {new Date(view.windowStart).toLocaleString()} - {hhmm(view.windowEnd)}</Text>

      {offline && (
        <Text style={styles.warn}>No connection to the control room. Showing what was known at {hhmm(loadedAt?.toISOString())}. Permit actions need a connection.</Text>
      )}
      {unsynced.length > 0 && (
        <View style={styles.unsyncedBanner}>
          <Text style={styles.unsyncedTitle}>{unsynced.length} SWITCHING STEP{unsynced.length > 1 ? 'S' : ''} NOT SENT</Text>
          <Text style={styles.unsyncedText}>The control room does NOT know about {unsynced.map((p) => p.step_label).join(', ')}. It sends by itself when there is signal. Nothing else unlocks until it does.</Text>
        </View>
      )}
      {rejected.map((p) => (
        <View key={p.client_confirmation_id} style={styles.rejectedBanner}>
          <Text style={styles.unsyncedTitle}>REFUSED: {p.step_label}</Text>
          <Text style={styles.unsyncedText}>{p.last_error} ({p.last_code}). Call the control room now.</Text>
          <Pressable style={styles.smallBtn} onPress={() => Alert.alert('Remove from phone?', 'Only after you have spoken to the control room about this step.', [
            { text: 'Keep', style: 'cancel' },
            { text: 'Remove', style: 'destructive', onPress: async () => { await discardRejected(p.client_confirmation_id); load(); } },
          ])}>
            <Text style={styles.smallBtnText}>I called the control room - remove</Text>
          </Pressable>
        </View>
      ))}

      {['isolate', 'restore'].map((phase) => (
        <View key={phase} style={{ marginTop: 10 }}>
          <Text style={styles.section}>{phase === 'isolate' ? 'ISOLATE' : 'RESTORE'}</Text>
          {view.steps.filter((s) => s.phase === phase).map((s) => {
            const ui = stepUiState(s, view, pending);
            return (
              <View key={s.id} style={[styles.step, styles[`step_${ui}`]]}>
                <Text style={styles.stepSeq}>{s.seq}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stepText}><Text style={{ fontWeight: '800' }}>{ACTION_TEXT[s.action] || s.action}</Text> {s.deviceLabel}</Text>
                  <Text style={styles.stepSub}>{s.location} · {s.mine ? 'your step' : s.assignee === 'crew' ? `crew ${s.assigneeCrewId}` : 'control room'}</Text>
                  {ui === 'confirmed' && <Text style={styles.okText}>✓ Confirmed by {s.confirmedBy} {hhmm(s.performedAt)}</Text>}
                  {ui === 'unsynced' && <Text style={styles.badText}>NOT SENT - control room does not know</Text>}
                  {ui === 'rejected' && <Text style={styles.badText}>REFUSED - call the control room</Text>}
                </View>
                {ui === 'actionable' && (
                  <Pressable style={styles.confirmBtn} disabled={busy} onPress={() => confirmStep(s)}>
                    <Text style={styles.confirmText}>Confirm done</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      ))}

      <Text style={[styles.section, { marginTop: 12 }]}>WORK PERMIT</Text>
      {!permit || ['refused', 'withdrawn'].includes(permit.state) ? (
        <View>
          {permit?.state === 'refused' && <Text style={styles.warn}>Permit {permit.permit_no} was refused: {permit.refusal_reason}</Text>}
          <Pressable style={[styles.primary, !canRequest && styles.disabled]} disabled={!canRequest || busy}
            onPress={() => permitAction(() => requestPermit(job.id), 'Permit requested. Waiting for the control room.')}>
            <Text style={styles.primaryText}>Request work permit</Text>
          </Pressable>
          {!ownIsolationDone && <Text style={styles.stepSub}>Available once your isolation steps are confirmed by the control room.</Text>}
        </View>
      ) : permit.state === 'requested' ? (
        <View>
          <View style={styles.waiting}><ActivityIndicator color="#1F3864" /><Text style={styles.stepText}>  {permit.permit_no}: waiting for the control room to issue it…</Text></View>
          <Pressable style={styles.smallBtn} disabled={busy || offline} onPress={() => permitAction(() => withdrawPermit(permit.id))}>
            <Text style={styles.smallBtnText}>Withdraw request</Text>
          </Pressable>
        </View>
      ) : permit.state === 'issued' ? (
        <View style={styles.permitCard}>
          <Text style={styles.permitNo}>{permit.permit_no} · ISSUED</Text>
          <Text style={styles.stepSub}>by {permit.issued_by} at {hhmm(permit.issued_at)}</Text>
          <Text style={styles.stepText}>Isolated at: {permit.isolation_points}</Text>
          <Text style={styles.stepText}>Earths at: {permit.earthing_points}</Text>
          {returning
            ? <ReturnForm busy={busy || offline} onCancel={() => setReturning(false)} onSubmit={(d) => permitAction(() => returnPermit(permit.id, d), 'Permit returned to the control room.').then(() => setReturning(false))} />
            : <Pressable style={styles.primary} onPress={() => setReturning(true)}><Text style={styles.primaryText}>Return permit</Text></Pressable>}
        </View>
      ) : (
        <Text style={styles.okText}>{permit.permit_no} returned at {hhmm(permit.returned_at)} - the line is handed back to the control room.</Text>
      )}
      {message ? <Text style={styles.warn}>{message}</Text> : null}
    </View>
  );
}

// The crew's declaration. All three must be switched on before it can be sent.
function ReturnForm({ busy, onCancel, onSubmit }) {
  const [d, setD] = useState({ menWithdrawn: false, earthsRemoved: false, toolsClear: false });
  const row = (key, label) => (
    <View style={styles.declRow} key={key}>
      <Switch value={d[key]} onValueChange={(v) => setD({ ...d, [key]: v })} />
      <Text style={styles.stepText}>  {label}</Text>
    </View>
  );
  const ready = d.menWithdrawn && d.earthsRemoved && d.toolsClear;
  return (
    <View style={{ marginTop: 8 }}>
      {row('menWithdrawn', 'All men withdrawn from the line')}
      {row('earthsRemoved', 'All working earths removed')}
      {row('toolsClear', 'All tools and materials clear')}
      <Pressable style={[styles.primary, (!ready || busy) && styles.disabled]} disabled={!ready || busy}
        onPress={() => Alert.alert('Return the permit?', 'The control room may re-energise the line after this.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Return permit', style: 'destructive', onPress: () => onSubmit(d) },
        ])}>
        <Text style={styles.primaryText}>Return permit</Text>
      </Pressable>
      <Pressable style={styles.smallBtn} onPress={onCancel}><Text style={styles.smallBtnText}>Cancel</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14, marginTop: 14, borderWidth: 1, borderColor: '#D5DCE5' },
  title: { color: '#1F3864', fontWeight: '800', fontSize: 13, letterSpacing: 0.5 },
  meta: { color: '#47566B', fontSize: 13, marginTop: 3 },
  section: { color: '#6B7A90', fontWeight: '700', fontSize: 11, letterSpacing: 0.8, marginBottom: 5 },
  warn: { color: '#8A4B00', backgroundColor: '#FFF4E5', borderRadius: 8, padding: 8, marginTop: 8, fontSize: 13 },
  unsyncedBanner: { backgroundColor: '#B42318', borderRadius: 10, padding: 10, marginTop: 10 },
  rejectedBanner: { backgroundColor: '#7A1A12', borderRadius: 10, padding: 10, marginTop: 10 },
  unsyncedTitle: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },
  unsyncedText: { color: '#FFE4E1', fontSize: 13, marginTop: 3 },
  step: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, borderWidth: 1, padding: 9, marginBottom: 6 },
  step_confirmed: { backgroundColor: '#E7F6EC', borderColor: '#2A9D5C' },
  step_unsynced: { backgroundColor: '#FFF4E5', borderColor: '#B42318', borderStyle: 'dashed', borderWidth: 2 },
  step_rejected: { backgroundColor: '#FDECEA', borderColor: '#B42318', borderWidth: 2 },
  step_actionable: { backgroundColor: '#FFFFFF', borderColor: '#1F3864', borderWidth: 2 },
  step_control_room: { backgroundColor: '#F2F4F7', borderColor: '#E1E5EB' },
  step_pending: { backgroundColor: '#FFFFFF', borderColor: '#E1E5EB' },
  stepSeq: { width: 22, color: '#6B7A90', fontWeight: '700' },
  stepText: { color: '#1D2939', fontSize: 14 },
  stepSub: { color: '#6B7A90', fontSize: 12, marginTop: 2 },
  okText: { color: '#1E7B46', fontSize: 12.5, marginTop: 3, fontWeight: '600' },
  badText: { color: '#B42318', fontSize: 12.5, marginTop: 3, fontWeight: '800' },
  confirmBtn: { backgroundColor: '#1F3864', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9, marginLeft: 8 },
  confirmText: { color: '#FFFFFF', fontWeight: '800' },
  primary: { backgroundColor: '#1F3864', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  primaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  disabled: { opacity: 0.45 },
  smallBtn: { paddingVertical: 8, alignItems: 'center', marginTop: 6, borderRadius: 8, borderWidth: 1, borderColor: '#D5DCE5', backgroundColor: '#FFFFFF' },
  smallBtnText: { color: '#1F3864', fontWeight: '700' },
  waiting: { flexDirection: 'row', alignItems: 'center', padding: 10, backgroundColor: '#EEF2F7', borderRadius: 10 },
  permitCard: { backgroundColor: '#EEF6FF', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#9DB8DB' },
  permitNo: { color: '#1F3864', fontWeight: '800', fontSize: 15 },
  declRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
});
