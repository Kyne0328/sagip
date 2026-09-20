export type ResponderStatus = 'ACKNOWLEDGED' | 'EN_ROUTE' | 'ON_SCENE' | 'RESOLVED';

export interface ResponderIdentity {
  responderId: string;
  callsign: string;
  role: string;
  registeredAt: string;
}

export interface ResponderAck {
  ackId: string;
  reportId: string;
  responderId: string;
  callsign: string;
  status: ResponderStatus;
  note: string | null;
  acknowledgedAt: string;
}

export interface IncidentLocation {
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  capturedAtMs: number | null;
  source: string | null;
  freshness: string | null;
}

export interface IncidentSummary {
  reportId: string;
  createdAtMs: number;
  firstReceivedAt: string;
  latestRevision: number;
  emergencyType: string;
  urgency: string;
  location: IncidentLocation | null;
  latestAck: ResponderAck | null;
}

export interface IncidentDetail extends IncidentSummary {
  revisions: Array<{
    revision: number;
    emergencyType: string;
    urgency: string;
    location: IncidentLocation | null;
  }>;
  acknowledgements: ResponderAck[];
}

export interface ReportStatusResponse {
  reportId: string;
  serverAccepted: boolean;
  acceptedAt: string | null;
  latestAck: {
    ackId: string;
    callsign: string;
    status: ResponderStatus;
    note: string | null;
    acknowledgedAt: string;
  } | null;
}
