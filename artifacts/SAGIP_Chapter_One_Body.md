# CHAPTER ONE

## INTRODUCTION

Communication is essential during an emergency. People must be able to report their condition, location, and need for help. However, disasters can also damage the communication systems that people depend on.

Mobile data may become unavailable during a disaster. Network infrastructure may fail or become congested. A mobile device may also move in and out of coverage. These conditions can prevent conventional mobile applications from reaching a remote server.

SAGIP addresses this problem through an offline-first and delay-tolerant design. The system does not require an active internet connection when a user creates an emergency report. It first stores the report on the user's device. The system then attempts to deliver the report when a communication path becomes available.

SAGIP uses local storage as the first protection against message loss. The system considers an SOS successfully created only after it stores the report in the local database. Internet access, Bluetooth connectivity, location data, and server availability are not required for this local operation.

When internet access is available, SAGIP can send the emergency report directly to its coordination backend. When internet access is not available, SAGIP can use Bluetooth Low Energy (BLE) to search for nearby SAGIP devices. A nearby device can receive the emergency report and store it locally.

The relay device can carry the emergency report while both devices remain offline. When the relay device later obtains internet access, it can send the stored report to the SAGIP backend. This process uses a store-carry-forward model.

The system also separates each delivery stage. A report that is stored on the device is not yet a report that reached the server. A report that moved to another SAGIP device is also not yet a report that reached a responder. SAGIP therefore presents different states for local storage, pending delivery, relay transfer, server acceptance, and responder acknowledgement.

SAGIP must also handle interrupted transfers and repeated delivery attempts. The system keeps stable report and message identifiers across retries and relay operations. This design helps the backend recognize repeated copies of the same emergency report as one logical incident.

The mobile application uses React Native and TypeScript for the civilian interface. A native Android Survival Core uses Kotlin to manage functions that must continue outside the normal JavaScript lifecycle. These functions include local persistence, BLE communication, delivery retries, cryptographic operations, background work, and recovery after application interruptions.

The backend uses Node.js, TypeScript, and PostgreSQL. It validates emergency envelopes, stores accepted incidents, prevents duplicate logical records, and supports responder operations. Authorized responders can acknowledge an incident after the backend accepts it.

SAGIP therefore combines local persistence, direct network delivery, BLE relay, backend coordination, and responder acknowledgement. The project studies whether these mechanisms can support emergency communication when normal connectivity is temporary, unreliable, or unavailable.

## PROJECT OVERVIEW

SAGIP is an offline-first emergency communication system for disaster-affected communities. It is designed to preserve emergency reports and continue delivery attempts during periods of network disruption.

The system starts with local storage. When a user creates an SOS, SAGIP stores the report in the device database before it starts any delivery operation. This rule protects the emergency report from network failure during creation.

The local database is the authoritative source of emergency state on the device. The system restores stored reports after an application restart. It also keeps the same report and message identities during retry and relay operations.

After the local save, SAGIP prepares the emergency data for delivery. The system can use two main delivery paths.

The first path uses an internet connection. SAGIP sends the prepared emergency envelope to the coordination backend when the backend is reachable. If the attempt fails because of a temporary condition, the system keeps the report eligible for another attempt.

The second path uses Bluetooth Low Energy. SAGIP can search for nearby compatible devices when direct internet delivery is not available. A nearby SAGIP device can receive the emergency envelope through BLE.

The receiving device must store the complete valid envelope before it reports successful custody to the sending device. This rule is called durable-before-acknowledgement behavior. It reduces the risk of reporting a successful relay when the receiving device did not preserve the data.

A relay device can later become a gateway. When the relay device obtains internet access, it sends the stored emergency envelope to the SAGIP backend. The gateway sends the original envelope data instead of creating a new incident.

The SAGIP backend validates the received envelope and stores the incident in PostgreSQL. The backend also uses idempotent processing. Repeated delivery of the same logical emergency message must not create separate incidents.

Authorized responders can access accepted incidents through responder services. A responder can record an operational status such as `ACKNOWLEDGED`, `EN_ROUTE`, `ON_SCENE`, or `RESOLVED`.

Responder acknowledgement is separate from server acceptance. The application must not tell the user that a responder acknowledged the incident when only the server accepted it.

A relay device can also obtain responder status for a report that it delivered for another phone. The relay device stores this acknowledgement separately from its own civilian reports. It can later return the acknowledgement to the originating device through BLE.

