import {consoleAssetResponse} from './consoleAssets.js';

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0c2942">
  <title>SAGIP Responder Console</title>
  <link rel="stylesheet" href="/responder/assets/maplibre-gl-6.11.2/maplibre-gl.css">
  <link rel="stylesheet" href="/responder/styles.css">
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
      <div class="auth-card">
        <span class="auth-accent" aria-hidden="true"></span>
        <h2 id="authTitle">Responder sign-in</h2>
        <p class="auth-intro">Access your team’s response workspace.</p>
        <p id="authPending" class="sr-only" role="status"></p>
        <form id="authForm" method="post" novalidate aria-busy="false">
          <div class="form-field">
            <label for="tokenInput">Provisioned responder token</label>
            <p id="tokenHelp" class="field-help">Paste the token from your approved team secret store.</p>
            <div class="token-control">
              <input id="tokenInput" name="responder-token" type="password" autocomplete="off" spellcheck="false" inputmode="text" aria-describedby="tokenHelp authError" required>
              <button id="tokenVisibility" class="token-visibility" type="button" aria-label="Show responder token" aria-pressed="false" aria-controls="tokenInput">Show</button>
            </div>
          </div>
          <button id="connectButton" type="submit">Start responder session</button>
          <p id="authError" class="error" role="alert"></p>
        </form>
        <div class="auth-security">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"></path></svg>
          <p>A browser session for up to 12 hours.<br><span>SAGIP does not save your token in browser storage.</span></p>
        </div>
      </div>
      <p class="auth-footer">For authorized response teams</p>
    </section>

    <section id="consolePanel" class="console hidden" aria-label="Responder operations">
      <nav class="console-rail" aria-label="Operations views">
        <button id="mapViewButton" type="button" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 5 6-3 6 3 6-3v17l-6 3-6-3-6 3V5Zm6-3v17m6-14v17"/></svg><span>Map</span></button>
        <button id="queueViewButton" type="button" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/></svg><span>Incidents</span></button>
        <button id="readinessButton" type="button" aria-expanded="false" aria-controls="offlineReadiness"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/></svg><span>Offline</span></button>
        <span class="rail-caption">TAGUM</span>
      </nav>
      <div class="toolbar">
        <div class="toolbar-copy">
          <p class="eyebrow">Emergency operations</p>
          <h2 aria-label="Tagum emergency operations">Tagum City</h2>
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
          <span class="stat-icon stat-open-icon" aria-hidden="true">⚑</span><span class="stat-label">Open incidents</span>
          <strong id="openCount">0</strong>
          <span>Not resolved</span>
        </div>
        <div class="stat-card stat-critical">
          <span class="stat-icon" aria-hidden="true">!</span><span class="stat-label">Immediate danger</span>
          <strong id="immediateCount">0</strong>
          <span>Latest accepted revision</span>
        </div>
        <div class="stat-card">
          <span class="stat-icon" aria-hidden="true">◷</span><span class="stat-label">Pending response</span>
          <strong id="pendingCount">0</strong>
          <span>No responder acknowledgement</span>
        </div>
        <div class="stat-card">
          <span class="stat-icon" aria-hidden="true">✓</span><span class="stat-label">Active response</span>
          <strong id="activeCount">0</strong>
          <span>Acknowledged, en route, or on scene</span>
        </div>
      </section>

      <div class="operations-stage">
      <section id="offlineOperations" class="offline-operations" aria-labelledby="offlineOperationsTitle">
        <div id="offlineReadiness" class="readiness-popover" tabindex="-1">
        <div class="offline-heading">
          <div>
            <p class="section-label">Offline readiness</p>
            <h3 id="offlineOperationsTitle">Offline response workspace</h3>
            <p class="muted">Readiness is based on prepared map data, protected incident access, a complete snapshot, and pending responder updates.</p>
          </div>
          <div class="offline-actions">
            <button id="prepareMapButton" type="button" class="secondary">Prepare Tagum offline map</button>
            <button id="offlineDiscardButton" type="button" class="danger-outline" hidden>Discard pending offline updates</button>
          </div>
        </div>
        <div class="readiness-grid" aria-live="polite">
          <div class="readiness-item"><span>Map source</span><strong>Local vector map · no satellite imagery</strong></div>
          <div class="readiness-item"><span>Protected incident access</span><strong id="accessReadinessStatus">Checking…</strong></div>
          <div class="readiness-item"><span>Incident snapshot</span><strong id="snapshotReadinessStatus">Checking…</strong></div>
          <div class="readiness-item"><span>Offline responder updates</span><strong id="outboxReadinessStatus">Checking…</strong></div>
        </div>
        </div>
        <section id="incidentMapPanel" class="incident-map-panel" aria-labelledby="incidentMapTitle" tabindex="-1">
          <div class="map-heading">
            <div>
              <p class="section-label">Incident map</p>
              <h4 id="incidentMapTitle">Prepared local coverage</h4>
            </div>
            <span id="mapCoverage" class="muted">Checking local map package…</span>
          </div>
          <div class="map-stage">
            <div id="incidentMapCanvas" class="incident-map-canvas" role="region" aria-label="Interactive incident map"></div>
            <div id="incidentMapPlaceholder" class="map-placeholder">Checking local map package…</div>
            <div id="mapFocusStatus" class="map-focus-status" hidden>
              <span>Viewing incident location</span>
              <strong id="mapFocusTitle">Emergency incident</strong>
              <span id="mapFocusLocation">Location unavailable</span>
            </div>
            <button id="exitMapFocusButton" type="button" class="map-focus-exit" hidden>Back to incident details</button>
          </div>
          <p id="mapAnnouncement" class="sr-only" aria-live="polite"></p>
          <p class="map-package-status"><span class="map-package-dot" aria-hidden="true"></span><strong id="mapReadinessStatus">Checking…</strong></p>
          <p class="map-accessibility-note">The incident queue remains the primary keyboard and screen-reader workspace. The map is a supplemental spatial view.</p>
          <p class="map-attribution">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · package by <a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a>. ODbL.</p>
        </section>
      </section>

      <div class="workspace">
        <section class="incident-column" tabindex="-1" aria-labelledby="incidentListTitle">
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

        <section id="detailPanel" class="detail-panel" tabindex="-1" aria-labelledby="detailTitle">
          <div id="detailPlaceholder" class="detail-placeholder">
            <span class="placeholder-mark" aria-hidden="true">+</span>
            <strong>Select an incident</strong>
            <span>Location evidence, accepted revisions, and persisted responder actions will appear here.</span>
          </div>

          <div id="detailContent" class="hidden" data-view="overview">
            <div class="detail-heading">
              <div>
                <p class="eyebrow">Incident detail</p>
                <h3 id="detailTitle">Incident</h3>
                <p id="detailSubtitle" class="detail-subtitle"></p>
              </div>
              <span id="detailStatus" class="status-pill">Pending</span>
              <button id="mobileResponseButton" class="mobile-response-button" type="button">Update status ↗</button>
            </div>

            <div class="detail-tabs" role="tablist" aria-label="Incident information">
              <button id="overviewTab" role="tab" aria-selected="true" aria-controls="overviewSection" data-detail-view="overview" type="button">Overview</button>
              <button id="responseTab" role="tab" aria-selected="false" aria-controls="ackForm" data-detail-view="response" type="button" tabindex="-1">Response</button>
              <button id="historyTab" role="tab" aria-selected="false" aria-controls="historySection" data-detail-view="history" type="button" tabindex="-1">History</button>
            </div>
            <div id="overviewSection" role="tabpanel" aria-labelledby="overviewTab">
            <div id="urgencyBanner" class="urgency-banner hidden" role="status">
              <strong>Immediate danger</strong>
              <span>Latest server-accepted classification</span>
            </div>

            <dl id="detailFacts" class="facts"></dl>

            <div id="locationCard" class="location-card hidden">
              <div class="location-copy">
                <span class="section-label">Location evidence</span>
                <strong>Best available location</strong>
                <span id="locationText" class="location-coordinates"></span>
                <span id="locationMeta" class="muted"></span>
                <span id="locationCaptured" class="muted"></span>
              </div>
              <button id="mapLink" type="button" class="map-link">Show on offline map</button>
            </div>

            </div>
            <form id="ackForm" role="tabpanel" aria-labelledby="responseTab" class="ack-form" method="post" novalidate>
              <div class="form-heading">
                <p class="section-label">Response update</p>
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

            <div id="historySection" role="tabpanel" aria-labelledby="historyTab">
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
            <div class="detail-footer"><button id="detailResponseButton" type="button">Update responder status <span aria-hidden="true">↗</span></button></div>
          </div>
        </section>
      </div>
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
  font-family: Bahnschrift, "Segoe UI", Arial, sans-serif;
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
.offline-actions { display: flex; flex-wrap: wrap; gap: 0.55rem; align-items: center; justify-content: flex-end; }
.offline-actions button { min-block-size: 3rem; }

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

