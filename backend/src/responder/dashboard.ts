import {consoleAssetResponse} from './consoleAssets.js';

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0c2942">
  <title>SAGIP Responder Console</title>
  <link rel="stylesheet" href="/responder/styles.css">
  <link rel="stylesheet" href="/responder/assets/maplibre-gl-6.11.2/maplibre-gl.css">
</head>
<body>
  <a class="skip-link" href="#mainContent">Skip to emergency operations</a>

  <header class="topbar">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 108 108" role="img" aria-label="SAGIP locator pin with medical plus logo">
        <circle cx="54" cy="54" r="50" fill="#fff" stroke="#0f4c81" stroke-width="4"></circle>
        <path d="M54 19C38.5 19 27 30.7 27 45.8C27 64.4 54 90 54 90S81 64.4 81 45.8C81 30.7 69.5 19 54 19Z" fill="#c9302c"></path>
        <path d="M49 31H59V41H69V51H59V61H49V51H39V41H49Z" fill="#fff"></path>
      </svg>
      <div class="brand-copy">
        <strong>SAGIP</strong>
        <span>Responder Console</span>
      </div>
    </div>

    <div class="topbar-status">
      <div id="responderIdentity" class="responder-identity hidden">
        <span id="responderCallsign">Responder</span>
        <span id="responderRole">Authorized session</span>
      </div>
      <div class="connection" aria-live="polite">
        <span id="connectionDot" class="dot" aria-hidden="true"></span>
        <span id="connectionText">Not connected</span>
      </div>
    </div>
  </header>

  <main id="mainContent" tabindex="-1">
    <h1 class="sr-only">SAGIP Responder Console</h1>

    <section id="authPanel" class="auth-shell" aria-labelledby="authTitle">
      <div class="auth-context">
        <p class="eyebrow eyebrow-on-dark">AUTHORIZED RESPONSE ACCESS</p>
        <h2 id="authTitle">Start a responder shift</h2>
        <p class="auth-lede">Paste your provisioned responder token once. SAGIP exchanges it for a secure 12-hour browser session, so you do not need to remember or repeatedly enter the token during the shift.</p>

        <div class="auth-notes" role="list" aria-label="Console safeguards">
          <div class="auth-note" role="listitem">
            <span class="auth-note-mark" aria-hidden="true">01</span>
            <div>
              <strong>Token is not kept in browser storage</strong>
              <span>The raw token is used only to start the session. Authentication then uses an HttpOnly, Secure, same-site cookie.</span>
            </div>
          </div>
          <div class="auth-note" role="listitem">
            <span class="auth-note-mark" aria-hidden="true">02</span>
            <div>
              <strong>Server-accepted incidents only</strong>
              <span>Local saves and peer relays do not appear here until the backend has accepted the SOS.</span>
            </div>
          </div>
        </div>
      </div>

      <div class="auth-card">
        <p class="section-label">Responder authentication</p>
        <h3>Connect this browser</h3>
        <p class="muted">Copy the token from the approved team secret store. You will only need it again after the session expires, is revoked, or you disconnect.</p>
        <form id="authForm" method="post" novalidate>
          <div class="form-field">
            <label for="tokenInput">Provisioned responder token</label>
            <p id="tokenHelp" class="field-help">SAGIP never embeds a token in the console and does not save this value in localStorage or sessionStorage.</p>
            <input id="tokenInput" name="responder-token" type="password" autocomplete="off" spellcheck="false" inputmode="text" aria-describedby="tokenHelp authError" required>
          </div>
          <button id="connectButton" type="submit">Start responder session</button>
        </form>
        <p id="authError" class="error" role="alert"></p>
      </div>
    </section>

    <section id="consolePanel" class="console hidden" aria-label="Responder operations">
      <div class="toolbar">
        <div class="toolbar-copy">
          <p class="eyebrow">RESPONDER OPERATIONS</p>
          <h2>Emergency queue</h2>
          <div class="queue-meta">
            <span id="incidentCount" aria-live="polite">0 incidents loaded</span>
            <span aria-hidden="true">•</span>
            <span id="lastUpdated" aria-live="polite">Waiting for server data…</span>
            <span aria-hidden="true">•</span>
            <span id="sessionExpiry">Session active</span>
          </div>
        </div>

        <div class="toolbar-actions" aria-label="Queue controls">
          <div class="control-field">
            <label for="statusFilter">Incident status</label>
            <select id="statusFilter">
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="ACKNOWLEDGED">Acknowledged</option>
              <option value="EN_ROUTE">En route</option>
              <option value="ON_SCENE">On scene</option>
              <option value="RESOLVED">Resolved</option>
            </select>
          </div>
          <button id="refreshButton" type="button" class="secondary">Refresh</button>
          <button id="logoutButton" type="button" class="ghost">Disconnect</button>
        </div>
      </div>

      <div id="serverError" class="banner-error hidden" role="alert"></div>

      <section class="stats-grid" aria-label="Incident queue summary">
        <div class="stat-card">
          <span class="stat-label">Open incidents</span>
          <strong id="openCount">0</strong>
          <span>Not resolved</span>
        </div>
        <div class="stat-card stat-critical">
          <span class="stat-label">Immediate danger</span>
          <strong id="immediateCount">0</strong>
          <span>Latest accepted revision</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Pending response</span>
          <strong id="pendingCount">0</strong>
          <span>No responder acknowledgement</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Active response</span>
          <strong id="activeCount">0</strong>
          <span>Acknowledged, en route, or on scene</span>
        </div>
      </section>

      <section id="offlineOperations" class="offline-operations" aria-labelledby="offlineOperationsTitle">
        <div class="offline-heading">
          <div>
            <p class="section-label">OUTAGE READINESS</p>
            <h3 id="offlineOperationsTitle">Offline response workspace</h3>
            <p class="muted">Readiness is based on prepared map data, protected incident access, a complete snapshot, and pending responder updates.</p>
          </div>
          <button id="offlineDiscardButton" type="button" class="danger-outline" hidden>Discard pending offline updates</button>
        </div>
        <div class="readiness-grid" aria-live="polite">
          <div class="readiness-item"><span>Local map package</span><strong id="mapReadinessStatus">Checking…</strong></div>
          <div class="readiness-item"><span>Protected incident access</span><strong id="accessReadinessStatus">Checking…</strong></div>
          <div class="readiness-item"><span>Incident snapshot</span><strong id="snapshotReadinessStatus">Checking…</strong></div>
          <div class="readiness-item"><span>Offline responder updates</span><strong id="outboxReadinessStatus">Checking…</strong></div>
        </div>
        <section id="incidentMapPanel" class="incident-map-panel" aria-labelledby="incidentMapTitle">
          <div class="map-heading">
            <div>
              <p class="section-label">INCIDENT MAP</p>
              <h4 id="incidentMapTitle">Prepared local coverage</h4>
            </div>
            <span id="mapCoverage" class="muted">Checking local map package…</span>
          </div>
          <div class="map-stage">
            <div id="incidentMapCanvas" class="incident-map-canvas" aria-hidden="true"></div>
            <div id="incidentMapPlaceholder" class="map-placeholder">Checking local map package…</div>
          </div>
          <p id="mapAnnouncement" class="sr-only" aria-live="polite"></p>
          <p class="map-accessibility-note">The incident queue remains the primary keyboard and screen-reader workspace. The map is a supplemental spatial view.</p>
        </section>
      </section>

      <div class="workspace">
        <section class="incident-column" aria-labelledby="incidentListTitle">
          <div class="panel-header">
            <div>
              <p class="section-label">Server-accepted reports</p>
              <h3 id="incidentListTitle">Incident queue</h3>
            </div>
            <span id="queueScope">Newest 100 maximum</span>
          </div>
          <div id="incidentList" class="incident-list"></div>
          <div id="emptyState" class="empty hidden">
            <strong>No incidents in this view</strong>
            <span>New server-accepted SOS reports matching this filter will appear here.</span>
          </div>
        </section>

        <section id="detailPanel" class="detail-panel" aria-labelledby="detailTitle">
          <div id="detailPlaceholder" class="detail-placeholder">
            <span class="placeholder-mark" aria-hidden="true">+</span>
            <strong>Select an incident</strong>
            <span>Location evidence, accepted revisions, and persisted responder actions will appear here.</span>
          </div>

          <div id="detailContent" class="hidden">
            <div class="detail-heading">
              <div>
                <p class="eyebrow">INCIDENT DETAIL</p>
                <h3 id="detailTitle">Incident</h3>
                <p id="detailSubtitle" class="detail-subtitle"></p>
              </div>
              <span id="detailStatus" class="status-pill">Pending</span>
            </div>

            <div id="urgencyBanner" class="urgency-banner hidden" role="status">
              <strong>Immediate danger</strong>
              <span>This classification comes from the latest server-accepted SOS revision.</span>
            </div>

            <dl id="detailFacts" class="facts"></dl>

            <div id="locationCard" class="location-card hidden">
              <div class="location-copy">
                <span class="section-label">LOCATION EVIDENCE</span>
                <strong>Best available location</strong>
                <span id="locationText" class="location-coordinates"></span>
                <span id="locationMeta" class="muted"></span>
                <span id="locationCaptured" class="muted"></span>
              </div>
              <a id="mapLink" class="map-link" href="#incidentMapPanel">Show on offline map</a>
            </div>

            <form id="ackForm" class="ack-form" method="post" novalidate>
              <div class="form-heading">
                <p class="section-label">RESPONSE UPDATE</p>
                <h4>Record responder status</h4>
                <p class="muted">SAGIP persists the update before reporting success. If the response is lost, refresh before assuming it failed.</p>
              </div>

              <div class="ack-fields">
                <div class="form-field">
                  <label for="ackStatus">Status</label>
                  <select id="ackStatus" required>
                    <option value="ACKNOWLEDGED">Acknowledged</option>
                    <option value="EN_ROUTE">En route</option>
                    <option value="ON_SCENE">On scene</option>
                    <option value="RESOLVED">Resolved</option>
                  </select>
                </div>

                <div class="form-field ack-note-field">
                  <label for="ackNote">Operational note <span class="muted">(optional)</span></label>
                  <textarea id="ackNote" maxlength="1000" rows="3" placeholder="Example: Boat team dispatched; ETA 8 minutes"></textarea>
                </div>
              </div>

              <div class="ack-actions">
                <button id="ackButton" type="submit">Save responder update</button>
                <p id="ackResult" class="form-result" role="status" aria-live="polite"></p>
              </div>
            </form>

            <section class="history-section" aria-labelledby="historyTitle">
              <div class="section-heading">
                <h4 id="historyTitle">Responder history</h4>
                <span>Persisted acknowledgement trail</span>
              </div>
              <div id="ackHistory" class="history"></div>
            </section>

            <section class="history-section" aria-labelledby="revisionHistoryTitle">
              <div class="section-heading">
                <h4 id="revisionHistoryTitle">Report revision history</h4>
                <span>Accepted SOS revisions</span>
              </div>
              <div id="revisionHistory" class="history"></div>
            </section>
          </div>
        </section>
      </div>
    </section>
  </main>

  <script src="/responder/app.js" defer></script>
  <script type="module" src="/responder/assets/browser/consoleController.js"></script>
  <noscript><p class="noscript-warning">JavaScript is required for responder operations. Do not rely on this browser for offline incident handling until scripting is enabled.</p></noscript>
