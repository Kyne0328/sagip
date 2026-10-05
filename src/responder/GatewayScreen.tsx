import React, {useEffect, useRef, useState} from 'react';
import {AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {GatewayCore, type GatewayAction, type GatewayIncident} from './GatewayCore';

const statuses = ['Acknowledge', 'En route', 'On scene', 'Resolved'];
function incidentAccessibilityLabel(incident: GatewayIncident): string {
  const urgency = incident.urgency === 'IMMEDIATE_DANGER' ? 'Immediate danger' : 'Need assistance';
  const location = incident.location
    ? `Location ${incident.location.latitude}, ${incident.location.longitude}`
    : 'Location unavailable';
  return `Select ${incident.emergencyType.toLowerCase()} incident ${incident.reportId.slice(0, 8)}, revision ${incident.revision}. ${urgency}. ${location}`;
}
export function GatewayScreen({onClose}: {onClose: () => void}) {
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [incidents, setIncidents] = useState<GatewayIncident[]>([]);
  const [selected, setSelected] = useState<GatewayIncident | null>(null);
  const [authorityReady, setAuthorityReady] = useState(false);
  const [status, setStatus] = useState(1);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('Device verification required');
  const [pending, setPending] = useState<GatewayAction | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const credentialHandoff = useRef(false);
  const unlockQueued = useRef(false);
  const foreground = useRef(AppState.currentState === 'active' || AppState.currentState == null);
  const lock = () => {
    generation.current += 1;
    unlockQueued.current = false;
    setUnlocked(false); setIncidents([]); setSelected(null); setNote(''); setPending(null);
    setAuthorityReady(false); setMessage('Device verification required');
    GatewayCore.lock().catch(() => {});
  };
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (state === 'background' && !credentialHandoff.current) {lock();}
      if (state === 'active' && unlockQueued.current) {
        unlockQueued.current = false;
        loadWorkspace();
      }
    });
    return () => {active.current = false; generation.current += 1; listener.remove(); GatewayCore.lock().catch(() => {});};
  }, []);
  useEffect(() => {
    if (!unlocked) {return;}
    const timeout = setTimeout(lock, 60_000);
    return () => clearTimeout(timeout);
  }, [unlocked]);
  async function loadWorkspace() {
    const token = generation.current;
    setBusy(true);
    try {
      const [authority, list] = await Promise.all([GatewayCore.status(), GatewayCore.listGatewayIncidents()]);
      if (!active.current || generation.current !== token || !foreground.current) {return;}
      setIncidents(list); setAuthorityReady(authority.authorityReady); setUnlocked(true);
      setMessage('Choose an incident, then explicitly save your action.');
    } catch {if (active.current && token === generation.current) {setMessage('Responder workspace unavailable or locked');}}
    finally {if (active.current) {setBusy(false);}}
  }
  const unlock = async () => {
    if (inFlight.current) {return;}
    inFlight.current = true; setBusy(true);
    const token = generation.current;
    credentialHandoff.current = true;
    try {
      if (!await GatewayCore.authenticate()) {return;}
      if (!active.current || generation.current !== token) {return;}
      if (foreground.current) {await loadWorkspace();}
      else {unlockQueued.current = true; setMessage('Return to SAGIP to open the verified workspace.');}
    } catch {if (active.current && token === generation.current) {setMessage('Responder workspace unavailable or locked');}}
    finally {credentialHandoff.current = false; inFlight.current = false; if (active.current) {setBusy(false);}}
  };
  const save = async () => {
    if (!selected || inFlight.current) {return;}
    inFlight.current = true; setBusy(true);
    const token = generation.current;
    try {
      const action = pending ?? {actionId: await GatewayCore.newActionId(), reportId: selected.reportId,
        observedIncidentVersion: selected.observedIncidentVersion, status, note};
      if (!active.current || generation.current !== token) {return;}
      setPending(action);
      const result = await GatewayCore.recordGatewayAction(action);
      if (!active.current || generation.current !== token) {return;}
      if (result.state === 'SIGNED') {
        setMessage('Signed acknowledgement saved on this device. Cloud import and requester delivery remain unconfirmed.');
        setPending(null);
        const list = await GatewayCore.listGatewayIncidents();
        if (active.current && generation.current === token) {setIncidents(list); setSelected(list.find(i => i.reportId === action.reportId) ?? null);}
      } else if (result.state === 'PREPARING') {
        setMessage('Work saved on this device. Awaiting verified issuance.');
      } else {
        setPending(null);
        if (result.reason === 'DEVICE_ACCESS_REQUIRED') {lock(); return;}
        setMessage(result.reason === 'INVALID_FIELDS' ? 'Action not saved. Correct the note or fields and try again.' : 'Saved work requires review against the current incident revision.');
        const list = await GatewayCore.listGatewayIncidents();
        if (active.current && generation.current === token) {setIncidents(list); setSelected(list.find(i => i.reportId === action.reportId) ?? null);}
      }
    } catch {if (active.current && generation.current === token) {setMessage('Outcome unknown. Retry the same saved action.');}}
    finally {inFlight.current = false; if (active.current) {setBusy(false);}}
  };
  return <KeyboardAvoidingView style={styles.keyboardAvoider} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header" style={styles.title}>Responder workspace</Text>
    <Text style={styles.body}>Native offline incident queue</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Return to civilian SOS" style={({pressed}) => [styles.secondaryButton, pressed && styles.pressed]}
      onPress={() => {lock(); onClose();}}><Text style={styles.secondaryButtonText}>Return to SOS</Text></Pressable>
    <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text>
    {!unlocked ? <Pressable accessibilityRole="button" accessibilityLabel="Unlock responder workspace"
      disabled={busy} accessibilityState={{disabled: busy, busy}} style={({pressed}) => [styles.button, busy && styles.disabled, pressed && styles.pressed]} onPress={unlock}>
      <Text style={styles.buttonText}>Verify device access</Text></Pressable> : <>
      <Text style={styles.body}>{authorityReady ? 'Offline authority available; current revocation status unavailable.' : 'Verified issuance unavailable. Work can still be saved locally.'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Lock responder workspace" style={({pressed}) => [styles.secondaryButton, pressed && styles.pressed]} onPress={lock}><Text style={styles.secondaryButtonText}>Lock workspace</Text></Pressable>
      {incidents.length === 0 && <Text style={styles.body}>No received incidents on this device.</Text>}
      {incidents.map(incident => <Pressable key={incident.reportId} accessibilityRole="button"
        accessibilityLabel={incidentAccessibilityLabel(incident)} accessibilityState={{selected: selected?.reportId === incident.reportId, disabled: busy || pending !== null}}
        disabled={busy || pending !== null} style={({pressed}) => [styles.card, selected?.reportId === incident.reportId && styles.selectedCard, (busy || pending !== null) && styles.disabled, pressed && styles.pressed]} onPress={() => {
          const saved = incident.pendingActions?.find(a => a.observedIncidentVersion === incident.observedIncidentVersion) ?? null;
          setSelected(incident); setPending(saved); setStatus(saved?.status ?? 1); setNote(saved?.note ?? '');
        }}>
        <Text style={styles.cardTitle}>{selected?.reportId === incident.reportId ? '✓ ' : ''}{incident.emergencyType} · revision {incident.revision}</Text>
        <Text style={styles.body}>{incident.reportId}</Text>
        <Text style={styles.body}>{incident.location ? `${incident.location.latitude}, ${incident.location.longitude}` : 'Location unavailable'}</Text>
      </Pressable>)}
      {selected && <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.cardTitle}>Record responder action</Text>
        {selected.message != null && <>
          <Text accessibilityRole="header" style={styles.cardTitle}>Civilian message</Text>
          <Text style={styles.body}>{selected.message}</Text>
        </>}
        {selected.pendingActions?.filter(a => a.observedIncidentVersion !== selected.observedIncidentVersion).map(action =>
          <Text key={action.actionId} style={styles.body}>Earlier saved work retained for review: {action.note || statuses[action.status - 1]}</Text>)}
        {statuses.map((label, index) => <Pressable key={label} accessibilityRole="radio" accessibilityLabel={label}
          accessibilityState={{checked: status === index + 1, disabled: busy || pending !== null}} disabled={busy || pending !== null}
          style={({pressed}) => [styles.choice, status === index + 1 && styles.selected, (busy || pending !== null) && styles.disabled, pressed && styles.pressed]} onPress={() => setStatus(index + 1)}><Text style={[styles.body, status === index + 1 && styles.selectedText]}>{status === index + 1 ? '✓ ' : ''}{label}</Text></Pressable>)}
        <TextInput accessibilityLabel="Responder action note" editable={!busy && pending === null}
          multiline maxLength={1024} value={note} onChangeText={setNote} style={styles.input} placeholder="Optional note" placeholderTextColor="#56615D" />
        <Pressable accessibilityRole="button" accessibilityLabel={pending ? 'Retry saved action' : status === 1 ? 'Save acknowledgement' : `Save ${statuses[status - 1].toLowerCase()} action`}
          disabled={busy} accessibilityState={{disabled: busy, busy}} style={({pressed}) => [styles.button, busy && styles.disabled, pressed && styles.pressed]} onPress={save}><Text style={styles.buttonText}>{pending ? 'Retry saved action' : 'Save action on this device'}</Text></Pressable>
        <Text style={styles.body}>Saving records an explicit responder statement. It does not prove dispatch or delivery.</Text>
        {selected.timeline.map(event => <Text key={event.eventId} style={styles.body}>{event.callsign}: responder reported {statuses[event.status - 1]?.toLowerCase()} (revision {event.revision}){event.note ? ` · ${event.note}` : ''}</Text>)}
      </View>}
    </>}
  </ScrollView></KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  keyboardAvoider: {flex: 1},
  container: {padding: 16, paddingBottom: 48, gap: 16, backgroundColor: '#F7F5F0', flexGrow: 1},
  title: {fontSize: 28, lineHeight: 34, fontWeight: '800', color: '#18211E'},
  body: {fontSize: 16, lineHeight: 24, color: '#44524D'},
  message: {fontSize: 16, lineHeight: 24, fontWeight: '600', color: '#21302B', padding: 16, borderRadius: 16, backgroundColor: '#E8ECEA'},
  button: {minHeight: 54, padding: 14, backgroundColor: '#21302B', borderRadius: 14, justifyContent: 'center', alignItems: 'center'},
  buttonText: {fontSize: 16, lineHeight: 24, fontWeight: '800', textAlign: 'center', color: '#FFFFFF'},
  secondaryButton: {minHeight: 50, padding: 12, borderWidth: 1.5, borderColor: '#8C9893', borderRadius: 14, justifyContent: 'center', alignItems: 'center'},
  secondaryButtonText: {fontSize: 16, lineHeight: 24, fontWeight: '700', textAlign: 'center', color: '#35423D'},
  card: {padding: 18, borderRadius: 20, backgroundColor: '#FFFFFF', gap: 12, borderWidth: 1, borderColor: '#DCE1DB'},
  selectedCard: {borderColor: '#21302B', backgroundColor: '#EFF6F1'},
  cardTitle: {fontSize: 18, lineHeight: 25, color: '#18211E', fontWeight: '800'},
  choice: {minHeight: 52, padding: 12, borderWidth: 1.5, borderColor: '#BCC4C0', borderRadius: 14, justifyContent: 'center'},
  selected: {backgroundColor: '#E8ECEA', borderColor: '#21302B'},
  selectedText: {fontWeight: '800', color: '#18211E'},
  input: {minHeight: 96, padding: 12, borderWidth: 1.5, borderColor: '#8C9893', color: '#18211E', backgroundColor: '#FFFFFF', borderRadius: 14, fontSize: 16, lineHeight: 24, textAlignVertical: 'top'},
  disabled: {opacity: 0.45},
  pressed: {opacity: 0.8},
});
