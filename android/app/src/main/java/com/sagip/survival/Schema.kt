package com.sagip.survival

object Schema {
  const val VERSION = 8

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
        message TEXT CHECK(message IS NULL OR length(CAST(message AS BLOB)) <= 500),
        latitude REAL,
        longitude REAL,
        accuracy_meters REAL,
        captured_at INTEGER,
        source TEXT,
        freshness TEXT,
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
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        envelope_bytes BLOB,
        priority INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        next_attempt_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        delivery_state TEXT NOT NULL,
        preparation_state TEXT NOT NULL DEFAULT 'NEEDS_PREPARATION',
        UNIQUE(report_id, revision),
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
    """
      CREATE TABLE detail_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        request_digest TEXT NOT NULL,
        result_revision INTEGER NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
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
  )

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

  // SQLiteOpenHelper runs upgrades in one transaction. Foreign keys remain enabled.
  // Preserve and remove child tables BEFORE dropping the populated parent; DROP otherwise cascades.
  // https://www.sqlite.org/foreignkeys.html#fk_schemacommands
  // Frozen v8 DDL/explicit copies intentionally do not depend on future CREATE_STATEMENTS changes.
  val MIGRATE_7_TO_8 = listOf(
    "ALTER TABLE report_revisions ADD COLUMN message TEXT CHECK(message IS NULL OR length(CAST(message AS BLOB)) <= 500)",
    "ALTER TABLE report_revisions ADD COLUMN latitude REAL",
    "ALTER TABLE report_revisions ADD COLUMN longitude REAL",
    "ALTER TABLE report_revisions ADD COLUMN accuracy_meters REAL",
    "ALTER TABLE report_revisions ADD COLUMN captured_at INTEGER",
    "ALTER TABLE report_revisions ADD COLUMN source TEXT",
    "ALTER TABLE report_revisions ADD COLUMN freshness TEXT",
    "UPDATE report_revisions SET latitude = (SELECT latitude FROM locations WHERE locations.report_id = report_revisions.report_id) WHERE revision = 1",
    "UPDATE report_revisions SET longitude = (SELECT longitude FROM locations WHERE locations.report_id = report_revisions.report_id) WHERE revision = 1",
    "UPDATE report_revisions SET accuracy_meters = (SELECT accuracy_meters FROM locations WHERE locations.report_id = report_revisions.report_id) WHERE revision = 1",
    "UPDATE report_revisions SET captured_at = (SELECT captured_at FROM locations WHERE locations.report_id = report_revisions.report_id) WHERE revision = 1",
    "UPDATE report_revisions SET source = (SELECT source FROM locations WHERE locations.report_id = report_revisions.report_id) WHERE revision = 1",
    "UPDATE report_revisions SET freshness = (SELECT freshness FROM locations WHERE locations.report_id = report_revisions.report_id) WHERE revision = 1",
    "CREATE TEMP TABLE p07_delivery_events AS SELECT event_id, report_id, message_id, event_type, occurred_at FROM delivery_events",
    "DROP TABLE delivery_events",
    "CREATE TEMP TABLE p07_delivery_attempts AS SELECT attempt_id, message_id, transport, peer_identifier, started_at, completed_at, outcome, retry_classification FROM delivery_attempts",
    "DROP TABLE delivery_attempts",
    "CREATE TEMP TABLE p07_server_receipts AS SELECT receipt_id, message_id, report_id, revision, accepted_at FROM server_receipts",
    "DROP TABLE server_receipts",
    "CREATE TEMP TABLE p07_relay_receipts AS SELECT receipt_id, message_id, peer_identifier, acknowledged_at FROM relay_receipts",
    "DROP TABLE relay_receipts",
    """
      CREATE TABLE outbound_envelopes_v8 (
        message_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        envelope_bytes BLOB,
        priority INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        next_attempt_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        delivery_state TEXT NOT NULL,
        preparation_state TEXT NOT NULL DEFAULT 'NEEDS_PREPARATION',
        UNIQUE(report_id, revision),
        FOREIGN KEY (report_id, revision) REFERENCES report_revisions(report_id, revision) ON DELETE CASCADE
      )
    """.trimIndent(),
    "INSERT INTO outbound_envelopes_v8 (message_id, report_id, revision, envelope_bytes, priority, created_at, expires_at, next_attempt_at, attempt_count, delivery_state, preparation_state) SELECT message_id, report_id, revision, envelope_bytes, priority, created_at, expires_at, next_attempt_at, attempt_count, delivery_state, preparation_state FROM outbound_envelopes",
    "DROP TABLE outbound_envelopes",
    "ALTER TABLE outbound_envelopes_v8 RENAME TO outbound_envelopes",
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
    "INSERT INTO delivery_events (event_id, report_id, message_id, event_type, occurred_at) SELECT event_id, report_id, message_id, event_type, occurred_at FROM p07_delivery_events",
    "DROP TABLE p07_delivery_events",
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
    "INSERT INTO delivery_attempts (attempt_id, message_id, transport, peer_identifier, started_at, completed_at, outcome, retry_classification) SELECT attempt_id, message_id, transport, peer_identifier, started_at, completed_at, outcome, retry_classification FROM p07_delivery_attempts",
    "DROP TABLE p07_delivery_attempts",
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
    "INSERT INTO server_receipts (receipt_id, message_id, report_id, revision, accepted_at) SELECT receipt_id, message_id, report_id, revision, accepted_at FROM p07_server_receipts",
    "DROP TABLE p07_server_receipts",
    """
      CREATE TABLE relay_receipts (
        receipt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        peer_identifier TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    "INSERT INTO relay_receipts (receipt_id, message_id, peer_identifier, acknowledged_at) SELECT receipt_id, message_id, peer_identifier, acknowledged_at FROM p07_relay_receipts",
    "DROP TABLE p07_relay_receipts",
    "CREATE INDEX idx_outbound_due ON outbound_envelopes(delivery_state, next_attempt_at, priority, created_at)",
    "CREATE INDEX idx_outbound_ready_due ON outbound_envelopes(preparation_state, delivery_state, next_attempt_at, priority, created_at)",
    "CREATE INDEX idx_delivery_attempts_message ON delivery_attempts(message_id, started_at)",
    "CREATE INDEX idx_server_receipts_report ON server_receipts(report_id)",
    "CREATE INDEX idx_relay_receipts_message ON relay_receipts(message_id)",
    """
      CREATE TABLE detail_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        request_digest TEXT NOT NULL,
        result_revision INTEGER NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
      )
    """.trimIndent(),
  )
}
