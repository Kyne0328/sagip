package com.sagip.survival

object Schema {
  const val VERSION = 12

  private val GATEWAY_CREATE_STATEMENTS = listOf(
    "CREATE TABLE gateway_active_grant (singleton INTEGER PRIMARY KEY CHECK(singleton=1), grant_id TEXT NOT NULL REFERENCES receipt_grants(grant_id))",
    """
      CREATE TABLE gateway_work (
        action_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        observed_version INTEGER NOT NULL,
        status INTEGER NOT NULL CHECK(status BETWEEN 1 AND 4),
        note TEXT NOT NULL,
        saved_at_ms INTEGER NOT NULL,
        bound_grant_id TEXT REFERENCES receipt_grants(grant_id)
      )
    """.trimIndent(),
  )

  private val RECEIPT_CREATE_STATEMENTS = listOf(
    """
      CREATE TABLE receipt_report_state (
        report_id TEXT PRIMARY KEY NOT NULL,
        receipt_version INTEGER NOT NULL DEFAULT 0
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_report_identities (
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        report_protocol_version INTEGER NOT NULL,
        payload_digest BLOB NOT NULL,
        origin_key_id BLOB NOT NULL,
        origin_public_key_der BLOB NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (report_id, revision)
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_sequences (
        issuer_key_id BLOB NOT NULL,
        grant_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        PRIMARY KEY (issuer_key_id, grant_id, report_id)
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_actions (
        action_id TEXT PRIMARY KEY NOT NULL,
        issuer_provider_id BLOB NOT NULL,
        action_digest BLOB NOT NULL,
        issuer_key_id BLOB NOT NULL,
        grant_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        report_protocol_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        payload_digest BLOB NOT NULL,
        origin_key_id BLOB NOT NULL,
        responder_id TEXT NOT NULL,
        callsign TEXT NOT NULL,
        observed_incident_version INTEGER NOT NULL,
        status INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        forwarding_expires_at_ms INTEGER NOT NULL,
        note TEXT NOT NULL,
        proof_bytes BLOB NOT NULL,
        allocated_at_ms INTEGER NOT NULL,
        preparation_state TEXT NOT NULL,
        lease_token TEXT,
        lease_until_ms INTEGER
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_records (
        event_id TEXT PRIMARY KEY NOT NULL,
        object_kind TEXT NOT NULL,
        event_digest BLOB NOT NULL UNIQUE,
        object_bytes BLOB NOT NULL,
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        issuer_provider_id BLOB,
        sequence INTEGER,
        verification_kind TEXT NOT NULL,
        authority_checked_at_ms INTEGER,
        forwarding_expires_at_ms INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL,
        cloud_archived_at_ms INTEGER
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_projections (
        issuer_provider_id BLOB NOT NULL,
        report_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        verification_kind TEXT NOT NULL,
        authority_checked_at_ms INTEGER,
        notification_eligible INTEGER NOT NULL DEFAULT 0,
        requester_delivery_state TEXT NOT NULL DEFAULT 'UNKNOWN',
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (issuer_provider_id, report_id)
      )
    """.trimIndent(),
    """
      CREATE TABLE requester_receipt_actions (
        ack_event_id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        report_id TEXT NOT NULL,
        report_protocol_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        origin_key_id BLOB NOT NULL,
        origin_public_key_der BLOB NOT NULL,
        ack_digest BLOB NOT NULL,
        received_at_ms INTEGER NOT NULL,
        forwarding_expires_at_ms INTEGER NOT NULL,
        preparation_state TEXT NOT NULL,
        lease_token TEXT,
        lease_until_ms INTEGER
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_quarantine (
        object_digest BLOB PRIMARY KEY NOT NULL,
        claimed_event_id TEXT,
        object_bytes BLOB NOT NULL,
        report_id TEXT,
        revision INTEGER,
        reason TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_grants (
        grant_id TEXT PRIMARY KEY NOT NULL,
        issuer_provider_id BLOB NOT NULL,
        issuer_key_id BLOB NOT NULL,
        object_digest BLOB NOT NULL UNIQUE,
        object_bytes BLOB NOT NULL,
        received_at_ms INTEGER NOT NULL,
        authority_checked_at_ms INTEGER,
        revoked_at_ms INTEGER
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_time_challenges (
        challenge_id TEXT PRIMARY KEY NOT NULL,
        verifier_id BLOB NOT NULL,
        verifier_boot_session_id TEXT NOT NULL,
        nonce BLOB NOT NULL,
        sent_elapsed_ms INTEGER NOT NULL,
        high_water_earliest_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_time_checkpoints (
        checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id TEXT NOT NULL UNIQUE,
        verifier_id BLOB NOT NULL,
        earliest_ms INTEGER NOT NULL,
        latest_ms INTEGER NOT NULL,
        boot_id TEXT NOT NULL,
        received_elapsed_ms INTEGER NOT NULL,
        valid_until_ms INTEGER NOT NULL,
        proof_digest TEXT NOT NULL,
        committed_at_ms INTEGER NOT NULL
      )
    """.trimIndent(),
    """
      CREATE TABLE receipt_time_high_water (
        verifier_id BLOB PRIMARY KEY NOT NULL,
        earliest_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    """.trimIndent(),
    "CREATE INDEX idx_receipt_identities_report ON receipt_report_identities(report_id, revision DESC)",
    "CREATE INDEX idx_receipt_actions_report ON receipt_actions(report_id, revision, sequence)",
    "CREATE UNIQUE INDEX idx_receipt_actions_issuer_sequence ON receipt_actions(issuer_key_id, grant_id, report_id, sequence)",
    "CREATE INDEX idx_receipt_records_report ON receipt_records(report_id, revision, received_at_ms)",
    "CREATE INDEX idx_receipt_projections_report ON receipt_projections(report_id, revision, sequence)",
    "CREATE INDEX idx_receipt_quarantine_received ON receipt_quarantine(received_at_ms)",
  )
  private val RELAY_CREATE_STATEMENTS = listOf(
    "ALTER TABLE receipt_quarantine ADD COLUMN claimed_object_kind INTEGER",
    """
      CREATE TABLE relay_objects (
        object_kind INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        object_digest BLOB NOT NULL UNIQUE,
        object_bytes BLOB NOT NULL,
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        signed_issued_at_ms INTEGER,
        signed_expires_at_ms INTEGER,
        custody_accepted_at_ms INTEGER NOT NULL,
        custody_expires_at_ms INTEGER NOT NULL,
        verification_class TEXT NOT NULL,
        transport_state TEXT NOT NULL,
        accounted_bytes INTEGER NOT NULL,
        PRIMARY KEY (object_kind, object_id),
        CHECK (object_kind IN (1, 2, 3))
      )
    """.trimIndent(),
    """
      CREATE TABLE relay_object_tombstones (
        object_kind INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        object_digest BLOB NOT NULL,
        signed_expires_at_ms INTEGER,
        protected_until_ms INTEGER NOT NULL,
        accounted_bytes INTEGER NOT NULL,
        PRIMARY KEY (object_kind, object_id),
        CHECK (object_kind IN (1, 2, 3))
      )
    """.trimIndent(),
    """
      CREATE TABLE relay_time_state (
        state_id INTEGER PRIMARY KEY NOT NULL CHECK (state_id = 1),
        high_water_earliest_ms INTEGER NOT NULL
      )
    """.trimIndent(),
    "CREATE INDEX idx_relay_objects_report ON relay_objects(report_id, revision, object_kind)",
    "CREATE INDEX idx_relay_objects_transport ON relay_objects(transport_state, custody_expires_at_ms)",
    "CREATE INDEX idx_relay_tombstones_protected ON relay_object_tombstones(protected_until_ms)",
  )

