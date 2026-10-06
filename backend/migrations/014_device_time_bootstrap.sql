-- Device time is bound to an installation key and boot, independent of SOS/report access.
-- Keep existing custody proof rows, high-water and nonce history intact.
ALTER TABLE custody_authority_time_proofs ALTER COLUMN report_id DROP NOT NULL;