.map-stage > .incident-map-canvas.maplibregl-map,
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
.map-accessibility-note,
.map-attribution { margin: 0; color: var(--ink-soft); font-size: 0.78rem; }
.map-attribution a { color: var(--navy-800); font-weight: 750; }

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
  .offline-actions { justify-content: flex-start; }
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
  color: var(--navy-800);
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
.civilian-message {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

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


/* Reference-aligned operations shell. One responsive layout, real incident data. */
@media screen {
  :root { font-family: "Segoe UI", Arial, sans-serif; --navy-950:#071d32; --navy-900:#082b47; --navy-800:#10456c; --navy-700:#0766d8; --ink:#102b45; --ink-soft:#506780; --ink-faint:#66798c; --line:#dce5ec; --red-700:#e32735; --red-800:#b71828; --green-800:#087c51; }
  body { font-family:"Segoe UI",Arial,sans-serif; background:#e9eef2; }
  button,input,select,textarea { font-family:inherit; }
  button:focus-visible,a:focus-visible { outline:3px solid #0878ff; outline-offset:3px; }
  .topbar { border-bottom:1px solid #234b68; height:66px; min-block-size:66px; padding:10px 24px 10px 88px; background:linear-gradient(110deg,#103b5d,#06243d); box-shadow:none; }
  .brand-mark { width:44px; height:44px; }
  .brand-copy strong { font-size:19px; letter-spacing:.055em; }
  .brand-copy span { font-size:13px; color:#e5eef5; }
  .topbar-status { gap:20px; }
  .responder-identity { padding-right:18px; border-right:1px solid #ffffff30; font-size:13px; }
  .responder-identity span:last-child,.connection { font-size:12px; }
  main { width:100%; max-width:none; padding:0; }
  .auth-shell { margin:40px auto; max-width:1080px; }
  .console { position:relative; display:block; margin-left:72px; min-height:calc(100dvh - 66px); background:#e7eeeb; }
  .console-rail { position:fixed; z-index:45; left:0; top:66px; bottom:0; width:72px; padding:14px 6px; display:flex; flex-direction:column; gap:10px; background:linear-gradient(#0d304c,#061e30); }
  .console-rail::before { content:""; position:absolute; left:0; top:-66px; width:72px; height:66px; display:grid; place-items:center; border-right:1px solid #ffffff25; color:#fff; font-size:30px; font-weight:300; }
  .console-rail button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; min-height:72px; padding:10px 2px; border:0; border-radius:6px; background:transparent; color:#e5edf5; font-size:11px; box-shadow:none; }
  .console-rail button:hover { background:#ffffff12; }
  .console-rail button[aria-pressed="true"],.console-rail button[aria-expanded="true"] { background:#164e7b; box-shadow:inset 3px 0 #087bff; color:#fff; }
  .console-rail svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .rail-caption { margin-top:auto; color:#9bb3c6; font-size:9px; letter-spacing:.14em; text-align:center; padding-bottom:14px; }
  .toolbar { position:absolute; z-index:21; top:18px; right:20px; width:340px; min-height:0; padding:12px 14px; border:1px solid #d5e0e8; border-radius:12px; background:#fff; box-shadow:0 6px 22px #102b4520; gap:12px; }
  .toolbar-copy { min-width:0; }
  .toolbar-copy h2 { font-size:17px; margin:0 0 4px; letter-spacing:-.02em; }
  .toolbar-copy .eyebrow { display:none; }
  .queue-meta { gap:3px; font-size:10px; color:var(--ink-soft); }
  .queue-meta #sessionExpiry,.queue-meta > span[aria-hidden] { display:none; }
  .queue-meta { display:flex; flex-direction:column; align-items:flex-start; }
  .toolbar-actions { gap:6px; }
  .toolbar-actions button { min-height:36px; padding:7px 9px; font-size:11px; border-radius:6px; }
  .toolbar-actions .control-field { display:none; }
  .stats-grid { position:absolute; z-index:20; top:18px; left:20px; width:calc(100% - 400px); max-width:940px; margin:0; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; pointer-events:none; }
  .stat-card { position:relative; min-height:104px; padding:14px 12px 12px 66px; display:grid; grid-template-columns:1fr; grid-template-rows:auto 1fr auto; gap:2px; border:1px solid #d8e0e7; border-radius:12px; background:#fff; box-shadow:0 5px 18px #102b4522; pointer-events:auto; }
  .stat-icon { position:absolute; top:15px; left:14px; display:grid; place-items:center; width:40px; height:46px; border-radius:10px; background:#e92937; color:#fff; font-size:28px; font-weight:800; }
  .stat-card:nth-child(2) .stat-icon { background:#c62031; }
  .stat-card:nth-child(3) .stat-icon { background:#fa7521; }
  .stat-card:nth-child(4) .stat-icon { background:#099362; }
  .stat-label { color:var(--ink); font-size:13px; font-weight:700; letter-spacing:0; text-transform:none; line-height:1.25; }
  .stat-card strong { color:var(--navy-950); font-size:32px; line-height:1.05; font-weight:750; font-variant-numeric:tabular-nums; }
  .stat-card > span:last-child { font-size:11px; color:var(--ink-soft); line-height:1.3; }
  .stat-critical { border-left:1px solid #d8e0e7; }
  .operations-stage,.offline-operations { position:relative; min-height:calc(100dvh - 66px); padding:0; border:0; border-radius:0; background:transparent; box-shadow:none; }
  .operations-stage { overflow:hidden; }
  .readiness-popover { position:absolute; z-index:34; top:136px; left:20px; width:340px; max-height:calc(100dvh - 230px); overflow:auto; border:1px solid var(--line); border-radius:12px; background:#fff; box-shadow:0 10px 30px #102b4526; }
  .readiness-popover > .offline-heading,.readiness-popover > .readiness-grid { position:static; width:auto; margin:0; border:0; box-shadow:none; }
  .console:not(.readiness-open) .readiness-popover { display:none; }
  .console.map-focus-mode .readiness-popover { visibility:hidden; }
  .offline-heading { position:absolute; z-index:34; top:136px; left:20px; width:340px; padding:16px; border:1px solid var(--line); border-radius:12px 12px 0 0; background:#fff; box-shadow:0 10px 30px #102b4526; flex-direction:column; align-items:stretch; gap:12px; }
  .offline-heading .section-label { display:none; }
  .offline-heading h3 { font-size:18px; margin:0 0 6px; }
  .offline-heading .muted { display:block; font-size:12px; line-height:1.5; margin:0; }
  .offline-actions { display:flex; flex-wrap:wrap; }
  .offline-actions button { min-height:42px; font-size:12px; }
  .readiness-grid { position:absolute; z-index:34; top:310px; left:20px; width:340px; padding:12px; gap:0; display:grid; grid-template-columns:1fr; border:1px solid var(--line); border-top:0; border-radius:0 0 12px 12px; background:#fff; box-shadow:0 14px 26px #102b4520; }
  .readiness-item { padding:10px 4px; border:0; border-top:1px solid #e5ecf1; border-radius:0; background:#fff; }
  .readiness-item span { font-size:11px; color:var(--ink-soft); }
  .readiness-item strong { font-size:12px; margin-top:4px; color:var(--ink); }
  .console:not(.readiness-open) .offline-heading,.console:not(.readiness-open) .readiness-grid { display:none; }
  .incident-map-panel { scroll-margin-top:76px; position:relative; padding:0; border:0; border-radius:0; background:transparent; }
  .map-heading { display:none; }
  .map-stage { position:relative; min-height:calc(100dvh - 66px); border:0; border-radius:0; background:#e5ece8; }
  .incident-map-canvas { z-index:1; }
  .incident-map-canvas .maplibregl-canvas-container,.incident-map-canvas .maplibregl-canvas { width:100%!important; height:100%!important; }
  .map-placeholder { max-width:360px; padding:24px; border:1px solid var(--line); border-radius:12px; background:#fff; font-size:14px; line-height:1.6; box-shadow:0 8px 30px #102b4518; }
  .map-package-status { position:absolute; z-index:14; bottom:10px; left:20px; max-width:330px; margin:0; padding:8px 11px; display:flex; align-items:center; gap:7px; border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--ink-soft); font-size:10px; box-shadow:0 3px 12px #102b4512; }
  .map-package-dot { width:6px; height:6px; border-radius:50%; background:#71879a; flex-shrink:0; }
  .map-attribution { position:absolute; z-index:14; bottom:0; right:0; margin:0; padding:3px 6px; background:#ffffffed; font-size:10px; color:var(--ink-soft); }
  .map-accessibility-note { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); }
  .workspace { position:absolute; z-index:15; inset:142px 20px 52px; display:grid; grid-template-columns:minmax(290px,370px) minmax(20px,1fr) minmax(330px,400px); align-items:stretch; gap:24px; padding:0; pointer-events:none; }
  .incident-column,.detail-panel { scroll-margin-top:76px; pointer-events:auto; min-width:0; border:1px solid #d6e1e9; border-radius:13px; background:#fff; box-shadow:0 10px 30px #102b4526; scrollbar-width:thin; scrollbar-color:#b4c3ce transparent; }
  .incident-column { position:relative; top:auto; grid-column:1; align-self:end; margin:0; max-height:min(460px,100%); overflow:auto; }
  .console.queue-expanded .incident-column { align-self:stretch; max-height:none; }
  .panel-header { gap:10px; padding:12px 12px 10px; min-height:0; align-items:center; border-radius:13px 13px 0 0; background:#fff; }
  .panel-header .section-label { display:none; }
  .panel-header > div:first-child { min-width:0; }
  .panel-header h3 { font-size:18px; letter-spacing:-.02em; }
  .panel-header > span { display:none; }
  .queue-controls { position:static; flex:0 1 145px; min-width:0; width:42%; max-width:145px; padding:0; background:#fff; }
  .queue-controls label { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); }
  .queue-controls .control-field { min-inline-size:0; }
  .queue-controls select { min-height:40px; width:100%; font-size:12px; border-radius:7px; }
  .incident-list { gap:0; padding:0 8px 8px; }
  .incident-card { position:relative; content-visibility:visible; contain-intrinsic-size:none; min-height:80px; padding:10px 24px 9px 54px; border:0; border-bottom:1px solid #e7edf2; border-left:4px solid #a9c6e4; border-radius:5px; box-shadow:none; background:#fff; }
  .incident-card::before { content:"+"; position:absolute; top:16px; left:10px; width:32px; height:32px; display:grid; place-items:center; border-radius:50%; background:#eaf3fc; color:#1667b4; font-size:21px; font-weight:700; }
  .incident-card.immediate { border-left-color:#ed2434; }
  .incident-card.immediate::before { content:"!"; color:#fff; background:#e22b37; }
  .incident-card::after { content:"›"; position:absolute; right:10px; top:44px; color:#315d82; font-size:23px; }
  .incident-card:hover { background:#f5f9fc; }
  .incident-card.selected,.incident-card[aria-current="true"] { background:#ecf4fc; box-shadow:none; }
  .incident-card.immediate.selected,.incident-card.immediate[aria-current="true"] { background:#fff0f1; box-shadow:none; }
  .incident-type { font-size:15px; color:var(--ink); letter-spacing:0; }
  .incident-type.urgent { color:#bc1828; }
  .incident-top { gap:6px; align-items:start; }
  .status-pill { padding:3px 8px; min-height:0; font-size:10px; white-space:nowrap; }
  .incident-meta { margin-top:5px; font-size:11px; gap:4px; }
  .incident-meta > span:first-child { display:none; }
  .incident-location { font-size:12px; margin-top:4px; font-weight:400; color:var(--ink-soft); }
  .incident-responder { display:none; }
  .incident-report-id { display:none; }
  .detail-panel { grid-column:3; margin:0; padding:0; min-height:0; max-height:100%; overflow:auto; }
  .detail-placeholder { min-height:270px; padding:24px; }
  .detail-panel:has(#detailContent.hidden) { align-self:start; }
  #detailContent { min-height:100%; display:flex; flex-direction:column; }
  #detailContent.hidden { display:none; }
  .detail-heading { position:relative; top:auto; z-index:4; padding:14px 18px 8px 68px; margin:0; display:block; border:0; background:#fff; }
  .detail-heading:has(.status-pill.pending)::before { background:#e32735; }
  .detail-heading::before { content:"!"; position:absolute; top:17px; left:18px; width:38px; height:44px; display:grid; place-items:center; border-radius:9px; color:#fff; background:#173f60; font-size:26px; font-weight:750; }
  .detail-heading .eyebrow { font-size:10px; letter-spacing:.04em; color:var(--ink-soft); }
  .detail-heading h3 { font-size:21px; line-height:1.2; letter-spacing:-.025em; margin:3px 0 5px; }
  .detail-subtitle { font-size:10px; margin:0 0 6px; color:var(--ink-soft); }
  .detail-tabs { position:relative; top:auto; z-index:3; display:flex; padding:0 16px; border-bottom:1px solid var(--line); background:#fff; }
  .detail-tabs button { flex:1; min-height:40px; padding:10px 4px; border:0; border-bottom:3px solid transparent; border-radius:0; background:#fff; color:var(--ink-soft); font-size:12px; font-weight:600; }
  .detail-tabs button[aria-selected="true"] { color:#0068e6; border-bottom-color:#087bff; }
  #overviewSection,#historySection { padding:0 18px 16px; }
  #detailContent[data-view="overview"] #ackForm,#detailContent[data-view="overview"] #historySection,
  #detailContent[data-view="response"] #overviewSection,#detailContent[data-view="response"] #historySection,
  #detailContent[data-view="history"] #overviewSection,#detailContent[data-view="history"] #ackForm { display:none; }
  .urgency-banner { margin:10px 0 0; padding:7px 10px; border:1px solid #f3cdd1; border-radius:7px; display:block; background:#fff4f5; }
  .urgency-banner strong { font-size:12px; }
  .urgency-banner span { display:block; margin-top:2px; font-size:10px; color:#895560; }
  .detail-panel .facts { display:block; margin:12px 0; }
  .detail-panel .fact { display:grid; grid-template-columns:minmax(90px,.75fr) minmax(0,1.3fr); align-items:center; gap:12px; padding:8px 0; border:0; border-bottom:1px solid #e3eaf0; border-radius:0; background:transparent; }
  .detail-panel .fact dt { font-size:12px; text-transform:none; letter-spacing:0; color:var(--ink-soft); }
  .detail-panel .fact dd { margin:0; font-size:13px; font-weight:500; line-height:1.5; overflow-wrap:anywhere; }
  .detail-panel .fact:has(.civilian-message) { grid-template-columns:1fr; gap:7px; }
  .detail-panel .fact:has(.civilian-message) dt { font-size:12px; font-weight:700; color:var(--ink); }
  .location-card { margin:16px 0 0; padding:14px; border:1px solid #d9e5ee; border-radius:8px; flex-direction:column; align-items:stretch; background:#f4f8fc; }
  .location-copy .section-label { display:none; }
  .location-copy strong { font-size:12px; }
  .location-coordinates,.location-copy .muted { font-size:11px; }
  .map-link { min-height:40px; align-self:stretch; border-radius:6px; background:#fff; font-size:12px; }
  .detail-panel .ack-form { padding:16px 18px; margin:0; border:0; border-radius:0; background:#fff; }
  .form-heading h4 { font-size:16px; }
  .form-heading .section-label { display:none; }
  .form-heading .muted { font-size:11px; line-height:1.6; }
  .detail-panel .ack-fields { display:block; }
  .detail-panel .form-field { margin:16px 0; }
  .detail-panel .form-field label { font-size:12px; }
  .detail-panel select,.detail-panel textarea { font-size:13px; min-height:44px; border-radius:7px; }
  .detail-panel .ack-actions { flex-direction:column; align-items:stretch; }
  .detail-panel .ack-actions button { font-size:12px; min-height:44px; }
  .mobile-response-button { display:none; }
  .detail-footer { position:sticky; bottom:0; z-index:4; margin-top:auto; padding:12px 18px; border-top:1px solid var(--line); background:#fff; }
  .detail-footer button { width:100%; min-height:44px; font-size:13px; background:#10476f; display:flex; justify-content:space-between; align-items:center; border-radius:7px; }
  #detailContent[data-view="response"] .detail-footer { display:none; }
  .history-section { margin-top:18px; padding-top:16px; }
  .section-heading { display:block; }
  .section-heading h4 { font-size:15px; }
  .section-heading span { font-size:10px; }
  .history { margin-left:5px; padding-left:14px; border-left:2px solid #d8e4ee; }
  .history-item { position:relative; padding:8px 0; border:0; background:#fff; }
  .history-item::before { content:""; position:absolute; left:-20px; top:15px; width:8px; height:8px; border:2px solid #fff; border-radius:50%; background:#0c72db; box-shadow:0 0 0 1px #b5cede; }
  .history-item strong { font-size:12px; }
  .history-item span { font-size:11px; line-height:1.5; }
  .maplibregl-ctrl-bottom-right { right:440px; bottom:54px; }
  .maplibregl-ctrl-bottom-left { left:410px; bottom:10px; }
  .maplibregl-ctrl-group { border:1px solid var(--line); border-radius:9px; overflow:hidden; box-shadow:0 4px 18px #102b4525; }
  .maplibregl-ctrl-group button { width:44px; height:44px; min-height:44px; padding:0; border-radius:0; }
  .maplibregl-ctrl-scale { color:var(--ink); background:#ffffffee; font-size:11px; }
  .map-marker { width:38px; height:38px; min-height:38px; border:3px solid #fff; background:#086edd; font-size:22px; box-shadow:0 3px 12px #173f6055; }
  .map-marker[data-urgency="IMMEDIATE_DANGER"] { background:#e32b3a; }
  .map-marker[data-selected="true"] { outline:7px solid #e52c3a36; outline-offset:3px; box-shadow:0 0 0 2px #fff,0 5px 20px #9c10264d; }
  .map-focus-status,.map-focus-exit { position:absolute; z-index:30; top:18px; border:1px solid var(--line); border-radius:10px; background:#fff; color:var(--ink); box-shadow:0 5px 22px #102b4530; }
  .map-focus-status { left:20px; display:grid; gap:3px; max-width:calc(100% - 230px); padding:14px 18px; }
  .map-focus-status[hidden] { display:none; }
  .map-focus-status > span { font-size:11px; color:var(--ink-soft); }
  .map-focus-status strong { font-size:16px; }
  .map-focus-exit { right:20px; min-height:44px; padding:10px 15px; font-size:12px; }
  .console.map-focus-mode .stats-grid,.console.map-focus-mode .toolbar,.console.map-focus-mode .offline-heading,.console.map-focus-mode .readiness-grid,.console.map-focus-mode .workspace { visibility:hidden; pointer-events:none; }
  .banner-error { position:absolute; z-index:38; top:128px; left:20px; right:20px; margin:0; }
  .prepare-map-shortcut { position:absolute; z-index:22; left:20px; top:130px; min-height:40px; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); font-size:12px; box-shadow:0 4px 16px #102b4520; }
  .console.map-focus-mode .prepare-map-shortcut { display:none; }
  .console.map-focus-mode .maplibregl-ctrl-bottom-right { right:8px; }
  .console.map-focus-mode .maplibregl-ctrl-bottom-left { left:20px; bottom:44px; }
}
@media screen and (max-width:1400px) and (min-width:1051px) {
  .stats-grid { width:calc(100% - 370px); max-width:none; }
  .stat-card { min-height:104px; padding-left:54px; }
  .stat-icon { left:10px; width:34px; }
  .stat-label { font-size:12px; }
  .toolbar { top:18px; width:310px; }
  .workspace { top:142px; grid-template-columns:320px minmax(0,1fr) 350px; gap:16px; }
  .incident-column { max-height:100%; }
  .prepare-map-shortcut { top:126px; }
  .maplibregl-ctrl-bottom-right { right:385px; }
  .maplibregl-ctrl-bottom-left { left:365px; }
}
@media screen and (max-width:1050px) {
  .topbar { position:sticky; top:0; padding-left:20px; }
  .console { margin-left:0; padding-top:0; }
  .console-rail { position:sticky; top:66px; right:0; bottom:auto; width:auto; height:58px; flex-direction:row; padding:5px 12px; gap:8px; }
  .console-rail::before,.rail-caption { display:none; }
  .console-rail button { flex-direction:row; min-height:48px; padding:6px 16px; font-size:12px; gap:9px; }
  .console-rail svg { width:20px; height:20px; }
  .toolbar { position:relative; top:auto; right:auto; width:auto; margin:12px; justify-content:space-between; }
  .stats-grid { position:relative; inset:auto; width:auto; max-width:none; margin:12px; gap:8px; }
  .stat-card { min-height:98px; padding-left:54px; }
  .stat-icon { left:10px; width:34px; height:40px; }
  .operations-stage { min-height:0; overflow:visible; padding:0 12px 12px; }
  .offline-operations { min-height:0; }
  .map-stage { min-height:420px; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .workspace { position:relative; inset:auto; grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr); gap:12px; padding-top:12px; pointer-events:auto; }
  .incident-column { grid-column:1; max-height:620px; align-self:start; }
  .detail-panel { grid-column:2; max-height:760px; }
  .map-package-status { bottom:24px; left:12px; }
  .maplibregl-ctrl-bottom-right { right:0; bottom:28px; }
  .maplibregl-ctrl-bottom-left { left:0; bottom:58px; }
  .map-attribution { bottom:3px; right:3px; font-size:9px; }
  .prepare-map-shortcut { top:12px; left:12px; }
  .readiness-popover { position:fixed; top:136px; left:12px; width:320px; max-height:calc(100dvh - 150px); }
  .offline-heading { top:64px; left:12px; width:320px; }
  .readiness-grid { top:238px; left:12px; width:320px; }
  .console.map-focus-mode .map-stage { min-height:calc(100dvh - 160px); }
  .console.map-focus-mode .toolbar,.console.map-focus-mode .stats-grid,.console.map-focus-mode .workspace { display:none; }
  .banner-error { position:relative; inset:auto; margin:12px; }
}
@media screen and (max-width:650px) {
  .topbar { padding:10px 12px; height:66px; align-items:center; }
  .brand-mark { width:36px; height:36px; }
  .brand-copy strong { font-size:16px; }
  .brand-copy span { display:none; }
  .topbar-status { gap:8px; }
  .responder-identity { font-size:10px; padding-right:8px; }
  .responder-identity span:last-child { font-size:9px; }
  .connection { font-size:10px; }
  .stats-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .stat-card { min-height:95px; padding:12px 10px 10px 54px; }
  .stat-label { font-size:11px; }
  .stat-card strong { font-size:28px; }
  .stat-card > span:last-child { font-size:9px; }
  .workspace { grid-template-columns:1fr; }
  .incident-column,.detail-panel { grid-column:1; max-height:none; }
  .incident-column { max-height:410px; }
  .detail-panel,.incident-column,.incident-map-panel { scroll-margin-top:136px; }
  .mobile-response-button { display:inline-flex; margin-left:6px; min-height:30px; padding:5px 9px; border:1px solid #10476f; border-radius:5px; background:#10476f; color:#fff; font-size:11px; }
  .mobile-response-button:hover,.mobile-response-button:focus-visible { background:#082b47; color:#fff; }
  .detail-heading,.detail-tabs { position:relative; top:auto; }
  .detail-footer { bottom:0; }
  .map-stage { min-height:340px; }
  .toolbar { flex-direction:row; align-items:center; gap:8px; padding:12px; }
  .toolbar-actions { display:flex; flex-direction:column; gap:4px; }
  .toolbar-actions button { width:90px; min-height:32px; }
  .toolbar-copy h2 { font-size:16px; }
  .toolbar-actions button { font-size:10px; padding:7px; }
  .console-rail button { flex:1; padding:5px; }
  .map-focus-status { left:10px; top:10px; max-width:calc(100% - 20px); }
  .map-focus-exit { right:10px; top:auto; bottom:48px; }
  .readiness-grid,.offline-heading { width:calc(100% - 24px); }
  .readiness-popover { width:calc(100% - 24px); }
  .map-package-status { max-width:calc(100% - 24px); font-size:9px; }
  .auth-shell { margin:16px 12px; }
}
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; } }


/* Focused access gate. Scope all visual overrides to the signed-out state. */
body:has(#authPanel:not(.hidden)) { background:#fafbf9; font-family:"Segoe UI",Arial,sans-serif; color:#142f43; }
body:has(#authPanel:not(.hidden)) .topbar { position:relative; height:96px; padding:24px 48px; border-bottom:1px solid #e3e8e6; background:#fafbf9; color:#142f43; box-shadow:none; }
body:has(#authPanel:not(.hidden)) .brand { gap:12px; }
body:has(#authPanel:not(.hidden)) .brand-mark { width:44px; height:44px; }
body:has(#authPanel:not(.hidden)) .brand-copy strong { font-size:19px; letter-spacing:.1em; line-height:1.25; }
body:has(#authPanel:not(.hidden)) .brand-copy span { display:block; color:#60717c; font-size:12px; line-height:1.6; }
body:has(#authPanel:not(.hidden)) .topbar-status { display:none; }
body:has(#authPanel:not(.hidden)) .topbar::after { content:"Responder access"; color:#60717c; font-size:13px; letter-spacing:.01em; }
body:has(#authPanel:not(.hidden)) main { width:100%; padding:0; }
.auth-shell { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:calc(100svh - 96px); max-width:none; margin:0; padding:64px 24px 28px; border:0; border-radius:0; overflow:visible; box-shadow:none; background:transparent; }
.auth-card { width:100%; max-width:408px; padding:0; margin:auto 0; align-self:auto; }
.auth-accent { display:block; width:32px; height:4px; margin-bottom:24px; border-radius:2px; background:#c9302c; }
.auth-card h2 { margin:0; font-size:36px; line-height:1.2; font-weight:650; letter-spacing:-1.15px; color:#142f43; }
.auth-intro { margin:16px 0 36px; color:#61727c; font-size:16px; line-height:1.6; }
.auth-card .form-field { margin:0 0 20px; }
.auth-card label { margin:0 0 8px; font-size:14px; font-weight:600; line-height:1.4; }
.auth-card .field-help { margin:0 0 14px; font-size:13px; line-height:1.6; color:#61727c; }
.token-control { position:relative; }
.auth-card input { min-height:54px; padding:13px 72px 13px 16px; border:1px solid #7b8f9a; border-radius:8px; color:#142f43; background:#fff; font-size:16px; line-height:1.5; }
.auth-card input:hover { border-color:#708995; }
.auth-card input:focus-visible { outline:3px solid #0f4c8140; outline-offset:3px; border-color:#0f4c81; }
.auth-card input[aria-invalid="true"] { border-color:#b12a29; box-shadow:0 0 0 1px #b12a29; }
.auth-card .token-visibility { position:absolute; right:5px; top:5px; min-width:60px; min-height:44px; padding:0 9px; border:0; border-radius:5px; font-size:13px; font-weight:600; color:#345367; background:transparent; }
.auth-card .token-visibility:hover { background:#eef3f4; }
.auth-card button:focus-visible { outline:3px solid #0f4c81; outline-offset:3px; }
.auth-card #connectButton { display:block; width:100%; min-height:54px; border-radius:8px; background:#143d58; font-size:15px; font-weight:600; letter-spacing:.01em; box-shadow:0 2px 3px #142f4310; }
.auth-card #connectButton:hover { background:#0b2c43; }
.auth-card #connectButton:disabled { opacity:1; background:#687e8c; cursor:wait; }
.auth-card .error { margin:12px 0 0; min-height:0; font-size:13px; font-weight:500; line-height:1.65; color:#a52625; overflow-wrap:anywhere; }
.auth-card .error:empty { margin:0; }
.auth-security { display:flex; align-items:flex-start; gap:12px; margin-top:25px; padding-top:24px; border-top:1px solid #dfe6e6; color:#556d7b; }
.auth-security svg { width:18px; height:18px; flex:none; margin-top:3px; }
.auth-security p { margin:0; font-size:13px; line-height:1.7; }
.auth-security span { color:#61727c; }
.auth-footer { margin:64px 0 0; color:#61727c; font-size:12px; line-height:1.6; text-align:center; }
@media screen and (max-width:650px) {
  body:has(#authPanel:not(.hidden)) .topbar { height:88px; min-height:88px; padding:20px 24px; }
  body:has(#authPanel:not(.hidden)) .topbar::after { content:none; }
  body:has(#authPanel:not(.hidden)) .brand-mark { width:40px; height:40px; }
  .auth-shell { min-height:calc(100svh - 88px); margin:0; padding:32px 24px 24px; }
  .auth-accent { margin-bottom:20px; }
  .auth-security { margin-top:24px; padding-top:20px; }
  .auth-card h2 { font-size:32px; letter-spacing:-.8px; }
  .auth-intro { margin-top:14px; margin-bottom:28px; }
  .auth-footer { margin-top:48px; }
}
@media screen and (max-width:360px) {
  body:has(#authPanel:not(.hidden)) .topbar { padding-inline:20px; }
  .auth-shell { padding-inline:20px; }
  .auth-card h2 { font-size:30px; }
}
@media (prefers-reduced-motion:reduce) { .auth-card button { transition:none; } }

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
  let loadedReportId = null;
  let detailRequestVersion = 0;
  let acknowledgementPending = false;
  let sessionGeneration = 0;
  let refreshRequestVersion = 0;
  const responseDrafts = new Map();
  let refreshTimer = null;
  let latestIncidents = [];
  let offlineDetails = new Map();
  let activeOfflineSnapshot = null;
  let dataSource = 'online';

  const authPanel = document.getElementById('authPanel');
  const consolePanel = document.getElementById('consolePanel');
  const authForm = document.getElementById('authForm');
  const tokenInput = document.getElementById('tokenInput');
  const tokenVisibility = document.getElementById('tokenVisibility');
  function maskToken() {
    tokenInput.type = 'password';
    tokenVisibility.textContent = 'Show';
    tokenVisibility.setAttribute('aria-label', 'Show responder token');
    tokenVisibility.setAttribute('aria-pressed', 'false');
  }
  tokenVisibility.addEventListener('click', () => {
    const reveal = tokenInput.type === 'password';
    tokenInput.type = reveal ? 'text' : 'password';
    tokenVisibility.textContent = reveal ? 'Hide' : 'Show';
    tokenVisibility.setAttribute('aria-label', reveal ? 'Hide responder token' : 'Show responder token');
    tokenVisibility.setAttribute('aria-pressed', String(reveal));
  }, {signal: lifecycle.signal});
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

  // View controls only reorganize the existing operations; API state stays authoritative.
  const mapViewButton = document.getElementById('mapViewButton');
  const queueViewButton = document.getElementById('queueViewButton');
  const readinessButton = document.getElementById('readinessButton');
  const queueControls = document.createElement('div');
  queueControls.className = 'queue-controls';
  queueControls.append(statusFilter.parentElement);
  document.querySelector('.panel-header').append(queueControls);
  const prepareMapShortcut = document.createElement('button');
  prepareMapShortcut.type = 'button';
  prepareMapShortcut.className = 'prepare-map-shortcut';
  prepareMapShortcut.textContent = 'Prepare Tagum offline map';
  prepareMapShortcut.addEventListener('click', () => {
    document.getElementById('prepareMapButton').click();
  }, {signal: lifecycle.signal});
  document.querySelector('.offline-operations').append(prepareMapShortcut);
  const mapStatus = document.getElementById('mapReadinessStatus');
  const syncMapShortcut = () => {
    prepareMapShortcut.hidden = mapStatus.textContent.startsWith('Ready') || consolePanel.classList.contains('readiness-open');
  };
  new MutationObserver(syncMapShortcut).observe(mapStatus, {childList:true, subtree:true, characterData:true});
  syncMapShortcut();

  function leaveMapFocus() {
    if (consolePanel.classList.contains('map-focus-mode')) document.getElementById('exitMapFocusButton').click();
  }
  function setQueueView(expanded) {
    if (expanded) leaveMapFocus();
    consolePanel.classList.toggle('queue-expanded', expanded);
    mapViewButton.setAttribute('aria-pressed', String(!expanded));
    queueViewButton.setAttribute('aria-pressed', String(expanded));
    if (expanded && window.innerWidth <= 1050) {
      const queue = document.querySelector('.incident-column');
      queue.scrollIntoView({block:'start'});
      queue.focus({preventScroll:true});
    }
  }
  mapViewButton.addEventListener('click', () => {
    setQueueView(false);
    if (window.innerWidth <= 1050) {
      const mapPanel = document.getElementById('incidentMapPanel');
      mapPanel.scrollIntoView({block:'start'});
      mapPanel.focus({preventScroll:true});
    }
  }, {signal:lifecycle.signal});
  queueViewButton.addEventListener('click', () => setQueueView(true), {signal:lifecycle.signal});
  readinessButton.addEventListener('click', () => {
    leaveMapFocus();
    const open = consolePanel.classList.toggle('readiness-open');
    readinessButton.setAttribute('aria-expanded', String(open));
    syncMapShortcut();
    if (open) document.getElementById('offlineReadiness').focus({preventScroll:true});
  }, {signal:lifecycle.signal});
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && consolePanel.classList.contains('readiness-open')) {
      consolePanel.classList.remove('readiness-open');
      readinessButton.setAttribute('aria-expanded','false');
      syncMapShortcut();
      readinessButton.focus();
    }
  }, {signal:lifecycle.signal});

  const detailTabs = Array.from(document.querySelectorAll('[data-detail-view]'));
  function setDetailView(view, focusTab) {
    detailContent.dataset.view = view;
    detailTabs.forEach(tab => {
      const selected = tab.dataset.detailView === view;
      tab.setAttribute('aria-selected',String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) tab.focus();
    });
    document.getElementById('detailPanel').scrollTop = 0;
  }
  detailTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => setDetailView(tab.dataset.detailView, false), {signal:lifecycle.signal});
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + detailTabs.length) % detailTabs.length;
      setDetailView(detailTabs[next].dataset.detailView,true);
    }, {signal:lifecycle.signal});
  });
  document.getElementById('mobileResponseButton').addEventListener('click', () => {
    setDetailView('response',false);
    ackStatus.focus();
  }, {signal:lifecycle.signal});
  document.getElementById('detailResponseButton').addEventListener('click', () => {
    setDetailView('response',false);
    ackStatus.focus();
  }, {signal:lifecycle.signal});

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
    return !value || value === 'UNSPECIFIED' ? 'Not specified' : formatWords(value, 'UNSPECIFIED');
  }

  function formatUrgency(value) {
    if (value === 'IMMEDIATE_DANGER') return 'Immediate danger';
    if (value === 'NEED_ASSISTANCE' || value === 'NEEDS_ASSISTANCE') return 'Needs assistance';
    return 'Not specified';
  }

  function incidentTitle(incident, suffix) {
    if (!incident.emergencyType || incident.emergencyType === 'UNSPECIFIED') {
      return (!incident.urgency || incident.urgency === 'UNSPECIFIED') && !incident.message
        ? 'SOS · details not provided' : 'SOS · category not specified';
    }
    return formatEmergencyType(incident.emergencyType) + suffix;
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
    const generation = sessionGeneration;
    const response = await fetch(
      path,
      Object.assign({credentials: 'same-origin'}, options || {})
    );
    if (response.status === 401) {
      if (generation === sessionGeneration && dataSource === 'online') showLoggedOut('Your responder session expired or was revoked. Paste your provisioned token to reconnect.');
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

  function showDetailPlaceholder(title, message) {
    loadedReportId = null;
    detailContent.classList.add('hidden');
    detailPlaceholder.classList.remove('hidden');
    detailPlaceholder.querySelector('strong').textContent = title;
    detailPlaceholder.querySelector('span:last-child').textContent = message;
    ackButton.disabled = true;
  }

  function resetDetail() {
    selectedReportId = null;
    detailRequestVersion++;
    showDetailPlaceholder('Select an incident', 'Location evidence, accepted revisions, and persisted responder actions will appear here.');
    ackNote.value = '';
    ackResult.textContent = '';
  }

  function showLoggedOut(message) {
    sessionGeneration++;
    refreshRequestVersion++;
    acknowledgementPending = false;
    currentResponder = null;
    responseDrafts.clear();
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
    maskToken();
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
    ackResult.textContent = '';
    ackNote.value = '';
    showDetailPlaceholder('Loading incident…', 'Responder actions are unavailable until this incident is loaded.');
    Array.from(incidentList.children).forEach((item) => {
      const selected = item.dataset.reportId === reportId;
      item.classList.toggle('selected', selected);
      if (selected) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    });
    publishDashboardState();
    setDetailView('overview',false);
    void loadDetail(reportId).then(() => {
      if (reportId === selectedReportId && window.innerWidth <= 650) {
        const panel = document.getElementById('detailPanel');
        panel.scrollIntoView({block:'start'});
        panel.focus({preventScroll:true});
      }
    });
  }

  function snapshotEntryToIncident(entry) {
    return {
      reportId: entry.reportId,
      emergencyType: entry.emergencyType,
      message: typeof entry.message === 'string' ? entry.message : null,
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
    refreshRequestVersion++;
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
    card.dataset.reportId = incident.reportId;
    if (incident.urgency === 'IMMEDIATE_DANGER') card.classList.add('immediate');

    if (incident.reportId === selectedReportId) {
      card.classList.add('selected');
      card.setAttribute('aria-current', 'true');
    }

    const status = statusLabel(incident);
    const urgency = formatUrgency(incident.urgency);
    card.setAttribute(
      'aria-label',
      incidentTitle(incident, ' incident') + ', ' + urgency + ', ' + formatStatus(status) + ', report ' + shortReportId(incident.reportId) + ', received ' + formatRelative(incident.firstReceivedAt)
    );

    const top = document.createElement('div');
    top.className = 'incident-top';
    const type = createText(
      'span',
      'incident-type' + (incident.urgency === 'IMMEDIATE_DANGER' ? ' urgent' : ''),
      incidentTitle(incident, '')
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
    const focusedCard = document.activeElement && document.activeElement.closest('.incident-card');
    const focusedReportId = focusedCard && incidentList.contains(focusedCard) ? focusedCard.dataset.reportId : null;
    latestIncidents = incidents;
    incidentList.replaceChildren();
    emptyState.classList.toggle('hidden', incidents.length !== 0);
    incidentCount.textContent = incidents.length + (incidents.length === 1 ? ' incident loaded' : ' incidents loaded');
    queueScope.textContent = incidents.length >= 100 ? 'Newest 100 shown' : 'All matching incidents shown';
    incidents.forEach((incident) => incidentList.appendChild(makeIncidentCard(incident)));
    if (focusedReportId) {
      const replacement = Array.from(incidentList.children).find(card => card.dataset.reportId === focusedReportId);
      if (replacement) replacement.focus({preventScroll:true});
    }
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

  function addFact(label, value, className) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fact';
    wrapper.append(
      createText('dt', '', label),
      createText('dd', className || '', value)
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
      const urgency = formatUrgency(revision.urgency);
      item.append(
        createText('strong', '', 'Revision ' + revision.revision + ' · ' + formatEmergencyType(revision.emergencyType)),
        createText('span', '', urgency)
      );
      if (typeof revision.message === 'string' && revision.message.length > 0) {
        item.append(
          createText('strong', '', 'Civilian message'),
          createText('span', 'civilian-message', revision.message)
        );
      }

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
    detailTitle.textContent = incidentTitle(detail, ' emergency');
    detailSubtitle.textContent = 'Server accepted ' + formatRelative(detail.firstReceivedAt) + ' · Revision ' + detail.latestRevision;

    const status = statusLabel(detail);
    detailStatus.textContent = formatStatus(status);
    detailStatus.className = 'status-pill ' + statusClass(status);
    urgencyBanner.classList.toggle('hidden', detail.urgency !== 'IMMEDIATE_DANGER');

    detailFacts.replaceChildren();
    if (typeof detail.message === 'string' && detail.message.length > 0) {
      addFact('Civilian message', detail.message, 'civilian-message');
    }
    if (!detail.emergencyType || detail.emergencyType === 'UNSPECIFIED') addFact('Category', 'Not specified');
    if (detail.urgency !== 'IMMEDIATE_DANGER') addFact('Urgency', formatUrgency(detail.urgency));
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

    let draft = responseDrafts.get(detail.reportId);
    if (!draft) {
      const nextStatus = status === 'ACKNOWLEDGED' ? 'EN_ROUTE'
        : status === 'EN_ROUTE' ? 'ON_SCENE'
        : status === 'ON_SCENE' || status === 'RESOLVED' ? 'RESOLVED'
        : 'ACKNOWLEDGED';
      draft = {status: nextStatus, note: ''};
    }
    ackStatus.value = draft.status;
    ackNote.value = draft.note;
    loadedReportId = detail.reportId;
    ackButton.disabled = acknowledgementPending;
  }

  async function loadDetail(reportId) {
    const requestVersion = ++detailRequestVersion;
    try {
      showError('');
      const detail = dataSource === 'offline'
        ? offlineDetails.get(reportId)
        : await api('/v1/incidents/' + encodeURIComponent(reportId));
      if (reportId !== selectedReportId || requestVersion !== detailRequestVersion) return;
      if (!detail || detail.reportId !== reportId) throw new Error('DETAIL_NOT_AVAILABLE');
      renderDetail(detail);
    } catch (error) {
      if (reportId !== selectedReportId || requestVersion !== detailRequestVersion) return;
      if (String(error && error.message) !== 'UNAUTHORIZED') {
        showDetailPlaceholder('Incident detail unavailable', 'Select the incident again or refresh to retry. Responder actions remain unavailable.');
        showError('Could not load incident detail. The server retains the incident; retry when connectivity returns.');
      }
    }
  }

  async function refreshIncidents(showLoading) {
    if (!currentResponder) return;
    const responderAtStart = currentResponder;
    const generation = sessionGeneration;
    const requestVersion = ++refreshRequestVersion;
    const requestedFilter = statusFilter.value;
    const isCurrentRefresh = () => currentResponder === responderAtStart && generation === sessionGeneration && requestVersion === refreshRequestVersion && statusFilter.value === requestedFilter;

    try {
      if (showLoading) lastUpdated.textContent = 'Refreshing…';
      showError('');

      const query = requestedFilter
        ? '?limit=100&status=' + encodeURIComponent(requestedFilter)
        : '?limit=100';

      const results = await Promise.all([
        api('/v1/incidents/summary'),
        api('/v1/incidents' + query)
      ]);
      if (!isCurrentRefresh()) return;
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
      if (!isCurrentRefresh()) return;
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
    const generation = sessionGeneration;
    try {
      const response = await fetch('/v1/responder/session', {
        method: 'GET', credentials: 'same-origin'
      });
      if (generation !== sessionGeneration) return;
      if (response.status === 401) {
        if (dataSource !== 'offline') showLoggedOut('');
        return;
      }
      if (!response.ok) throw new Error(await parseError(response));
      const session = await response.json();
      if (generation !== sessionGeneration) return;
      currentResponder = session.responder;
      sessionExpiresAt = session.expiresAt;
      showConsole();
      await refreshIncidents(true);
    } catch (_) {
      if (generation === sessionGeneration && dataSource !== 'offline') {
        showLoggedOut('Could not confirm an existing responder session. Check connectivity, then reconnect with your provisioned token.');
      }
    }
  }

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (connectButton.disabled) return;
    authError.textContent = '';
    const candidate = tokenInput.value.trim();

    if (!candidate) {
      tokenInput.setAttribute('aria-invalid', 'true');
      authError.textContent = 'Paste your provisioned responder token.';
      tokenInput.focus();
      return;
    }

    const loginGeneration = ++sessionGeneration;
    tokenInput.removeAttribute('aria-invalid');
    connectButton.disabled = true;
    tokenVisibility.disabled = true;
    authForm.setAttribute('aria-busy', 'true');
    document.getElementById('authPending').textContent = 'Connecting to the responder console.';
    connectButton.textContent = 'Connecting…';

    try {
      const sessionPromise = startSession(candidate);
      tokenInput.value = '';
      maskToken();
      const session = await sessionPromise;
      if (loginGeneration !== sessionGeneration) return;
      currentResponder = session.responder;
      sessionExpiresAt = session.expiresAt;
      showConsole();
      await refreshIncidents(true);
    } catch (error) {
      const message = String(error && error.message);
      if (message === 'INVALID_TOKEN') {
        tokenInput.setAttribute('aria-invalid', 'true');
        authError.textContent = 'That responder token was not accepted. Copy the current token from the approved team secret store.';
      } else if (message === 'RATE_LIMITED') {
        authError.textContent = 'Too many connection attempts. Wait briefly before trying again.';
      } else {
        authError.textContent = 'Could not start the responder session. Check connectivity and retry.';
      }
      tokenInput.focus();
    } finally {
      maskToken();
      authForm.setAttribute('aria-busy', 'false');
      document.getElementById('authPending').textContent = '';
      tokenVisibility.disabled = false;
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
      const response = await fetch('/v1/responder/session', {method: 'DELETE', credentials: 'same-origin'});
      if (!response.ok) throw new Error('DISCONNECT_UNCONFIRMED');
      showLoggedOut('');
    } catch (_) {
      showError('Disconnect could not be confirmed. Your session may still be active; retry when connectivity returns.');
    }
  }, {signal: lifecycle.signal});

  statusFilter.addEventListener('change', () => {
    resetDetail();
    if (dataSource === 'offline' && activeOfflineSnapshot) renderOfflineSnapshot(activeOfflineSnapshot);
    else void refreshIncidents(true);
  }, {signal: lifecycle.signal});

  function rememberResponseDraft() {
    if (loadedReportId && loadedReportId === selectedReportId) {
      responseDrafts.set(loadedReportId, {status: ackStatus.value, note: ackNote.value});
    }
  }
  ackStatus.addEventListener('change', rememberResponseDraft, {signal: lifecycle.signal});
  ackNote.addEventListener('input', rememberResponseDraft, {signal: lifecycle.signal});

  ackForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedReportId || loadedReportId !== selectedReportId || acknowledgementPending) return;
    const generation = sessionGeneration;
    const reportId = loadedReportId;
    const submittedStatus = ackStatus.value;
    const submittedNote = ackNote.value;
    const isCurrentReport = () => generation === sessionGeneration && selectedReportId === reportId && loadedReportId === reportId;
    const clearSubmittedDraft = () => {
      if (generation !== sessionGeneration) return;
      const draft = responseDrafts.get(reportId);
      if (draft && draft.status === submittedStatus && draft.note === submittedNote) {
        responseDrafts.delete(reportId);
        if (isCurrentReport()) ackNote.value = '';
      }
    };
    acknowledgementPending = true;
    ackButton.disabled = true;
    ackResult.textContent = 'Saving…';
    try {
      if (dataSource === 'offline' && window.SagipOfflineConsole) {
        const queuedResult = await window.SagipOfflineConsole.queueStatus(
          reportId, submittedStatus, submittedNote.trim()
        );
        if (queuedResult && queuedResult.queued && queuedResult.queued.kind === 'SAVED_LOCAL') {
          const remaining = queuedResult.drain && Number(queuedResult.drain.remaining || 0);
          if (isCurrentReport()) ackResult.textContent = remaining === 0
            ? 'Saved locally and committed to the selected provider.'
            : 'Saved on this browser. Provider delivery is still pending.';
          clearSubmittedDraft();
        } else if (isCurrentReport()) {
          ackResult.textContent = queuedResult && queuedResult.kind === 'FULL'
            ? 'Offline update storage is full. Existing pending updates were preserved.'
            : 'The offline update could not be saved. Existing incident data was preserved.';
        }
        return;
      }
      const ack = await api('/v1/incidents/' + encodeURIComponent(reportId) + '/ack', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({status: submittedStatus, note: submittedNote.trim() || null})
      });
      if (isCurrentReport()) ackResult.textContent = 'Saved: ' + formatStatus(ack.status);
      clearSubmittedDraft();
      if (generation === sessionGeneration) await refreshIncidents(false);
    } catch (error) {
      if (isCurrentReport() && String(error && error.message) !== 'UNAUTHORIZED') {
        ackResult.textContent = 'Could not confirm the update. It may have been saved; refresh before retrying.';
      }
    } finally {
      if (generation === sessionGeneration) {
        acknowledgementPending = false;
        ackButton.disabled = !loadedReportId || loadedReportId !== selectedReportId;
      }
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