The intended complete flow is:

**Create SOS -> store locally -> prepare emergency envelope -> use internet or BLE relay -> reach gateway -> reach backend -> record responder acknowledgement -> return acknowledgement toward the origin**

The current implementation contains the main software components for this flow. Automated tests cover many parts of the system. Android instrumentation also validates important native functions.

The project has physical-device evidence for selected Android functions. It also has live PostgreSQL and backend evidence. However, the complete flow has not yet passed the required two-phone physical field test.

The remaining field test must use two physical Android devices. The test must show BLE custody from the offline origin device to a relay device. The relay must later send the report to the live backend. A responder must acknowledge the incident. The acknowledgement must then return to the offline origin through physical BLE communication.

Current `main` also contains newer security work. This work includes SQLCipher-based local database encryption and an encrypted SGP2 emergency-envelope design.

These newer security functions are not yet the normal field-test path. SGP2 production emission is still disabled. Its activation depends on responder public-key distribution, responder key custody, and compatible responder-side decryption.

SQLCipher support is implemented in the current code. However, its migration and recovery behavior still requires connected physical-device qualification before the project can describe it as field-qualified.

## REQUIREMENTS

The SAGIP requirements support one main objective. The system must preserve an emergency report and continue delivery attempts even when network access is unavailable.

The requirements are divided into functional and non-functional requirements.

### Functional Requirements

1. **Emergency Report Creation**
   - The system shall allow a user to create an SOS.
   - The user shall be able to select an emergency type.
   - The user shall be able to select an urgency level.
   - The system shall allow SOS creation without internet access.
   - A location failure shall not prevent the system from saving the SOS.

2. **Durable Local Persistence**
   - The system shall store the emergency report before it reports successful creation.
   - The system shall keep stored reports after an application restart.
   - SQLite shall serve as the authoritative local emergency database.
   - The system shall keep stable report and message identifiers across retries.
   - The system shall keep stable identifiers across relay operations.

3. **Location Capture**
   - The system shall attempt to obtain GPS or GNSS location data when available.
   - Location capture shall use a best-effort process.
   - The system shall store available location accuracy information.
   - The system shall store the location capture time when available.
   - An SOS without location data shall remain valid.

4. **Direct Network Delivery**
   - The system shall attempt direct backend delivery when network access is available.
   - A temporary delivery failure shall not delete the emergency report.
   - The system shall keep failed temporary deliveries eligible for another attempt.
   - The system shall reuse the prepared emergency envelope during retries.
   - The system shall store server acceptance separately from local creation.

5. **Bluetooth Low Energy Relay**
   - The system shall search for nearby compatible SAGIP devices through BLE.
   - A compatible relay device shall be able to receive an emergency envelope without internet access.
   - The relay device shall validate the complete envelope before it accepts custody.
   - The relay device shall store the complete envelope before it returns a custody acknowledgement.
   - The system shall detect duplicate messages when possible.
   - BLE permission failure shall not prevent local SOS creation.

6. **Store-Carry-Forward Delivery**
   - A relay device shall retain an accepted emergency envelope after the originating device leaves BLE range.
   - The relay device shall send the stored envelope when internet access becomes available.
   - The relay device shall preserve the original report identity.
   - The relay device shall preserve the original message identity.
   - Repeated server delivery shall not create duplicate logical incidents.

7. **Responder Coordination**
   - Responder operations shall require authentication.
   - An authorized responder shall be able to view accepted incidents.
   - An authorized responder shall be able to record an operational status.
   - The system shall support the defined responder states.
   - Responder acknowledgement shall remain separate from server acceptance.

8. **Return Acknowledgement**
   - A gateway shall be able to request responder status for a relayed report.
   - The gateway shall store the responder acknowledgement before BLE return delivery.
   - A gateway-held acknowledgement shall not create a local civilian incident.
   - The gateway shall make the stored acknowledgement available for BLE return.
   - The origin device shall store a valid acknowledgement before it displays responder acknowledgement.
   - Duplicate acknowledgement delivery shall not create duplicate logical acknowledgement records.

9. **Background Operation and Recovery**
   - Critical emergency delivery work shall not depend only on the React Native JavaScript lifecycle.
   - Native Android components shall manage lifecycle-sensitive delivery work.
   - The system shall retain emergency state after supported process interruptions.
   - The system shall restore applicable delivery scheduling after device restart.
   - BLE relay recovery shall depend on valid permission and Bluetooth readiness.

