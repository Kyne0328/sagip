import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {EmergencyHistoryEvent, EmergencyReportSummary, ServerStatusInfo} from './types';

const PAGE_SIZE = 10;
const EVENT_PAGE_SIZE = 50;
const eventLabels: Record<EmergencyHistoryEvent['kind'], string> = {
  LOCAL_COMMIT: 'SOS saved on this device',
  DETAILS_SAVED: 'Details saved',
  RELAYED_TO_PEER: 'Relayed to a nearby phone',
  SERVER_ACCEPTED: 'Server accepted SOS',
  DELIVERY_FAILED: 'Delivery failed',
  RESPONDER_UPDATE: 'Responder update',
};
const statusLabels: Record<string, string> = {
  ACKNOWLEDGED: 'Responder acknowledged SOS',
  EN_ROUTE: 'Responder says they are on the way',
  ON_SCENE: 'Responder says they are on scene',
  RESOLVED: 'Responder marked this resolved',
};

export function historyDate(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined) return 'not available';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'not available' : date.toLocaleString();
}

export function StatusFreshness({report, syncing = false}: {
  report: EmergencyReportSummary;
  syncing?: boolean;
}) {
  const sync = report.statusSync;
  return (
    <View style={styles.freshness}>
      {syncing ? <Text style={styles.detail} accessibilityLiveRegion="polite">Checking for updates…</Text> : null}
      <Text style={styles.detail}>
        {sync?.lastSuccessAt !== null && sync?.lastSuccessAt !== undefined
          ? `Last server check: ${historyDate(sync.lastSuccessAt)}`
          : 'No server check yet.'}
      </Text>
      {sync?.historyPending ? <Text style={styles.detail}>More history is syncing.</Text> : null}
      {sync?.state === 'FAILED' ? (
        <Text style={styles.warning}>Last server check failed at {historyDate(sync.lastAttemptAt)}. Status may be out of date.</Text>
      ) : null}
      <Text style={styles.detail}>
        {report.receiptReturnState === 'READY'
          ? 'A nearby SAGIP phone must connect before a new responder update can arrive.'
          : report.receiptReturnState === 'WAITING_FOR_QUALIFICATION'
            ? 'Nearby responder updates cannot be verified yet.'
            : 'Connect to the internet for new responder updates.'}
      </Text>
    </View>
  );
}

export function AuthenticatedServerStatus({status}: {status: ServerStatusInfo}) {
  return (
    <View style={styles.serverStatus}>
      <Text style={styles.title}>Responder update</Text>
      <Text style={styles.body}>{statusLabels[status.status]}</Text>
      {status.callsign ? <Text style={styles.body}>{status.callsign}</Text> : null}
      {status.note ? <Text style={styles.body}>{status.note}</Text> : null}
      <Text style={styles.detail}>Updated {historyDate(status.updatedAt)}</Text>
      <Text style={styles.detail}>Applies to the whole SOS.</Text>
    </View>
  );
}

export function offlineSnapshotText(receipt: NonNullable<EmergencyReportSummary['verifiedReceipt']>, serverConfirmed = false): string {
  const state = receipt.offlineEvidenceState;
  const qualification = state === 'VALID_AT_LAST_CHECK'
    ? 'Responder approval was valid at the last check.'
    : state === 'EXPIRED' ? 'Offline responder proof expired.'
      : state === 'REVOKED' ? 'Responder approval was revoked.'
        : state === 'CONFLICT' ? 'Responder approval is uncertain.'
          : 'Responder approval cannot be checked.';
  const authority = state === 'REVOKED'
    ? 'This saved update is not trusted.'
    : 'Current responder approval cannot be confirmed offline.';
  return `Saved signed responder update. ${qualification} ${authority} Issued: ${historyDate(receipt.issuedAt ?? null)}. Checked: ${historyDate(receipt.authorityCheckedAt)}. Valid until: ${historyDate(receipt.authorityExpiresAt ?? null)}. ${serverConfirmed ? 'Server confirmed this SOS resolved.' : 'SOS stays active.'}`;
}

function provenanceText(event: EmergencyHistoryEvent, serverConfirmed = false): string {
  switch (event.provenance) {
    case 'SERVER_AUTHENTICATED': return 'Server verified';
    case 'UNVERIFIED': return 'Unverified update';
    case 'VERIFIED_CURRENT': return 'Signed and verified when received';
    case 'VERIFIED_OFFLINE_AUTHORITY': return 'Signed and verified offline. Current approval cannot be checked.';
    case 'VERIFIED_OFFLINE_ROOT_SNAPSHOT': return 'Signed from an earlier approval check. Current approval cannot be checked.' +
      (serverConfirmed ? '' : ' SOS stays active.');
    default: return 'Recorded on this device';
  }
}

