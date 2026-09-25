# SAGIP Field-Test Release

GitHub field-test releases are created from tags matching:

```text
field-test-*
```

These are deliberately GitHub **pre-releases**, not production releases.

The workflow in .github/workflows/field-test-release.yml:

1. runs the React Native and backend automated checks;
2. builds the Android debug APK with the hosted Neon HTTPS backend configured;
3. computes a SHA-256 checksum;
4. publishes the APK and checksum as GitHub pre-release assets.

No database password, Neon API key, responder bearer token, or Android production signing secret is embedded in the workflow or APK.

## Current field-test backend

```text
https://br-shy-brook-b3mhu6ho-api.compute.c-4.ap-southeast-1.aws.neon.tech
```

## Important limitation

The field-test APK is debug-signed because production Android signing has not yet been configured. It exists to execute the physical two-phone acceptance runbook, not for production distribution.

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
