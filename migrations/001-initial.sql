-- Harvester V2 schema version 1.
-- Normative source: docs/specs/004-storage-schema-and-migrations.md

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL CHECK(length(checksum)=64),
  package_version TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK(applied_at>=0)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);

CREATE TABLE onboarding_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN (
    'INSPECTING','PLANNED','WAITING_FOR_SECRET',
    'WAITING_FOR_ROUTE_CONFIGURATION','INITIALIZING_STORAGE',
    'VERIFYING_ROUTES','COMPLETED','CANCELLED','RECOVERY_REQUIRED'
  )),
  requested_route_mode TEXT CHECK(requested_route_mode IN ('telegram','session','both')),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  safe_reason_code TEXT,
  started_at INTEGER NOT NULL CHECK(started_at>=0),
  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at>=started_at)
);

CREATE TABLE route_configurations (
  route TEXT PRIMARY KEY CHECK(route IN ('telegram','session')),
  selected INTEGER NOT NULL CHECK(selected IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN (
    'DISABLED','UNCONFIGURED','CONFIGURED','VERIFYING',
    'READY','DEGRADED','RECOVERY_REQUIRED'
  )),
  safe_config_json TEXT NOT NULL CHECK(json_valid(safe_config_json)),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);

CREATE TABLE route_test_receipts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT UNIQUE REFERENCES delivery_outbox(id),
  route TEXT NOT NULL REFERENCES route_configurations(route),
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision>=1),
  test_generation INTEGER NOT NULL CHECK(test_generation>=0),
  provider_receipt_ref TEXT NOT NULL,
  accepted_at INTEGER NOT NULL CHECK(accepted_at>=0),
  safe_receipt_json TEXT NOT NULL CHECK(json_valid(safe_receipt_json)),
  UNIQUE(route, configuration_revision, test_generation),
  CHECK((route='telegram' AND delivery_id IS NOT NULL) OR (route='session' AND delivery_id IS NULL))
);

CREATE TABLE completion_events (
  id TEXT PRIMARY KEY,
  correlation_key TEXT NOT NULL UNIQUE CHECK(length(correlation_key)=64),
  source_platform TEXT NOT NULL,
  source_adapter TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>=0),
  completed_at INTEGER NOT NULL CHECK(completed_at>=0),
  source_revision TEXT NOT NULL,
  safe_evidence_json TEXT NOT NULL CHECK(json_valid(safe_evidence_json)),
  safe_evidence_digest TEXT NOT NULL CHECK(length(safe_evidence_digest)=64),
  state TEXT NOT NULL CHECK(state IN (
    'ASSESSMENT_PENDING','PUBLICATION_PENDING',
    'OWNER_VISIBLE_AND_SCHEDULED','ACK_PENDING','ACKNOWLEDGED',
    'RECOVERY_REQUIRED'
  )),
  assessment_attempts INTEGER NOT NULL DEFAULT 0 CHECK(assessment_attempts>=0),
  assessment_next_at INTEGER,
  assessment_lease_token TEXT,
  assessment_lease_owner TEXT,
  assessment_lease_expires_at INTEGER,
  ack_attempts INTEGER NOT NULL DEFAULT 0 CHECK(ack_attempts>=0),
  ack_next_at INTEGER,
  received_at INTEGER NOT NULL CHECK(received_at>=0),
  scheduled_at INTEGER,
  acknowledged_at INTEGER,
  UNIQUE(source_adapter, source_event_id),
  CHECK(
    (assessment_lease_token IS NULL AND assessment_lease_owner IS NULL
      AND assessment_lease_expires_at IS NULL)
    OR
    (state='ASSESSMENT_PENDING' AND assessment_lease_token IS NOT NULL
      AND assessment_lease_owner IS NOT NULL
      AND assessment_lease_expires_at IS NOT NULL)
  ),
  CHECK(
    (state='ASSESSMENT_PENDING' AND assessment_next_at IS NOT NULL)
    OR
    (state<>'ASSESSMENT_PENDING' AND assessment_next_at IS NULL)
  )
);

