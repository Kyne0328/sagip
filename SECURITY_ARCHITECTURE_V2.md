# SAGIP Security Architecture v2 Design Note

Status: Agent 4 design baseline for implementation and cross-agent integration.
Date: 2026-09-28
Rel.AI work session: `00d62741-9b6a-4f33-8074-47d8f5333310`

This note resolves the cryptographic architecture direction for the two production blockers identified in `DESIGN.md` and `PROJECT_STATUS.md`: end-to-end incident-payload confidentiality/responder key distribution and encrypted Android emergency storage. It does not claim operational production readiness. Several key-management and field-recovery decisions remain deployment-owner responsibilities and are listed explicitly below.

## 1. Existing invariants that remain unchanged

The following rules are preserved:

- Local SOS durability is the success boundary. Network availability, encryption preparation, Android Keystore availability, signing, or responder availability must not be required for the initial local report commit.
- The existing installation signing identity remains Android Keystore P-256 / `SHA256withECDSA`; its private key remains non-exportable.
- Origin signatures remain end-to-end origin-authenticity evidence and are never replaced by transport-hop signatures.
- Report ID, message ID, revision, and immutable prepared envelope bytes remain stable across retry and relay.
- BLE relays remain untrusted opaque couriers and must not require incident plaintext.
- The full transport envelope remains capped at 8192 bytes.
- Existing responder authentication/authorization remains required even for a responder that possesses a payload decryption key. Possession of a decryption key is not an API authorization token.
- Existing SGP1/SRP1 validation remains supported for previously persisted/test traffic. SGP1 is not silently reinterpreted as encrypted traffic.
- SGC1 chunk framing and durable-before-ACK behavior remain bounded and retry-safe.
- No private responder keys, SQLCipher database keys, bearer credentials, or production signing material may be committed to source control.

## 2. Threat model

### 2.1 Lost or stolen relay phone

Assume an attacker obtains a relay device and can copy its application data or inspect held `inbound_envelopes`.

Required protection:

- Relay-held transport payloads are ciphertext.
- Relay nodes do not possess responder decryption private keys merely because they relay civilian traffic.
- The local SQLCipher database protects stored envelopes and operational metadata at rest while the device is locked/offline, subject to Android device/Keystore compromise limits.
- Cleartext transport metadata is minimized but is not claimed secret.

Residual exposure:

- A relay can observe message/report identifiers, creation/expiry timing, routing priority, origin public-key material/key ID, ciphertext length, recipient key IDs, BLE encounter metadata, and traffic timing unless a future traffic-analysis-resistant layer is added.

### 2.2 Malicious relay

Assume a relay can drop, delay, replay, duplicate, reorder, corrupt, or refuse traffic.

Required protection:

- The relay cannot decrypt incident content.
- Outer origin signature and digest detect alteration.
- HPKE ciphertext integrity rejects corrupted recipient ciphertext.
- Stable message IDs, payload digests, `seen_messages`, immutable bytes, idempotent backend ingestion, and relay receipts continue to handle duplicate/replay behavior.
- No relay can create a valid modified origin envelope without the origin P-256 signing key.

Availability against a malicious relay is not cryptographically solvable; SAGIP relies on multiple delivery paths and retry/store-carry-forward behavior.

### 2.3 Compromised network

Assume internet/BLE observers can capture and modify packets.

Required protection:

- Incident content is protected by responder-recipient public-key encryption independently of TLS and BLE link security.
- TLS remains required for the production backend because E2E payload encryption does not hide metadata, authentication tokens, receipts, or API behavior.
- P-256 origin signatures and HPKE integrity detect active ciphertext modification.

### 2.4 Untrusted backend operator

For the production confidentiality goal, assume a backend/database operator may read PostgreSQL rows, logs, application memory available to the backend process, and stored envelope bytes but does not possess authorized responder private decryption keys.

Therefore:

- The backend MUST NOT receive responder private decryption keys.
- The backend MUST NOT decrypt SGP2 incident payloads as part of normal ingestion.
- Emergency type, urgency, coordinates, location accuracy/freshness, and later free-form sensitive incident detail belong inside encrypted responder content.
- SGP2 backend ingestion may verify framing, bounds, origin public-key continuity, payload digest, and P-256 signature, then persist the ciphertext and server-visible metadata.
- The current backend schema/service path that decodes SRP1 and stores plaintext incident fields is a legacy SGP1 path. It cannot be reused for SGP2 without defeating the untrusted-backend property.
- The current browser responder console is not automatically E2E-capable. SGP2 incident detail must be decrypted in a responder-controlled client that holds an authorized private key. Server-side decryption is not an acceptable compatibility shortcut.

If deployment owners later choose a backend-trusted threat model, that is a separate explicitly documented deployment mode, not a silent weakening of this design.

### 2.5 Stolen database copy

Android:

- A copied `sagip.db` must be SQLCipher-encrypted.
- The SQLCipher key is random and is not stored plaintext beside the database.
- The SQLCipher key is wrapped by an Android Keystore key.

Backend:

- A copied PostgreSQL database reveals SGP2 routing metadata and encrypted payload bytes, but not incident plaintext unless responder private keys were improperly co-located.

### 2.6 Responder credential compromise

Two independent credentials exist:

1. API authentication/authorization credential (currently responder bearer token).
2. Payload decryption private key.

Compromise of only the bearer token must not grant payload decryption.
Compromise of only a payload private key must not grant responder API operations.

If both are compromised, an attacker may access incidents authorized to that recipient key until revocation/rotation takes effect. Previously captured ciphertext encrypted to a compromised private key generally remains decryptable; key rotation primarily protects future ciphertext.

### 2.7 Origin-device compromise

If the origin device and its unlocked application/Keystore are compromised, an attacker may read locally available plaintext reports, invoke signing, and create apparently valid reports using that installation identity. E2E encryption does not solve endpoint compromise.

Mitigations remain OS device security, Android Keystore non-exportability, minimal local plaintext lifetime, SQLCipher at rest, bounded diagnostics, and future device-revocation processes.

### 2.8 Long offline periods

Origin devices may remain offline while all responders are also offline.

Required behavior:

- Origin report creation still commits locally first.
- Encryption preparation can succeed offline only when the device already holds a previously verified responder/agency public-key directory entry.
- Prepared encrypted envelopes can be relayed for hours/days without any responder online.
- Authorized responders decrypt later when they obtain the ciphertext.
- No plaintext fallback is permitted merely because responder/network services are unavailable.

The maximum acceptable age of a cached key directory, and behavior after cached recipient keys expire or are known revoked elsewhere, are operational policy questions that must be fixed before production.

## 3. Encryption goals and selected primitive

### 3.1 Confidential payload

Confidential responder content includes at minimum the current SRP1 logical payload:

- emergency type;
- urgency;
- location presence;
- latitude/longitude;
- accuracy;
- location timestamp;
- source/freshness.

Future user-supplied notes, medical details, household/person data, or precise routing detail that does not need to be processed by relays/backend also belongs inside the encrypted responder content.

### 3.2 Server/relay-visible metadata

The following remains visible because it is required for routing, deduplication, expiry, verification, or bounded queueing:

- envelope magic/version and signature algorithm;
- message ID;
- report ID;
- revision;
- created/expiry timestamps;
- routing priority;
- origin key ID and origin public key;
- encrypted-payload digest;
- encrypted-payload length/ciphertext;
- responder-recipient key IDs contained in the encrypted-payload container;
- outer signature;
- relay/BLE framing and receipt metadata.

Routing priority must be treated as coarse scheduling metadata, not a plaintext copy of detailed medical/emergency semantics.

### 3.3 Primitive choice

Use Google Tink Hybrid Encryption with HPKE rather than designing a custom KEM/KDF/AEAD construction.

Selected parameter family:

- HPKE / RFC 9180;
- DHKEM X25519 + HKDF-SHA-256;
- HKDF-SHA-256;
- AES-256-GCM.

The Android dependency is `com.google.crypto.tink:tink-android`. The implementation must use Tink's supported HPKE parameter/key APIs rather than manually implementing X25519, HKDF, nonce derivation, or AES-GCM composition.

Tink hybrid encryption provides confidentiality to a recipient public key but does not replace sender authentication. SAGIP retains the existing P-256 origin signature over the complete canonical SGP2 unsigned body.

### 3.4 Multi-recipient access model

Encryption recipients are authorization groups/agency encryption keys, not arbitrary relay phones and not automatically every bearer-token identity.

For each selected authorized agency/group recipient, the origin encrypts the same inner SRP1 bytes independently with that recipient's HPKE public key. This deliberate bounded fan-out avoids inventing a custom content-encryption-key wrapping format.

Initial hard bound:

- maximum recipients per encrypted payload: 8;
- each entry has a 32-byte recipient key ID and a bounded ciphertext length;
- total encrypted-payload bytes remain constrained by the existing transport payload and 8192-byte full-envelope limits.

Multi-agency access is achieved by including one recipient entry per authorized agency/group. A responder may decrypt only an entry whose private key is provisioned to that responder environment.

## 4. Responder public-key distribution

### 4.1 Provisioning

Responder/agency encryption key pairs are generated and managed outside the civilian app.

The public-key directory record must include:

- recipient/agency identifier;
- 32-byte stable key ID;
- public HPKE key material in a documented Tink-compatible serialization;
- key epoch/version;
- activation time;
- encryption-valid-until time;
- decrypt-retention horizon;
- revocation state when known;
- allowed agency/scope metadata.

Civilian devices cache only public encryption material.

### 4.2 Authenticating the directory

Because the backend is within the confidentiality threat model, a public key received from the backend cannot be trusted solely because HTTPS delivered it.

The responder key directory/manifest must be signed by a SAGIP/agency offline trust anchor whose verification public key is pinned in the civilian application (or otherwise provisioned through an independently trusted channel). Directory signature verification is separate from per-origin P-256 signing.

The backend may distribute the signed manifest but cannot silently substitute its own recipient key without failing manifest verification.

### 4.3 Rotation

- New recipient public keys are introduced with a new key ID/epoch.
- A transition manifest can contain both old and new encryption-valid keys.
- Origins encrypt only to keys allowed for encryption at preparation time.
- Responders retain authorized old private keys for at least the incident retention/decryption horizon so delayed/offline traffic remains decryptable.
- Rotation never requires rewriting an already READY immutable envelope.

### 4.4 Revocation

- A compromised recipient key is marked revoked in a newly signed directory.
- Online origins stop encrypting to that key once the signed revocation is observed.
- Previously produced ciphertext for the compromised key cannot be retroactively protected.
- Long-offline origins cannot learn revocation until contact occurs; this is an inherent offline-system limitation and must be represented in the operational risk model.

### 4.5 Recovery/disaster operations

Recovery must not place responder private keys in the ordinary backend database.

Acceptable production patterns include agency-controlled HSM/KMS escrow, MDM-managed secure key provisioning, or another audited emergency recovery process. The exact operational escrow/quorum procedure is intentionally not invented in application code and remains an explicit production decision.

## 5. Encrypted payload container (SRE2)

SRP1 remains the canonical inner emergency payload for this compatibility stage.

A new deterministic framing container identifies recipient ciphertext entries:

```text
magic                 4 bytes ASCII "SRE2"
container_version     u8 = 1
plaintext_format      u8 = 1  # SRP1
recipient_count       u8 = 1..8

repeated recipient_count times:
  recipient_key_id    32 bytes
  ciphertext_length   u16, bounded and > 0
  hpke_ciphertext      declared bytes
```