  private val TRANSFER_CREATE_STATEMENTS = listOf(
    """
      CREATE TABLE relay_peer_object_state (
        peer_id TEXT NOT NULL,
        object_kind INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        terminal_outcome TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (peer_id, object_kind, object_id),
        CHECK (object_kind IN (1, 2, 3))
      )
    """.trimIndent(),
    """
      CREATE TABLE relay_transfer_leases (
        lease_id TEXT PRIMARY KEY NOT NULL,
        object_kind INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        object_digest BLOB NOT NULL,
        peer_id TEXT NOT NULL,
        lease_until_ms INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT,
        created_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        CHECK (object_kind IN (1, 2, 3)),
        CHECK (state IN ('ACTIVE', 'COMPLETED', 'EXPIRED'))
      )
    """.trimIndent(),
    "CREATE UNIQUE INDEX idx_relay_transfer_active_object ON relay_transfer_leases(object_kind, object_id) WHERE state='ACTIVE'",
    "CREATE INDEX idx_relay_peer_due ON relay_peer_object_state(peer_id, terminal_outcome, next_attempt_at_ms)",
    "CREATE INDEX idx_relay_transfer_peer_state ON relay_transfer_leases(peer_id, state, lease_until_ms)",
  )

  private val CONTACT_CREATE_STATEMENTS = listOf(
    """
      CREATE TABLE relay_peer_contacts (
        peer_id TEXT PRIMARY KEY NOT NULL,
        contact_started_at_ms INTEGER NOT NULL,
        last_activity_at_ms INTEGER NOT NULL,
        attempted_transfers INTEGER NOT NULL DEFAULT 0,
        CHECK (attempted_transfers BETWEEN 0 AND 8)
      )
    """.trimIndent(),
    "CREATE INDEX idx_relay_peer_contacts_activity ON relay_peer_contacts(last_activity_at_ms)",
  )

