import {NativeModules} from 'react-native';

export interface GatewayAction {
  actionId: string;
  reportId: string;
  observedIncidentVersion: string;
  status: number;
  note: string;
}
export interface GatewayIncident {
  reportId: string;
  revision: number;
  observedIncidentVersion: string;
  emergencyType: string;
  urgency: string;
  message?: string | null;
  location: {latitude: number; longitude: number} | null;
  timeline: {eventId: string; callsign: string; status: number; note: string; revision: number}[];
  pendingActions?: GatewayAction[];
}
export interface GatewayResult {
  actionId: string;
  state: 'PREPARING' | 'SIGNED' | 'CONFLICT' | 'REJECTED' | 'FAILED';
  reason?: string | null;
  eventDigest?: string | null;
}
export interface GatewayAuthority {authorityReady: boolean; callsign: string | null}
export interface GatewayProvisioningInput {
  grantId: string; responderId: string; callsign: string; statusMask: number; purposeMask: number; scope: string;
}
export interface GatewayGrantRequest extends GatewayProvisioningInput {
  requestId: string; issuerKeyId: string; issuerPublicKeyDer: string; issuerProviderId: string;
}
interface NativeGateway {
  authenticate(): Promise<boolean>;
  lock(): Promise<void>;
  newActionId(): Promise<string>;
  status(): Promise<GatewayAuthority>;
  listGatewayIncidents(): Promise<GatewayIncident[]>;
  recordGatewayAction(action: GatewayAction): Promise<GatewayResult>;
  getGatewayAction(actionId: string): Promise<GatewayResult>;
  exportProvisioningRequest(input: GatewayProvisioningInput): Promise<GatewayGrantRequest>;
  provisionGrant(bytesBase64: string): Promise<{state: 'ACCEPTED' | 'REJECTED'; reason: string | null}>;
  beginAuthorityTimeChallenge(): Promise<{challengeId: string; verifierId: string; verifierBootSessionId: string; nonce: string}>;
  acceptAuthorityTimeProof(challengeId: string, bytesBase64: string): Promise<{kind: string; reason: string | null}>;
}
function native(): NativeGateway {
  const module = NativeModules.SagipGatewayCore as NativeGateway | undefined;
  if (!module) {throw new Error('Responder workspace requires Android');}
  return module;
}
export const GatewayCore = {
  authenticate: () => native().authenticate(),
  lock: async () => native().lock(),
  newActionId: () => native().newActionId(),
  status: () => native().status(),
  listGatewayIncidents: () => native().listGatewayIncidents(),
  recordGatewayAction: (action: GatewayAction) => native().recordGatewayAction(action),
  getGatewayAction: (actionId: string) => native().getGatewayAction(actionId),
  exportProvisioningRequest: (input: GatewayProvisioningInput) => native().exportProvisioningRequest(input),
  provisionGrant: (bytesBase64: string) => native().provisionGrant(bytesBase64),
  beginAuthorityTimeChallenge: () => native().beginAuthorityTimeChallenge(),
  acceptAuthorityTimeProof: (challengeId: string, bytesBase64: string) => native().acceptAuthorityTimeProof(challengeId, bytesBase64),
};
