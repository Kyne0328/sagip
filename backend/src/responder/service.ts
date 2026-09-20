import {createHash, randomUUID} from 'node:crypto';

import type {Pool} from 'pg';

import type {
  IncidentDetail,
  IncidentLocation,
  IncidentSummary,
  ReportStatusResponse,
  ResponderAck,
  ResponderIdentity,
  ResponderStatus,
} from './types.js';

const EMERGENCY_TYPES: Record<number, string> = {
  1: 'MEDICAL',
  2: 'FLOOD',
  3: 'FIRE',
  4: 'TRAPPED',
  5: 'VIOLENCE',
  6: 'OTHER',
};

const URGENCIES: Record<number, string> = {
  1: 'IMMEDIATE_DANGER',
  2: 'NEED_ASSISTANCE',
};

const LOCATION_SOURCES: Record<number, string> = {
  1: 'GPS',
  2: 'NETWORK',
};

const LOCATION_FRESHNESS: Record<number, string> = {
  1: 'FRESH',
  2: 'STALE',
};

export class ResponderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponderNotFoundError';
  }
}

export class ResponderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponderValidationError';
  }
}

export class ResponderService {
  constructor(private readonly pool: Pool) {}

  async authenticate(token: string): Promise<ResponderIdentity | null> {
    const trimmed = token.trim();
    if (!trimmed) return null;

    const hash = createHash('sha256').update(trimmed, 'utf8').digest('hex');
    const result = await this.pool.query<{
      responder_id: string;
      callsign: string;
      role: string;
      registered_at: Date;
    }>(
      `SELECT responder_id, callsign, role, registered_at
       FROM responder_identities
       WHERE api_key_hash = $1`,
      [hash],
    );

    if (result.rowCount === 0 || !result.rows[0]) return null;
    const row = result.rows[0];
    return {
      responderId: row.responder_id,
      callsign: row.callsign,
      role: row.role,
      registeredAt: row.registered_at.toISOString(),
    };
  }

  async listIncidents(statusFilter?: string, limit: number = 50): Promise<IncidentSummary[]> {
    const safeLimit = Math.min(Math.max(1, limit), 100);

    // Query incidents with latest revision and latest ack
    const sql = `
      WITH latest_rev AS (
        SELECT DISTINCT ON (report_id)
          report_id,
          revision,
          emergency_type,
          urgency,
          location_latitude_e6,
          location_longitude_e6,
          location_accuracy_cm,
          location_captured_at_ms,
          location_source,
          location_freshness
        FROM incident_revisions
        ORDER BY report_id, revision DESC
      ),
      latest_ack AS (
        SELECT DISTINCT ON (ra.report_id)
          ra.ack_id,
          ra.report_id,
          ra.responder_id,
          ri.callsign,
          ra.status,
          ra.note,
          ra.acknowledged_at
        FROM responder_acknowledgements ra
        JOIN responder_identities ri ON ra.responder_id = ri.responder_id
        ORDER BY ra.report_id, ra.acknowledged_at DESC
      )
      SELECT
        i.report_id,
        i.created_at_ms,
        i.first_received_at,
        lr.revision,
        lr.emergency_type,
        lr.urgency,
        lr.location_latitude_e6,
        lr.location_longitude_e6,
        lr.location_accuracy_cm,
        lr.location_captured_at_ms,
        lr.location_source,
        lr.location_freshness,
        la.ack_id,
        la.responder_id,
        la.callsign,
        la.status AS ack_status,
        la.note AS ack_note,
        la.acknowledged_at AS ack_time
      FROM incidents i
      JOIN latest_rev lr ON i.report_id = lr.report_id
      LEFT JOIN latest_ack la ON i.report_id = la.report_id
      ${statusFilter ? 'WHERE ($2 = \'PENDING\' AND la.ack_id IS NULL) OR la.status = $2' : ''}
      ORDER BY lr.urgency ASC, i.created_at_ms DESC
      LIMIT $1
    `;

    const params = statusFilter ? [safeLimit, statusFilter] : [safeLimit];
    const result = await this.pool.query<{
      report_id: string;
      created_at_ms: string | number;
      first_received_at: Date;
      revision: number;
      emergency_type: number;
      urgency: number;
      location_latitude_e6: number | null;
      location_longitude_e6: number | null;
      location_accuracy_cm: number | null;
      location_captured_at_ms: string | number | null;
      location_source: number | null;
      location_freshness: number | null;
      ack_id: string | null;
      responder_id: string | null;
      callsign: string | null;
      ack_status: string | null;
      ack_note: string | null;
      ack_time: Date | null;
    }>(sql, params);

    return result.rows.map(row => ({
      reportId: row.report_id,
      createdAtMs: Number(row.created_at_ms),
      firstReceivedAt: row.first_received_at.toISOString(),
      latestRevision: row.revision,
      emergencyType: EMERGENCY_TYPES[row.emergency_type] ?? 'OTHER',
      urgency: URGENCIES[row.urgency] ?? 'NEED_ASSISTANCE',
      location: this.mapLocation(row),
      latestAck: row.ack_id && row.responder_id && row.callsign && row.ack_status && row.ack_time
        ? {
            ackId: row.ack_id,
            reportId: row.report_id,
            responderId: row.responder_id,
            callsign: row.callsign,
            status: row.ack_status as ResponderStatus,
            note: row.ack_note,
            acknowledgedAt: row.ack_time.toISOString(),
          }
        : null,
    }));
  }