  val CREATE_STATEMENTS = listOf(
    """
      CREATE TABLE reports (
        report_id TEXT PRIMARY KEY NOT NULL,
        created_at INTEGER NOT NULL,
        emergency_type TEXT NOT NULL,
        urgency TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL
      )
    """.trimIndent(),
    """
      CREATE TABLE report_revisions (
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        emergency_type TEXT NOT NULL,
        urgency TEXT NOT NULL,
        PRIMARY KEY (report_id, revision),
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE locations (
        location_id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id TEXT NOT NULL UNIQUE,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracy_meters REAL,
        captured_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        freshness TEXT NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE outbound_envelopes (
        message_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        envelope_bytes BLOB,
        priority INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        next_attempt_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        delivery_state TEXT NOT NULL,
        preparation_state TEXT NOT NULL DEFAULT 'NEEDS_PREPARATION',
        FOREIGN KEY (report_id, revision) REFERENCES report_revisions(report_id, revision) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE delivery_events (
        event_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE delivery_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        peer_identifier TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        outcome TEXT,
        retry_classification TEXT,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE server_receipts (
        receipt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE inbound_envelopes (
        inbound_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        report_id TEXT,
        envelope_bytes BLOB NOT NULL,
        received_at INTEGER NOT NULL,
        origin_key_id BLOB NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        delivery_state TEXT NOT NULL DEFAULT 'DELIVERY_PENDING',
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0
      )
    """.trimIndent(),
    """
      CREATE TABLE seen_messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        digest BLOB NOT NULL,
        first_seen_at INTEGER NOT NULL
      )
    """.trimIndent(),
    """
      CREATE TABLE relay_receipts (
        receipt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        peer_identifier TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE responder_acks (
        ack_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        responder_id TEXT NOT NULL,
        callsign TEXT,
        status TEXT NOT NULL,
        note TEXT,
        acknowledged_at INTEGER NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE relay_responder_acks (
        ack_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        responder_id TEXT NOT NULL,
        callsign TEXT,
        status TEXT NOT NULL,
        note TEXT,
        acknowledged_at INTEGER NOT NULL,
        UNIQUE(report_id, status, acknowledged_at)
      )
    """.trimIndent(),
    "CREATE INDEX idx_outbound_due ON outbound_envelopes(delivery_state, next_attempt_at, priority, created_at)",
    "CREATE INDEX idx_outbound_ready_due ON outbound_envelopes(preparation_state, delivery_state, next_attempt_at, priority, created_at)",
    "CREATE INDEX idx_delivery_attempts_message ON delivery_attempts(message_id, started_at)",
    "CREATE INDEX idx_server_receipts_report ON server_receipts(report_id)",
    "CREATE INDEX idx_inbound_due ON inbound_envelopes(delivery_state, next_attempt_at, priority, received_at)",
    "CREATE INDEX idx_inbound_report ON inbound_envelopes(report_id)",
    "CREATE INDEX idx_seen_messages_digest ON seen_messages(digest)",
    "CREATE INDEX idx_relay_receipts_message ON relay_receipts(message_id)",
    "CREATE INDEX idx_responder_acks_report ON responder_acks(report_id)",
    "CREATE INDEX idx_relay_responder_acks_report ON relay_responder_acks(report_id, acknowledged_at DESC)",
  ) + RECEIPT_CREATE_STATEMENTS + RELAY_CREATE_STATEMENTS + TRANSFER_CREATE_STATEMENTS + CONTACT_CREATE_STATEMENTS + GATEWAY_CREATE_STATEMENTS