CREATE TABLE skill_catalog_snapshots (
  revision TEXT PRIMARY KEY CHECK(length(revision)=64),
  catalog_schema_version INTEGER NOT NULL CHECK(catalog_schema_version=1),
  canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL UNIQUE REFERENCES completion_events(id),
  assessment_version TEXT NOT NULL,
  catalog_revision TEXT NOT NULL
    REFERENCES skill_catalog_snapshots(revision)
    CHECK(length(catalog_revision)=64),
  decision TEXT NOT NULL CHECK(decision IN (
    'not-a-skill','extend-existing','propose-new'
  )),
  reason_code TEXT,
  reason_summary TEXT NOT NULL,
  target_skill_ref TEXT,
  target_skill_name TEXT,
  extension_summary TEXT,
  recommendation_id TEXT UNIQUE,
  recommendation_json TEXT CHECK(
    recommendation_json IS NULL OR json_valid(recommendation_json)
  ),
  recommendation_digest TEXT CHECK(
    recommendation_digest IS NULL OR length(recommendation_digest)=64
  ),
  committed_at INTEGER NOT NULL CHECK(committed_at>=0),
  CHECK(
    (decision='not-a-skill' AND target_skill_ref IS NULL
      AND extension_summary IS NULL AND recommendation_id IS NULL
      AND recommendation_json IS NULL AND recommendation_digest IS NULL)
    OR
    (decision='extend-existing' AND target_skill_ref IS NOT NULL
      AND extension_summary IS NOT NULL AND recommendation_id IS NULL
      AND recommendation_json IS NULL AND recommendation_digest IS NULL)
    OR
    (decision='propose-new' AND target_skill_ref IS NULL
      AND extension_summary IS NULL AND recommendation_id IS NOT NULL
      AND recommendation_json IS NOT NULL
      AND recommendation_digest IS NOT NULL)
  )
);

CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL UNIQUE REFERENCES completion_events(id),
  assessment_id TEXT NOT NULL UNIQUE REFERENCES assessments(id),
  content_schema_version INTEGER NOT NULL CHECK(content_schema_version>=1),
  canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
  canonical_json_digest TEXT NOT NULL CHECK(length(canonical_json_digest)=64),
  markdown_relative_path TEXT NOT NULL UNIQUE,
  markdown_sha256 TEXT NOT NULL CHECK(length(markdown_sha256)=64),
  visibility_state TEXT NOT NULL CHECK(visibility_state IN (
    'DRAFT_COMMITTED','OWNER_VISIBLE','RECOVERY_REQUIRED'
  )),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  visible_at INTEGER,
  CHECK(visibility_state<>'OWNER_VISIBLE' OR visible_at IS NOT NULL)
);