  async getIncidentDetail(reportId: string): Promise<IncidentDetail | null> {
    const incResult = await this.pool.query<{
      report_id: string;
      created_at_ms: string | number;
      first_received_at: Date;
    }>(
      'SELECT report_id, created_at_ms, first_received_at FROM incidents WHERE report_id = $1',
      [reportId],
    );

    if (incResult.rowCount === 0 || !incResult.rows[0]) return null;
    const inc = incResult.rows[0];

    const revResult = await this.pool.query<{
      revision: number;
      emergency_type: number;
      urgency: number;
      location_latitude_e6: number | null;
      location_longitude_e6: number | null;
      location_accuracy_cm: number | null;
      location_captured_at_ms: string | number | null;
      location_source: number | null;
      location_freshness: number | null;
    }>(
      `SELECT revision, emergency_type, urgency, location_latitude_e6, location_longitude_e6,
              location_accuracy_cm, location_captured_at_ms, location_source, location_freshness
       FROM incident_revisions
       WHERE report_id = $1
       ORDER BY revision ASC`,
      [reportId],
    );

    const acksResult = await this.pool.query<{
      ack_id: string;
      report_id: string;
      responder_id: string;
      callsign: string;
      status: string;
      note: string | null;
      acknowledged_at: Date;
    }>(
      `SELECT ra.ack_id, ra.report_id, ra.responder_id, ri.callsign, ra.status, ra.note, ra.acknowledged_at
       FROM responder_acknowledgements ra
       JOIN responder_identities ri ON ra.responder_id = ri.responder_id
       WHERE ra.report_id = $1
       ORDER BY ra.acknowledged_at ASC`,
      [reportId],
    );

    const revisions = revResult.rows.map(r => ({
      revision: r.revision,
      emergencyType: EMERGENCY_TYPES[r.emergency_type] ?? 'OTHER',
      urgency: URGENCIES[r.urgency] ?? 'NEED_ASSISTANCE',
      location: this.mapLocation(r),
    }));

    const acks: ResponderAck[] = acksResult.rows.map(a => ({
      ackId: a.ack_id,
      reportId: a.report_id,
      responderId: a.responder_id,
      callsign: a.callsign,
      status: a.status as ResponderStatus,
      note: a.note,
      acknowledgedAt: a.acknowledged_at.toISOString(),
    }));

    const latestRev = revisions.at(-1) ?? {
      revision: 1,
      emergencyType: 'OTHER',
      urgency: 'NEED_ASSISTANCE',
      location: null,
    };

    return {
      reportId: inc.report_id,
      createdAtMs: Number(inc.created_at_ms),
      firstReceivedAt: inc.first_received_at.toISOString(),
      latestRevision: latestRev.revision,
      emergencyType: latestRev.emergencyType,
      urgency: latestRev.urgency,
      location: latestRev.location,
      latestAck: acks.at(-1) ?? null,
      revisions,
      acknowledgements: acks,
    };
  }