</body>
</html>`;

const DASHBOARD_CSS = `:root {
  color-scheme: light;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --navy-950: #071b2b;
  --navy-900: #0c2942;
  --navy-800: #123b5d;
  --navy-700: #0f4c81;
  --navy-100: #e9f1f7;
  --ink: #14212b;
  --ink-soft: #50606c;
  --ink-faint: #687783;
  --canvas: #eef2f5;
  --surface: #ffffff;
  --surface-soft: #f6f8fa;
  --line: #d5dfe6;
  --line-strong: #adbdc8;
  --red-800: #84211e;
  --red-700: #9d2521;
  --red-100: #fff0ef;
  --amber-800: #654000;
  --amber-100: #fff3d5;
  --green-800: #104c2e;
  --green-100: #e3f3eb;
  --focus: #f2a900;
  --shadow-sm: 0 8px 24px rgba(7, 27, 43, 0.08);
  --shadow-lg: 0 24px 70px rgba(7, 27, 43, 0.14);
  background: var(--canvas);
  color: var(--ink);
}

* { box-sizing: border-box; }

html { background: var(--canvas); }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--canvas);
  color: var(--ink);
  line-height: 1.5;
}

button,
input,
select,
textarea { font: inherit; }

button,
select,
input,
textarea,
.map-link { min-block-size: 3rem; }

button {
  cursor: pointer;
  border: 0;
  border-radius: 0.7rem;
  padding-inline: 1rem;
  font-weight: 800;
  background: var(--navy-700);
  color: var(--surface);
  transition: background-color 120ms ease, transform 120ms ease;
}

button:hover { background: var(--navy-800); }
button:active { transform: translateY(1px); }
button:disabled { cursor: wait; opacity: 0.62; transform: none; }

button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
a:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 3px;
}

button.secondary { background: var(--navy-800); }
button.secondary:hover { background: var(--navy-950); }

button.ghost {
  color: var(--navy-900);
  background: transparent;
  border: 1px solid var(--line-strong);
}
button.ghost:hover { background: var(--navy-100); }

input,
select,
textarea {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 0.65rem;
  background: var(--surface);
  color: var(--ink);
  padding: 0.7rem 0.78rem;
}

textarea { resize: vertical; min-block-size: 6.5rem; }
input[aria-invalid="true"] { border-color: var(--red-700); box-shadow: 0 0 0 1px var(--red-700); }

a { color: var(--navy-700); }

.hidden { display: none !important; }

.skip-link {
  position: fixed;
  display: inline-flex;
  align-items: center;
  min-block-size: 3rem;
  z-index: 100;
  inset-block-start: 0.5rem;
  inset-inline-start: 0.5rem;
  transform: translateY(-160%);
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--navy-950);
  font-weight: 800;
  box-shadow: var(--shadow-sm);
}
.skip-link:focus { transform: translateY(0); }