  val MIGRATE_1_TO_2 = listOf(
    "ALTER TABLE outbound_envelopes ADD COLUMN envelope_bytes BLOB",
    "ALTER TABLE outbound_envelopes ADD COLUMN priority INTEGER NOT NULL DEFAULT 100",
    "ALTER TABLE outbound_envelopes ADD COLUMN expires_at INTEGER",
    "ALTER TABLE outbound_envelopes ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE outbound_envelopes ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
    """
      CREATE TABLE delivery_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        peer_identifier TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        outcome TEXT,
        retry_classification TEXT,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    "CREATE INDEX idx_outbound_due ON outbound_envelopes(delivery_state, next_attempt_at, priority, created_at)",
    "CREATE INDEX idx_delivery_attempts_message ON delivery_attempts(message_id, started_at)",
  )

  val MIGRATE_2_TO_3 = listOf(
    "ALTER TABLE outbound_envelopes ADD COLUMN preparation_state TEXT NOT NULL DEFAULT 'NEEDS_PREPARATION'",
    "CREATE INDEX idx_outbound_ready_due ON outbound_envelopes(preparation_state, delivery_state, next_attempt_at, priority, created_at)",
  )

  val MIGRATE_3_TO_4 = listOf(
    "CREATE TABLE server_receipts (receipt_id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL UNIQUE, report_id TEXT NOT NULL, revision INTEGER NOT NULL, accepted_at TEXT NOT NULL, FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE)",
    "CREATE INDEX idx_server_receipts_report ON server_receipts(report_id)",
  )

  val MIGRATE_4_TO_5 = listOf(
    """
      CREATE TABLE inbound_envelopes (
        inbound_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        envelope_bytes BLOB NOT NULL,
        received_at INTEGER NOT NULL,
        origin_key_id BLOB NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        delivery_state TEXT NOT NULL DEFAULT 'DELIVERY_PENDING',
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0
      )
    """.trimIndent(),
    """
      CREATE TABLE seen_messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        digest BLOB NOT NULL,
        first_seen_at INTEGER NOT NULL
      )
    """.trimIndent(),
    """
      CREATE TABLE relay_receipts (
        receipt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        peer_identifier TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    "CREATE INDEX idx_inbound_due ON inbound_envelopes(delivery_state, next_attempt_at, priority, received_at)",
    "CREATE INDEX idx_seen_messages_digest ON seen_messages(digest)",
    "CREATE INDEX idx_relay_receipts_message ON relay_receipts(message_id)",
  )

  val MIGRATE_5_TO_6 = listOf(
    """
      CREATE TABLE responder_acks (
        ack_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        responder_id TEXT NOT NULL,
        callsign TEXT,
        status TEXT NOT NULL,
        note TEXT,
        acknowledged_at INTEGER NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    "CREATE INDEX idx_responder_acks_report ON responder_acks(report_id)",
  )

  val MIGRATE_6_TO_7 = listOf(
    "ALTER TABLE inbound_envelopes ADD COLUMN report_id TEXT",
    "CREATE INDEX idx_inbound_report ON inbound_envelopes(report_id)",
    """
      CREATE TABLE relay_responder_acks (
        ack_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        responder_id TEXT NOT NULL,
        callsign TEXT,
        status TEXT NOT NULL,
        note TEXT,
        acknowledged_at INTEGER NOT NULL,
        UNIQUE(report_id, status, acknowledged_at)
      )
    """.trimIndent(),
    "CREATE INDEX idx_relay_responder_acks_report ON relay_responder_acks(report_id, acknowledged_at DESC)",
  )

  val MIGRATE_7_TO_8 = RECEIPT_CREATE_STATEMENTS
  val MIGRATE_8_TO_9 = RELAY_CREATE_STATEMENTS
  val MIGRATE_9_TO_10 = TRANSFER_CREATE_STATEMENTS
  val MIGRATE_10_TO_11 = CONTACT_CREATE_STATEMENTS
  val MIGRATE_11_TO_12 = GATEWAY_CREATE_STATEMENTS
}
