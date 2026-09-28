const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0f2740">
  <title>SAGIP Responder Console</title>
  <link rel="stylesheet" href="/responder/styles.css">
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 108 108" role="img" aria-label="SAGIP locator pin with medical plus logo">
        <circle cx="54" cy="54" r="50" fill="#fff" stroke="#0f4c81" stroke-width="4"></circle>
        <path d="M54 19C38.5 19 27 30.7 27 45.8C27 64.4 54 90 54 90S81 64.4 81 45.8C81 30.7 69.5 19 54 19Z" fill="#c9302c"></path>
        <path d="M49 31H59V41H69V51H59V61H49V51H39V41H49Z" fill="#fff"></path>
      </svg>
      <div>
        <strong>SAGIP</strong>
        <span>Responder Console</span>
      </div>
    </div>
    <div class="connection">
      <span id="connectionDot" class="dot" aria-hidden="true"></span>
      <span id="connectionText">Not connected</span>
    </div>
  </header>

  <main>
    <section id="authPanel" class="auth-card" aria-labelledby="authTitle">
      <p class="eyebrow">AUTHORIZED RESPONDERS</p>
      <h1 id="authTitle">Connect to emergency operations</h1>
      <p class="muted">Use a responder bearer token provisioned by the SAGIP backend. The token is kept only in this browser tab session.</p>
      <form id="authForm">
        <label for="tokenInput">Responder token</label>
        <input id="tokenInput" name="token" type="password" autocomplete="off" spellcheck="false" required>
        <button type="submit">Open console</button>
      </form>
      <p id="authError" class="error" role="alert"></p>
    </section>

    <section id="consolePanel" class="console hidden" aria-label="Responder operations">
      <div class="toolbar">
        <div>
          <p class="eyebrow">LIVE INCIDENTS</p>
          <h1>Emergency queue</h1>
          <p id="lastUpdated" class="muted" aria-live="polite">Waiting for server data…</p>
        </div>
        <div class="toolbar-actions">
          <label class="filter-label" for="statusFilter">Status</label>
          <select id="statusFilter">
            <option value="">All</option>
            <option value="PENDING">Pending</option>
            <option value="ACKNOWLEDGED">Acknowledged</option>
            <option value="EN_ROUTE">En route</option>
            <option value="ON_SCENE">On scene</option>
            <option value="RESOLVED">Resolved</option>
          </select>
          <button id="refreshButton" type="button" class="secondary">Refresh</button>
          <button id="logoutButton" type="button" class="ghost">Disconnect</button>
        </div>
      </div>

      <div id="serverError" class="banner-error hidden" role="alert"></div>

      <div class="workspace">
        <section class="incident-column" aria-labelledby="incidentListTitle">
          <h2 id="incidentListTitle" class="sr-only">Incidents</h2>
          <div id="incidentList" class="incident-list" aria-live="polite"></div>
          <div id="emptyState" class="empty hidden">
            <strong>No incidents in this view.</strong>
            <span>New server-accepted SOS reports will appear here.</span>
          </div>
        </section>

        <section id="detailPanel" class="detail-panel" aria-labelledby="detailTitle">
          <div id="detailPlaceholder" class="detail-placeholder">
            <strong>Select an incident</strong>
            <span>Emergency type, urgency, location, revisions, and responder acknowledgements will appear here.</span>
          </div>
          <div id="detailContent" class="hidden">
            <div class="detail-heading">
              <div>
                <p class="eyebrow">INCIDENT DETAIL</p>
                <h2 id="detailTitle">Incident</h2>
              </div>
              <span id="detailStatus" class="status-pill">Pending</span>
            </div>

            <dl id="detailFacts" class="facts"></dl>

            <div id="locationCard" class="location-card hidden">
              <div>
                <strong>Best available location</strong>
                <span id="locationText"></span>
                <span id="locationMeta" class="muted"></span>
              </div>
              <a id="mapLink" target="_blank" rel="noopener noreferrer">Open map</a>
            </div>

            <section class="history-section" aria-labelledby="revisionHistoryTitle">
              <h3 id="revisionHistoryTitle">Report revision history</h3>
              <div id="revisionHistory" class="history"></div>
            </section>

            <section class="history-section" aria-labelledby="historyTitle">
              <h3 id="historyTitle">Responder history</h3>
              <div id="ackHistory" class="history"></div>
            </section>

            <form id="ackForm" class="ack-form">
              <h3>Update response status</h3>
              <label for="ackStatus">Status</label>
              <select id="ackStatus" required>
                <option value="ACKNOWLEDGED">Acknowledged</option>
                <option value="EN_ROUTE">En route</option>
                <option value="ON_SCENE">On scene</option>
                <option value="RESOLVED">Resolved</option>
              </select>
              <label for="ackNote">Operational note <span class="muted">(optional)</span></label>
              <textarea id="ackNote" maxlength="1000" rows="3" placeholder="Example: Boat team dispatched; ETA 8 minutes"></textarea>
              <button id="ackButton" type="submit">Save responder update</button>
              <p id="ackResult" class="form-result" role="status" aria-live="polite"></p>
            </form>
          </div>
        </section>
      </div>
    </section>
  </main>

  <script src="/responder/app.js" defer></script>
