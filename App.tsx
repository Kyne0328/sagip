import React, {useEffect, useState} from 'react';
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {SagipMark} from './src/branding/SagipMark';
import {GatewayScreen} from './src/responder/GatewayScreen';
import {
  EMERGENCY_TYPES,
  URGENCIES,
  type BleRelayStatus,
  type EmergencyType,
  type ResponderAckInfo,
  type VerifiedReceiptInfo,
  type Urgency,
} from './src/emergency/types';
import {SurvivalCore} from './src/emergency/SurvivalCore';
import {prepareSosLocation} from './src/emergency/prepareSosLocation';
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

function responderAcknowledgementText(ack: ResponderAckInfo | null | undefined) {
  const responseState = (() => {
    switch (ack?.status) {
      case 'EN_ROUTE':
        return 'Responders report they are on the way';
      case 'ON_SCENE':
        return 'Responders report they are on scene';
      case 'RESOLVED':
        return 'Responder marked this incident resolved';
      default:
        return 'Responder has acknowledged your SOS';
    }
  })();

  return [
    responseState,
    ack?.callsign ? `· ${ack.callsign}` : null,
    ack?.note ? `(${ack.note})` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function verifiedResponderHeadline(receipt: VerifiedReceiptInfo): string {
  switch (receipt.status) {
    case 'EN_ROUTE':
      return 'Responder reports they are on the way';
    case 'ON_SCENE':
      return 'Responder reports they are on scene';
    case 'RESOLVED':
      return 'Responder reports this incident is resolved';
    default:
      return 'Responder acknowledged your current SOS';
  }
}

function verifiedResponderText(receipt: VerifiedReceiptInfo): string {
  return [
    verifiedResponderHeadline(receipt),
    receipt.callsign ? `· ${receipt.callsign}` : null,
    receipt.note ? `(${receipt.note})` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function verifiedAuthorityText(receipt: VerifiedReceiptInfo): string {
  if (receipt.verificationKind === 'VERIFIED_OFFLINE_AUTHORITY') {
    const checkedAt = (() => {
      if (receipt.authorityCheckedAt === null) {
        return 'Authority check time is unavailable.';
      }
      const date = new Date(receipt.authorityCheckedAt);
      return Number.isNaN(date.getTime())
        ? 'Authority check time could not be formatted.'
        : `Authority last checked ${date.toISOString()}.`;
    })();
    return `Verified using offline responder credentials. Current revocation status is unavailable. ${checkedAt}`;
  }
  return 'Responder authority verified with current authorization evidence.';
}

function requesterDeliveryText(receipt: VerifiedReceiptInfo): string {
  return receipt.requesterDeliveryState === 'RECEIVED'
    ? 'Responder received your return confirmation'
    : 'Requester return confirmation not yet received';
}

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
  const [showGateway, setShowGateway] = useState(false);
  const [emergencyType, setEmergencyType] = useState<EmergencyType | null>(null);
  const [urgency, setUrgency] = useState<Urgency | null>(null);
  const latest = reports[0];
  const latestVerifiedReportId = latest?.reportId;
  const latestVerifiedReceipt = latest?.verifiedReceipt;
  const latestVerifiedEventId = latestVerifiedReceipt?.eventId;
  const latestVerifiedHeadline = latestVerifiedReceipt
    ? verifiedResponderHeadline(latestVerifiedReceipt)
    : null;

  useEffect(() => {
    void prepareSosLocation(false);
  }, []);

  useEffect(() => {
    if (!latestVerifiedReportId || !latestVerifiedEventId || !latestVerifiedHeadline) {
      return;
    }

    let cancelled = false;
    void SurvivalCore.claimVerifiedReceiptNotification(
      latestVerifiedReportId,
      latestVerifiedEventId,
    )
      .then(claimed => {
        if (claimed && !cancelled) {
          AccessibilityInfo.announceForAccessibility(latestVerifiedHeadline);
        }
      })
      .catch(() => {
        // Notification delivery is best-effort. Verified evidence remains visible.
      });

    return () => {
      cancelled = true;
    };
  }, [latestVerifiedEventId, latestVerifiedHeadline, latestVerifiedReportId]);
  const messageIsError =
    message === 'SOS was not saved. Please try again.' ||
    message === 'Saved SOS reports could not be loaded.';

  const save = async () => {
    if (!emergencyType || !urgency) return;
    const result = await create({emergencyType, urgency});
    if (result) {
      setShowForm(false);
      setEmergencyType(null);
      setUrgency(null);
    }
  };

  if (showGateway) {
    return <SafeAreaView style={styles.safeArea}><GatewayScreen onClose={() => setShowGateway(false)} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.brandRow}>
          <SagipMark />
          <View style={styles.brandCopy}>
            <Text style={styles.brand}>SAGIP</Text>
            <Text style={styles.brandTagline}>Emergency communication that keeps trying</Text>
          </View>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open responder workspace"
          style={{minHeight: 48, justifyContent: 'center'}} onPress={() => setShowGateway(true)}>
          <Text style={{color: '#0f3d56', fontWeight: '600'}}>Responder workspace</Text>
        </Pressable>
        <Text style={styles.eyebrow}>NEED HELP?</Text>
        <Text style={styles.title}>Create an emergency SOS</Text>
        <Text style={styles.subtitle}>
          Your SOS is saved on this phone first. Internet is not required.
        </Text>
        <Text style={styles.deliveryHelpText}>
          If internet works, SAGIP sends directly to the server. Nearby-device relay is the offline fallback.
        </Text>
        <Text style={styles.deliveryHelpText}>
          Device location is attached when available. Your SOS still saves if location permission or GPS is unavailable.
        </Text>

        {!showForm ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create emergency SOS report"
            accessibilityHint="Opens emergency category selection to save SOS locally on this device"
            style={styles.sosButton}
            onPress={() => {
              setShowForm(true);
              void prepareSosLocation(true);
            }}>
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
              accessibilityLabel={saving ? 'Saving emergency report locally' : 'Save SOS now on this device'}
              accessibilityHint="Commits emergency report immediately to authoritative local storage"
              disabled={!emergencyType || !urgency || saving}
              accessibilityState={{disabled: !emergencyType || !urgency || saving}}
              onPress={() => {
                void save();
              }}
              style={({pressed}) => [
                styles.saveButton,
                (!emergencyType || !urgency || saving) && styles.disabledButton,
                pressed && styles.pressed,
              ]}>
              <Text style={styles.saveButtonText}>{saving ? 'Saving…' : 'Save SOS now'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel SOS details"
              accessibilityHint="Returns to the main SOS button without saving a report"
              disabled={saving}
              accessibilityState={{disabled: saving}}
              onPress={() => {
                setShowForm(false);
                setEmergencyType(null);
                setUrgency(null);
              }}
              style={({pressed}) => [
                styles.cancelButton,
                saving && styles.disabledButton,
                pressed && styles.pressed,
              ]}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {message ? (
          <View
            accessibilityRole={messageIsError ? 'alert' : undefined}
            accessibilityLiveRegion={messageIsError ? 'assertive' : 'polite'}
            style={styles.messageCard}>
            <Text style={styles.messageText}>{message}</Text>
          </View>
        ) : null}

        <View style={styles.statusCard}>
          <Text style={styles.sectionTitle}>Latest SOS status</Text>
          {loading ? (
            <Text style={styles.statusText}>Checking this device…</Text>
          ) : latest ? (
            <>
              <Text style={styles.savedText}>Saved on this device</Text>
              {latest.verifiedReceipt ? (
                <View style={styles.verifiedReceiptBlock}>
                  <Text style={styles.responderText}>Verified responder update</Text>
                  <Text style={styles.statusDetailText}>
                    {verifiedResponderText(latest.verifiedReceipt)}
                  </Text>
                  <Text style={styles.evidenceText}>
                    {verifiedAuthorityText(latest.verifiedReceipt)}
                  </Text>
                  <Text style={styles.evidenceText}>
                    {requesterDeliveryText(latest.verifiedReceipt)}
                  </Text>
                </View>
              ) : null}
              {latest.deliveryState === 'RESPONDER_ACKNOWLEDGED' ? (
                <>
                  <Text
                    style={
                      latest.verifiedReceipt
                        ? styles.deliveryEvidenceText
                        : styles.pendingText
                    }>
                    {latest.verifiedReceipt
                      ? 'Responder acknowledgement transport state recorded'
                      : 'Unverified responder update'}
                  </Text>
                  <Text style={styles.statusDetailText}>
                    {latest.verifiedReceipt
                      ? 'Verified responder evidence is shown separately above.'
                      : `${responderAcknowledgementText(latest.responderAck)}. This legacy acknowledgement is not cryptographically verified.`}
                  </Text>
                </>
              ) : latest.deliveryState === 'SERVER_ACCEPTED' ? (
                <>
                  <Text style={styles.acceptedText}>Server accepted</Text>
                  <Text style={styles.statusDetailText}>
                    The SAGIP server has accepted this SOS. Server acceptance does not by itself prove responder acknowledgement.
                  </Text>
                </>
              ) : latest.deliveryState === 'PERMANENT_FAILURE' ? (
                <>
                  <Text style={styles.failedText}>Delivery failed permanently</Text>
                  <Text style={styles.statusDetailText}>
                    This SOS is still saved on this device, but automatic delivery cannot continue for this report.
                  </Text>
                </>
              ) : latest.deliveryState === 'RELAYED_TO_PEER' ? (
                <>
                  <Text style={styles.relayedText}>Relayed to another SAGIP device</Text>
                  <Text style={styles.statusDetailText}>
                    Another SAGIP device has a saved copy to forward. This does not yet mean the server or a responder received it.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.pendingText}>Pending delivery</Text>
                  <Text style={styles.statusDetailText}>
                    SAGIP is searching for an internet or nearby-device delivery path. Your SOS remains saved here.
                  </Text>
                </>
              )}
              <Text style={styles.statusText}>
                {emergencyLabels[latest.emergencyType]} · {urgencyLabels[latest.urgency]}
              </Text>
              <Text style={styles.statusDetailText}>
                {latest.location
                  ? `Location attached · ${latest.location.source} · ${latest.location.freshness === 'FRESH' ? 'recent fix' : 'older fix'}${latest.location.accuracyMeters === null ? '' : ` · ±${Math.round(latest.location.accuracyMeters)} m`}`
                  : 'No device location was attached to this SOS.'}
              </Text>
            </>
          ) : (
            <Text style={styles.statusText}>No SOS saved on this device yet.</Text>
          )}
        </View>

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
      </ScrollView>
    </SafeAreaView>
  );
}

function relayCustodySummary(status: BleRelayStatus | null): string | null {
  if (!status || status.heldRelayCount <= 0) return null;
  const heldLabel = `${status.heldRelayCount} relayed SOS message${status.heldRelayCount === 1 ? '' : 's'}`;
  if (status.pendingForwardCount <= 0) {
    return `This phone is safely carrying ${heldLabel}; server forwarding has completed.`;
  }
  if (status.pendingForwardCount === status.heldRelayCount) {
    return `This phone is safely carrying ${heldLabel} and is waiting to forward ${status.pendingForwardCount === 1 ? 'it' : 'them'} to the SAGIP server.`;
  }
  return `This phone is safely carrying ${heldLabel}; ${status.pendingForwardCount} still ${status.pendingForwardCount === 1 ? 'needs' : 'need'} server forwarding.`;
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
  const custodySummary = relayCustodySummary(status);

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
          detail = custodySummary
            ? `${custodySummary} SAGIP is conserving battery between nearby-device checks.`
            : 'SAGIP is conserving battery between nearby-device checks. Relay will resume automatically.';
        } else if (status.isScanning && status.isAdvertising) {
          stateText = 'Nearby relay active';
          const discoveryDetail =
            status.peerCount > 0
              ? `${status.peerCount} nearby SAGIP device${status.peerCount === 1 ? '' : 's'} detected.`
              : 'Searching for nearby SAGIP devices.';
          detail = custodySummary ? `${custodySummary} ${discoveryDetail}` : discoveryDetail;
        } else if (status.isScanning || status.isAdvertising) {
          stateText = 'Nearby relay partially active';
          detail = custodySummary
            ? `${custodySummary} Bluetooth relay is running, but one nearby mode is not active.`
            : 'Bluetooth relay is running, but one relay mode is not active. SAGIP will keep retrying delivery.';
          actionLabel = 'Retry nearby relay';
          action = onEnable;
        } else {
          stateText = 'Nearby relay not active';
          detail = custodySummary
            ? `${custodySummary} Bluetooth is ready, but nearby relay is not running.`
            : 'Bluetooth is ready, but nearby relay is not running. Your SOS remains saved locally.';
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
          accessibilityState={{disabled: requesting}}
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
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  brandCopy: {flex: 1, gap: 2},
  brand: {fontSize: 20, fontWeight: '900', letterSpacing: 2, color: '#21302B'},
  brandTagline: {fontSize: 12, lineHeight: 17, fontWeight: '700', color: '#56615D'},
  eyebrow: {fontSize: 13, fontWeight: '800', letterSpacing: 1.4, color: '#8D2F2A', marginTop: 8},
  title: {fontSize: 32, lineHeight: 38, fontWeight: '800', color: '#18211E'},
  subtitle: {fontSize: 17, lineHeight: 25, color: '#4B5752'},
  deliveryHelpText: {fontSize: 14, lineHeight: 21, fontWeight: '600', color: '#56615D'},
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
  cancelButton: {minHeight: 50, borderRadius: 14, borderWidth: 1.5, borderColor: '#8C9893', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
  cancelButtonText: {fontSize: 16, fontWeight: '800', color: '#35423D'},
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
  verifiedReceiptBlock: {gap: 6, paddingVertical: 4},
  evidenceText: {fontSize: 14, lineHeight: 20, color: '#56615D'},
  deliveryEvidenceText: {fontSize: 15, lineHeight: 21, fontWeight: '700', color: '#56615D'},
  failedText: {fontSize: 16, fontWeight: '800', color: '#B33A32'},
  statusDetailText: {fontSize: 15, lineHeight: 22, fontWeight: '600', color: '#44524D'},
  statusText: {fontSize: 15, lineHeight: 22, color: '#56615D'},
});
