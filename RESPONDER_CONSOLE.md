# SAGIP Responder Console

SAGIP has two independent delivery paths after an SOS is durably committed on the originating Android device:

1. **Direct internet delivery** — if the phone has usable connectivity, the signed immutable envelope is sent directly to the SAGIP backend. No nearby SAGIP device is required.
2. **BLE store-carry-forward fallback** — if direct delivery is unavailable, another SAGIP Android device can take durable custody and later forward the same signed envelope when it gains connectivity.

A peer relay is therefore a fallback transport, not a prerequisite for server delivery.

## What responders can see

The responder console is served by the same backend as the ingestion API:

```text
/responder
```

For the current field-test backend:

```text
https://br-shy-brook-b3mhu6ho-api.compute.c-4.ap-southeast-1.aws.neon.tech/responder
```

The console displays only information currently carried and validated by the SAGIP emergency protocol:

- emergency type;
- urgency;
- report/server timestamps;
- best available location, accuracy, source, and freshness when location was captured;
- report revision history;
- responder acknowledgement/status history.

The incident emergency type and urgency come from the latest accepted report revision. Best available location uses the newest accepted revision that actually contains a complete coordinate fix, so a later revision without location does not erase an earlier actionable fix. The revision history remains visible so responders can see which revision supplied each location.

The current emergency payload does **not** carry a resident name, phone number, free-form narrative, medical history, or other personal profile data. Adding those fields is a protocol/privacy change and must not be done only in the dashboard.

An SOS becomes visible in this console only after the backend has accepted it. `Saved on this device` and `Relayed to nearby SAGIP device` do not mean the server or a responder has received it.

## Responder access

Responder API clients can continue to use a provisioned bearer token. The browser console now uses that token only to start a short-lived responder session:

1. the responder pastes the provisioned token once;
2. the backend verifies the existing SHA-256 token hash;
3. the backend creates a random 12-hour browser session and stores only that session token's SHA-256 hash in PostgreSQL;
4. the browser receives the raw session token only in an `HttpOnly; Secure; SameSite=Strict` cookie;
5. dashboard JavaScript clears the pasted bearer token and does not place it in `localStorage`, `sessionStorage`, or later API headers.

Closing and reopening the console in the same browser can therefore restore the responder session until it expires, is revoked, or the responder presses **Disconnect**. Disconnect deletes the server-side session before clearing the cookie. Existing bearer-token API clients remain compatible.

Provision a responder against the intended database:

```text
DATABASE_URL=<private PostgreSQL URL>
RESPONDER_CALLSIGN=RESCUE-ALPHA-1
RESPONDER_ROLE=DISPATCHER
npm --prefix backend run provision-responder
```

The command prints the bearer token once. Store it in the approved private secret store. PostgreSQL stores only its SHA-256 hash. Responders should copy the token from that store when starting a new browser session rather than memorizing it.

## Acknowledgement return path

A responder update is persisted in PostgreSQL before success is returned to the console. The originating phone can learn the status directly from the backend when online. If the origin remains offline, the existing SGA1 return-ACK path can propagate the responder acknowledgement back through SAGIP peers.

If connectivity drops after a responder submits an update, the console does not claim that the update failed to persist. It asks the responder to refresh or retry because the database commit may have completed before the HTTP response was lost. Repeating the same responder/status transition is idempotent and returns the canonical stored acknowledgement.

## Backend operations

The repository .neon project context is linked to the production branch. Keep database URLs, Neon credentials, responder bearer tokens, and signing material outside source control.

Before deploying a backend revision, run:

    npm --prefix backend test
    npm --prefix backend run typecheck
    npm --prefix backend run lint
    neon config plan

Apply schema migrations to the intended production database using a privately supplied DATABASE_URL, then deploy the function:

    npm --prefix backend run migrate
    neon deploy

Post-deploy verification should cover:

    GET /healthz                         -> 200
    GET /responder                       -> 200
    GET /v1/responder/session             -> 401 without a browser session
    GET /v1/incidents                    -> 401 without bearer or browser-session auth
    GET /v1/incidents?limit=1&offset=0   -> read-only authenticated smoke check

Responder incident pagination is bounded to limit 1..100 and offset 0..10000. Status filters are restricted to PENDING, ACKNOWLEDGED, EN_ROUTE, ON_SCENE, and RESOLVED. A provisioning smoke test should use a clearly named temporary responder identity and remove it after verification if it is not an operational account; never commit or paste the generated bearer token into documentation.

## Production boundaries

The repository now prevents Android release builds from silently using the debug signing key. A production release requires these settings:

```text
SAGIP_RELEASE_KEYSTORE_PATH
SAGIP_RELEASE_KEYSTORE_PASSWORD
SAGIP_RELEASE_KEY_ALIAS
SAGIP_RELEASE_KEY_PASSWORD
SAGIP_BACKEND_BASE_URL=https://...
```

Do not commit those secret values.

Physical two-phone BLE custody/SGA1 return testing and production signing with the real private keystore remain environment dependent. SECURITY_ARCHITECTURE_V2.md now defines the SGP2/SRE2 confidentiality direction, but SGP2 production emission, ciphertext incident persistence/API support, responder-local decryption/key custody, and physical SQLCipher migration validation remain explicitly gated and must not be represented as production-enabled until those paths are implemented and exercised.