Entries must have unique recipient key IDs and deterministic ordering by unsigned lexicographic key ID before serialization. HPKE ciphertext itself is intentionally randomized.

The HPKE `context_info` binds ciphertext use to immutable message context. It is built from a versioned domain-separation label plus:

- message ID;
- report ID;
- report revision;
- SGP2 version.

A ciphertext copied from one logical message into another therefore fails HPKE decryption even before outer signature acceptance would allow it.

## 6. SGP2 transport envelope and compatibility

### 6.1 Why a new envelope version is necessary

SGP1 explicitly defines `payload` as SRP1 plaintext, and backend `verifyEnvelopeV1` decodes that payload after signature verification. Reusing SGP1 magic/version for ciphertext would create ambiguity and make old consumers misclassify encrypted traffic as malformed SRP1.

Therefore use a versioned new outer envelope: `SGP2`.

### 6.2 SGP2 field model

SGP2 retains the bounded fixed-order outer fields needed by existing routing/idempotency logic:

- magic `SGP2`;
- protocol version 2;
- signature algorithm 1 = existing ECDSA P-256 / SHA-256;
- message ID;
- report ID;
- revision;
- created-at;
- expiry;
- routing priority;
- origin key ID;
- origin X.509 P-256 public key;
- encrypted payload digest;
- encrypted payload length;
- SRE2 encrypted payload bytes;
- signature length;
- P-256 DER signature.

The envelope remains <= 8192 bytes. Per-field public-key/signature limits remain unchanged unless a separately reviewed protocol revision changes them.

### 6.3 Signature/digest/encryption order

The exact preparation order is:

1. Deterministically encode logical emergency data as SRP1.
2. For each authorized recipient public key, HPKE-encrypt the SRP1 bytes using the bound `context_info`.
3. Serialize the SRE2 encrypted-payload container.
4. Compute `payload_digest = SHA-256(SRE2 bytes)`.
5. Build the canonical SGP2 unsigned body containing the ciphertext container and its digest.
6. Sign the canonical SGP2 unsigned body using the existing non-exportable P-256 Android Keystore signing identity.
7. Append DER signature length/signature.
8. Persist the exact immutable SGP2 bytes as READY.

This is encrypt-then-origin-sign at the message level. Backend/relay validation never requires decrypting the incident.

### 6.4 Backward compatibility

- Existing SGP1 decoder/verifier is left unchanged.
- New code uses an envelope-version dispatcher that recognizes SGP1 and SGP2 explicitly.
- Previously READY SGP1 rows continue retrying and relaying verbatim; they are not mutated in place.
- New reports may only switch to SGP2 when valid trusted recipient public keys are available and all required producer/consumer paths for SGP2 are deployed.
- There is no silent SGP2-to-SGP1 plaintext downgrade.
- Migration from SGP1 to SGP2 for an already-created report, if required, must be a new revision/message with explicit semantics rather than rewriting immutable bytes.

### 6.5 SGC1

SGC1 is a chunk transport and can carry SGP2 bytes without changing its chunk frame layout.

Required consumer change:

- reassembly validation must call a version-aware transport-envelope decoder/verifier rather than hard-coded `TransportEnvelopeV1.decode`;
- manifest digest semantics remain the SHA-256 digest carried by the accepted outer envelope;
- the 8192-byte reassembled-envelope ceiling is unchanged.

No SGC2 is needed solely for encrypted payload support.

### 6.6 SGA1

SGA1 carries responder return status, report ID, callsign, ETA, timestamp, and CRC32. It does not contain the civilian incident payload, so SGP2 does not require a wire change for basic acknowledgement return.

However, SGA1 is not confidential or cryptographically authenticated at the application layer. A passive BLE observer or malicious peer may learn/forge status metadata within BLE reach. This is a separate production security question. If return-ACK confidentiality/authenticity is required by the deployment threat model, define a separately versioned authenticated/encrypted return-ACK protocol rather than silently changing SGA1.

## 7. Backend/responder contract changes

