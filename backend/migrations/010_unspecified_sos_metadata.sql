-- Explicit not-yet-provided metadata for one-tap SOS. Existing codes keep their meaning.
-- Apply before enabling code-0 senders. Older payload decoders reject code 0.
ALTER TABLE incident_revisions DROP CONSTRAINT incident_revisions_emergency_type_check;
ALTER TABLE incident_revisions DROP CONSTRAINT incident_revisions_urgency_check;
ALTER TABLE incident_revisions ADD CONSTRAINT incident_revisions_emergency_type_check
  CHECK (emergency_type BETWEEN 0 AND 6);
ALTER TABLE incident_revisions ADD CONSTRAINT incident_revisions_urgency_check
  CHECK (urgency BETWEEN 0 AND 2);
