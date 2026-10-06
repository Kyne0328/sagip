import React, {useEffect, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {SagipMark} from './src/branding/SagipMark';
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
import {activeEmergencyReport, reportIsResolved, useEmergencyReports} from './src/emergency/useEmergencyReports';
import {AuthenticatedServerStatus, historyDate, offlineSnapshotText, SosHistory, StatusFreshness} from './src/emergency/SosHistory';

const emergencyLabels: Record<EmergencyType, string> = {
  UNSPECIFIED: 'Type not specified',
  MEDICAL: 'Medical',
  FLOOD: 'Flood',
  FIRE: 'Fire',
  TRAPPED: 'Trapped',
  VIOLENCE: 'Violence / threat',
  OTHER: 'Other emergency',
};

const urgencyLabels: Record<Urgency, string> = {
  UNSPECIFIED: 'Urgency not specified',
  IMMEDIATE_DANGER: 'Immediate danger',
  NEED_ASSISTANCE: 'Need assistance',
};

function responderAcknowledgementText(ack: ResponderAckInfo | null | undefined) {
  const responseState = (() => {
    switch (ack?.status) {
      case 'EN_ROUTE':
        return 'Responders say they are on the way';
      case 'ON_SCENE':
        return 'Responders say they are on scene';
      case 'RESOLVED':
        return 'Responder marked this resolved';
      default:
        return 'Responder acknowledged your SOS';
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

function verifiedResponderHeadline(receipt: VerifiedReceiptInfo, currentRevision = receipt.revision, serverConfirmed = false): string {
  if (receipt.verificationKind === 'VERIFIED_OFFLINE_ROOT_SNAPSHOT') {
    if (serverConfirmed) return 'Server confirmed this SOS resolved.';
    if (receipt.offlineEvidenceState !== 'VALID_AT_LAST_CHECK') {
      return 'Saved responder update needs a fresh check. SOS stays active.';
    }
    return receipt.status === 'RESOLVED'
      ? 'Saved responder update says resolved. SOS stays active until confirmed.'
      : `Saved responder update: ${receipt.status.replace(/_/g, ' ').toLowerCase()}. Current status is unconfirmed.`;
  }
  switch (receipt.status) {
    case 'EN_ROUTE':
      return 'Responder says they are on the way';
    case 'ON_SCENE':
      return 'Responder says they are on scene';
    case 'RESOLVED':
      return 'Responder marked this resolved';
    default:
      return receipt.revision === currentRevision ? 'Responder acknowledged this SOS' : `Responder acknowledged SOS version ${receipt.revision}`;
  }
}

function verifiedResponderText(receipt: VerifiedReceiptInfo, currentRevision: number, serverConfirmed = false): string {
  return [
    verifiedResponderHeadline(receipt, currentRevision, serverConfirmed),
    receipt.callsign ? `· ${receipt.callsign}` : null,
    receipt.note ? `(${receipt.note})` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function verifiedAuthorityText(receipt: VerifiedReceiptInfo, serverConfirmed = false): string {
  if (receipt.verificationKind === 'VERIFIED_OFFLINE_ROOT_SNAPSHOT') return offlineSnapshotText(receipt, serverConfirmed);
  return `Responder approval was verified offline. Current approval cannot be checked. Checked: ${historyDate(receipt.authorityCheckedAt)}.`;
}

export default function App() {
  const {reports, loading, syncing, saving: nativeSaving, message: nativeMessage, create, appendDetails, refresh} = useEmergencyReports();
  const {
    status: relayStatus,
    loading: relayLoading,
    requesting: relayRequesting,
    enable: enableRelay,
    refresh: refreshRelay,
  } = useBleRelayStatus();
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const primarySosBottom = useRef(0);
  const [showCompactSos, setShowCompactSos] = useState(false);
  const {width, fontScale} = useWindowDimensions();
  const compactCategories = width >= 360 && fontScale <= 1.3;
  const [showHelp, setShowHelp] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [detailsTarget, setDetailsTarget] = useState<{reportId: string; revision: number} | null>(null);
  const detailOperation = useRef<{key: string; id: string} | null>(null);
  const detailsSaveInFlight = useRef(false);
  const [preparingDetails, setPreparingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const saving = nativeSaving || preparingDetails;
  const message = detailsError ?? nativeMessage;
  const [emergencyType, setEmergencyType] = useState<EmergencyType | null>(null);
  const [urgency, setUrgency] = useState<Urgency | null>(null);
  const activeSos = activeEmergencyReport(reports);
  const latest = activeSos ?? reports[0];
  const hasActiveSos = !!activeSos;
  const latestServerConfirmed = latest?.serverResolutionConfirmed === true && reportIsResolved(latest);
  const detailsReport = reports.find(report => report.reportId === detailsTarget?.reportId);
  const detailsTargetClosed = !!detailsReport && reportIsResolved(detailsReport);
  const originalDeliveryState = latest?.originalDelivery?.deliveryState ?? latest?.deliveryState;
  const latestVerifiedReportId = latest?.reportId;
  const latestVerifiedReceipt = latest?.verifiedReceipt;
  const latestVerifiedEventId = latestVerifiedReceipt?.eventId;
  const latestVerifiedHeadline = latestVerifiedReceipt
    ? latest?.providerConflict
      ? 'Responder updates conflict. SOS stays active.'
      : verifiedResponderHeadline(latestVerifiedReceipt, latest?.revision ?? 1, latestServerConfirmed)
    : null;

  useEffect(() => {
    // Warm a previously granted location permission without putting a dialog in front of SOS.
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
    message === 'Could not save SOS. Try again.' ||
    message === 'Could not load saved SOS reports.' ||
    message?.startsWith('Could not save details.') === true;

  useEffect(() => {
    // Reveal the form, saved report or error without jumping on delivery refreshes.
    scrollRef.current?.scrollTo({y: 0, animated: false});
    setShowCompactSos(false);
  }, [showForm, messageIsError]);

  const sendSos = async () => {
    setDetailsError(null);
    setShowHelp(false);
    // No form, permission request, or location acquisition can gate durable creation.
    const saved = await create({});
    if (saved) {
      // The SOS is already durable. Permission/current-fix work is best effort from here.
      void prepareSosLocation(true);
      setShowForm(false);
      setDetailsTarget(null);
      detailOperation.current = null;
    }
  };

  const pressSos = () => { if (hasActiveSos) { void refresh(); } else { void sendSos(); } };

  const openDetails = () => {
    if (!latest || saving) return;
    setDetailsTarget({reportId: latest.reportId, revision: latest.revision ?? 1});
    setEmergencyType(null);
    setUrgency(null);
    detailOperation.current = null;
    setDetailsError(null);
    setShowForm(true);
  };

  const save = async () => {
    if (!detailsTarget || detailsTargetClosed || (!emergencyType && !urgency) || detailsSaveInFlight.current) return;
    detailsSaveInFlight.current = true;
    setPreparingDetails(true);
    setDetailsError(null);
    try {
      const key = JSON.stringify([detailsTarget, emergencyType, urgency]);
      if (detailOperation.current?.key !== key) {
        detailOperation.current = {key, id: await SurvivalCore.newEmergencyDetailsOperationId()};
      }
      const result = await appendDetails(detailsTarget.reportId, {
        expectedRevision: detailsTarget.revision,
        operationId: detailOperation.current.id,
        ...(emergencyType ? {emergencyType} : {}),
        ...(urgency ? {urgency} : {}),
      });
      if (result) {
        setShowForm(false);
        setDetailsTarget(null);
        setEmergencyType(null);
        setUrgency(null);
      }
    } catch {
      setDetailsError('Could not save details. SOS is still saved. Try again.');
    } finally {
      detailsSaveInFlight.current = false;
      setPreparingDetails(false);
    }
  };

  const statusCard = (
    <View style={styles.statusCard}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>{hasActiveSos ? 'Active SOS' : 'Latest SOS'}</Text>
      {loading ? (
        <Text style={styles.statusText}>Checking…</Text>
      ) : latest ? (
        <>
          <Text style={styles.savedText}>Saved on this device</Text>
          <StatusFreshness report={latest} syncing={syncing} />
          {latest.providerConflict ? <Text style={styles.pendingText}>Responder updates conflict. SOS stays active.</Text> : null}
          {latest.offlineSnapshotClosureHold ? <Text style={styles.pendingText}>Offline responder proof cannot confirm closure. SOS stays active.</Text> : null}
          {!hasActiveSos ? <Text style={styles.statusDetailText}>Resolved. You can send a new SOS.</Text> : null}
          {latest.serverStatus ? <AuthenticatedServerStatus status={latest.serverStatus} /> : null}
          {latest.verifiedReceipt ? (
            <View style={styles.verifiedReceiptBlock}>
              <Text style={styles.responderText}>{latest.verifiedReceipt.verificationKind === 'VERIFIED_OFFLINE_ROOT_SNAPSHOT' ? 'Saved responder update' : 'Responder update'}</Text>
              {latest.verifiedReceipt.revision !== (latest.revision ?? 1) ? <Text style={styles.evidenceText}>For SOS version {latest.verifiedReceipt.revision}</Text> : null}
              <Text style={styles.statusDetailText}>
                {verifiedResponderText(latest.verifiedReceipt, latest.revision ?? 1, latestServerConfirmed)}
              </Text>
              {latest.verifiedReceipt.verificationKind !== 'VERIFIED_CURRENT' ? (
                <Text style={styles.evidenceText}>
                  {verifiedAuthorityText(latest.verifiedReceipt, latestServerConfirmed)}
                </Text>
              ) : null}
            </View>
          ) : null}
          {latest.serverStatus && (originalDeliveryState === 'DELIVERY_PENDING' || originalDeliveryState === 'RELAYED_TO_PEER' || originalDeliveryState === 'PERMANENT_FAILURE') ? (
            <>
              <Text style={styles.deliveryEvidenceText}>
                {originalDeliveryState === 'PERMANENT_FAILURE' ? 'Original delivery receipt unavailable' : 'Original delivery receipt pending'}
              </Text>
              <Text style={styles.statusDetailText}>
                The server has this SOS. This phone is still missing the original delivery receipt.
                {' '}{originalDeliveryState === 'PERMANENT_FAILURE'
                  ? 'Automatic delivery cannot retry it.'
                  : originalDeliveryState === 'RELAYED_TO_PEER'
                    ? 'A nearby phone has a copy. SAGIP will keep checking.'
                    : 'SAGIP will keep retrying.'}
              </Text>
            </>
          ) : latest.serverStatus && originalDeliveryState === 'RESPONDER_ACKNOWLEDGED' ? (
            <Text style={styles.deliveryEvidenceText}>Server-confirmed responder status is shown above.</Text>
          ) : originalDeliveryState === 'RESPONDER_ACKNOWLEDGED' ? (
            <>
              <Text
                style={
                  latest.verifiedReceipt
                    ? styles.deliveryEvidenceText
                    : styles.pendingText
                }>
                {latest.verifiedReceipt
                  ? 'Responder update recorded'
                  : 'Unverified responder update'}
              </Text>
              <Text style={styles.statusDetailText}>
                {latest.verifiedReceipt
                  ? 'Verified responder status is shown above.'
                  : `${responderAcknowledgementText(latest.responderAck)}. This update is not verified.`}
              </Text>
            </>
          ) : originalDeliveryState === 'SERVER_ACCEPTED' ? (
            <>
              <Text style={styles.acceptedText}>Server accepted SOS</Text>
              <Text style={styles.statusDetailText}>
                Responder acknowledgement is not confirmed yet.
              </Text>
            </>
          ) : originalDeliveryState === 'PERMANENT_FAILURE' ? (
            <>
              <Text style={styles.failedText}>Delivery failed permanently</Text>
              <Text style={styles.statusDetailText}>
                SOS is still saved here. Automatic delivery cannot continue.
              </Text>
            </>
          ) : originalDeliveryState === 'RELAYED_TO_PEER' ? (
            <>
              <Text style={styles.relayedText}>Relayed to another SAGIP phone</Text>
              <Text style={styles.statusDetailText}>
                Server receipt is not confirmed yet.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.pendingText}>Waiting to send</Text>
              <Text style={styles.statusDetailText}>
                SOS is saved. SAGIP will keep trying.
              </Text>
            </>
          )}
          {(latest.revision ?? 1) > 1 && latest.latestDelivery ? (
            <View style={styles.verifiedReceiptBlock}>
              <Text style={styles.sectionTitle}>Details status</Text>
              <Text style={styles.statusDetailText}>
                {detailsDeliveryText(latest.latestDelivery.deliveryState)}
              </Text>
            </View>
          ) : null}
          <Text style={styles.statusText}>
            {emergencyLabels[latest.emergencyType]} · {urgencyLabels[latest.urgency]}
          </Text>
          <Text style={styles.statusDetailText}>
            {latest.location
              ? `Location · ${latest.location.source} · ${latest.location.freshness === 'FRESH' ? 'recent' : 'older'}${latest.location.accuracyMeters === null ? '' : ` · ±${Math.round(latest.location.accuracyMeters)} m`}`
              : 'No location attached.'}
          </Text>
        </>
      ) : (
        <Text style={styles.statusText}>No SOS saved yet.</Text>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      {showForm || showCompactSos ? (
        <Pressable testID="compact-sos-button" accessibilityRole="button"
          accessibilityLabel={hasActiveSos ? 'Active SOS. Check status' : 'Save emergency SOS'}
          accessibilityHint={hasActiveSos ? 'Checks this SOS. It does not create a new one.' : 'Saves the SOS on this phone first.'}
          disabled={saving} accessibilityState={{disabled: saving, busy: saving}}
          onPress={pressSos}
          style={({pressed}) => [styles.compactSosButton, saving && styles.disabledButton, pressed && styles.pressed]}>
          <Text style={styles.compactSosText}>{saving ? 'Saving SOS…' : hasActiveSos ? 'SOS already active' : 'SOS'}</Text>
          <Text style={styles.compactSosHint}>{hasActiveSos ? 'Check status' : 'Tap to save SOS'}</Text>
        </Pressable>
      ) : null}
      <ScrollView ref={scrollRef} contentContainerStyle={styles.container}
        scrollEventThrottle={16}
        onScroll={event => setShowCompactSos(primarySosBottom.current > 0 && event.nativeEvent.contentOffset.y >= primarySosBottom.current)}>
        <View style={styles.brandRow}>
          <SagipMark />
          <View style={styles.brandCopy}>
            <Text style={styles.brand}>SAGIP</Text>
            <Text style={styles.brandTagline}>Emergency communication that keeps trying</Text>
          </View>
        </View>
        {message ? (
          <View
            accessibilityRole={messageIsError ? 'alert' : undefined}
            accessibilityLiveRegion={messageIsError ? 'assertive' : 'polite'}
            style={styles.messageCard}>
            <Text style={styles.messageText}>{message}</Text>
          </View>
        ) : null}
        {showForm || !latest ? (
          <View style={styles.introduction}>
            <Text accessibilityRole="header" style={styles.title}>
              {showForm ? 'Add optional details' : 'Need help now?'}
            </Text>
            <Text style={styles.subtitle}>{showForm ? 'SOS is already saved. Add details if you can.' : 'SOS saves even without internet.'}</Text>
          </View>
        ) : null}

        {!showForm ? (
          <Pressable
            accessibilityRole="button"
            testID="primary-sos-button"
            onLayout={event => { primarySosBottom.current = event.nativeEvent.layout.y + event.nativeEvent.layout.height; }}
            accessibilityLabel={hasActiveSos ? 'Active SOS. Check status' : 'Save emergency SOS'}
            accessibilityHint={hasActiveSos ? 'Checks this SOS. It does not create a new one.' : 'Saves the SOS on this phone and starts delivery.'}
            disabled={saving}
            accessibilityState={{disabled: saving, busy: saving}}
            style={({pressed}) => [styles.sosButton, saving && styles.disabledButton, pressed && styles.pressed]}
            onPress={pressSos}>
            <Text style={styles.sosButtonText}>SOS</Text>
            <Text style={styles.sosButtonSubtext}>
              {saving ? 'Saving SOS…' : hasActiveSos ? 'SOS already active' : latest ? 'Tap to send a new SOS' : 'Tap once to send SOS'}
            </Text>
            {hasActiveSos ? <Text style={styles.sosButtonHint}>
              {syncing ? 'Checking status…' : 'Tap to check status'}
            </Text> : null}
          </Pressable>
        ) : (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Emergency type</Text>
            <View style={styles.optionGrid}>
              {EMERGENCY_TYPES.map(type => (
                <OptionButton
                  key={type}
                  compact={compactCategories}
                  label={emergencyLabels[type]}
                  disabled={saving}
                  selected={emergencyType === type}
                  onPress={() => setEmergencyType(type)}
                />
              ))}
            </View>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Urgency</Text>
            {URGENCIES.map(item => (
              <OptionButton
                key={item}
                label={urgencyLabels[item]}
                disabled={saving}
                selected={urgency === item}
                onPress={() => setUrgency(item)}
              />
            ))}
          </View>
        )}
        {!showForm ? statusCard : null}
        {latest && hasActiveSos && !showForm ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Add optional SOS details"
            disabled={saving} accessibilityState={{disabled: saving}}
            onPress={openDetails} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Add optional details</Text>
          </Pressable>
        ) : null}
        {showForm ? statusCard : null}

        {!showForm ? <>
          <Pressable accessibilityRole="button" accessibilityLabel="SOS history"
            accessibilityState={{expanded: showHistory}} style={styles.secondaryButton}
            onPress={() => setShowHistory(current => !current)}>
            <Text style={styles.secondaryButtonText}>{showHistory ? 'Hide history' : `SOS history (${reports.length})`}</Text>
          </Pressable>
          {showHistory ? <SosHistory reports={reports} /> : null}
        </> : null}
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="How SOS works"
          accessibilityState={{expanded: showHelp}}
          onPress={() => setShowHelp(current => !current)}
          style={({pressed}) => [styles.secondaryButton, pressed && styles.pressed]}>
          <Text style={styles.secondaryButtonText}>{showHelp ? 'Hide help' : 'How SOS works'}</Text>
        </Pressable>
        {showHelp ? (
          <View style={styles.card}>
            <Text style={styles.deliveryHelpText}>
              With internet, SAGIP sends to the server. Without internet, nearby SAGIP phones can relay it.
            </Text>
            <Text style={styles.deliveryHelpText}>
              SAGIP adds location when available. SOS saving does not depend on location.
            </Text>
          </View>
        ) : null}
      </ScrollView>
      {showForm ? (
        <View style={styles.formActions}>
          {detailsTargetClosed ? <Text style={styles.statusDetailText}>This SOS was resolved. Close these unsaved details.</Text> : null}
          {detailsTarget && latest?.reportId === detailsTarget.reportId && (latest.revision ?? 1) !== detailsTarget.revision ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Refresh SOS and keep choices"
              disabled={saving} accessibilityState={{disabled: saving}}
              onPress={() => {
                setDetailsTarget({reportId: latest.reportId, revision: latest.revision ?? 1});
                detailOperation.current = null;
                setDetailsError(null);
              }} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>SOS changed. Refresh and keep choices</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={saving ? 'Saving optional SOS details' : 'Save optional SOS details'}
            accessibilityHint="Adds the selected details to this SOS."
            disabled={detailsTargetClosed || (!emergencyType && !urgency) || saving}
            accessibilityState={{disabled: detailsTargetClosed || (!emergencyType && !urgency) || saving}}
            onPress={() => {
              void save();
            }}
            style={({pressed}) => [
              styles.saveButton,
              (detailsTargetClosed || (!emergencyType && !urgency) || saving) && styles.disabledButton,
              pressed && styles.pressed,
            ]}>
            <Text style={styles.saveButtonText}>{saving ? 'Saving details…' : 'Save details'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip optional SOS details"
            accessibilityHint="Keeps the SOS. Discards unsaved choices."
            disabled={saving}
            accessibilityState={{disabled: saving}}
            onPress={() => {
              setShowForm(false);
              setDetailsError(null);
              setDetailsTarget(null);
              setEmergencyType(null);
              setUrgency(null);
            }}
            style={({pressed}) => [
              styles.cancelButton,
              saving && styles.disabledButton,
              pressed && styles.pressed,
            ]}>
            <Text style={styles.cancelButtonText}>Skip details</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function detailsDeliveryText(state: string): string {
  switch (state) {
    case 'SERVER_ACCEPTED': return 'Server accepted the latest details.';
    case 'RESPONDER_ACKNOWLEDGED': return 'Responder acknowledgement recorded for the latest details.';
    case 'RELAYED_TO_PEER': return 'Another SAGIP phone has the latest details. Server receipt is not confirmed.';
    case 'PERMANENT_FAILURE': return 'Latest details stay saved here. Delivery failed permanently.';
    default: return 'Latest details are saved here. Waiting to send.';
  }
}

function relayCustodySummary(status: BleRelayStatus | null): string | null {
  if (!status || status.heldRelayCount <= 0) return null;
  const heldLabel = `${status.heldRelayCount} relayed SOS message${status.heldRelayCount === 1 ? '' : 's'}`;
  if (status.pendingForwardCount <= 0) {
    return `${heldLabel} saved here. Forwarding complete.`;
  }
  if (status.pendingForwardCount === status.heldRelayCount) {
    return `${heldLabel} saved here. Waiting to forward.`;
  }
  return `${heldLabel} saved here. ${status.pendingForwardCount} waiting to forward.`;
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
  let detail = 'SOS saving does not depend on nearby relay.';
  let actionLabel: string | null = null;
  let action: (() => void) | null = null;
  const custodySummary = relayCustodySummary(status);

  if (!loading || status) {
    switch (status?.availability) {
      case 'PERMISSION_REQUIRED':
        stateText = 'Nearby relay needs permission';
        detail =
          'Allow nearby-device access to relay SOS messages when internet is unavailable.';
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
        detail = 'This phone does not support SAGIP nearby relay.';
        break;
      case 'READY':
        if (status.isDutyCyclePaused) {
          stateText = 'Nearby relay active';
          detail = custodySummary
            ? `${custodySummary} Relay is paused to save battery.`
            : 'Relay is paused to save battery. It restarts automatically.';
        } else if (status.isScanning && status.isAdvertising) {
          stateText = 'Nearby relay active';
          const discoveryDetail =
            status.peerCount > 0
              ? `${status.peerCount} nearby SAGIP device${status.peerCount === 1 ? '' : 's'} detected.`
              : 'Searching for nearby SAGIP phones.';
          detail = custodySummary ? `${custodySummary} ${discoveryDetail}` : discoveryDetail;
        } else if (status.isScanning || status.isAdvertising) {
          stateText = 'Nearby relay partially active';
          detail = custodySummary
            ? `${custodySummary} Relay is only partly active.`
            : 'Relay is only partly active. SAGIP will retry.';
          actionLabel = 'Retry nearby relay';
          action = onEnable;
        } else {
          stateText = 'Nearby relay not active';
          detail = custodySummary
            ? `${custodySummary} Bluetooth is ready, but nearby relay is not running.`
            : 'Bluetooth is ready. Nearby relay is not running.';
          actionLabel = 'Retry nearby relay';
          action = onEnable;
        }
        break;
      default:
        stateText = 'Relay status unavailable';
        detail = 'SOS saving still works.';
        actionLabel = 'Check relay status';
        action = onRefresh;
    }
  }

  return (
    <View style={styles.relayCard}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>Nearby relay</Text>
      <Text accessibilityLiveRegion="polite" style={styles.relayStateText}>
        {stateText}
      </Text>
      <Text style={styles.relayDetailText}>{detail}</Text>
      {actionLabel && action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          accessibilityHint="Checks nearby relay only."
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
  compact = false,
  disabled = false,
  selected,
  onPress,
}: {
  label: string;
  compact?: boolean;
  disabled?: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{selected, disabled}}
      accessibilityLabel={label}
      onPress={onPress}
      style={({pressed}) => [styles.optionButton, compact && styles.compactOption, selected && styles.optionButtonSelected, pressed && styles.pressed]}>
      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{selected ? '✓ ' : ''}{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#F7F5F0'},
  container: {padding: 16, gap: 12},
  introduction: {gap: 8},
  formActions: {paddingHorizontal: 16, paddingBottom: 8, gap: 8, borderTopWidth: 1, borderTopColor: '#BCC4C0', backgroundColor: '#F7F5F0'},
  secondaryButton: {minHeight: 48, justifyContent: 'center'},
  secondaryButtonText: {fontSize: 16, fontWeight: '700', color: '#35423D'},
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  brandCopy: {flex: 1, gap: 2},
  brand: {fontSize: 20, fontWeight: '900', letterSpacing: 2, color: '#21302B'},
  brandTagline: {fontSize: 12, lineHeight: 17, fontWeight: '700', color: '#56615D'},
  title: {fontSize: 28, lineHeight: 34, fontWeight: '800', color: '#18211E'},
  subtitle: {fontSize: 17, lineHeight: 25, color: '#4B5752'},
  deliveryHelpText: {fontSize: 14, lineHeight: 21, fontWeight: '600', color: '#56615D'},
  sosButton: {minHeight: 190, borderRadius: 28, backgroundColor: '#B33A32', alignItems: 'center', justifyContent: 'center', padding: 24, marginVertical: 8},
  sosButtonText: {fontSize: 56, fontWeight: '900', color: '#FFFFFF', letterSpacing: 3},
  sosButtonSubtext: {fontSize: 16, lineHeight: 23, textAlign: 'center', fontWeight: '700', color: '#FFFFFF', marginTop: 8},
  compactSosButton: {minHeight: 64, marginHorizontal: 16, marginTop: 8, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 14, backgroundColor: '#B33A32', justifyContent: 'center'},
  compactSosText: {fontSize: 20, lineHeight: 26, fontWeight: '800', color: '#FFFFFF'},
  compactSosHint: {fontSize: 13, lineHeight: 19, color: '#FFFFFF'},
  sosButtonHint: {fontSize: 14, lineHeight: 21, textAlign: 'center', color: '#FFFFFF', marginTop: 6},
  card: {backgroundColor: '#FFFFFF', borderRadius: 20, padding: 18, gap: 12, borderWidth: 1, borderColor: '#DCE1DB'},
  sectionTitle: {fontSize: 18, fontWeight: '800', color: '#18211E', marginTop: 4},
  optionGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  compactOption: {width: '47%', flexGrow: 1},
  optionButton: {width: '100%', minHeight: 52, paddingVertical: 12, borderWidth: 1.5, borderColor: '#BCC4C0', borderRadius: 14, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#FFFFFF'},
  optionButtonSelected: {borderColor: '#21302B', backgroundColor: '#E8ECEA'},
  optionText: {fontSize: 16, fontWeight: '600', color: '#35423D'},
  optionTextSelected: {fontWeight: '800', color: '#18211E'},
  saveButton: {minHeight: 58, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 16, backgroundColor: '#21302B', alignItems: 'center', justifyContent: 'center', marginTop: 8},
  disabledButton: {opacity: 0.45},
  pressed: {opacity: 0.8},
  saveButtonText: {fontSize: 17, lineHeight: 24, textAlign: 'center', fontWeight: '800', color: '#FFFFFF'},
  cancelButton: {minHeight: 50, borderRadius: 14, borderWidth: 1.5, borderColor: '#8C9893', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
  cancelButtonText: {fontSize: 16, fontWeight: '800', color: '#35423D'},
  messageCard: {borderRadius: 16, padding: 16, backgroundColor: '#E8ECEA'},
  messageText: {fontSize: 16, lineHeight: 23, fontWeight: '700', color: '#21302B'},
  relayCard: {borderRadius: 20, padding: 18, backgroundColor: '#FFFFFF', gap: 8, marginTop: 4, borderWidth: 1, borderColor: '#DCE1DB'},
  relayStateText: {fontSize: 16, lineHeight: 22, fontWeight: '800', color: '#21302B'},
  relayDetailText: {fontSize: 15, lineHeight: 22, color: '#56615D'},
  relayActionButton: {minHeight: 50, borderRadius: 14, backgroundColor: '#21302B', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginTop: 4},
  relayActionText: {fontSize: 16, fontWeight: '800', color: '#FFFFFF'},
  statusCard: {borderRadius: 20, padding: 18, backgroundColor: '#FFFFFF', gap: 8, marginTop: 4, borderWidth: 1, borderColor: '#DCE1DB'},
  savedText: {fontSize: 18, fontWeight: '800', color: '#21302B'},
  pendingText: {fontSize: 16, fontWeight: '800', color: '#8A5B18'},
  relayedText: {fontSize: 16, fontWeight: '800', color: '#805016'},
  acceptedText: {fontSize: 16, fontWeight: '800', color: '#1B6B38'},
  responderText: {fontSize: 16, fontWeight: '800', color: '#0D6857'},
  verifiedReceiptBlock: {gap: 6, padding: 12, borderRadius: 12, backgroundColor: '#EFF6F1', borderWidth: 1, borderColor: '#B9D4C5'},
  evidenceText: {fontSize: 14, lineHeight: 20, color: '#56615D'},
  deliveryEvidenceText: {fontSize: 15, lineHeight: 21, fontWeight: '700', color: '#56615D'},
  failedText: {fontSize: 16, fontWeight: '800', color: '#B33A32'},
  statusDetailText: {fontSize: 15, lineHeight: 22, fontWeight: '600', color: '#44524D'},
  statusText: {fontSize: 15, lineHeight: 22, color: '#56615D'},
});
