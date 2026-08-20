-- Migration 004: Allow recommendations for extend-existing decisions

PRAGMA foreign_keys=OFF;

CREATE TABLE new_assessments (
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
      AND extension_summary IS NOT NULL AND recommendation_id IS NOT NULL
      AND recommendation_json IS NOT NULL AND recommendation_digest IS NOT NULL)
    OR
    (decision='propose-new' AND target_skill_ref IS NULL
      AND extension_summary IS NULL AND recommendation_id IS NOT NULL
      AND recommendation_json IS NOT NULL
      AND recommendation_digest IS NOT NULL)
  )
);

INSERT INTO new_assessments SELECT * FROM assessments;

DROP TABLE assessments;

ALTER TABLE new_assessments RENAME TO assessments;

PRAGMA foreign_keys=ON;
