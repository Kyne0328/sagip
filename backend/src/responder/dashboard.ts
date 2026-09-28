const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0c2942">
  <title>SAGIP Responder Console</title>
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
    <div class="connection" aria-live="polite">
      <span id="connectionDot" class="dot" aria-hidden="true"></span>
      <span id="connectionText">Not connected</span>
    </div>
  </header>

  <main id="mainContent">
    <h1 class="sr-only">SAGIP Responder Console</h1>

    <section id="authPanel" class="auth-shell" aria-labelledby="authTitle">
      <div class="auth-context">
        <p class="eyebrow eyebrow-on-dark">AUTHORIZED RESPONSE ACCESS</p>
        <h2 id="authTitle">Connect to emergency operations</h2>
        <p class="auth-lede">Review server-accepted SOS incidents, location evidence, report revisions, and responder status history from one focused workspace.</p>

        <div class="auth-notes" role="list" aria-label="Console safeguards">
          <div class="auth-note" role="listitem">
            <span class="auth-note-mark" aria-hidden="true">01</span>
            <div>
              <strong>Server-accepted incidents only</strong>
              <span>Local saves and peer relays do not appear here until the backend accepts the SOS.</span>
            </div>
          </div>
          <div class="auth-note" role="listitem">
            <span class="auth-note-mark" aria-hidden="true">02</span>
            <div>
              <strong>Session-only credential</strong>
              <span>Your responder token stays in this browser tab session and is cleared when the session ends.</span>
            </div>
          </div>
        </div>
      </div>

      <div class="auth-card">
        <p class="section-label">Responder authentication</p>
        <p class="muted">Use a bearer token provisioned by the SAGIP backend administrator.</p>
        <form id="authForm">
          <div class="form-field">
            <label for="tokenInput">Responder token</label>
            <p id="tokenHelp" class="field-help">The token is not embedded in this console and is never shown after you connect.</p>
            <input id="tokenInput" name="token" type="password" autocomplete="off" spellcheck="false" aria-describedby="tokenHelp authError" required>
          </div>
          <button type="submit">Connect to console</button>
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
            <span id="incidentCount" aria-live="polite">0 incidents</span>
            <span aria-hidden="true">•</span>
            <span id="lastUpdated" aria-live="polite">Waiting for server data…</span>
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
          <button id="refreshButton" type="button" class="secondary">Refresh queue</button>
          <button id="logoutButton" type="button" class="ghost">Disconnect</button>
        </div>
      </div>

      <div id="serverError" class="banner-error hidden" role="alert"></div>

      <div class="workspace">
        <section class="incident-column" aria-labelledby="incidentListTitle">
          <div class="panel-header">
            <div>
              <p class="section-label">Active view</p>
              <h3 id="incidentListTitle">Incident queue</h3>
            </div>
            <span>Server-accepted reports</span>
          </div>
          <div id="incidentList" class="incident-list" aria-live="polite"></div>
          <div id="emptyState" class="empty hidden">
            <strong>No incidents in this view</strong>
            <span>New server-accepted SOS reports matching this filter will appear here.</span>
          </div>
        </section>

        <section id="detailPanel" class="detail-panel" aria-labelledby="detailTitle">
          <div id="detailPlaceholder" class="detail-placeholder">
            <span class="placeholder-mark" aria-hidden="true">+</span>
            <strong>Select an incident</strong>
            <span>Emergency type, urgency, location, revisions, and responder acknowledgements will appear here.</span>
          </div>

          <div id="detailContent" class="hidden">
            <div class="detail-heading">
              <div>
                <p class="eyebrow">INCIDENT DETAIL</p>
                <h3 id="detailTitle">Incident</h3>
              </div>
              <span id="detailStatus" class="status-pill">Pending</span>
            </div>

            <dl id="detailFacts" class="facts"></dl>

            <div id="locationCard" class="location-card hidden">
              <div class="location-copy">
                <span class="section-label">LOCATION EVIDENCE</span>
                <strong>Best available location</strong>
                <span id="locationText"></span>
                <span id="locationMeta" class="muted"></span>
              </div>
              <a id="mapLink" class="map-link" target="_blank" rel="noopener noreferrer">Open map</a>
            </div>

            <section class="history-section" aria-labelledby="revisionHistoryTitle">
              <div class="section-heading">
                <h4 id="revisionHistoryTitle">Report revision history</h4>
                <span>Accepted SOS revisions</span>
              </div>
              <div id="revisionHistory" class="history"></div>
            </section>

            <section class="history-section" aria-labelledby="historyTitle">
              <div class="section-heading">
                <h4 id="historyTitle">Responder history</h4>
                <span>Persisted acknowledgement trail</span>
              </div>
              <div id="ackHistory" class="history"></div>
            </section>

            <form id="ackForm" class="ack-form">
              <div class="form-heading">
                <p class="section-label">RESPONSE UPDATE</p>
                <h4>Update response status</h4>
                <p class="muted">The backend persists responder updates before confirming success.</p>
              </div>

              <div class="form-field">
                <label for="ackStatus">Status</label>
                <select id="ackStatus" required>
                  <option value="ACKNOWLEDGED">Acknowledged</option>
                  <option value="EN_ROUTE">En route</option>
                  <option value="ON_SCENE">On scene</option>
                  <option value="RESOLVED">Resolved</option>
                </select>
              </div>

              <div class="form-field">
                <label for="ackNote">Operational note <span class="muted">(optional)</span></label>
                <textarea id="ackNote" maxlength="1000" rows="3" placeholder="Example: Boat team dispatched; ETA 8 minutes"></textarea>
              </div>

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
  --navy-950: #071b2b;
  --navy-900: #0c2942;
  --navy-800: #123b5d;
  --navy-700: #0f4c81;
  --navy-100: #e9f1f7;
  --ink: #14212b;
  --ink-soft: #50606c;
  --ink-faint: #6b7882;
  --canvas: #eef2f5;
  --surface: #ffffff;
  --surface-soft: #f6f8fa;
  --line: #d5dfe6;
  --line-strong: #adbdc8;
  --red-700: #9d2521;
  --red-100: #fff0ef;
  --amber-700: #744900;
  --amber-100: #fff3d5;
  --green-700: #145b36;
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