### 7.1 SGP1 legacy path

The current path remains:

- verify SGP1;
- decode SRP1;
- populate plaintext `incident_revisions`;
- expose plaintext fields to the existing responder service/console.

This is compatibility only and is not the target production confidentiality path.

### 7.2 SGP2 path

The backend may:

- enforce <=8192 bytes and all declared field bounds;
- verify key ID/public key continuity;
- verify SHA-256 over SRE2 ciphertext bytes;
- enforce P-256 origin key/curve and signature;
- validate SRE2 framing/recipient count/duplicate key IDs/ciphertext lengths without decrypting;
- transactionally persist outer metadata, ciphertext, and idempotency state;
- return the canonical server acceptance receipt.

The backend must not synthesize fake plaintext values such as `OTHER` or missing coordinates to make encrypted incidents fit legacy responder DTOs.

### 7.3 Responder access

An SGP2-capable responder client must:

1. authenticate/authorize to the backend as today;
2. fetch only incidents permitted by responder authorization;
3. receive encrypted payload bytes and signed outer metadata;
4. select a recipient entry for a locally held private key;
5. verify/decrypt locally;
6. decode SRP1 locally;
7. display incident fields only after successful cryptographic processing.

Current server-side/browser-console behavior needs coordinated work before SGP2 can be enabled for production traffic. Backend access control remains mandatory even though ciphertext itself is E2E encrypted.

## 8. Encrypted Android SQLite

### 8.1 Selected storage engine

Use the maintained `sqlcipher-android` package, not the deprecated `android-database-sqlcipher` package and not custom page/file encryption.

Target dependency for this implementation slice:

- `net.zetetic:sqlcipher-android:4.17.0@aar`;
- `androidx.sqlite:sqlite:2.6.2`.

This repository currently compiles against Android API 36. SQLCipher for Android 4.18.0 and later require compileSdk 37, so 4.17.0 is the newest compatible maintained line for the current build baseline. Upgrade SQLCipher together with compileSdk after the Android toolchain is intentionally raised.

SQLCipher native library loading must happen before database use.

### 8.2 Database key generation

- Generate 32 random bytes using `SecureRandom` as the SQLCipher database key.
- Generate a separate Android Keystore AES-256 key with `PURPOSE_ENCRYPT | PURPOSE_DECRYPT`, GCM mode, no padding, and `setUserAuthenticationRequired(false)` so emergency restart/background delivery is not blocked on interactive user authentication.
- The AES wrapping key remains non-exportable in Android Keystore.
- Wrap the random SQLCipher key using Android Keystore AES-GCM with a fresh random/provider nonce.
- Persist only a small versioned wrapped-key record (version, nonce, ciphertext/tag) in app-private storage.

Do not derive the SQLCipher key from device identifiers, PINs, bearer tokens, P-256 signing keys, or hard-coded secrets.

### 8.3 Process death/restart

On every process start:

1. load wrapped-key record;
2. load the existing Keystore wrapping key;
3. AES-GCM unwrap the SQLCipher key in memory;
4. open SQLCipher with that key;
5. zero temporary raw-key byte arrays where practical after the database library has consumed them.

Object recreation/process death therefore does not rotate the database key.

### 8.4 Keystore/key-loss failure behavior

If an encrypted database and wrapped key exist but the Keystore wrapping key is missing/invalidated, the app MUST NOT silently create a new wrapping key and overwrite metadata. That would orphan the emergency database while making the failure look like an empty new install.

Fail closed into an explicit local-storage recovery state. Delivery/report UI must not claim the old emergency records are available.

Whether a recoverable escrow copy of the database key is allowed is an operational decision. This design does not add server escrow by default.

### 8.5 Plaintext SQLite migration

Existing `sagip.db` installations require a one-time non-destructive plaintext-to-SQLCipher migration.

Required high-level sequence:

