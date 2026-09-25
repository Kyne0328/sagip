import React, {useState} from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {
  EMERGENCY_TYPES,
  URGENCIES,
  type BleRelayStatus,
  type EmergencyType,
  type Urgency,
} from './src/emergency/types';
import {useBleRelayStatus} from './src/emergency/useBleRelayStatus';
import {useEmergencyReports} from './src/emergency/useEmergencyReports';

const emergencyLabels: Record<EmergencyType, string> = {
  MEDICAL: 'Medical',
  FLOOD: 'Flood',
  FIRE: 'Fire',
  TRAPPED: 'Trapped',
  VIOLENCE: 'Violence / threat',
  OTHER: 'Other emergency',
};

const urgencyLabels: Record<Urgency, string> = {
  IMMEDIATE_DANGER: 'Immediate danger',
  NEED_ASSISTANCE: 'Need assistance',
};

export default function App() {
  const {reports, loading, saving, message, create} = useEmergencyReports();
  const {
    status: relayStatus,
    loading: relayLoading,
    requesting: relayRequesting,
    enable: enableRelay,
    refresh: refreshRelay,
  } = useBleRelayStatus();
  const [showForm, setShowForm] = useState(false);
  const [emergencyType, setEmergencyType] = useState<EmergencyType | null>(null);
  const [urgency, setUrgency] = useState<Urgency | null>(null);
  const latest = reports[0];

  const save = async () => {
    if (!emergencyType || !urgency) return;
    const result = await create({emergencyType, urgency});
    if (result) {
      setShowForm(false);
      setEmergencyType(null);
      setUrgency(null);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>SAGIP</Text>
        <Text style={styles.eyebrow}>NEED HELP?</Text>
        <Text style={styles.title}>Create an emergency SOS</Text>
        <Text style={styles.subtitle}>
          Your SOS is saved on this phone first. Internet is not required.
        </Text>

        {!showForm ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create emergency SOS report"
            accessibilityHint="Opens emergency category selection to save SOS locally on this device"
            style={styles.sosButton}
            onPress={() => setShowForm(true)}>
            <Text style={styles.sosButtonText}>SOS</Text>
            <Text style={styles.sosButtonSubtext}>Tap to report an emergency</Text>
          </Pressable>
        ) : (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>What is happening?</Text>
            <View style={styles.optionGrid}>
              {EMERGENCY_TYPES.map(type => (
                <OptionButton
                  key={type}
                  label={emergencyLabels[type]}
                  selected={emergencyType === type}
                  onPress={() => setEmergencyType(type)}
                />
              ))}
            </View>
            <Text style={styles.sectionTitle}>How urgent is it?</Text>
            {URGENCIES.map(item => (
              <OptionButton
                key={item}
                label={urgencyLabels[item]}
                selected={urgency === item}
                onPress={() => setUrgency(item)}
              />
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={saving ? "Saving emergency report locally" : "Save SOS now on this device"}
              accessibilityHint="Commits emergency report immediately to authoritative local storage"
              disabled={!emergencyType || !urgency || saving}
              onPress={() => {
                save();
              }}
              style={({pressed}) => [
                styles.saveButton,
                (!emergencyType || !urgency || saving) && styles.disabledButton,
                pressed && styles.pressed,
              ]}>
              <Text style={styles.saveButtonText}>{saving ? 'Saving…' : 'Save SOS now'}</Text>
            </Pressable>
          </View>
        )}

        {message ? (
          <View accessibilityRole="alert" style={styles.messageCard}>
            <Text style={styles.messageText}>{message}</Text>
          </View>
        ) : null}

        <NearbyRelayCard
          status={relayStatus}
          loading={relayLoading}
          requesting={relayRequesting}
          onEnable={() => {
            void enableRelay();
          }}
          onRefresh={() => {
            void refreshRelay();
          }}
        />

        <View accessibilityLiveRegion="polite" style={styles.statusCard}>
          <Text style={styles.sectionTitle}>Local SOS status</Text>
          {loading ? (
            <Text style={styles.statusText}>Checking this device…</Text>
          ) : latest ? (
            <>
              <Text style={styles.savedText}>Saved on this device</Text>
              {latest.deliveryState === 'RESPONDER_ACKNOWLEDGED' ? (
                <>
                  <Text style={styles.responderText}>Responder acknowledged</Text>
                  <Text style={styles.responderSubtext}>
                    {[
                      'Help is on the way',
                      latest.responderAck?.callsign ? `· ${latest.responderAck.callsign}` : null,
                      latest.responderAck?.note ? `(${latest.responderAck.note})` : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  </Text>
                </>
              ) : latest.deliveryState === 'SERVER_ACCEPTED' ? (
                <Text style={styles.acceptedText}>Server accepted</Text>
              ) : latest.deliveryState === 'PERMANENT_FAILURE' ? (
                <Text style={styles.failedText}>Delivery failed permanently</Text>
              ) : latest.deliveryState === 'RELAYED_TO_PEER' ? (
                <Text style={styles.relayedText}>Relayed to nearby SAGIP device</Text>
              ) : (
                <Text style={styles.pendingText}>Pending delivery</Text>
              )}
              <Text style={styles.statusText}>
                {emergencyLabels[latest.emergencyType]} · {urgencyLabels[latest.urgency]}
              </Text>
            </>
          ) : (
            <Text style={styles.statusText}>No SOS saved on this device yet.</Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function NearbyRelayCard({
  status,
  loading,
  requesting,
  onEnable,
  onRefresh,
}: {
  status: BleRelayStatus | null;
  loading: boolean;
  requesting: boolean;
  onEnable: () => void;
  onRefresh: () => void;
}) {
  let stateText = 'Checking nearby relay…';
  let detail = 'Your SOS can still be saved on this phone while relay is checked.';
  let actionLabel: string | null = null;
  let action: (() => void) | null = null;

  if (!loading || status) {
    switch (status?.availability) {
      case 'PERMISSION_REQUIRED':
        stateText = 'Nearby relay needs permission';
        detail =
          'SOS saving still works without it. Allow nearby-device access so SAGIP can pass saved SOS messages to nearby SAGIP phones when internet is unavailable.';
        actionLabel = requesting ? 'Requesting permission…' : 'Allow nearby relay';
        action = onEnable;
        break;
      case 'BLUETOOTH_OFF':
        stateText = 'Nearby relay unavailable';
        detail = 'Bluetooth is off. Turn on Bluetooth to use nearby relay.';
        actionLabel = 'Check Bluetooth again';
        action = onRefresh;
        break;
      case 'NOT_SUPPORTED':
        stateText = 'Nearby relay unavailable';
        detail = 'This phone does not support the Bluetooth relay SAGIP needs.';
        break;
      case 'READY':
        if (status.isDutyCyclePaused) {
          stateText = 'Nearby relay active';
          detail =
            'SAGIP is conserving battery between nearby-device checks. Relay will resume automatically.';
        } else if (status.isScanning && status.isAdvertising) {
          stateText = 'Nearby relay active';
          detail =
            status.peerCount > 0
              ? `${status.peerCount} nearby SAGIP device${status.peerCount === 1 ? '' : 's'} detected.`
              : 'Searching for nearby SAGIP devices.';
        } else if (status.isScanning || status.isAdvertising) {
          stateText = 'Nearby relay partially active';
          detail =
            'Bluetooth relay is running, but one relay mode is not active. SAGIP will keep retrying delivery.';
          actionLabel = 'Retry nearby relay';
          action = onEnable;
        } else {
          stateText = 'Nearby relay not active';
          detail =
            'Bluetooth is ready, but nearby relay is not running. Your SOS remains saved locally.';
          actionLabel = 'Retry nearby relay';
          action = onEnable;
        }
        break;
      default:
        stateText = 'Nearby relay status unavailable';
        detail = 'Your SOS can still be saved locally. SAGIP could not confirm Bluetooth relay status.';
        actionLabel = 'Check relay status';
        action = onRefresh;
    }
  }

  return (
    <View style={styles.relayCard}>
      <Text style={styles.sectionTitle}>Nearby relay</Text>
      <Text accessibilityLiveRegion="polite" style={styles.relayStateText}>
        {stateText}
      </Text>
      <Text style={styles.relayDetailText}>{detail}</Text>
      {actionLabel && action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          accessibilityHint="Updates Bluetooth relay availability without affecting locally saved SOS reports"
          disabled={requesting}
          onPress={action}
          style={({pressed}) => [
            styles.relayActionButton,
            requesting && styles.disabledButton,
            pressed && styles.pressed,
          ]}>
          <Text style={styles.relayActionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function OptionButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected}}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.optionButton, selected && styles.optionButtonSelected]}>
      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#F7F5F0'},
  container: {padding: 24, gap: 16},
  brand: {fontSize: 18, fontWeight: '800', letterSpacing: 2, color: '#21302B'},
  eyebrow: {fontSize: 13, fontWeight: '800', letterSpacing: 1.4, color: '#8D2F2A', marginTop: 8},
  title: {fontSize: 32, lineHeight: 38, fontWeight: '800', color: '#18211E'},
  subtitle: {fontSize: 17, lineHeight: 25, color: '#4B5752'},
  sosButton: {minHeight: 190, borderRadius: 28, backgroundColor: '#B33A32', alignItems: 'center', justifyContent: 'center', padding: 24, marginVertical: 8},
  sosButtonText: {fontSize: 56, fontWeight: '900', color: '#FFFFFF', letterSpacing: 3},
  sosButtonSubtext: {fontSize: 16, fontWeight: '700', color: '#FFFFFF', marginTop: 8},
  card: {backgroundColor: '#FFFFFF', borderRadius: 20, padding: 18, gap: 12},
  sectionTitle: {fontSize: 18, fontWeight: '800', color: '#18211E', marginTop: 4},
  optionGrid: {gap: 10},
  optionButton: {minHeight: 52, borderWidth: 1.5, borderColor: '#BCC4C0', borderRadius: 14, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#FFFFFF'},
  optionButtonSelected: {borderColor: '#21302B', backgroundColor: '#E8ECEA'},
  optionText: {fontSize: 16, fontWeight: '600', color: '#35423D'},
  optionTextSelected: {fontWeight: '800', color: '#18211E'},
  saveButton: {minHeight: 58, borderRadius: 16, backgroundColor: '#21302B', alignItems: 'center', justifyContent: 'center', marginTop: 8},
  disabledButton: {opacity: 0.45},
  pressed: {opacity: 0.8},
  saveButtonText: {fontSize: 17, fontWeight: '800', color: '#FFFFFF'},
  messageCard: {borderRadius: 16, padding: 16, backgroundColor: '#E8ECEA'},
  messageText: {fontSize: 16, lineHeight: 23, fontWeight: '700', color: '#21302B'},
  relayCard: {borderRadius: 20, padding: 18, backgroundColor: '#FFFFFF', gap: 8, marginTop: 4},
  relayStateText: {fontSize: 16, lineHeight: 22, fontWeight: '800', color: '#21302B'},
  relayDetailText: {fontSize: 15, lineHeight: 22, color: '#56615D'},
  relayActionButton: {minHeight: 50, borderRadius: 14, backgroundColor: '#21302B', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginTop: 4},
  relayActionText: {fontSize: 16, fontWeight: '800', color: '#FFFFFF'},
  statusCard: {borderRadius: 20, padding: 18, backgroundColor: '#FFFFFF', gap: 8, marginTop: 4},
  savedText: {fontSize: 18, fontWeight: '800', color: '#21302B'},
  pendingText: {fontSize: 16, fontWeight: '800', color: '#8A5B18'},
  relayedText: {fontSize: 16, fontWeight: '800', color: '#B26B00'},
  acceptedText: {fontSize: 16, fontWeight: '800', color: '#1B6B38'},
  responderText: {fontSize: 16, fontWeight: '800', color: '#0D6857'},
  responderSubtext: {fontSize: 14, fontWeight: '700', color: '#0D6857'},
  failedText: {fontSize: 16, fontWeight: '800', color: '#B33A32'},
  statusText: {fontSize: 15, lineHeight: 22, color: '#56615D'},
});