</body>
</html>`;

const DASHBOARD_CSS = `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f3f6f8;
  color: #14212b;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #f3f6f8; }
button, input, select, textarea { font: inherit; }
button, select, input, textarea { min-height: 48px; }
button { cursor: pointer; border: 0; border-radius: 12px; padding: 0 16px; font-weight: 800; background: #0f4c81; color: #fff; }
button:hover { filter: brightness(.96); }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline: 3px solid #f2a900; outline-offset: 2px; }
button.secondary { background: #173d5c; }
button.ghost { color: #173d5c; background: #fff; border: 1px solid #aebbc5; }
.topbar { min-height: 72px; padding: 10px clamp(16px, 3vw, 36px); display: flex; align-items: center; justify-content: space-between; gap: 20px; background: #0f2740; color: #fff; box-shadow: 0 2px 10px rgba(15,39,64,.18); }
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark { width: 48px; height: 48px; flex: 0 0 auto; }
.brand strong { display: block; font-size: 1.2rem; letter-spacing: .12em; }
.brand span { display: block; margin-top: 2px; color: #dce8f2; font-size: .88rem; }
.connection { display: flex; align-items: center; gap: 8px; color: #dce8f2; font-weight: 700; font-size: .88rem; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #96a7b5; }
.dot.online { background: #55c889; }
main { width: min(1500px, 100%); margin: 0 auto; padding: clamp(18px, 3vw, 36px); }
.auth-card { width: min(560px, 100%); margin: 7vh auto 0; padding: clamp(24px, 4vw, 40px); background: #fff; border-radius: 24px; box-shadow: 0 18px 55px rgba(35,55,70,.12); }
.eyebrow { margin: 0 0 6px; color: #a52b28; font-size: .76rem; font-weight: 900; letter-spacing: .12em; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 8px; font-size: clamp(1.7rem, 4vw, 2.5rem); line-height: 1.08; }
h2 { margin-bottom: 8px; }
.muted { color: #5b6973; }
.auth-card form, .ack-form { display: grid; gap: 9px; margin-top: 24px; }
label { font-weight: 800; font-size: .9rem; }
input, select, textarea { width: 100%; border: 1px solid #aebbc5; border-radius: 10px; background: #fff; color: #14212b; padding: 10px 12px; }
textarea { min-height: 90px; resize: vertical; }
.error, .banner-error { color: #8f1e1a; font-weight: 800; }
.banner-error { margin-bottom: 16px; padding: 12px 14px; background: #fff0ef; border: 1px solid #e4aaa7; border-radius: 10px; }
.hidden { display: none !important; }
.toolbar { display: flex; justify-content: space-between; align-items: end; gap: 24px; margin-bottom: 18px; }
.toolbar h1 { margin-bottom: 4px; }
.toolbar-actions { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; }
.filter-label { align-self: center; }
.workspace { display: grid; grid-template-columns: minmax(320px, .95fr) minmax(420px, 1.4fr); gap: 18px; align-items: start; }
.incident-column, .detail-panel { min-height: 480px; background: #fff; border-radius: 18px; border: 1px solid #dde5ea; overflow: hidden; }
.incident-list { display: grid; }
.incident-card { width: 100%; min-height: 112px; padding: 16px 18px; text-align: left; color: #14212b; background: #fff; border-radius: 0; border-bottom: 1px solid #e2e9ed; display: grid; gap: 8px; }
.incident-card:hover, .incident-card.selected { background: #eef5fa; filter: none; }
.incident-top, .incident-meta, .detail-heading { display: flex; justify-content: space-between; gap: 14px; align-items: center; }
.incident-type { font-size: 1.02rem; font-weight: 900; }
.urgent { color: #a5221d; }
.incident-meta { color: #5b6973; font-size: .84rem; align-items: flex-start; }
.status-pill { display: inline-flex; min-height: 28px; align-items: center; padding: 4px 9px; border-radius: 999px; background: #e8eef3; color: #344d61; font-size: .75rem; font-weight: 900; white-space: nowrap; }
.status-pill.pending { background: #fff3d5; color: #7a4d00; }
.status-pill.active { background: #e3f3eb; color: #16623a; }
.status-pill.resolved { background: #e7eef4; color: #334b5e; }
.empty { padding: 38px 22px; text-align: center; color: #5b6973; }
.empty strong, .empty span { display: block; }
.detail-panel { padding: clamp(20px, 3vw, 28px); }
.detail-placeholder { min-height: 420px; display: grid; place-content: center; text-align: center; gap: 8px; color: #65737d; }
.detail-placeholder strong { font-size: 1.2rem; color: #2a3a46; }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
.fact { padding: 13px; border-radius: 12px; background: #f5f8fa; }
.fact dt { color: #62717c; font-size: .75rem; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
.fact dd { margin: 5px 0 0; font-weight: 850; }
.location-card { display: flex; justify-content: space-between; gap: 14px; align-items: center; padding: 15px; border: 1px solid #cbd9e3; border-radius: 13px; background: #f2f8fc; }
.location-card strong, .location-card span { display: block; }
.location-card a { color: #0f4c81; font-weight: 900; }
.history-section { margin-top: 24px; }
.history { display: grid; gap: 10px; }
.history-item { padding: 12px 14px; border-left: 4px solid #0f4c81; background: #f6f8fa; border-radius: 6px 10px 10px 6px; }
.history-item strong, .history-item span { display: block; }
.history-item span { margin-top: 3px; color: #5b6973; font-size: .87rem; }
.ack-form { margin-top: 26px; padding-top: 22px; border-top: 1px solid #dce4e9; }
.form-result { min-height: 22px; margin: 0; font-weight: 800; color: #16623a; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 900px) {
  .workspace { grid-template-columns: 1fr; }
  .detail-panel { min-height: 320px; }
  .detail-placeholder { min-height: 260px; }
}
@media (max-width: 640px) {
  main { padding: 14px; }
  .topbar { align-items: flex-start; }
  .connection { margin-top: 10px; }
  .toolbar { align-items: stretch; flex-direction: column; }
  .toolbar-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .filter-label { grid-column: 1 / -1; }
  .toolbar-actions select { grid-column: 1 / -1; }
  .facts { grid-template-columns: 1fr; }
  .location-card { align-items: flex-start; flex-direction: column; }
}`;

const DASHBOARD_JS = `(() => {
  'use strict';

  const TOKEN_KEY = 'sagipResponderToken';
  const REFRESH_MS = 10000;
  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  let selectedReportId = null;
  let refreshTimer = null;

  const authPanel = document.getElementById('authPanel');
  const consolePanel = document.getElementById('consolePanel');
  const authForm = document.getElementById('authForm');
  const tokenInput = document.getElementById('tokenInput');
  const authError = document.getElementById('authError');
  const incidentList = document.getElementById('incidentList');
  const emptyState = document.getElementById('emptyState');
  const detailPlaceholder = document.getElementById('detailPlaceholder');
  const detailContent = document.getElementById('detailContent');
  const detailTitle = document.getElementById('detailTitle');
  const detailStatus = document.getElementById('detailStatus');
  const detailFacts = document.getElementById('detailFacts');
  const locationCard = document.getElementById('locationCard');
  const locationText = document.getElementById('locationText');
  const locationMeta = document.getElementById('locationMeta');
  const mapLink = document.getElementById('mapLink');
  const revisionHistory = document.getElementById('revisionHistory');
  const ackHistory = document.getElementById('ackHistory');
  const ackForm = document.getElementById('ackForm');
  const ackStatus = document.getElementById('ackStatus');
  const ackNote = document.getElementById('ackNote');
  const ackButton = document.getElementById('ackButton');
  const ackResult = document.getElementById('ackResult');
  const statusFilter = document.getElementById('statusFilter');
  const lastUpdated = document.getElementById('lastUpdated');
  const serverError = document.getElementById('serverError');
  const connectionDot = document.getElementById('connectionDot');
  const connectionText = document.getElementById('connectionText');

  function setConnected(connected) {
    connectionDot.classList.toggle('online', connected);
    connectionText.textContent = connected ? 'Server connected' : 'Not connected';
  }

  function showError(message) {
    serverError.textContent = message || '';
    serverError.classList.toggle('hidden', !message);
  }

  function statusLabel(incident) {
    return incident.latestAck ? incident.latestAck.status.replaceAll('_', ' ') : 'PENDING';
  }

  function statusClass(status) {
    if (status === 'PENDING') return 'pending';
    if (status === 'RESOLVED') return 'resolved';
    return 'active';
  }

  function formatDate(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  }

  function formatEmergencyType(value) {
    return String(value || 'OTHER').replaceAll('_', ' ');
  }

  function createText(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  async function api(path, options) {
    const headers = new Headers((options && options.headers) || {});
    headers.set('authorization', 'Bearer ' + token);
    const response = await fetch(path, Object.assign({}, options || {}, {headers}));
    if (response.status === 401) {
      disconnect('Responder token was rejected. Request a valid token from the SAGIP backend administrator.');
      throw new Error('UNAUTHORIZED');
    }
    if (!response.ok) {
      let errorName = 'SERVER_ERROR';
      try {
        const body = await response.json();
        if (body && body.error) errorName = body.error;
      } catch (_) {}
      throw new Error(errorName);
    }
    return response.json();
  }

  function connectView() {
    authPanel.classList.add('hidden');
    consolePanel.classList.remove('hidden');
    setConnected(true);
    startRefreshTimer();
  }

  function disconnect(message) {
    token = '';
    selectedReportId = null;
    sessionStorage.removeItem(TOKEN_KEY);
    stopRefreshTimer();
    consolePanel.classList.add('hidden');
    authPanel.classList.remove('hidden');
    tokenInput.value = '';
    authError.textContent = message || '';
    setConnected(false);
  }

  function startRefreshTimer() {
    stopRefreshTimer();
    refreshTimer = window.setInterval(() => {
      void refreshIncidents(false);
    }, REFRESH_MS);
  }

  function stopRefreshTimer() {
    if (refreshTimer !== null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function makeIncidentCard(incident) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'incident-card';
    if (incident.reportId === selectedReportId) card.classList.add('selected');
    card.setAttribute('aria-label', formatEmergencyType(incident.emergencyType) + ' incident, ' + statusLabel(incident));

    const top = document.createElement('div');
    top.className = 'incident-top';
    const type = createText('span', 'incident-type' + (incident.urgency === 'IMMEDIATE_DANGER' ? ' urgent' : ''), formatEmergencyType(incident.emergencyType));
    const pill = createText('span', 'status-pill ' + statusClass(statusLabel(incident)), statusLabel(incident));
    top.append(type, pill);

    const meta = document.createElement('div');
    meta.className = 'incident-meta';
    meta.append(
      createText('span', '', incident.urgency === 'IMMEDIATE_DANGER' ? 'Immediate danger' : 'Needs assistance'),
      createText('span', '', formatDate(incident.firstReceivedAt))
    );

    const location = incident.location && incident.location.latitude !== null && incident.location.longitude !== null
      ? Number(incident.location.latitude).toFixed(5) + ', ' + Number(incident.location.longitude).toFixed(5)
      : 'Location unavailable';

    card.append(top, meta, createText('span', 'muted', location));
    card.addEventListener('click', () => {
      selectedReportId = incident.reportId;
      void loadDetail(incident.reportId);
      Array.from(incidentList.children).forEach((item) => item.classList.remove('selected'));
      card.classList.add('selected');
    });
    return card;
  }

  function renderIncidents(incidents) {
    incidentList.replaceChildren();
    emptyState.classList.toggle('hidden', incidents.length !== 0);
    incidents.forEach((incident) => incidentList.appendChild(makeIncidentCard(incident)));
  }

  function addFact(label, value) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fact';
    const term = createText('dt', '', label);
    const description = createText('dd', '', value);
    wrapper.append(term, description);
    detailFacts.appendChild(wrapper);
  }

  function renderLocation(location) {
    const available = location && location.latitude !== null && location.longitude !== null;
    locationCard.classList.toggle('hidden', !available);
    if (!available) return;

    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    locationText.textContent = latitude.toFixed(6) + ', ' + longitude.toFixed(6);
    const pieces = [];
    if (location.accuracyMeters !== null) pieces.push('±' + Math.round(Number(location.accuracyMeters)) + ' m');
    if (location.freshness) pieces.push(String(location.freshness).toLowerCase());
    if (location.source) pieces.push(String(location.source));
    locationMeta.textContent = pieces.join(' · ');
    mapLink.href = 'https://www.openstreetmap.org/?mlat=' + encodeURIComponent(latitude) + '&mlon=' + encodeURIComponent(longitude) + '#map=17/' + encodeURIComponent(latitude) + '/' + encodeURIComponent(longitude);
  }

  function renderAckHistory(acks) {
    ackHistory.replaceChildren();
    if (!acks.length) {
      ackHistory.appendChild(createText('p', 'muted', 'No responder acknowledgement yet.'));
      return;
    }
    acks.forEach((ack) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.append(
        createText('strong', '', ack.status.replaceAll('_', ' ') + ' · ' + (ack.callsign || 'Responder')),
        createText('span', '', formatDate(ack.acknowledgedAt)),
        createText('span', '', ack.note || 'No operational note')
      );
      ackHistory.appendChild(item);
    });
  }

  function renderRevisionHistory(revisions) {
    revisionHistory.replaceChildren();
    if (!revisions.length) {
      revisionHistory.appendChild(createText('p', 'muted', 'No report revisions are available.'));
      return;
    }
    revisions.forEach((revision) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const urgency = revision.urgency === 'IMMEDIATE_DANGER' ? 'Immediate danger' : 'Needs assistance';
      item.append(
        createText('strong', '', 'Revision ' + revision.revision + ' · ' + formatEmergencyType(revision.emergencyType)),
        createText('span', '', urgency)
      );
      if (revision.location && revision.location.latitude !== null && revision.location.longitude !== null) {
        const locationParts = [
          Number(revision.location.latitude).toFixed(6) + ', ' + Number(revision.location.longitude).toFixed(6)
        ];
        if (revision.location.accuracyMeters !== null) {
          locationParts.push('±' + Math.round(Number(revision.location.accuracyMeters)) + ' m');
        }
        if (revision.location.freshness) locationParts.push(String(revision.location.freshness).toLowerCase());
        if (revision.location.source) locationParts.push(String(revision.location.source));
        item.append(createText('span', '', locationParts.join(' · ')));
        if (revision.location.capturedAtMs !== null) {
          item.append(createText('span', '', 'Location captured ' + formatDate(revision.location.capturedAtMs)));
        }
      } else {
        item.append(createText('span', '', 'No location in this revision'));
      }
      revisionHistory.appendChild(item);
    });
  }

  function renderDetail(detail) {
    detailPlaceholder.classList.add('hidden');
    detailContent.classList.remove('hidden');
    detailTitle.textContent = formatEmergencyType(detail.emergencyType) + ' emergency';
    const status = statusLabel(detail);
    detailStatus.textContent = status;
    detailStatus.className = 'status-pill ' + statusClass(status);

    detailFacts.replaceChildren();
    addFact('Urgency', detail.urgency === 'IMMEDIATE_DANGER' ? 'Immediate danger' : 'Needs assistance');
    addFact('Server received', formatDate(detail.firstReceivedAt));
    addFact('Report created', formatDate(detail.createdAtMs));
    addFact('Report ID', detail.reportId);
    addFact('Latest revision', String(detail.latestRevision));

    renderLocation(detail.location);
    renderRevisionHistory(detail.revisions || []);
    renderAckHistory(detail.acknowledgements || []);
  }

  async function loadDetail(reportId) {
    try {
      showError('');
      const detail = await api('/v1/incidents/' + encodeURIComponent(reportId));
      renderDetail(detail);
    } catch (error) {
      if (String(error && error.message) !== 'UNAUTHORIZED') {
        showError('Could not load incident detail. The server will keep the incident; retry when connectivity returns.');
      }
    }
  }

  async function refreshIncidents(showLoading) {
    if (!token) return;
    try {
      if (showLoading) lastUpdated.textContent = 'Refreshing…';
      showError('');
      const query = statusFilter.value ? '?limit=100&status=' + encodeURIComponent(statusFilter.value) : '?limit=100';
      const incidents = await api('/v1/incidents' + query);
      connectView();
      renderIncidents(incidents);
      lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
      if (selectedReportId && incidents.some((incident) => incident.reportId === selectedReportId)) {
        await loadDetail(selectedReportId);
      }
    } catch (error) {
      if (String(error && error.message) !== 'UNAUTHORIZED') {
        setConnected(false);
        lastUpdated.textContent = 'Last refresh failed';
        showError('The responder console could not refresh. Existing incidents remain on the server; retry shortly.');
      }
    }
  }

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    authError.textContent = '';
    const candidate = tokenInput.value.trim();
    if (!candidate) {
      authError.textContent = 'Enter a responder token.';
      return;
    }
    token = candidate;
    sessionStorage.setItem(TOKEN_KEY, token);
    await refreshIncidents(true);
  });

  document.getElementById('refreshButton').addEventListener('click', () => {
    void refreshIncidents(true);
  });

  document.getElementById('logoutButton').addEventListener('click', () => {
    disconnect('');
  });

  statusFilter.addEventListener('change', () => {
    selectedReportId = null;
    detailContent.classList.add('hidden');
    detailPlaceholder.classList.remove('hidden');
    void refreshIncidents(true);
  });

  ackForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedReportId) return;
    ackButton.disabled = true;
    ackResult.textContent = 'Saving…';
    try {
      const ack = await api('/v1/incidents/' + encodeURIComponent(selectedReportId) + '/ack', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          status: ackStatus.value,
          note: ackNote.value.trim() || null
        })
      });
      ackResult.textContent = 'Saved: ' + ack.status.replaceAll('_', ' ');
      ackNote.value = '';
      await refreshIncidents(false);
      await loadDetail(selectedReportId);
    } catch (error) {
      if (String(error && error.message) !== 'UNAUTHORIZED') {
        ackResult.textContent = 'Could not confirm the update. It may have been saved; refresh or retry when connectivity returns.';
      }
    } finally {
      ackButton.disabled = false;
    }
  });

  if (token) {
    void refreshIncidents(true);
  } else {
    disconnect('');
  }
})();`;

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export function responderDashboardResponse(pathname: string, method: string): Response | null {
  const isDashboardPath =
    pathname === '/responder' ||
    pathname === '/responder/' ||
    pathname === '/responder/styles.css' ||
    pathname === '/responder/app.js';

  if (!isDashboardPath) return null;
  if (method !== 'GET') {
    return new Response(JSON.stringify({error: 'METHOD_NOT_ALLOWED'}), {
      status: 405,
      headers: {
        ...SECURITY_HEADERS,
        allow: 'GET',
        'content-type': 'application/json; charset=utf-8',
      },
    });
  }

  if (pathname === '/responder/styles.css') {
    return new Response(DASHBOARD_CSS, {
      status: 200,
      headers: {...SECURITY_HEADERS, 'content-type': 'text/css; charset=utf-8'},
    });
  }
  if (pathname === '/responder/app.js') {
    return new Response(DASHBOARD_JS, {
      status: 200,
      headers: {...SECURITY_HEADERS, 'content-type': 'text/javascript; charset=utf-8'},
    });
  }

  return new Response(DASHBOARD_HTML, {
    status: 200,
    headers: {...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8'},
  });
}
