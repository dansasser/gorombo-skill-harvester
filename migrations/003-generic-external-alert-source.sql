ALTER TABLE external_alert_deliveries RENAME TO external_alert_deliveries_legacy;

DROP INDEX external_alert_due;
DROP INDEX external_alert_lease;

CREATE TABLE external_alert_deliveries (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source = 'external-harvester'),
  external_key TEXT NOT NULL CHECK(length(external_key) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN (
    'QUEUED','SENDING','RETRY_WAIT','SENT','DEAD_LETTER'
  )),
  message_private TEXT NOT NULL CHECK(length(message_private) BETWEEN 1 AND 4096),
  message_digest TEXT NOT NULL CHECK(length(message_digest) = 64),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  provider_receipt_ref TEXT,
  last_error_category TEXT,
  ambiguous_acceptance INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_acceptance IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  UNIQUE(source, external_key),
  CHECK(
    (state = 'SENDING' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'SENDING' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

INSERT INTO external_alert_deliveries (
  id, source, external_key, state, message_private, message_digest,
  attempt_count, next_attempt_at, lease_token, lease_owner, lease_expires_at,
  provider_receipt_ref, last_error_category, ambiguous_acceptance,
  created_at, updated_at, terminal_at
)
SELECT
  id, 'external-harvester', external_key, state, message_private, message_digest,
  attempt_count, next_attempt_at, lease_token, lease_owner, lease_expires_at,
  provider_receipt_ref, last_error_category, ambiguous_acceptance,
  created_at, updated_at, terminal_at
FROM external_alert_deliveries_legacy;

DROP TABLE external_alert_deliveries_legacy;

CREATE INDEX external_alert_due
  ON external_alert_deliveries(state, next_attempt_at, created_at, id);
CREATE INDEX external_alert_lease
  ON external_alert_deliveries(state, lease_expires_at, id);