button, input, select, textarea { font: inherit; }
button, select, input, textarea { min-block-size: 3rem; }

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
  color: var(--navy-800);
  background: var(--surface);
  border: 1px solid var(--line-strong);
}
button.ghost:hover { background: var(--surface-soft); }

.skip-link {
  position: fixed;
  inset-block-start: 0.75rem;
  inset-inline-start: 0.75rem;
  z-index: 100;
  min-block-size: 3rem;
  display: inline-flex;
  align-items: center;
  transform: translateY(-200%);
  padding: 0.7rem 0.9rem;
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--navy-900);
  font-weight: 800;
  box-shadow: var(--shadow-sm);
}
.skip-link:focus { transform: translateY(0); }

.topbar {
  position: sticky;
  inset-block-start: 0;
  z-index: 20;
  min-block-size: 4.5rem;
  padding: 0.65rem clamp(1rem, 3vw, 2.25rem);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.25rem;
  background: var(--navy-900);
  color: var(--surface);
  border-block-end: 1px solid rgba(255, 255, 255, 0.12);
}

.brand { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
.brand-mark { width: 3rem; height: 3rem; flex: 0 0 auto; }
.brand-copy { min-width: 0; }
.brand strong { display: block; font-size: 1.1rem; letter-spacing: 0.14em; line-height: 1.1; }
.brand span { display: block; margin-block-start: 0.2rem; color: #dce8f2; font-size: 0.86rem; }

.connection {
  display: inline-flex;
  min-block-size: 2.25rem;
  align-items: center;
  gap: 0.55rem;
  padding-inline: 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  color: #e5edf3;
  background: rgba(255, 255, 255, 0.06);
  font-weight: 800;
  font-size: 0.84rem;
  white-space: nowrap;
}

.dot {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
  background: #96a7b5;
  box-shadow: 0 0 0 3px rgba(150, 167, 181, 0.16);
}
.dot.online {
  background: #55c889;
  box-shadow: 0 0 0 3px rgba(85, 200, 137, 0.16);
}

main {
  width: min(96rem, 100%);
  margin-inline: auto;
  padding: clamp(1rem, 3vw, 2.25rem);
}

h1, h2, h3, h4, p { margin-block-start: 0; }
h2, h3, h4 { color: var(--ink); }
h2 { margin-block-end: 0.55rem; font-size: clamp(1.65rem, 1.2rem + 1.5vw, 2.4rem); line-height: 1.08; letter-spacing: -0.02em; }
h3 { margin-block-end: 0.45rem; font-size: 1.2rem; line-height: 1.2; }
h4 { margin-block-end: 0.4rem; font-size: 1rem; line-height: 1.3; }

.muted { color: var(--ink-soft); }

.eyebrow,
.section-label {
  margin-block-end: 0.45rem;
  color: var(--red-700);
  font-size: 0.72rem;
  font-weight: 900;
  letter-spacing: 0.12em;
  line-height: 1.2;
  text-transform: uppercase;
}
.eyebrow-on-dark { color: #ffb5af; }

.auth-shell {
  width: min(65rem, 100%);
  margin: clamp(1.5rem, 7vh, 4.5rem) auto 0;
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(22rem, 0.92fr);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 1.25rem;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}

.auth-context {
  padding: clamp(2rem, 5vw, 4rem);
  background: var(--navy-900);
  color: var(--surface);
}
.auth-context h2 { max-width: 11ch; color: var(--surface); }
.auth-lede {
  max-width: 37rem;
  margin-block: 1rem 2.25rem;
  color: #dce8f2;
  font-size: 1.02rem;
}

.auth-notes { display: grid; gap: 1rem; }
.auth-note {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  gap: 0.85rem;
  align-items: start;
  padding-block-start: 1rem;
  border-block-start: 1px solid rgba(255, 255, 255, 0.18);
}
.auth-note-mark {
  color: #ffb5af;
  font-size: 0.75rem;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.auth-note strong,
.auth-note span { display: block; }
.auth-note strong { margin-block-end: 0.2rem; color: var(--surface); }
.auth-note div > span { color: #cbd9e4; font-size: 0.9rem; }

.auth-card { padding: clamp(2rem, 4vw, 3.5rem); align-self: center; }
.auth-card > .muted { max-width: 34rem; }

#authForm,
.ack-form { display: grid; gap: 1rem; margin-block-start: 1.5rem; }

.form-field { display: grid; gap: 0.4rem; }

label { font-weight: 800; font-size: 0.9rem; }
.field-help { margin: 0; color: var(--ink-soft); font-size: 0.84rem; }

input,
select,
textarea {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 0.65rem;
  background: var(--surface);
  color: var(--ink);
  padding: 0.7rem 0.8rem;
}

input:hover,
select:hover,
textarea:hover { border-color: #7d919f; }

input[aria-invalid="true"] { border-color: var(--red-700); background: #fff8f7; }
textarea { min-block-size: 6rem; resize: vertical; }

.error,
.banner-error { color: #821d19; font-weight: 800; }
.error { min-block-size: 1.5rem; margin-block: 0.75rem 0; }

.banner-error {
  margin-block-end: 1rem;
  padding: 0.85rem 1rem;
  background: var(--red-100);
  border: 1px solid #e4aaa7;
  border-inline-start: 4px solid var(--red-700);
  border-radius: 0.65rem;
}

.hidden { display: none !important; }

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 1.5rem;
  margin-block-end: 1rem;
  padding: 1.1rem 1.15rem;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 1rem;
  box-shadow: var(--shadow-sm);
}

.toolbar h2 { margin-block-end: 0.35rem; }
.toolbar-copy { min-width: 0; }

.queue-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  color: var(--ink-soft);
  font-size: 0.86rem;
  font-weight: 700;
}

.toolbar-actions {
  display: flex;
  align-items: end;
  gap: 0.65rem;
  flex-wrap: wrap;
}
.control-field { display: grid; gap: 0.35rem; min-width: 11rem; }

.workspace {
  display: grid;
  grid-template-columns: minmax(20rem, 0.82fr) minmax(29rem, 1.55fr);
  gap: 1rem;
  align-items: start;
}

.incident-column,
.detail-panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 1rem;
  box-shadow: var(--shadow-sm);
}

.incident-column {
  position: sticky;
  inset-block-start: 5.5rem;
  max-block-size: calc(100dvh - 6.5rem);
  overflow: auto;
  scrollbar-gutter: stable;
}

.panel-header {
  position: sticky;
  inset-block-start: 0;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: end;
  padding: 1rem 1.1rem 0.85rem;
  background: rgba(255, 255, 255, 0.96);
  border-block-end: 1px solid var(--line);
  backdrop-filter: blur(8px);
}
.panel-header h3 { margin: 0; }
.panel-header > span { color: var(--ink-faint); font-size: 0.78rem; text-align: end; }

.incident-list { display: grid; }

.incident-card {
  position: relative;
  width: 100%;
  min-block-size: 7rem;
  padding: 1rem 1.05rem;
  text-align: start;
  color: var(--ink);
  background: var(--surface);
  border-radius: 0;
  border-block-end: 1px solid #e2e9ed;
  border-inline-start: 4px solid transparent;
  display: grid;
  gap: 0.55rem;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.incident-card:hover {
  background: #f1f6fa;
  transform: none;
}

.incident-card.selected,
.incident-card[aria-current="true"] {
  background: var(--navy-100);
  border-inline-start-color: var(--navy-700);
}

.incident-top,
.incident-meta,
.detail-heading {
  display: flex;
  justify-content: space-between;
  gap: 0.85rem;
  align-items: center;
}

.incident-type { font-size: 1rem; font-weight: 900; }
.urgent { color: var(--red-700); }

.incident-meta {
  color: var(--ink-soft);
  font-size: 0.82rem;
  align-items: flex-start;
}

.status-pill {
  display: inline-flex;
  min-block-size: 1.9rem;
  align-items: center;
  padding: 0.3rem 0.6rem;
  border: 1px solid #cdd9e2;
  border-radius: 999px;
  background: #e8eef3;
  color: #344d61;
  font-size: 0.72rem;
  font-weight: 900;
  white-space: nowrap;
}

.status-pill.pending {
  border-color: #e5c779;
  background: var(--amber-100);
  color: var(--amber-700);
}
.status-pill.active {
  border-color: #9acdb2;
  background: var(--green-100);
  color: var(--green-700);
}
.status-pill.resolved {
  border-color: #cbd7df;
  background: #e7eef4;
  color: #334b5e;
}

.empty {
  padding: 3rem 1.5rem;
  text-align: center;
  color: var(--ink-soft);
}
.empty strong,
.empty span { display: block; }
.empty strong { margin-block-end: 0.3rem; color: var(--ink); }

.detail-panel {
  min-block-size: 38rem;
  padding: clamp(1.25rem, 3vw, 2rem);
}

.detail-placeholder {
  min-block-size: 34rem;
  display: grid;
  place-content: center;
  justify-items: center;
  text-align: center;
  gap: 0.6rem;
  color: var(--ink-soft);
}
.placeholder-mark {
  display: grid;
  width: 3rem;
  height: 3rem;
  place-items: center;
  margin-block-end: 0.25rem;
  border: 1px solid #c9d6df;
  border-radius: 50%;
  background: var(--navy-100);
  color: var(--red-700);
  font-size: 1.65rem;
  font-weight: 600;
}
.detail-placeholder strong { font-size: 1.15rem; color: var(--ink); }
.detail-placeholder > span:last-child { max-width: 34rem; }

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  margin-block: 1.25rem;
}

.fact {
  min-width: 0;
  padding: 0.9rem;
  border: 1px solid #e1e8ed;
  border-radius: 0.75rem;
  background: var(--surface-soft);
}
.fact dt {
  color: var(--ink-faint);
  font-size: 0.7rem;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.fact dd {
  margin: 0.3rem 0 0;
  font-weight: 850;
  overflow-wrap: anywhere;
}

.location-card {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
  padding: 1rem;
  border: 1px solid #bed3e1;
  border-inline-start: 4px solid var(--navy-700);
  border-radius: 0.8rem;
  background: #f2f8fc;
}

.location-copy strong,
.location-copy > span { display: block; }
.location-copy strong { margin-block: 0.15rem 0.1rem; }

.map-link {
  display: inline-flex;
  min-block-size: 3rem;
  align-items: center;
  justify-content: center;
  padding-inline: 0.9rem;
  border: 1px solid #9bb8cc;
  border-radius: 0.65rem;
  color: var(--navy-700);
  background: var(--surface);
  font-weight: 900;
  text-decoration: none;
  white-space: nowrap;
}
.map-link:hover { background: var(--navy-100); }

.history-section { margin-block-start: 1.6rem; }

.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  margin-block-end: 0.7rem;
}
.section-heading h4 { margin: 0; }
.section-heading span { color: var(--ink-faint); font-size: 0.78rem; }

.history { display: grid; gap: 0.65rem; }

.history-item {
  padding: 0.8rem 0.9rem;
  border: 1px solid #e1e8ed;
  border-inline-start: 4px solid var(--navy-700);
  background: var(--surface-soft);
  border-radius: 0.45rem 0.7rem 0.7rem 0.45rem;
}
.history-item strong,
.history-item span { display: block; }
.history-item span { margin-block-start: 0.2rem; color: var(--ink-soft); font-size: 0.84rem; }

.ack-form {
  margin-block-start: 1.75rem;
  padding: 1.15rem;
  border: 1px solid var(--line);
  border-radius: 0.85rem;
  background: var(--surface-soft);
}
.form-heading { margin-block-end: 0.15rem; }
.form-heading h4 { margin-block-end: 0.25rem; }
.form-heading p:last-child { margin: 0; font-size: 0.86rem; }

.form-result {
  min-block-size: 1.4rem;
  margin: 0;
  font-weight: 800;
  color: var(--green-700);
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

@media (max-width: 62rem) {
  .auth-shell { grid-template-columns: 1fr; }
  .auth-context { padding-block: 2rem; }
  .auth-context h2 { max-width: none; }
  .auth-lede { margin-block-end: 1.5rem; }
  .auth-notes { grid-template-columns: repeat(2, minmax(0, 1fr)); }

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
  main { padding: 0.85rem; }

  .topbar {
    position: static;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .connection { margin-block-start: 0.35rem; }

  .auth-shell {
    margin-block-start: 0.5rem;
    border-radius: 0.9rem;
  }
  .auth-context,
  .auth-card { padding: 1.4rem; }
  .auth-notes { grid-template-columns: 1fr; }

  .toolbar {
    align-items: stretch;
    flex-direction: column;
    padding: 1rem;
  }
  .toolbar-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .control-field { grid-column: 1 / -1; }
  .toolbar-actions button { width: 100%; }

  .panel-header { align-items: start; }
  .panel-header > span { max-width: 8rem; }

  .incident-top,
  .incident-meta { align-items: flex-start; }
  .incident-meta { flex-direction: column; gap: 0.2rem; }

  .facts { grid-template-columns: 1fr; }
  .detail-heading { align-items: flex-start; }
  .location-card { align-items: stretch; flex-direction: column; }
  .map-link { align-self: stretch; }
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
  .incident-card[aria-current="true"] {
    forced-color-adjust: auto;
  }
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
  const incidentCount = document.getElementById('incidentCount');
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
    if (!value) return 'Unknown';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  }

  function formatEmergencyType(value) {
    return formatWords(value, 'OTHER');
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
    tokenInput.removeAttribute('aria-invalid');
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
    if (incident.reportId === selectedReportId) {
      card.classList.add('selected');
      card.setAttribute('aria-current', 'true');
    }
    card.setAttribute('aria-label', formatEmergencyType(incident.emergencyType) + ' incident, ' + formatStatus(statusLabel(incident)));

    const top = document.createElement('div');
    top.className = 'incident-top';
    const type = createText('span', 'incident-type' + (incident.urgency === 'IMMEDIATE_DANGER' ? ' urgent' : ''), formatEmergencyType(incident.emergencyType));
    const pill = createText('span', 'status-pill ' + statusClass(statusLabel(incident)), formatStatus(statusLabel(incident)));
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
      Array.from(incidentList.children).forEach((item) => {
        item.classList.remove('selected');
        item.removeAttribute('aria-current');
      });
      card.classList.add('selected');
      card.setAttribute('aria-current', 'true');
    });
    return card;
  }

  function renderIncidents(incidents) {
    incidentList.replaceChildren();
    emptyState.classList.toggle('hidden', incidents.length !== 0);
    incidentCount.textContent = incidents.length + (incidents.length === 1 ? ' incident' : ' incidents');
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
    detailStatus.textContent = formatStatus(status);
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
      tokenInput.setAttribute('aria-invalid', 'true');
      authError.textContent = 'Enter a responder token.';
      tokenInput.focus();
      return;
    }
    tokenInput.removeAttribute('aria-invalid');
    token = candidate;
    sessionStorage.setItem(TOKEN_KEY, token);
    await refreshIncidents(true);
  });

  tokenInput.addEventListener('input', () => {
    tokenInput.removeAttribute('aria-invalid');
    authError.textContent = '';
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
      ackResult.textContent = 'Saved: ' + formatStatus(ack.status);
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