.topbar {
  position: sticky;
  z-index: 20;
  inset-block-start: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-block-size: 4.5rem;
  gap: 1.25rem;
  padding: 0.7rem clamp(1rem, 3vw, 2rem);
  color: var(--surface);
  background: var(--navy-950);
  border-block-end: 3px solid var(--red-700);
}

.brand,
.topbar-status,
.connection,
.responder-identity,
.queue-meta,
.toolbar-actions,
.incident-top,
.incident-meta,
.detail-heading,
.location-card,
.ack-actions {
  display: flex;
  align-items: center;
}

.brand { gap: 0.75rem; }
.brand-mark { inline-size: 3.1rem; block-size: 3.1rem; flex: 0 0 auto; }
.brand-copy strong,
.brand-copy span { display: block; }
.brand-copy strong { letter-spacing: 0.08em; font-size: 1rem; }
.brand-copy span { color: #dce9f3; font-size: 0.78rem; }

.topbar-status { gap: 1rem; }
.responder-identity {
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.25;
}
.responder-identity span:first-child { font-weight: 850; }
.responder-identity span:last-child { color: #c8dae8; font-size: 0.76rem; }

.connection {
  gap: 0.5rem;
  white-space: nowrap;
  font-size: 0.82rem;
  font-weight: 750;
}

.dot {
  inline-size: 0.62rem;
  block-size: 0.62rem;
  border: 2px solid #dce9f3;
  border-radius: 50%;
  background: transparent;
}
.dot.online { border-color: #9ce2bd; background: #9ce2bd; }

main {
  width: min(100%, 100rem);
  margin-inline: auto;
  padding: clamp(1rem, 2.2vw, 2rem);
}

.eyebrow,
.section-label {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.35;
  font-weight: 900;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--navy-700);
}

.eyebrow-on-dark { color: #bcd4e5; }
.muted { color: var(--ink-soft); }
.error { min-block-size: 1.4rem; margin-block-end: 0; color: var(--red-800); font-weight: 800; }

.auth-shell {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(20rem, 0.75fr);
  max-width: 74rem;
  margin: clamp(1rem, 6vh, 4rem) auto;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 1rem;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}

.auth-context {
  padding: clamp(2rem, 5vw, 4.25rem);
  color: var(--surface);
  background: var(--navy-900);
}
.auth-context h2 {
  max-width: 13ch;
  margin: 0.6rem 0 0.8rem;
  font-size: clamp(2rem, 4vw, 3.35rem);
  line-height: 1.02;
  letter-spacing: -0.035em;
}
.auth-lede {
  max-width: 52rem;
  margin: 0 0 2.25rem;
  color: #d5e3ee;
  font-size: 1.02rem;
}

.auth-notes {
  display: grid;
  gap: 0.8rem;
}
.auth-note {
  display: grid;
  grid-template-columns: 2.25rem 1fr;
  gap: 0.8rem;
  padding-block: 0.85rem;
  border-block-start: 1px solid rgba(255, 255, 255, 0.15);
}
.auth-note-mark { color: #9fc2dc; font-size: 0.75rem; font-weight: 900; }
.auth-note strong,
.auth-note span { display: block; }
.auth-note span { margin-block-start: 0.18rem; color: #cfdeea; font-size: 0.86rem; }

.auth-card {
  align-self: center;
  padding: clamp(1.6rem, 4vw, 3rem);
}
.auth-card h3 { margin: 0.35rem 0 0.35rem; font-size: 1.55rem; }
.auth-card > .muted { margin-block-start: 0; }

.form-field { margin-block: 1rem; }
.form-field label {
  display: block;
  margin-block-end: 0.35rem;
  font-size: 0.86rem;
  font-weight: 850;
}
.field-help {
  margin: -0.1rem 0 0.55rem;
  color: var(--ink-soft);
  font-size: 0.8rem;
}

.console { display: grid; gap: 1rem; }

.toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.15rem;
  border: 1px solid var(--line);
  border-radius: 0.9rem;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.toolbar-copy h2 { margin: 0.15rem 0 0.1rem; font-size: clamp(1.55rem, 3vw, 2.2rem); }
.queue-meta { flex-wrap: wrap; gap: 0.45rem; color: var(--ink-soft); font-size: 0.8rem; }
.toolbar-actions { align-items: flex-end; gap: 0.65rem; }
.control-field { min-inline-size: 11.5rem; }
.control-field label {
  display: block;
  margin-block-end: 0.25rem;
  color: var(--ink-soft);
  font-size: 0.72rem;
  font-weight: 800;
}

.banner-error {
  padding: 0.85rem 1rem;
  border: 1px solid #e0aaa7;
  border-inline-start: 5px solid var(--red-700);
  border-radius: 0.65rem;
  background: var(--red-100);
  color: var(--red-800);
  font-weight: 750;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
}

.stat-card {
  contain: layout style paint;
  display: grid;
  min-block-size: 7.2rem;
  align-content: center;
  padding: 0.85rem 1rem;
  border: 1px solid var(--line);
  border-radius: 0.85rem;
  background: var(--surface);
}
.stat-card strong {
  margin-block: 0.05rem;
  font-size: clamp(1.65rem, 3vw, 2.3rem);
  line-height: 1;
  color: var(--navy-900);
}
.stat-card > span:last-child { color: var(--ink-faint); font-size: 0.75rem; }
.stat-label { color: var(--ink-soft); font-size: 0.75rem; font-weight: 850; text-transform: uppercase; letter-spacing: 0.05em; }
.stat-critical { border-inline-start: 5px solid var(--red-700); }
.stat-critical strong { color: var(--red-800); }

.offline-operations {
  display: grid;
  gap: 0.85rem;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.9rem;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.offline-heading,
.map-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.offline-heading h3,
.map-heading h4 { margin: 0.15rem 0 0; }

.offline-heading .muted { max-width: 68rem; margin: 0.3rem 0 0; }

.readiness-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.65rem;
}

.readiness-item {
  display: grid;
  gap: 0.15rem;
  min-block-size: 5.25rem;
  align-content: center;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--line);
  border-radius: 0.7rem;
  background: var(--surface-soft);
}

.readiness-item span { color: var(--ink-soft); font-size: 0.75rem; font-weight: 750; }
.readiness-item strong { color: var(--navy-900); font-size: 0.9rem; }

.incident-map-panel {
  display: grid;
  gap: 0.6rem;
  padding-block-start: 0.85rem;
  border-block-start: 1px solid var(--line);
}

.map-heading { align-items: end; }
.map-heading > span { max-width: 55%; text-align: end; font-size: 0.75rem; }

.map-stage {
  position: relative;
  min-block-size: 22rem;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 0.75rem;
  background:
    linear-gradient(rgba(15, 76, 129, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(15, 76, 129, 0.06) 1px, transparent 1px),
    var(--surface-soft);
  background-size: 2rem 2rem;
}

.incident-map-canvas { position: absolute; inset: 0; }

.map-placeholder {
  position: absolute;
  z-index: 2;
  inset: 50% auto auto 50%;
  width: min(88%, 36rem);
  transform: translate(-50%, -50%);
  padding: 1rem 1.15rem;
  border: 1px solid var(--line);
  border-radius: 0.65rem;
  background: rgba(255, 255, 255, 0.94);
  color: var(--ink-soft);
  text-align: center;
  box-shadow: var(--shadow-sm);
}

.map-placeholder[hidden] { display: none; }
.map-accessibility-note { margin: 0; color: var(--ink-soft); font-size: 0.78rem; }

.map-marker {
  display: grid;
  place-items: center;
  inline-size: 2.8rem;
  block-size: 2.8rem;
  min-block-size: 2.8rem;
  padding: 0;
  border: 3px solid var(--surface);
  border-radius: 50%;
  background: var(--navy-700);
  color: var(--surface);
  font-size: 1rem;
  box-shadow: 0 2px 8px rgba(7, 27, 43, 0.28);
}

.map-marker[aria-pressed="true"] { outline: 4px solid var(--focus); outline-offset: 2px; }

.danger-outline { color: var(--red-800); background: var(--surface); border: 1px solid #d4938f; }
.danger-outline:hover { background: var(--red-100); }

.noscript-warning {
  margin: 1rem;
  padding: 1rem;
  border: 2px solid var(--red-700);
  background: var(--red-100);
  color: var(--red-800);
  font-weight: 800;
}

@media (max-width: 68rem) {
  .readiness-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .offline-heading,
  .map-heading { align-items: stretch; flex-direction: column; }
  .map-heading > span { max-width: none; text-align: start; }
}

@media (max-width: 38rem) {
  .readiness-grid { grid-template-columns: 1fr; }
  .map-stage { min-block-size: 18rem; }
}

.workspace {
  display: grid;
  grid-template-columns: minmax(19rem, 0.72fr) minmax(0, 1.28fr);
  gap: 1rem;
  align-items: start;
}

.incident-column,
.detail-panel {
  border: 1px solid var(--line);
  border-radius: 0.9rem;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.incident-column {
  position: sticky;
  inset-block-start: 5.75rem;
  max-block-size: calc(100vh - 7rem);
  overflow: auto;
  overscroll-behavior: contain;
}

.panel-header {
  position: sticky;
  z-index: 2;
  inset-block-start: 0;
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.95rem 1rem;
  border-block-end: 1px solid var(--line);
  background: var(--surface);
}
.panel-header h3 { margin: 0.1rem 0 0; font-size: 1rem; }
.panel-header > span { align-self: center; color: var(--ink-faint); font-size: 0.75rem; text-align: end; }

.incident-list {
  display: grid;
  gap: 0.55rem;
  padding: 0.7rem;
}

.incident-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 9rem;
  width: 100%;
  min-block-size: 8.5rem;
  border: 1px solid var(--line);
  border-inline-start: 5px solid var(--navy-700);
  border-radius: 0.75rem;
  padding: 0.85rem;
  text-align: start;
  background: var(--surface);
  color: var(--ink);
  box-shadow: none;
}
.incident-card:hover { background: var(--surface-soft); }
.incident-card.immediate { border-inline-start-color: var(--red-700); }
.incident-card.selected,
.incident-card[aria-current="true"] {
  border-color: var(--navy-700);
  border-inline-start-color: var(--navy-700);
  background: var(--navy-100);
}
.incident-card.immediate.selected,
.incident-card.immediate[aria-current="true"] { border-inline-start-color: var(--red-700); }

.incident-top { justify-content: space-between; gap: 0.65rem; }
.incident-type { font-size: 0.98rem; font-weight: 900; }
.incident-type.urgent { color: var(--red-800); }

.incident-meta {
  justify-content: space-between;
  gap: 0.75rem;
  margin-block-start: 0.45rem;
  color: var(--ink-soft);
  font-size: 0.78rem;
}
.incident-location,
.incident-responder {
  display: block;
  margin-block-start: 0.38rem;
  color: var(--ink-soft);
  font-size: 0.78rem;
}
.incident-report-id { color: var(--ink-faint); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

.status-pill {
  display: inline-flex;
  align-items: center;
  min-block-size: 1.8rem;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
  white-space: nowrap;
  font-size: 0.7rem;
  font-weight: 900;
}
.status-pill.pending { color: var(--amber-800); background: var(--amber-100); border-color: #e5c171; }
.status-pill.active { color: var(--navy-800); background: var(--navy-100); border-color: #a8c8df; }
.status-pill.resolved { color: var(--green-800); background: var(--green-100); border-color: #9acfb2; }

.empty {
  display: grid;
  gap: 0.25rem;
  padding: 2.25rem 1.25rem;
  text-align: center;
  color: var(--ink-soft);
}
.empty strong { color: var(--ink); }

.detail-panel {
  min-block-size: 38rem;
  padding: clamp(1rem, 2.5vw, 1.5rem);
}

.detail-placeholder {
  display: grid;
  min-block-size: 34rem;
  place-items: center;
  align-content: center;
  gap: 0.45rem;
  text-align: center;
  color: var(--ink-soft);
}
.placeholder-mark {
  display: grid;
  place-items: center;
  inline-size: 3rem;
  block-size: 3rem;
  border: 2px solid var(--navy-700);
  border-radius: 50%;
  color: var(--navy-700);
  font-size: 1.6rem;
  font-weight: 700;
}
.detail-placeholder strong { color: var(--ink); font-size: 1.1rem; }

.detail-heading {
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  padding-block-end: 1rem;
  border-block-end: 1px solid var(--line);
}
.detail-heading h3 { margin: 0.15rem 0 0; font-size: clamp(1.45rem, 3vw, 2rem); }
.detail-subtitle { margin: 0.15rem 0 0; color: var(--ink-soft); font-size: 0.82rem; }

.urgency-banner {
  display: flex;
  align-items: baseline;
  gap: 0.65rem;
  margin-block-start: 1rem;
  padding: 0.7rem 0.85rem;
  border: 1px solid #e0aaa7;
  border-inline-start: 5px solid var(--red-700);
  border-radius: 0.65rem;
  background: var(--red-100);
  color: var(--red-800);
}
.urgency-banner span { font-size: 0.82rem; }

.facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
  margin-block: 1rem;
}
.fact {
  min-width: 0;
  padding: 0.7rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 0.65rem;
  background: var(--surface-soft);
}
.fact dt { color: var(--ink-faint); font-size: 0.7rem; font-weight: 850; text-transform: uppercase; letter-spacing: 0.04em; }
.fact dd { margin: 0.18rem 0 0; overflow-wrap: anywhere; font-size: 0.9rem; font-weight: 750; }

.location-card {
  contain: layout style;
  justify-content: space-between;
  gap: 1rem;
  margin-block: 1rem;
  padding: 1rem;
  border: 1px solid #b7cfdf;
  border-inline-start: 5px solid var(--navy-700);
  border-radius: 0.75rem;
  background: #f0f6fa;
}
.location-copy strong,
.location-copy span { display: block; }
.location-copy strong { margin-block: 0.15rem 0.25rem; }
.location-coordinates { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 800; }
.map-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  padding-inline: 0.9rem;
  border: 1px solid var(--navy-700);
  border-radius: 0.65rem;
  text-decoration: none;
  font-weight: 850;
  background: var(--surface);
}

.ack-form {
  margin-block: 1.25rem;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.85rem;
  background: var(--surface-soft);
}
.form-heading h4 { margin: 0.15rem 0 0.2rem; font-size: 1.05rem; }
.form-heading p:last-child { margin: 0; font-size: 0.8rem; }
.ack-fields {
  display: grid;
  grid-template-columns: minmax(11rem, 0.4fr) minmax(0, 1.6fr);
  gap: 0.8rem;
  align-items: start;
}
.ack-note-field { min-width: 0; }
.ack-actions { gap: 0.8rem; align-items: center; }
.form-result { min-block-size: 1.4rem; margin: 0; color: var(--green-800); font-weight: 800; }

.history-section {
  margin-block-start: 1.35rem;
  padding-block-start: 1.2rem;
  border-block-start: 1px solid var(--line);
}
.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  margin-block-end: 0.7rem;
}
.section-heading h4 { margin: 0; }
.section-heading span { color: var(--ink-faint); font-size: 0.76rem; }

.history { display: grid; gap: 0.6rem; }
.history-item {
  contain: layout style;
  padding: 0.75rem 0.85rem;
  border: 1px solid #e1e8ed;
  border-inline-start: 4px solid var(--navy-700);
  border-radius: 0.45rem 0.7rem 0.7rem 0.45rem;
  background: var(--surface-soft);
}
.history-item strong,
.history-item span { display: block; }
.history-item span { margin-block-start: 0.16rem; color: var(--ink-soft); font-size: 0.8rem; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 70rem) {
  .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workspace { grid-template-columns: minmax(17rem, 0.8fr) minmax(0, 1.2fr); }
  .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 58rem) {
  .auth-shell { grid-template-columns: 1fr; }
  .auth-context { padding-block: 2rem; }
  .auth-context h2 { max-width: none; }
  .auth-lede { margin-block-end: 1.5rem; }

  .workspace { grid-template-columns: 1fr; }
  .incident-column {
    position: static;
    max-block-size: none;
    overflow: visible;
  }
  .detail-panel { min-block-size: 24rem; }
  .detail-placeholder { min-block-size: 20rem; }
}

@media (max-width: 43rem) {
  main { padding: 0.8rem; }

  .topbar {
    position: static;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .topbar-status { align-items: flex-end; flex-direction: column; gap: 0.25rem; }
  .responder-identity { font-size: 0.78rem; }

  .auth-shell {
    margin-block-start: 0.5rem;
    border-radius: 0.9rem;
  }
  .auth-context,
  .auth-card { padding: 1.35rem; }

  .toolbar {
    align-items: stretch;
    flex-direction: column;
    padding: 0.95rem;
  }
  .toolbar-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .control-field { grid-column: 1 / -1; }
  .toolbar-actions button { width: 100%; }

  .stats-grid { grid-template-columns: 1fr 1fr; }
  .stat-card { min-block-size: 6.6rem; padding: 0.75rem; }

  .panel-header { align-items: start; }
  .panel-header > span { max-width: 8rem; }

  .incident-top,
  .incident-meta { align-items: flex-start; }
  .incident-meta { flex-direction: column; gap: 0.2rem; }

  .facts { grid-template-columns: 1fr; }
  .detail-heading { align-items: flex-start; }
  .urgency-banner { align-items: flex-start; flex-direction: column; gap: 0.2rem; }
  .location-card { align-items: stretch; flex-direction: column; }
  .map-link { align-self: stretch; }
  .ack-fields { grid-template-columns: 1fr; }
  .ack-actions { align-items: stretch; flex-direction: column; }
  .ack-actions button { width: 100%; }
  .section-heading { align-items: flex-start; flex-direction: column; gap: 0.15rem; }
}

@media (pointer: coarse) {
  button,
  select,
  input,
  textarea,
  .map-link { min-block-size: 3.25rem; }
}

@media (prefers-reduced-motion: reduce) {
  button,
  .incident-card { transition: none; }
}

@media (forced-colors: active) {
  .dot,
  .dot.online,
  .status-pill,
  .placeholder-mark,
  .location-card,
  .incident-card.selected,
  .incident-card[aria-current="true"],
  .urgency-banner {
    forced-color-adjust: auto;
  }
}

@media print {
  .topbar,
  .toolbar-actions,
  .stats-grid,
  .incident-column,
  .ack-form,
  .map-link,
  .banner-error { display: none !important; }

  body,
  main,
  .detail-panel { background: #fff; box-shadow: none; }

  main { width: 100%; padding: 0; }
  .workspace { display: block; }
  .detail-panel { border: 0; }
}`;

const DASHBOARD_JS = `(() => {
  'use strict';

  const REFRESH_MS = 10000;
  const lifecycle = new AbortController();
  let currentResponder = null;
  let sessionExpiresAt = null;
  let selectedReportId = null;
  let refreshTimer = null;
  let latestIncidents = [];
  let offlineDetails = new Map();
  let activeOfflineSnapshot = null;
  let dataSource = 'online';

  const authPanel = document.getElementById('authPanel');
  const consolePanel = document.getElementById('consolePanel');
  const authForm = document.getElementById('authForm');
  const tokenInput = document.getElementById('tokenInput');
  const connectButton = document.getElementById('connectButton');
  const authError = document.getElementById('authError');
  const responderIdentity = document.getElementById('responderIdentity');
  const responderCallsign = document.getElementById('responderCallsign');
  const responderRole = document.getElementById('responderRole');
  const incidentList = document.getElementById('incidentList');
  const emptyState = document.getElementById('emptyState');
  const incidentCount = document.getElementById('incidentCount');
  const queueScope = document.getElementById('queueScope');
  const detailPlaceholder = document.getElementById('detailPlaceholder');
  const detailContent = document.getElementById('detailContent');
  const detailTitle = document.getElementById('detailTitle');
  const detailSubtitle = document.getElementById('detailSubtitle');
  const detailStatus = document.getElementById('detailStatus');
  const urgencyBanner = document.getElementById('urgencyBanner');
  const detailFacts = document.getElementById('detailFacts');
  const locationCard = document.getElementById('locationCard');
  const locationText = document.getElementById('locationText');
  const locationMeta = document.getElementById('locationMeta');
  const locationCaptured = document.getElementById('locationCaptured');
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
  const sessionExpiry = document.getElementById('sessionExpiry');
  const serverError = document.getElementById('serverError');
  const connectionDot = document.getElementById('connectionDot');
  const connectionText = document.getElementById('connectionText');
  const openCount = document.getElementById('openCount');
  const immediateCount = document.getElementById('immediateCount');
  const pendingCount = document.getElementById('pendingCount');
  const activeCount = document.getElementById('activeCount');

  function setConnected(connected) {
    connectionDot.classList.toggle('online', connected);
    connectionText.textContent = connected ? 'Server connected' : 'Connection unavailable';
  }

  function showError(message) {
    serverError.textContent = message || '';
    serverError.classList.toggle('hidden', !message);
  }

  function statusLabel(incident) {
    return incident.latestAck ? incident.latestAck.status : 'PENDING';
  }

  function formatWords(value, fallback) {
    return String(value || fallback)
      .toLowerCase()
      .split('_')
      .map((word) => word ? word.charAt(0).toUpperCase() + word.slice(1) : word)
      .join(' ');
  }

  function formatStatus(value) {
    return formatWords(value, 'PENDING');
  }

  function statusClass(status) {
    if (status === 'PENDING') return 'pending';
    if (status === 'RESOLVED') return 'resolved';
    return 'active';
  }

  function formatDate(value) {
    if (value === null || value === undefined || value === '') return 'Unknown';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  }

  function formatRelative(value) {
    if (value === null || value === undefined || value === '') return 'time unknown';
    const date = new Date(value);
    const timestamp = date.getTime();
    if (Number.isNaN(timestamp)) return 'time unknown';

    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return seconds + 's ago';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function formatEmergencyType(value) {
    return formatWords(value, 'OTHER');
  }

  function shortReportId(value) {
    const text = String(value || '');
    return text.length > 12 ? text.slice(0, 8) + '…' : text;
  }

  function createText(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  async function parseError(response) {
    try {
      const body = await response.json();
      return body && body.error ? String(body.error) : 'SERVER_ERROR';
    } catch (_) {
      return 'SERVER_ERROR';
    }
  }

  async function api(path, options) {
    const response = await fetch(
      path,
      Object.assign({credentials: 'same-origin'}, options || {})
    );
    if (response.status === 401) {
      showLoggedOut('Your responder session expired or was revoked. Paste your provisioned token to reconnect.');
      throw new Error('UNAUTHORIZED');
    }
    if (!response.ok) {
      throw new Error(await parseError(response));
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function renderSessionIdentity() {
    const connected = Boolean(currentResponder);
    responderIdentity.classList.toggle('hidden', !connected);
    if (!connected) return;

    responderCallsign.textContent = currentResponder.callsign || 'Responder';
    responderRole.textContent = formatWords(currentResponder.role, 'AUTHORIZED');

    if (sessionExpiresAt) {
      const expiry = new Date(sessionExpiresAt);
      sessionExpiry.textContent = Number.isNaN(expiry.getTime())
        ? 'Session active'
        : 'Session ends ' + expiry.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    } else {
      sessionExpiry.textContent = 'Session active';
    }
  }

  function showConsole() {
    authPanel.classList.add('hidden');
    consolePanel.classList.remove('hidden');
    renderSessionIdentity();
    setConnected(dataSource === 'online');
    if (dataSource === 'online') startRefreshTimer();
    else stopRefreshTimer();
  }

  function resetDetail() {
    selectedReportId = null;
    detailContent.classList.add('hidden');
    detailPlaceholder.classList.remove('hidden');
    ackResult.textContent = '';
  }

  function showLoggedOut(message) {
    currentResponder = null;
    sessionExpiresAt = null;
    latestIncidents = [];
    offlineDetails = new Map();
    activeOfflineSnapshot = null;
    dataSource = 'online';
    stopRefreshTimer();
    resetDetail();
    consolePanel.classList.add('hidden');
    authPanel.classList.remove('hidden');
    responderIdentity.classList.add('hidden');
    tokenInput.value = '';
    tokenInput.removeAttribute('aria-invalid');
    authError.textContent = message || '';
    connectionText.textContent = 'Not connected';
    connectionDot.classList.remove('online');
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

  function publishDashboardState() {
    const incidents = latestIncidents.map((incident) => ({
      reportId: incident.reportId,
      emergencyType: incident.emergencyType,
      urgency: incident.urgency,
      location: incident.location || null
    }));
    window.dispatchEvent(new CustomEvent('sagip:incidents', {
      detail: {incidents: incidents, selectedReportId: selectedReportId}
    }));
  }

  function selectIncident(reportId) {
    selectedReportId = reportId;
    Array.from(incidentList.children).forEach((item) => {
      const selected = item.dataset.reportId === reportId;
      item.classList.toggle('selected', selected);
      if (selected) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    });
    publishDashboardState();
    void loadDetail(reportId);
  }

  function snapshotEntryToIncident(entry) {
    return {
      reportId: entry.reportId,
      emergencyType: entry.emergencyType,
      urgency: entry.urgency,
      firstReceivedAt: new Date(entry.receivedAtMs).toISOString(),
      createdAtMs: entry.reportCreatedAtMs,
      latestRevision: entry.revision,
      location: entry.location,
      latestAck: entry.latestAck || null,
      syncedAtMs: entry.syncedAtMs,
      receiptEvidence: Array.isArray(entry.receiptEvidence) ? entry.receiptEvidence : [],
      pendingActions: Array.isArray(entry.pendingActions) ? entry.pendingActions : []
    };
  }

  function snapshotEntryToDetail(entry) {
    return {
      ...snapshotEntryToIncident(entry),
      revisions: Array.isArray(entry.revisions) ? entry.revisions : [],
      acknowledgements: Array.isArray(entry.acknowledgements) ? entry.acknowledgements : []
    };
  }

  function renderOfflineSnapshot(snapshot) {
    dataSource = 'offline';
    activeOfflineSnapshot = snapshot;
    offlineDetails = new Map(
      snapshot.entries.map((entry) => [entry.reportId, snapshotEntryToDetail(entry)])
    );
    const all = snapshot.entries.map(snapshotEntryToIncident);
    const filtered = statusFilter.value
      ? all.filter((incident) => statusLabel(incident) === statusFilter.value)
      : all;
    showConsole();
    setConnected(false);
    connectionText.textContent = 'Offline snapshot';
    renderSummary(snapshot.summary);
    renderIncidents(filtered);
    queueScope.textContent = 'Complete offline snapshot · ' + snapshot.total + ' incidents';
    lastUpdated.textContent = 'Snapshot prepared ' + formatDate(snapshot.createdAtMs);
    if (selectedReportId && offlineDetails.has(selectedReportId)) {
      void loadDetail(selectedReportId);
    } else if (selectedReportId) {
      resetDetail();
    }
  }

  window.SagipResponderBridge = {
    getState: () => ({
      incidents: latestIncidents.map((incident) => ({
        reportId: incident.reportId,
        emergencyType: incident.emergencyType,
        urgency: incident.urgency,
        location: incident.location || null
      })),
      selectedReportId: selectedReportId
    }),
    selectReport: (reportId) => {
      if (latestIncidents.some((incident) => incident.reportId === reportId)) {
        selectIncident(reportId);
      }
    },
    useOfflineSnapshot: (snapshot) => renderOfflineSnapshot(snapshot),
    showOperationalMessage: (message) => showError(message),
    finishOfflineLogout: (message) => showLoggedOut(message || '')
  };

  function makeIncidentCard(incident) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'incident-card';
    if (incident.urgency === 'IMMEDIATE_DANGER') card.classList.add('immediate');

    if (incident.reportId === selectedReportId) {
      card.classList.add('selected');
      card.setAttribute('aria-current', 'true');
    }

    const status = statusLabel(incident);
    const urgency = incident.urgency === 'IMMEDIATE_DANGER' ? 'Immediate danger' : 'Needs assistance';
    card.setAttribute(
      'aria-label',
      formatEmergencyType(incident.emergencyType) + ' incident, ' + urgency + ', ' + formatStatus(status)
    );

    const top = document.createElement('div');
    top.className = 'incident-top';
    const type = createText(
      'span',
      'incident-type' + (incident.urgency === 'IMMEDIATE_DANGER' ? ' urgent' : ''),
      formatEmergencyType(incident.emergencyType)
    );
    const pill = createText('span', 'status-pill ' + statusClass(status), formatStatus(status));
    top.append(type, pill);

    const meta = document.createElement('div');
    meta.className = 'incident-meta';
    meta.append(
      createText('span', '', urgency),
      createText('span', '', 'Received ' + formatRelative(incident.firstReceivedAt))
    );

    const location = incident.location && incident.location.latitude !== null && incident.location.longitude !== null
      ? Number(incident.location.latitude).toFixed(5) + ', ' + Number(incident.location.longitude).toFixed(5)
      : 'Location unavailable';

    const responder = incident.latestAck
      ? formatStatus(incident.latestAck.status) + ' by ' + (incident.latestAck.callsign || 'responder')
      : 'Awaiting responder acknowledgement';

    card.append(
      top,
      meta,
      createText('span', 'incident-location', location),
      createText('span', 'incident-responder', responder),
      createText('span', 'incident-report-id', 'Report ' + shortReportId(incident.reportId))
    );

    card.addEventListener('click', () => {
      selectIncident(incident.reportId);
    }, {signal: lifecycle.signal});

    return card;
  }

  function renderIncidents(incidents) {
    latestIncidents = incidents;
    incidentList.replaceChildren();
    emptyState.classList.toggle('hidden', incidents.length !== 0);
    incidentCount.textContent = incidents.length + (incidents.length === 1 ? ' incident loaded' : ' incidents loaded');
    queueScope.textContent = incidents.length >= 100 ? 'Newest 100 shown' : 'All matching incidents shown';
    incidents.forEach((incident) => incidentList.appendChild(makeIncidentCard(incident)));
    publishDashboardState();
  }

  function renderSummary(summary) {
    const total = Number(summary.total || 0);
    const resolved = Number(summary.resolved || 0);
    openCount.textContent = String(Math.max(0, total - resolved));
    immediateCount.textContent = String(Number(summary.immediateDanger || 0));
    pendingCount.textContent = String(Number(summary.pending || 0));
    activeCount.textContent = String(
      Number(summary.acknowledged || 0) + Number(summary.enRoute || 0) + Number(summary.onScene || 0)
    );
  }

  function addFact(label, value) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fact';
    wrapper.append(
      createText('dt', '', label),
      createText('dd', '', value)
    );
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
    if (location.accuracyMeters !== null) pieces.push('Accuracy ±' + Math.round(Number(location.accuracyMeters)) + ' m');
    else pieces.push('Accuracy unknown');
    if (location.freshness) pieces.push(formatWords(location.freshness, 'UNKNOWN'));
    if (location.source) pieces.push(formatWords(location.source, 'UNKNOWN'));
    locationMeta.textContent = pieces.join(' · ');

    locationCaptured.textContent = location.capturedAtMs !== null
      ? 'Captured ' + formatDate(location.capturedAtMs) + ' (' + formatRelative(location.capturedAtMs) + ')'
      : 'Capture time unavailable';

    mapLink.href = '#incidentMapPanel';
  }

  function renderAckHistory(acks) {
    ackHistory.replaceChildren();
    if (!acks.length) {
      ackHistory.appendChild(createText('p', 'muted', 'No responder acknowledgement has been persisted yet.'));
      return;
    }

    acks.forEach((ack) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.append(
        createText('strong', '', formatStatus(ack.status) + ' · ' + (ack.callsign || 'Responder')),
        createText('span', '', formatDate(ack.acknowledgedAt) + ' · ' + formatRelative(ack.acknowledgedAt)),
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
        if (revision.location.freshness) locationParts.push(formatWords(revision.location.freshness, 'UNKNOWN'));
        if (revision.location.source) locationParts.push(formatWords(revision.location.source, 'UNKNOWN'));
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
    detailSubtitle.textContent = 'Server accepted ' + formatRelative(detail.firstReceivedAt) + ' · Revision ' + detail.latestRevision;

    const status = statusLabel(detail);
    detailStatus.textContent = formatStatus(status);
    detailStatus.className = 'status-pill ' + statusClass(status);
    urgencyBanner.classList.toggle('hidden', detail.urgency !== 'IMMEDIATE_DANGER');

    detailFacts.replaceChildren();
    addFact('Urgency', detail.urgency === 'IMMEDIATE_DANGER' ? 'Immediate danger' : 'Needs assistance');
    addFact('Server received', formatDate(detail.firstReceivedAt));
    addFact('Report created', formatDate(detail.createdAtMs));
    addFact('Latest revision', String(detail.latestRevision));
    addFact('Current status', formatStatus(status));
    if (detail.syncedAtMs !== null && detail.syncedAtMs !== undefined) {
      addFact('Offline snapshot synced', formatDate(detail.syncedAtMs) + ' · ' + formatRelative(detail.syncedAtMs));
    }
    if (Array.isArray(detail.receiptEvidence)) {
      const verified = detail.receiptEvidence.filter((item) => String(item.verification || '').startsWith('VERIFIED')).length;
      addFact('Responder evidence', verified + ' verified of ' + detail.receiptEvidence.length + ' stored receipt' + (detail.receiptEvidence.length === 1 ? '' : 's'));
    }
    if (Array.isArray(detail.pendingActions) && detail.pendingActions.length > 0) {
      addFact('Pending provider updates', String(detail.pendingActions.length));
    }
    addFact('Report ID', detail.reportId);

    renderLocation(detail.location);
    renderAckHistory(detail.acknowledgements || []);
    renderRevisionHistory(detail.revisions || []);

    if (status === 'ACKNOWLEDGED') ackStatus.value = 'EN_ROUTE';
    else if (status === 'EN_ROUTE') ackStatus.value = 'ON_SCENE';
    else if (status === 'ON_SCENE') ackStatus.value = 'RESOLVED';
    else if (status === 'RESOLVED') ackStatus.value = 'RESOLVED';
    else ackStatus.value = 'ACKNOWLEDGED';
  }

  async function loadDetail(reportId) {
    try {
      showError('');
      const detail = dataSource === 'offline'
        ? offlineDetails.get(reportId)
        : await api('/v1/incidents/' + encodeURIComponent(reportId));
      if (!detail) throw new Error('DETAIL_NOT_IN_SNAPSHOT');
      if (reportId !== selectedReportId) return;
      renderDetail(detail);
    } catch (error) {
      if (String(error && error.message) !== 'UNAUTHORIZED') {
        showError('Could not load incident detail. The server retains the incident; retry when connectivity returns.');
      }
    }
  }

  async function refreshIncidents(showLoading) {
    if (!currentResponder) return;

    try {
      if (showLoading) lastUpdated.textContent = 'Refreshing…';
      showError('');

      const query = statusFilter.value
        ? '?limit=100&status=' + encodeURIComponent(statusFilter.value)
        : '?limit=100';

      const results = await Promise.all([
        api('/v1/incidents/summary'),
        api('/v1/incidents' + query)
      ]);
      const summary = results[0];
      const incidents = results[1];

      dataSource = 'online';
      showConsole();
      renderSummary(summary);
      renderIncidents(incidents);
      lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();

      if (selectedReportId && incidents.some((incident) => incident.reportId === selectedReportId)) {
        await loadDetail(selectedReportId);
      } else if (selectedReportId) {
        resetDetail();
      }
    } catch (error) {
      if (String(error && error.message) !== 'UNAUTHORIZED') {
        setConnected(false);
        lastUpdated.textContent = 'Last refresh failed';
        if (activeOfflineSnapshot) {
          renderOfflineSnapshot(activeOfflineSnapshot);
          showError('Cloud refresh failed. Showing the last complete protected offline snapshot; pending responder updates remain in the durable browser outbox.');
        } else {
          showError('The responder console could not refresh. Existing incidents remain persisted on the server; retry shortly.');
        }
      }
    }
  }

  async function startSession(token) {
    const response = await fetch('/v1/responder/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token: token})
    });

    if (!response.ok) {
      const errorName = await parseError(response);
      if (response.status === 401) throw new Error('INVALID_TOKEN');
      if (response.status === 429) throw new Error('RATE_LIMITED');
      throw new Error(errorName);
    }

    return response.json();
  }

  async function restoreSession() {
    try {
      const response = await fetch('/v1/responder/session', {
        method: 'GET',
        credentials: 'same-origin'
      });

      if (response.status === 401) {
        if (dataSource !== 'offline') showLoggedOut('');
        return;
      }
      if (!response.ok) {
        throw new Error(await parseError(response));
      }

      const session = await response.json();
      currentResponder = session.responder;
      sessionExpiresAt = session.expiresAt;
      showConsole();
      await refreshIncidents(true);
    } catch (_) {
      if (dataSource !== 'offline') {
        showLoggedOut('Could not confirm an existing responder session. Check connectivity, then reconnect with your provisioned token.');
      }
    }
  }

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    authError.textContent = '';
    const candidate = tokenInput.value.trim();

    if (!candidate) {
      tokenInput.setAttribute('aria-invalid', 'true');
      authError.textContent = 'Paste your provisioned responder token.';
      tokenInput.focus();
      return;
    }

    tokenInput.removeAttribute('aria-invalid');
    connectButton.disabled = true;
    connectButton.textContent = 'Connecting…';

    try {
      const sessionPromise = startSession(candidate);
      tokenInput.value = '';
      const session = await sessionPromise;
      currentResponder = session.responder;
      sessionExpiresAt = session.expiresAt;
      showConsole();
      await refreshIncidents(true);
    } catch (error) {
      const message = String(error && error.message);
      if (message === 'INVALID_TOKEN') {
        authError.textContent = 'That responder token was not accepted. Copy the current token from the approved team secret store.';
      } else if (message === 'RATE_LIMITED') {
        authError.textContent = 'Too many connection attempts. Wait briefly before trying again.';
      } else {
        authError.textContent = 'Could not start the responder session. Check connectivity and retry.';
      }
      tokenInput.focus();
    } finally {
      connectButton.disabled = false;
      connectButton.textContent = 'Start responder session';
    }
  }, {signal: lifecycle.signal});

  tokenInput.addEventListener('input', () => {
    tokenInput.removeAttribute('aria-invalid');
    authError.textContent = '';
  }, {signal: lifecycle.signal});

  document.getElementById('refreshButton').addEventListener('click', () => {
    void refreshIncidents(true);
  }, {signal: lifecycle.signal});

  document.getElementById('logoutButton').addEventListener('click', async () => {
    const offline = window.SagipOfflineConsole;
    if (offline) {
      const result = await offline.safeLogout();
      if (result && result.kind === 'BLOCKED_PENDING_ACTIONS') {
        showError('Disconnect blocked: ' + result.pending + ' responder update' + (result.pending === 1 ? '' : 's') + ' still need provider custody. Retry delivery or explicitly discard them.');
        return;
      }
      if (result && result.kind === 'PROVIDER_REFUSED') {
        showError('Disconnect could not be confirmed by the selected provider. Protected data and pending updates were kept.');
        return;
      }
      if (result && result.kind === 'COMPLETE') {
        showLoggedOut('');
        return;
      }
    }
    try {
      await fetch('/v1/responder/session', {method: 'DELETE', credentials: 'same-origin'});
    } finally {
      showLoggedOut('');
    }
  }, {signal: lifecycle.signal});

  statusFilter.addEventListener('change', () => {
    resetDetail();
    if (dataSource === 'offline' && activeOfflineSnapshot) renderOfflineSnapshot(activeOfflineSnapshot);
    else void refreshIncidents(true);
  }, {signal: lifecycle.signal});

  ackForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedReportId) return;

    ackButton.disabled = true;
    ackResult.textContent = 'Saving…';
    try {
      if (dataSource === 'offline' && window.SagipOfflineConsole) {
        const queuedResult = await window.SagipOfflineConsole.queueStatus(
          selectedReportId,
          ackStatus.value,
          ackNote.value.trim()
        );
        if (queuedResult && queuedResult.queued && queuedResult.queued.kind === 'SAVED_LOCAL') {
          const remaining = queuedResult.drain && Number(queuedResult.drain.remaining || 0);
          ackResult.textContent = remaining === 0
            ? 'Saved locally and committed to the selected provider.'
            : 'Saved on this browser. Provider delivery is still pending.';
          ackNote.value = '';
        } else if (queuedResult && queuedResult.kind === 'FULL') {
          ackResult.textContent = 'Offline update storage is full. Existing pending updates were preserved.';
        } else {
          ackResult.textContent = 'The offline update could not be saved. Existing incident data was preserved.';
        }
        return;
      }
      const ack = await api('/v1/incidents/' + encodeURIComponent(selectedReportId) + '/ack', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          status: ackStatus.value,
          note: ackNote.value.trim() || null
        })
      });
      ackResult.textContent = 'Saved: ' + formatStatus(ack.status);
      ackNote.value = '';
      await refreshIncidents(false);
      if (selectedReportId) await loadDetail(selectedReportId);
    } catch (error) {
      if (String(error && error.message) !== 'UNAUTHORIZED') {
        ackResult.textContent = 'Could not confirm the update. It may have been saved; refresh before retrying.';
      }
    } finally {
      ackButton.disabled = false;
    }
  }, {signal: lifecycle.signal});

  window.addEventListener('pagehide', () => {
    stopRefreshTimer();
    lifecycle.abort();
  }, {once: true});

  void restoreSession();
})();`;

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export function responderDashboardResponse(pathname: string, method: string): Response | null {
  const mapAsset = consoleAssetResponse(pathname, method);
  if (mapAsset) return mapAsset;

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