  async acknowledgeIncident(
    reportId: string,
    responderId: string,
    status: ResponderStatus,
    note?: string | null,
  ): Promise<ResponderAck> {
    const validStatuses: ResponderStatus[] = ['ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE', 'RESOLVED'];
    if (!validStatuses.includes(status)) {
      throw new ResponderValidationError(`Invalid status: ${status}`);
    }

    // Ensure incident exists
    const inc = await this.pool.query('SELECT 1 FROM incidents WHERE report_id = $1', [reportId]);
    if (inc.rowCount === 0) {
      throw new ResponderNotFoundError(`Incident not found: ${reportId}`);
    }

    const ackId = randomUUID();
    // Insert with ON CONFLICT DO NOTHING for idempotency
    await this.pool.query(
      `INSERT INTO responder_acknowledgements(ack_id, report_id, responder_id, status, note, acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (report_id, responder_id, status) DO NOTHING`,
      [ackId, reportId, responderId, status, note ?? null],
    );

    // Read back canonical row
    const result = await this.pool.query<{
      ack_id: string;
      report_id: string;
      responder_id: string;
      callsign: string;
      status: string;
      note: string | null;
      acknowledged_at: Date;
    }>(
      `SELECT ra.ack_id, ra.report_id, ra.responder_id, ri.callsign, ra.status, ra.note, ra.acknowledged_at
       FROM responder_acknowledgements ra
       JOIN responder_identities ri ON ra.responder_id = ri.responder_id
       WHERE ra.report_id = $1 AND ra.responder_id = $2 AND ra.status = $3`,
      [reportId, responderId, status],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to retrieve acknowledgement');
    }

    return {
      ackId: row.ack_id,
      reportId: row.report_id,
      responderId: row.responder_id,
      callsign: row.callsign,
      status: row.status as ResponderStatus,
      note: row.note,
      acknowledgedAt: row.acknowledged_at.toISOString(),
    };
  }

  async getReportStatus(reportId: string): Promise<ReportStatusResponse | null> {
    const incResult = await this.pool.query<{
      report_id: string;
      first_received_at: Date;
    }>(
      'SELECT report_id, first_received_at FROM incidents WHERE report_id = $1',
      [reportId],
    );

    if (incResult.rowCount === 0 || !incResult.rows[0]) {
      return {
        reportId,
        serverAccepted: false,
        acceptedAt: null,
        latestAck: null,
      };
    }

    const inc = incResult.rows[0];
    const ackResult = await this.pool.query<{
      ack_id: string;
      callsign: string;
      status: string;
      note: string | null;
      acknowledged_at: Date;
    }>(
      `SELECT ra.ack_id, ri.callsign, ra.status, ra.note, ra.acknowledged_at
       FROM responder_acknowledgements ra
       JOIN responder_identities ri ON ra.responder_id = ri.responder_id
       WHERE ra.report_id = $1
       ORDER BY ra.acknowledged_at DESC
       LIMIT 1`,
      [reportId],
    );

    const ack = ackResult.rows[0];
    return {
      reportId: inc.report_id,
      serverAccepted: true,
      acceptedAt: inc.first_received_at.toISOString(),
      latestAck: ack
        ? {
            ackId: ack.ack_id,
            callsign: ack.callsign,
            status: ack.status as ResponderStatus,
            note: ack.note,
            acknowledgedAt: ack.acknowledged_at.toISOString(),
          }
        : null,
    };
  }

  private mapLocation(row: {
    location_latitude_e6: number | null;
    location_longitude_e6: number | null;
    location_accuracy_cm: number | null;
    location_captured_at_ms: string | number | null;
    location_source: number | null;
    location_freshness: number | null;
  }): IncidentLocation | null {
    if (row.location_latitude_e6 === null || row.location_longitude_e6 === null) {
      return null;
    }
    return {
      latitude: row.location_latitude_e6 / 1_000_000,
      longitude: row.location_longitude_e6 / 1_000_000,
      accuracyMeters: row.location_accuracy_cm === null ? null : row.location_accuracy_cm / 100,
      capturedAtMs: row.location_captured_at_ms === null ? null : Number(row.location_captured_at_ms),
      source: row.location_source ? LOCATION_SOURCES[row.location_source] ?? null : null,
      freshness: row.location_freshness ? LOCATION_FRESHNESS[row.location_freshness] ?? null : null,
    };
  }
}