CREATE TABLE delivery_outbox (
  id TEXT PRIMARY KEY,
  delivery_kind TEXT NOT NULL DEFAULT 'recommendation' CHECK(delivery_kind IN ('recommendation','route_test')),
  recommendation_id TEXT REFERENCES recommendations(id),
  route_configuration_revision INTEGER,
  route_test_generation INTEGER,
  test_message TEXT,
  test_message_digest TEXT CHECK(test_message_digest IS NULL OR length(test_message_digest)=64),
  target_binding_id TEXT REFERENCES telegram_bindings(id),
  route TEXT NOT NULL CHECK(route IN ('telegram','session')),
  payload_version INTEGER NOT NULL CHECK(payload_version>=1),
  delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK(delivery_generation>=0),
  state TEXT NOT NULL CHECK(state IN (
    'INTEGRITY_PENDING','QUEUED','SENDING','RETRY_WAIT','SENT','DEAD_LETTER','PAUSED'
  )),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_category TEXT,
  last_safe_error_json TEXT CHECK(
    last_safe_error_json IS NULL OR json_valid(last_safe_error_json)
  ),
  ambiguous_acceptance INTEGER NOT NULL DEFAULT 0
    CHECK(ambiguous_acceptance IN (0,1)),
  replay_of_delivery_id TEXT REFERENCES delivery_outbox(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  terminal_at INTEGER,
  UNIQUE(recommendation_id, route, payload_version, delivery_generation),
  UNIQUE(route, route_configuration_revision, route_test_generation),
  CHECK(
    (
      delivery_kind='recommendation'
      AND recommendation_id IS NOT NULL
      AND route_configuration_revision IS NULL
      AND route_test_generation IS NULL
      AND test_message IS NULL
      AND test_message_digest IS NULL
      AND target_binding_id IS NULL
    )
    OR
    (
      delivery_kind='route_test'
      AND recommendation_id IS NULL
      AND route='telegram'
      AND payload_version=1
      AND delivery_generation=0
      AND replay_of_delivery_id IS NULL
      AND route_configuration_revision IS NOT NULL
      AND route_configuration_revision>=1
      AND route_test_generation IS NOT NULL
      AND route_test_generation>=0
      AND test_message IS NOT NULL
      AND length(test_message) BETWEEN 1 AND 4096
      AND test_message_digest IS NOT NULL
      AND target_binding_id IS NOT NULL
    )
  ),
  CHECK(
    (state='SENDING' AND lease_token IS NOT NULL
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state<>'SENDING' AND lease_token IS NULL
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES delivery_outbox(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number>=1),
  lease_token TEXT NOT NULL,
  started_at INTEGER NOT NULL CHECK(started_at>=0),
  completed_at INTEGER,
  result_category TEXT CHECK(result_category IN (
    'accepted','retryable','rate_limited','route_blocked',
    'permanent','ambiguous','lease_expired','cancelled'
  )),
  safe_error_json TEXT CHECK(safe_error_json IS NULL OR json_valid(safe_error_json)),
  UNIQUE(delivery_id, attempt_number)
);

CREATE TABLE delivery_receipts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES delivery_outbox(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES delivery_attempts(id),
  provider_receipt_ref TEXT NOT NULL,
  accepted_at INTEGER NOT NULL CHECK(accepted_at>=0),
  safe_receipt_json TEXT NOT NULL CHECK(json_valid(safe_receipt_json))
);

CREATE TABLE delivery_replays (
  replay_request_id TEXT PRIMARY KEY,
  original_delivery_id TEXT NOT NULL REFERENCES delivery_outbox(id),
  replay_delivery_id TEXT NOT NULL UNIQUE REFERENCES delivery_outbox(id),
  requested_by TEXT NOT NULL,
  safe_reason TEXT NOT NULL,
  requested_at INTEGER NOT NULL CHECK(requested_at>=0)
);

CREATE TABLE pairing_requests (
  id TEXT PRIMARY KEY,
  code_digest TEXT NOT NULL UNIQUE CHECK(length(code_digest)=64),
  bot_identity TEXT NOT NULL,
  user_identity TEXT NOT NULL,
  chat_identity TEXT NOT NULL,
  chat_type TEXT NOT NULL DEFAULT 'private' CHECK(chat_type='private'),
  state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','EXPIRED','REJECTED','USED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE telegram_bindings (
  id TEXT PRIMARY KEY,
  bot_identity TEXT NOT NULL,
  user_identity TEXT NOT NULL,
  chat_identity TEXT NOT NULL,
  chat_type TEXT NOT NULL DEFAULT 'private' CHECK(chat_type='private'),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED','RECOVERY_REQUIRED')),
  approved_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(bot_identity, user_identity, chat_identity),
  CHECK(state='ACTIVE' OR is_primary=0)
);

CREATE UNIQUE INDEX telegram_bindings_one_active_primary
  ON telegram_bindings(bot_identity)
  WHERE state='ACTIVE' AND is_primary=1;

CREATE TABLE session_routes (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  internal_thread_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN (
    'SELECTED','READY','BUSY','MISSING','INACCESSIBLE','RESELECTION_REQUIRED'
  )),
  revision INTEGER NOT NULL CHECK(revision>=1),
  selected_at INTEGER NOT NULL,
  last_verified_at INTEGER
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  source_route TEXT NOT NULL CHECK(source_route IN ('telegram')),
  source_message_identity TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL REFERENCES telegram_bindings(id),
  request_text_private TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'ACCEPTED','QUEUED','RUNNING','WAITING_APPROVAL',
    'SUCCEEDED','FAILED','CANCELLED','RECOVERY_REQUIRED'
  )),
  accepted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_number INTEGER NOT NULL CHECK(run_number>=1),
  state TEXT NOT NULL,
  thread_id_private TEXT,
  safe_result_json TEXT CHECK(safe_result_json IS NULL OR json_valid(safe_result_json)),
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(task_id, run_number)
);

CREATE TABLE task_result_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN (
    'QUEUED','SENDING','RETRY_WAIT','SENT','DEAD_LETTER'
  )),
  message_private TEXT NOT NULL,
  message_digest TEXT NOT NULL CHECK(length(message_digest)=64),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  provider_receipt_ref TEXT,
  last_error_category TEXT,
  ambiguous_acceptance INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_acceptance IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  CHECK(
    (state='SENDING' AND lease_token IS NOT NULL
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state<>'SENDING' AND lease_token IS NULL
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE telegram_updates (
  update_identity TEXT PRIMARY KEY,
  binding_id TEXT REFERENCES telegram_bindings(id),
  task_id TEXT REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN ('REJECTED','ACCEPTED','HANDLED','DUPLICATE')),
  received_at INTEGER NOT NULL
);

CREATE TABLE telegram_reply_deliveries (
  id TEXT PRIMARY KEY,
  source_identity TEXT NOT NULL CHECK(length(source_identity) BETWEEN 3 AND 288),
  purpose TEXT NOT NULL CHECK(purpose IN (
    'PAIRING','STATUS','CANCEL','HELP','REJECTION','CONFIRMATION'
  )),
  binding_id TEXT REFERENCES telegram_bindings(id),
  chat_identity_private TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'QUEUED','SENDING','RETRY_WAIT','SENT','DEAD_LETTER'
  )),
  message_private TEXT NOT NULL,
  message_digest TEXT NOT NULL CHECK(length(message_digest)=64),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  provider_receipt_ref TEXT,
  last_error_category TEXT,
  ambiguous_acceptance INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_acceptance IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  UNIQUE(source_identity,purpose),
  CHECK(
    (state='SENDING' AND lease_token IS NOT NULL
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state<>'SENDING' AND lease_token IS NULL
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE operational_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  component TEXT NOT NULL,
  event_type TEXT NOT NULL,
  correlation_id TEXT,
  safe_detail_json TEXT NOT NULL CHECK(json_valid(safe_detail_json)),
  created_at INTEGER NOT NULL
);

CREATE INDEX completion_assessment_due
  ON completion_events(state, assessment_next_at, received_at, id);
CREATE INDEX completion_assessment_lease
  ON completion_events(state, assessment_lease_expires_at, id);
CREATE INDEX completion_ack_due
  ON completion_events(state, ack_next_at, received_at, id);
CREATE INDEX catalog_snapshot_created
  ON skill_catalog_snapshots(created_at, revision);
CREATE INDEX recommendation_visibility
  ON recommendations(visibility_state, created_at, id);
CREATE INDEX outbox_claim_due
  ON delivery_outbox(state, next_attempt_at, created_at, id);
CREATE INDEX outbox_lease_due
  ON delivery_outbox(state, lease_expires_at, id);
CREATE INDEX outbox_route_state
  ON delivery_outbox(route, state, updated_at, id);
CREATE INDEX attempt_delivery_started
  ON delivery_attempts(delivery_id, started_at, id);
CREATE INDEX pairing_expiry
  ON pairing_requests(state, expires_at, id);
CREATE INDEX tasks_state_updated
  ON tasks(state, updated_at, id);
CREATE INDEX task_result_due
  ON task_result_deliveries(state, next_attempt_at, id);
CREATE INDEX telegram_reply_due
  ON telegram_reply_deliveries(state, next_attempt_at, id);
CREATE INDEX telegram_reply_lease
  ON telegram_reply_deliveries(state, lease_expires_at, id);
CREATE INDEX operations_component_time
  ON operational_events(component, created_at, sequence);
