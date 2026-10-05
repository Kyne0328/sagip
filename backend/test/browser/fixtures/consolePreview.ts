import {createServer} from 'node:http';
import {handleSagipRequest} from '../../../src/http/handleRequest.js';

// Isolated UI fixture: synthetic data, loopback only, no database or credentials.
const now = Date.now();
const types = ['TRAPPED', 'FIRE', 'MEDICAL', 'OTHER', 'TRAPPED'];
const incidents = types.map((emergencyType, index) => ({
  reportId: '11111111-1111-4111-8111-' + String(index + 1).padStart(12, '0'),
  createdAtMs: now - (index + 1) * 120000,
  firstReceivedAt: new Date(now - (index + 1) * 120000).toISOString(),
  latestRevision: 1,
  emergencyType,
  urgency: index < 2 ? 'IMMEDIATE_DANGER' : 'NEEDS_ASSISTANCE',
  message: index === 0 ? 'Person trapped inside a vehicle following a collision. Needs immediate assistance.' : 'Synthetic incident for console layout verification.',
  location: {latitude: 7.4477 + index * 0.002, longitude: 125.8078 + index * 0.001, accuracyMeters: 9, capturedAtMs: now - 120000, source: 'GPS', freshness: 'FRESH'},
  latestAck: index === 2 ? {status: 'EN_ROUTE', callsign: 'DEMO-RESPONDER', acknowledgedAt: new Date(now).toISOString(), note: 'Team dispatched.'} : null,
}));

export async function previewResponse(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
  if (url.pathname === '/v1/responder/session') return request.method === 'DELETE' ? new Response(null, {status: 204}) : json({responder: {responderId: '22222222-2222-4222-8222-222222222222', callsign: 'DEMO-RESPONDER', role: 'DISPATCHER'}, expiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString()});
  if (url.pathname === '/v1/incidents/summary') return json({total: 5, pending: 4, acknowledged: 0, enRoute: 1, onScene: 0, resolved: 0, immediateDanger: 2});
  if (url.pathname === '/v1/incidents') return json(incidents.filter(item => !url.searchParams.get('status') || (item.latestAck?.status ?? 'PENDING') === url.searchParams.get('status')));
  const incident = incidents.find(item => url.pathname === '/v1/incidents/' + item.reportId);
  if (incident) return json({...incident, revisions: [{...incident, revision: 1}], acknowledgements: incident.latestAck ? [incident.latestAck] : []});
  if (url.pathname.startsWith('/v1/')) return json({error: 'Preview fixture does not persist operations'}, 404);
  return handleSagipRequest(request, {ingestEnvelope: async () => {throw new Error('Not available in preview');}});
}

if (process.argv.includes('--serve')) {
  const server = createServer((req, res) => {
    void previewResponse(new Request('http://127.0.0.1:8091' + req.url, {method: req.method ?? 'GET'})).then(async response => {
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    }).catch(() => {res.writeHead(500); res.end('Preview error');});
  });
  server.listen(8091, '127.0.0.1', () => console.log('Synthetic console preview: http://127.0.0.1:8091/responder'));
}