10. **Delivery Status Presentation**
    - The system shall show when an SOS is saved on the device.
    - The system shall show when delivery is pending.
    - The system shall show when another SAGIP device accepted relay custody.
    - The system shall show when the server accepted the report.
    - The system shall show when a responder acknowledged the incident.
    - The system shall not use one general "sent" state for different delivery stages.

### Non-Functional Requirements

1. **Reliability Requirements**
   - The system shall preserve a valid emergency report after local commit.
   - A temporary network failure shall not silently remove emergency data.
   - An interrupted delivery shall remain recoverable when the design permits a retry.
   - Repeated delivery shall preserve logical incident identity.
   - Critical state changes shall use durable storage.

2. **Security Requirements**
   - The system shall verify the integrity of supported emergency envelopes.
   - The system shall verify origin signatures for supported signed envelopes.
   - Android signing keys shall use Android Keystore protection.
   - The application repository shall not contain production private keys.
   - The repository shall not contain production responder bearer tokens.
   - The repository shall not contain private database credentials.
   - The repository shall not contain Android production signing credentials.
   - New encrypted transport functions shall remain gated until their required key infrastructure is available.

3. **Privacy Requirements**
   - Relay devices should not require emergency plaintext to forward protected payloads when the protocol supports opaque relay.
   - Logs shall not expose private cryptographic keys.
   - Public release artifacts shall not contain responder credentials.
   - Public release artifacts shall not contain database credentials.
   - Diagnostic information shall avoid unnecessary private incident data.

4. **Performance Requirements**
   - The transport envelope shall not exceed the defined 8192-byte maximum.
   - BLE transfer shall use bounded binary frames.
   - Retry operations shall avoid unnecessary envelope regeneration.
   - The system shall limit unnecessary mobile CPU and radio use.

5. **Battery Requirements**
   - BLE activity shall adapt to active emergency work.
   - The system shall use higher BLE activity during recent urgent work.
   - The system shall reduce BLE activity during longer offline periods.
   - Battery conservation shall not delete active emergency work.
   - Completed historical incidents shall not keep the radio in a high-power state.

6. **Compatibility Requirements**
   - The system shall preserve compatibility with established protocol versions when required.
   - Protocol changes shall use explicit versioning.
   - Android BLE permission handling shall account for Android version differences.
   - Persisted database upgrades shall use defined migrations.
   - Existing emergency envelope data shall not be silently rewritten during normal migration.

7. **Usability Requirements**
   - Emergency controls shall use clear labels.
   - The interface shall use plain status descriptions.
   - The interface shall avoid unnecessary transport terminology for civilian users.
   - Critical actions shall use practical touch-target sizes.
   - Status information shall not depend only on color.

8. **Accessibility Requirements**
   - Important controls shall provide accessibility labels.
   - Important controls shall provide accessibility hints when required.
   - Delivery updates shall support accessible status announcements.
   - Critical text shall remain readable with supported accessibility settings.
   - Emergency status shall use both text and visual indicators.

9. **Idempotency Requirements**
   - Repeated network submission shall not create duplicate logical incidents.
   - Repeated BLE encounters shall not create unnecessary duplicate custody records.
   - Repeated responder acknowledgement delivery shall not create duplicate logical acknowledgement state.
   - Server retry processing shall return consistent canonical results when applicable.

10. **Maintainability Requirements**
    - The system shall use explicit local database migrations.
    - The backend shall use explicit PostgreSQL migrations.
    - React Native shall remain responsible for the main user experience.
    - Native Kotlin shall remain responsible for lifecycle-sensitive survival functions.
    - The backend shall remain responsible for coordination and canonical server state.
    - Protocol behavior shall remain documented as a compatibility contract.

11. **Field-Validation Requirements**
    - Automated tests shall not count as complete physical field validation.
    - Emulator BLE results shall not replace a two-device physical BLE test.
    - A foreground-service test shall not prove BLE custody between devices.
    - The first milestone shall use two physical Android phones.
    - The relay path shall use a live PostgreSQL-backed backend.
    - The test shall include physical BLE custody from Phone A to Phone B.
    - The test shall include server acceptance.
    - The test shall include responder acknowledgement.
    - The test shall include physical acknowledgement return from Phone B to Phone A.
    - The project shall keep the milestone status incomplete until the complete path passes.
