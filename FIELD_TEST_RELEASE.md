# SAGIP Field-Test Release

GitHub field-test releases are created from tags matching:

```text
field-test-*
```

These are deliberately GitHub **pre-releases**, not production releases.

The workflow in .github/workflows/field-test-release.yml:

1. verifies the configured hosted backend `/healthz` endpoint;
2. runs the React Native and backend automated checks;
3. builds the Android debug APK with the hosted Neon HTTPS backend configured;
4. computes a SHA-256 checksum;
5. publishes the APK and checksum as GitHub pre-release assets.

No database password, Neon API key, responder bearer token, or Android production signing secret is embedded in the workflow or APK. The field-test workflow does not deploy Neon or apply production database migrations.

## Current field-test backend

```text
https://br-shy-brook-b3mhu6ho-api.compute.c-4.ap-southeast-1.aws.neon.tech
```

The same backend serves the authenticated responder console at `/responder` after the current backend revision is deployed. See `RESPONDER_CONSOLE.md` for provisioning and truthful-status semantics.

## Important limitation

The field-test APK is intentionally debug-signed because it exists to execute the physical two-phone acceptance runbook, not for production distribution. Production release builds are a separate manual workflow and fail unless HTTPS backend, explicit version metadata, and real release-keystore settings are supplied. No release signing secret is committed to the repository.

See `PRODUCTION_RELEASE.md` for the production workflow, GitHub Environment settings, Neon deployment sequence, rollback procedure, and responder provisioning boundary.

First-milestone field acceptance still requires the complete real-hardware path:

```text
Phone A offline
-> durable SOS
-> physical BLE custody to Phone B
-> Phone B online
-> live backend acceptance
-> responder acknowledgement
-> physical SGA1 return to Phone A
```
