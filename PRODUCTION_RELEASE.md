# SAGIP Production Release Operations

This document describes the production release mechanism. It is **not** evidence that SAGIP is ready for real emergency-service deployment. Production publication must remain blocked until the project-level security, physical-device, responder-operations, and service-readiness gates have actual evidence.

## Intended production target

The current local Neon context identifies:

- project: `plain-butterfly-00485937`
- branch: `production`

The local `.neon` context is git-ignored. The production GitHub Actions workflow therefore links that exact project and branch explicitly before planning or deploying.

The public Android backend base URL is configured through the GitHub `production` environment variable:

```text
SAGIP_BACKEND_BASE_URL=https://...
```

Release builds reject non-HTTPS backend URLs.

## GitHub production environment

Create a protected GitHub Environment named `production`. Require reviewer approval in GitHub for that environment when the repository plan supports environment protection.

Configure these environment variables:

```text
SAGIP_BACKEND_BASE_URL
SAGIP_RELEASE_CERT_SHA256
```

`SAGIP_RELEASE_CERT_SHA256` is the expected SHA-256 fingerprint of the owner-approved Android signing certificate. It is not secret. The release workflow rejects an APK signed by a different certificate even if another valid keystore was accidentally configured.

Configure these environment secrets:

```text
SAGIP_RELEASE_KEYSTORE_BASE64
SAGIP_RELEASE_KEYSTORE_PASSWORD
SAGIP_RELEASE_KEY_ALIAS
SAGIP_RELEASE_KEY_PASSWORD
NEON_API_KEY
DATABASE_URL
```

`DATABASE_URL` must point to the intended **direct/unpooled production PostgreSQL endpoint** used for migrations. Do not use a connection string for another branch.

Prefer a project-scoped Neon API key dedicated to CI rather than a broad personal credential. Revoke and replace it if it is exposed.

Never commit a production keystore, its Base64 encoding, passwords, database URLs, Neon API keys, responder tokens, or any other private credential.

## Android signing identity

The repository does not generate a production signing identity automatically.

The production signing identity must be created and backed up through an owner-approved secure process. Once an Android application is distributed with that identity, losing or casually replacing it can make future upgrades impossible or operationally unsafe.

The workflow materializes `SAGIP_RELEASE_KEYSTORE_BASE64` only inside the ephemeral GitHub runner and passes the resulting path through `SAGIP_RELEASE_KEYSTORE_PATH`. Signing credentials are scoped only to the workflow steps that need them. After building, `apksigner` verifies the APK and the workflow compares its signer certificate fingerprint with `SAGIP_RELEASE_CERT_SHA256`.

Gradle release validation requires:

```text
SAGIP_RELEASE_KEYSTORE_PATH
SAGIP_RELEASE_KEYSTORE_PASSWORD
SAGIP_RELEASE_KEY_ALIAS
SAGIP_RELEASE_KEY_PASSWORD
SAGIP_BACKEND_BASE_URL
SAGIP_VERSION_CODE
SAGIP_VERSION_NAME
```

A release build fails if signing is incomplete, the keystore file does not exist, the backend URL is not HTTPS, or explicit release version metadata is missing.

Debug builds continue to use the repository debug keystore and are not production artifacts.

## Production workflow

`.github/workflows/production-release.yml` is manual-only (`workflow_dispatch`).

Inputs:

- `version_name`: Android display version.
- `version_code`: positive, monotonically increasing Android version code.
- `release_tag`: production-style Git tag such as `v1.0.0`.
- `deploy_backend`: whether to apply production DB migrations and deploy the Neon Function.
- `publish_github_release`: whether to publish the signed APK/AAB to GitHub Releases.
- `confirm_production_readiness`: explicit acknowledgement that external production gates have actual evidence.

The build job always runs the application/backend validation gates before producing signed artifacts.

The workflow creates:

```text
sagip-<version>-release.apk
sagip-<version>-release.aab
SHA256SUMS.txt
release-notes.md
```

These are first uploaded as a private workflow artifact. Publishing to GitHub Releases is a separate opt-in action. The workflow refuses a publish request unless `confirm_production_readiness` is also true.

The workflow does **not** upload to Google Play or another app store.

## Backend deployment sequence

When `deploy_backend=true`, the workflow performs the following against the pinned Neon production target:

1. installs repository/backend dependencies;
2. installs the repository-validated Neon CLI version (`neon@6.1.0`);
3. links project `plain-butterfly-00485937`, branch `production`;
4. runs `neon status`;
5. runs `neon config plan`;
6. applies repository PostgreSQL migrations using the private `DATABASE_URL`;
7. runs `neon deploy`;
8. verifies:
   - `GET /healthz` returns 200 and `{"status":"ok"}`;
   - `GET /responder` returns HTML;
   - unauthenticated `GET /v1/incidents?limit=1&offset=0` returns 401.

The smoke check intentionally does not use a responder bearer token.

## Manual deployment / redeployment

From an authorized workstation with the repository checked out at the intended commit:

```text
npm ci
npm --prefix backend ci
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run lint

neon link --project-id plain-butterfly-00485937 --branch production -y
neon status
neon config plan

DATABASE_URL=<private direct production URL> npm --prefix backend run migrate
neon deploy

node scripts/verify-backend.mjs <https-production-base-url> --full
```

Do not paste private values into documentation, shell history shared with others, issue comments, CI logs, or release notes.

## Rollback

### Android application

Do not attempt to "rollback" Android by distributing an APK with a lower version code.

If an application release must be reverted:

1. check out the last known-good source revision;
2. increment `SAGIP_VERSION_CODE` to a value higher than every previously distributed production version;
3. keep the same owner-approved production signing identity;
4. rerun the full production validation/build workflow;
5. verify checksums, APK signer identity, and AAB signature before distributing the newly versioned corrective build.

### Backend

Database migrations are checksum-tracked and must be treated as forward history.

If a backend function release must be reverted:

1. identify the last known-good backend commit that is compatible with the **current** database schema;
2. run its tests/typecheck/lint;
3. run `neon config plan` against the pinned production branch;
4. redeploy that known-good backend revision;
5. run `scripts/verify-backend.mjs --full`.

Do not edit or delete an already-applied migration to simulate rollback. If database repair is required, add a reviewed corrective migration and validate it first.

## Responder provisioning

Responder credentials are operational secrets, not application-release assets.

Provision from an authorized environment against the intended production database:

```text
DATABASE_URL=<private production URL>
RESPONDER_CALLSIGN=RESCUE-ALPHA-1
RESPONDER_ROLE=DISPATCHER
npm --prefix backend run provision-responder
```

The generated bearer token is displayed once. Transfer it through the approved secret-management channel. Never commit it or add it to release notes. PostgreSQL stores only the token hash.

See `RESPONDER_CONSOLE.md` for responder behavior and API semantics.

## Release evidence and remaining gates

A successful CI build proves only the checks actually executed by CI.

Before describing SAGIP as production-ready, separately confirm current evidence for at least:

- production signing with the real owner-approved keystore;
- live production Neon migration/function deployment;
- physical two-phone BLE custody and SGA1 return-ACK testing;
- real-device encrypted SQLite migration/reopen behavior when that feature is enabled;
- end-to-end responder key custody/decryption path when encrypted envelopes are enabled;
- production responder operations and credential handling;
- uptime/monitoring/incident-response expectations.

Do not convert host tests or a successful build into claims of real-world field validation.
