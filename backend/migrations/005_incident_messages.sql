ALTER TABLE incident_revisions
  ADD COLUMN message TEXT;

ALTER TABLE incident_revisions
  ADD CONSTRAINT incident_revisions_message_bytes_check
  CHECK (message IS NULL OR octet_length(message) <= 500);