1. Acquire exclusive migration ownership before normal database open.
2. Verify that the existing database is a readable plaintext SAGIP SQLite database and record its schema version.
3. Generate/store the wrapped SQLCipher key.
4. Create a new encrypted temporary database in the same app-private database directory.
5. Use SQLCipher-supported export/migration functionality to copy the plaintext schema/data into the encrypted database.
6. Run integrity checks and verify `PRAGMA user_version` plus critical row/table invariants.
7. Close both databases and fsync/finish durable writes.
8. Atomically replace the plaintext database only after encrypted verification succeeds.
9. Retain/clean backup artifacts according to a bounded crash-recovery state machine; do not leave a long-lived plaintext backup after confirmed success.
10. Open the final encrypted database and continue ordinary schema migrations if required.

A crash before replacement must leave the original plaintext database usable for migration retry. A crash after replacement must leave the encrypted database identifiable and reopenable. Migration code must distinguish plaintext/encrypted/temp/backup states rather than guessing.

### 8.6 Backups

Android cloud/auto backup of `sagip.db`, SQLCipher wrapped-key metadata, and related emergency database sidecars must be disabled or explicitly excluded unless a complete tested key-recovery design exists.

A copied encrypted database without the device's Keystore wrapping key is intentionally not recoverable by default.

### 8.7 WAL/sidecars

SQLCipher must protect SQLite pages including WAL/journal content under its normal encrypted database operation. Migration/backup cleanup must also account for `-wal`, `-shm`, and temporary export files so plaintext remnants are not left indefinitely.

## 9. Validation requirements

Protocol/crypto tests:

- HPKE encrypt/decrypt round trip;
- decryption with the wrong recipient key fails;
- corrupted HPKE ciphertext fails;
- recipient-context mismatch fails;
- SRE2 framing rejects duplicate key IDs, zero/oversized counts, truncated entries, and trailing bytes;
- SGP2 golden canonical unsigned-body field-order parsing across Android/backend;
- P-256 signature tamper test;
- encrypted-payload digest tamper test;
- SGP1 old vectors remain unchanged;
- SGP1/SGP2 version dispatcher compatibility;
- SGC1 round trip with an SGP2-sized opaque envelope;
- exact 8192-byte acceptance / 8193-byte rejection.

Local storage tests:

- wrapped DB key persists across key-store object/helper recreation;
- wrapped-key ciphertext corruption fails;
- missing/wrong Keystore wrapping key fails without generating a replacement;
- fresh install creates/open encrypted SQLCipher database;
- existing plaintext database migrates with rows/schema preserved;
- interrupted migration states are retry-safe;
- encrypted database does not open as plaintext SQLite;
- schema v1..current forward migrations still behave under SQLCipher;
- process/database reopen preserves reports/outbound/inbound/ACK rows.

Backend/responder tests:

- SGP2 verification never requires SRP1 plaintext decode;
- SGP2 ciphertext persistence is idempotent;
- no plaintext incident columns are populated from ciphertext;
- unauthorized responder APIs remain rejected;
- encrypted incident DTO/API does not fabricate plaintext fallbacks.

## 10. Cross-agent integration

### Agent 2 - backend/responder

Required before SGP2 can be production-enabled:

- add SGP2 verification/persistence path without server decryption;
- add a migration for encrypted incident revision/ciphertext representation rather than weakening existing v1 constraints in place;
- expose encrypted incident data only through authenticated/authorized responder APIs;
- keep SGP1 compatibility;
- do not default encrypted incident fields to legacy plaintext values;
- keep server operator outside responder private-key custody.

### Agent 3 - client/experience/responder UI

Required before SGP2 can be production-enabled:

- civilian UI must preserve local-save semantics when encryption preparation is pending;
- diagnostics must not log decrypted incident content or keys;
- responder UI must only display SGP2 incident detail after local authorized decryption;
- current browser responder console needs an approved local-key/HPKE implementation or replacement responder client; server-side decryption is not an acceptable shortcut;
- user-visible delivery state must not equate encrypted server acceptance with responder decryption/acknowledgement.

