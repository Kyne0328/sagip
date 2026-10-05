package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SchemaTest {
  @Test
  fun `schema version is explicit and preparation state is present`() {
    assertEquals(19, Schema.VERSION)
    val ddl = Schema.CREATE_STATEMENTS.joinToString("\n")
    listOf(
      "reports",
      "report_revisions",
      "locations",
      "outbound_envelopes",
      "delivery_events",
      "delivery_attempts",
      "server_receipts",
      "inbound_envelopes",
      "seen_messages",
      "relay_receipts",
      "responder_acks",
      "relay_responder_acks",
      "detail_operations",
      "receipt_report_state",
      "receipt_report_identities",
      "receipt_sequences",
      "receipt_actions",
      "receipt_records",
      "receipt_projections",
      "requester_receipt_actions",
      "receipt_quarantine",
      "receipt_grants",
      "receipt_time_challenges",
      "receipt_time_checkpoints",
      "receipt_time_high_water",
      "relay_objects",
      "relay_object_tombstones",
      "relay_time_state",
      "relay_peer_object_state",
      "relay_transfer_leases",
      "relay_peer_contacts",
      "gateway_active_grant",
      "gateway_work",
      "gateway_pairings",
      "gateway_browser_sessions",
      "gateway_pairing_clock",
      "gateway_admission_global",
      "gateway_admission_sources",
    ).forEach {
      assertTrue("missing table $it", ddl.contains("CREATE TABLE $it"))
    }
    assertTrue(ddl.contains("PRIMARY KEY (report_id, revision)"))
    assertTrue(ddl.contains("next_attempt_at INTEGER NOT NULL"))
    assertTrue(ddl.contains("attempt_count INTEGER NOT NULL DEFAULT 0"))
    assertTrue(ddl.contains("preparation_state TEXT NOT NULL DEFAULT 'NEEDS_PREPARATION'"))
    assertTrue(ddl.contains("FOREIGN KEY (message_id) REFERENCES outbound_envelopes"))
    assertTrue(ddl.contains("CREATE TABLE inbound_envelopes"))
    assertTrue(ddl.contains("CREATE TABLE seen_messages"))
    assertTrue(ddl.contains("CREATE TABLE relay_receipts"))
    assertTrue(ddl.contains("CREATE TABLE responder_acks"))
    assertTrue(ddl.contains("CREATE TABLE relay_responder_acks"))
  }

  @Test
  fun `v1 to v2 migration is non destructive and adds retry state`() {
    val migration = Schema.MIGRATE_1_TO_2.joinToString("\n")
    assertTrue(migration.contains("ALTER TABLE outbound_envelopes ADD COLUMN next_attempt_at"))
    assertTrue(migration.contains("CREATE TABLE delivery_attempts"))
    assertTrue(!migration.contains("DROP TABLE"))
  }

  @Test
  fun `v2 to v3 migration is non destructive and adds preparation state`() {
    val migration = Schema.MIGRATE_2_TO_3.joinToString("\n")
    assertTrue(migration.contains("ALTER TABLE outbound_envelopes ADD COLUMN preparation_state"))
    assertTrue(migration.contains("CREATE INDEX idx_outbound_ready_due"))
    assertTrue(!migration.contains("DROP TABLE"))
  }

  @Test
  fun `v3 to v4 migration is non destructive and adds server receipts`() {
    val migration = Schema.MIGRATE_3_TO_4.joinToString("\n")
    assertTrue(migration.contains("CREATE TABLE server_receipts"))
    assertTrue(migration.contains("message_id TEXT NOT NULL UNIQUE"))
    assertTrue(!migration.contains("DROP TABLE"))
  }

  @Test
  fun `v4 to v5 migration is non destructive and adds relay tables`() {
    val migration = Schema.MIGRATE_4_TO_5.joinToString("\n")
    assertTrue(migration.contains("CREATE TABLE inbound_envelopes"))
    assertTrue(migration.contains("CREATE TABLE seen_messages"))
    assertTrue(migration.contains("CREATE TABLE relay_receipts"))
    assertTrue(migration.contains("idx_inbound_due"))
    assertTrue(!migration.contains("DROP TABLE"))
  }

  @Test
  fun `v5 to v6 migration is non destructive and adds responder acks`() {
    val migration = Schema.MIGRATE_5_TO_6.joinToString("\n")
    assertTrue(migration.contains("CREATE TABLE responder_acks"))
    assertTrue(migration.contains("idx_responder_acks_report"))
    assertTrue(!migration.contains("DROP TABLE"))
  }

  @Test
  fun `v6 to v7 migration is non destructive and adds gateway return ack state`() {
    val migration = Schema.MIGRATE_6_TO_7.joinToString("\n")
    assertTrue(migration.contains("ALTER TABLE inbound_envelopes ADD COLUMN report_id"))
    assertTrue(migration.contains("CREATE TABLE relay_responder_acks"))
    assertTrue(migration.contains("idx_relay_responder_acks_report"))
    assertTrue(!migration.contains("DROP TABLE"))
  }
  @Test
  fun `v7 to v8 migration is non destructive and adds durable receipt state`() {
    val migration = Schema.MIGRATE_7_TO_8.joinToString("\n")
    assertTrue(migration.contains("CREATE TABLE receipt_actions"))
    assertTrue(migration.contains("CREATE TABLE receipt_records"))
    assertTrue(migration.contains("CREATE TABLE receipt_projections"))
    assertTrue(migration.contains("CREATE TABLE receipt_time_checkpoints"))
    assertTrue(migration.contains("CREATE UNIQUE INDEX idx_receipt_actions_issuer_sequence"))
    assertTrue(!migration.contains("DROP TABLE"))
  }

  @Test
  fun `v8 to v9 migration is non destructive and adds bounded relay custody`() {
    val migration = Schema.MIGRATE_8_TO_9.joinToString("\n")
    assertTrue(migration.contains("CREATE TABLE relay_objects"))
    assertTrue(migration.contains("CREATE TABLE relay_object_tombstones"))
    assertTrue(migration.contains("CREATE TABLE relay_time_state"))
    assertTrue(migration.contains("ALTER TABLE receipt_quarantine ADD COLUMN claimed_object_kind"))
    assertTrue(!migration.contains("DROP TABLE"))
  }

  @Test
  fun `v9 to v10 migration is non destructive and adds persisted transfer state`() {
    val migration = Schema.MIGRATE_9_TO_10.joinToString("\n")
    assertTrue(migration.contains("CREATE TABLE relay_peer_object_state"))
    assertTrue(migration.contains("CREATE TABLE relay_transfer_leases"))
    assertTrue(migration.contains("idx_relay_transfer_active_object"))
    assertTrue(!migration.contains("DROP TABLE"))
  }
  @Test
  fun `v16 to v17 migration preserves existing delivery evidence and enables immutable detail revisions`() {
    val migration = Schema.MIGRATE_16_TO_17.joinToString("\n")
    assertTrue(migration.contains("ALTER TABLE report_revisions ADD COLUMN message"))
    assertTrue(migration.contains("UNIQUE(report_id, revision)"))
    assertTrue(migration.contains("CREATE TABLE detail_operations"))
    assertTrue(migration.contains("CREATE TEMP TABLE p16_delivery_events"))
    assertTrue(migration.contains("INSERT INTO delivery_events"))
  }

  @Test
  fun `v14 to v15 migration preserves delegated time proof bytes`() {
    val migration = Schema.MIGRATE_14_TO_15.joinToString("\n")
    assertTrue(migration.contains("ALTER TABLE receipt_time_checkpoints ADD COLUMN proof_bytes BLOB"))
    assertTrue(!migration.contains("DROP TABLE"))
  }

  @Test
  fun `v10 to v11 migration is non destructive and adds persistent contact quota`() {
    val migration = Schema.MIGRATE_10_TO_11.joinToString("\n")
    assertTrue(migration.contains("CREATE TABLE relay_peer_contacts"))
    assertTrue(migration.contains("attempted_transfers INTEGER NOT NULL DEFAULT 0"))
    assertTrue(migration.contains("idx_relay_peer_contacts_activity"))
    assertTrue(!migration.contains("DROP TABLE"))
  }
}
