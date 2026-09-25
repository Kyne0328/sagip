package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SchemaTest {
  @Test
  fun `schema version is explicit and preparation state is present`() {
    assertEquals(7, Schema.VERSION)
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
}