## 11. Agent 4 implementation and integration status

Implemented in this work session:

- Android SRE2 encrypted-payload framing with strict recipient bounds/canonical ordering and Tink `HybridEncrypt`/`HybridDecrypt` integration points.
- Android SGP2 transport envelope using the existing P-256 signing identity and the unchanged 8192-byte outer bound.
- Android version-aware SGP1/SGP2 verification for relay custody/offer/ACK paths, while preserving existing SGP1 bytes and retry behavior.
- Backend SRE2/SGP2 framing, digest, P-256 curve/signature verification, and explicit SGP1/SGP2 protocol dispatch without server-side SRP1 decode for SGP2.
- SQLCipher-backed `SagipDatabase`, random 256-bit database key generation, Android Keystore AES-GCM wrapping, fail-closed missing/corrupt key handling, and crash-aware plaintext SQLite export/replacement migration.
- Cross-platform SRE2 golden framing tests, old/new protocol compatibility tests, HPKE round-trip/wrong-key/corruption/context tests, signature/digest tamper tests, and 8192/8193 outer-bound tests.
- Instrumentation tests for plaintext-to-SQLCipher migration, wrong SQLCipher key rejection, wrapped-key corruption, missing Keystore key, manager recreation, and the encrypted-DB-with-no-key-state recovery edge case.

Intentionally **not activated**:

- `EnvelopePreparationService` still produces SGP1. SGP2 production emission is gated on a signed responder/agency public-key directory and a resolved stale-key/offline policy.
- Backend ingestion is not switched to SGP2 incident storage. Agent 2 must add a ciphertext representation/API path before enabling SGP2 traffic; storing decrypted SRP1 fields would violate the untrusted-backend goal.
- The responder browser console does not yet hold/decrypt responder private keys. Agent 3 needs an approved responder-local decryption client/key-custody design.
- SGA1 remains unchanged and is still plaintext/CRC32; an authenticated/confidential successor is a separate versioned protocol decision.

Validation status on 2026-09-28:

- full Android JVM unit suite: pass;
- targeted Android HPKE/SRE2/SGP2 suite: pass;
- Android instrumentation source including SQLCipher migration tests: compiles;
- backend SRE2/SGP2 suite: 5/5 pass;
- backend TypeScript typecheck: pass;
- connected SQLCipher/Keystore migration execution: **not run because this workspace has no connected Android device/emulator**.

The last item is a release-blocking validation gap for encrypted local storage. Run the instrumentation suite on representative physical/API targets before treating the migration as field-qualified.

## 12. Explicit open production decisions

The following are not resolved by unit tests and must be decided/tested operationally:

1. Who operates and signs the responder public-key directory trust anchor?
2. What is the exact recipient grouping model (city EOC, agency, station, dispatch team, etc.)?
3. What is the allowed maximum age of a cached signed key directory on a long-offline civilian device?
4. What happens when all cached encryption keys are expired or locally known revoked: keep only locally saved plaintext-at-rest report, or permit a defined emergency stale-key policy?
5. What is the responder private-key provisioning mechanism (MDM, hardware-backed device key, HSM/KMS-assisted provisioning, removable secure token, etc.)?
6. What is the disaster-recovery/escrow policy and approval quorum for lost responder keys?
7. How long must retired private keys remain available to decrypt delayed store-carry-forward traffic?
8. Which agencies receive each incident, and who decides the recipient set without exposing sensitive routing data?
9. Is SGA1 plaintext responder status/callsign acceptable, or is an authenticated/encrypted SGA2 required?
10. What is the secure responder-client platform for HPKE decryption if the browser console remains in use?
11. What are retention/deletion requirements for decrypted responder-side data?
12. What physical-device/OS versions are part of SQLCipher migration and Keystore-loss field qualification?

Until these are answered and physical/operational tests pass, the encryption design must be reported as implemented/validated only to the extent actually exercised, not as fully production-ready.