function HistoryReport({report}: {report: EmergencyReportSummary}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleEvents, setVisibleEvents] = useState(EVENT_PAGE_SIZE);
  const events = [...(report.history ?? [])].sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id));
  const receipt = report.verifiedReceipt;
  const serverConfirmed = report.serverResolutionConfirmed === true && !report.providerConflict && report.serverStatus?.status === 'RESOLVED';
  return (
    <View style={styles.report}>
      <Pressable accessibilityRole="button"
        accessibilityLabel={`SOS history for ${report.reportId}`}
        accessibilityState={{expanded}}
        onPress={() => setExpanded(current => !current)}
        style={styles.toggle}>
        <Text style={styles.title}>SOS · {historyDate(report.createdAt)}</Text>
        <Text style={styles.detail}>Report {report.reportId} · Version {report.revision ?? 1}</Text>
        <Text style={styles.link}>{expanded ? 'Hide timeline' : 'Show timeline'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.timeline}>
          <StatusFreshness report={report} />
          {report.providerConflict ? <Text style={styles.warning}>Responder updates conflict. SOS stays active.</Text> : null}
          {report.offlineSnapshotClosureHold ? <Text style={styles.warning}>Offline responder proof cannot confirm closure. SOS stays active.</Text> : null}
          {report.serverStatus ? <AuthenticatedServerStatus status={report.serverStatus} /> : null}
          {receipt ? (
            <View style={styles.event}>
              <Text style={styles.title}>{receipt.verificationKind === 'VERIFIED_OFFLINE_ROOT_SNAPSHOT' ? 'Saved responder update' : 'Responder receipt'} · Version {receipt.revision}</Text>
              <Text style={styles.body}>{statusLabels[receipt.status]}</Text>
              <Text style={styles.detail}>{receipt.callsign}{receipt.note ? ` · ${receipt.note}` : ''}</Text>
              <Text style={styles.detail}>
                {receipt.verificationKind === 'VERIFIED_OFFLINE_ROOT_SNAPSHOT'
                  ? offlineSnapshotText(receipt, serverConfirmed)
                  : receipt.verificationKind === 'VERIFIED_OFFLINE_AUTHORITY'
                    ? 'Verified offline. Current approval cannot be checked.'
                    : 'Responder approval was checked when received.'}
                {' '}Checked: {historyDate(receipt.authorityCheckedAt)}.
              </Text>
            </View>
          ) : null}
          {report.responderAck && !report.serverStatus ? (
            <Text style={styles.warning}>Unverified responder update: {statusLabels[report.responderAck.status] ?? report.responderAck.status}. SOS stays active until verified.</Text>
          ) : null}
          <Text style={styles.detail}>Saved timeline · newest first</Text>
          {events.length === 0 ? <Text style={styles.detail}>No detailed timeline.</Text> : events.slice(0, visibleEvents).map(event => (
            <View style={styles.event} key={event.id}>
              <Text style={styles.title}>{eventLabels[event.kind]}</Text>
              <Text style={styles.detail}>{historyDate(event.occurredAt)} · {event.revision === null ? 'Report-wide' : `Version ${event.revision}`}</Text>
              {event.status ? <Text style={styles.body}>{statusLabels[event.status] ?? event.status}</Text> : null}
              <Text style={event.provenance === 'UNVERIFIED' ? styles.warning : styles.detail}>{provenanceText(event, serverConfirmed)}</Text>
              {event.callsign ? <Text style={styles.body}>{event.callsign}</Text> : null}
              {event.note ? <Text style={styles.body}>{event.note}</Text> : null}
            </View>
          ))}
          {visibleEvents < events.length ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Show more history events for ${report.reportId}`}
              onPress={() => setVisibleEvents(current => current + EVENT_PAGE_SIZE)} style={styles.toggle}>
              <Text style={styles.link}>Show {Math.min(EVENT_PAGE_SIZE, events.length - visibleEvents)} more saved events</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function SosHistory({reports}: {reports: EmergencyReportSummary[]}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const ordered = [...reports].sort((a, b) => b.createdAt - a.createdAt || a.reportId.localeCompare(b.reportId));
  return (
    <View style={styles.history}>
      <Text accessibilityRole="header" style={styles.heading}>SOS history</Text>
      <Text style={styles.detail}>Available offline.</Text>
      {ordered.length === 0 ? <Text style={styles.body}>No saved SOS yet.</Text> : null}
      {ordered.slice(0, visibleCount).map(report => <HistoryReport key={report.reportId} report={report} />)}
      {visibleCount < ordered.length ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Show more SOS reports"
          onPress={() => setVisibleCount(current => current + PAGE_SIZE)} style={styles.toggle}>
          <Text style={styles.link}>Show {Math.min(PAGE_SIZE, ordered.length - visibleCount)} more reports</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  history: {gap: 12},
  heading: {fontSize: 18, fontWeight: '800', color: '#18211E'},
  report: {backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#DCE1DB', padding: 14},
  toggle: {minHeight: 48, justifyContent: 'center', gap: 6},
  title: {fontSize: 15, lineHeight: 22, fontWeight: '700', color: '#21302B'},
  body: {fontSize: 15, lineHeight: 22, color: '#35423D'},
  detail: {fontSize: 14, lineHeight: 21, color: '#56615D'},
  warning: {fontSize: 14, lineHeight: 21, color: '#8A5B18', fontWeight: '600'},
  link: {fontSize: 15, fontWeight: '700', color: '#0D6857'},
  freshness: {gap: 5},
  timeline: {gap: 12, paddingTop: 12},
  event: {gap: 5, borderLeftWidth: 3, borderLeftColor: '#B9D4C5', paddingLeft: 12, paddingVertical: 6},
  serverStatus: {gap: 6, padding: 12, borderRadius: 12, backgroundColor: '#EFF6F1', borderWidth: 1, borderColor: '#B9D4C5'},
});
