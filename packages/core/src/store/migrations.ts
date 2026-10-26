/**
 * Versioned schema migrations. Migrations are append-only: never edit a
 * released migration; add the next version instead.
 * @module @hodos/core/store/migrations
 */

/** One migration step. */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

/** All migrations in order. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE learners (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE principal_learners (
  principal TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id)
);
CREATE TABLE courses (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'draft', 'rejected')),
  origin TEXT NOT NULL CHECK (origin IN ('pack', 'agent', 'import')),
  plugin_id TEXT,
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  proposed_by TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  PRIMARY KEY (id, version)
);
CREATE TABLE journeys (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  course_id TEXT NOT NULL,
  course_version TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX journeys_learner ON journeys(learner_id, updated_at);
CREATE TABLE journey_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id TEXT NOT NULL REFERENCES journeys(id),
  event_json TEXT NOT NULL,
  actor_channel TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE session_bindings (
  session_id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  journey_id TEXT,
  bound_at TEXT NOT NULL
);
CREATE TABLE presentations (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  journey_id TEXT,
  course_id TEXT NOT NULL,
  course_version TEXT NOT NULL,
  item_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_correct INTEGER,
  hint_level INTEGER NOT NULL DEFAULT 0,
  hints_at_last_attempt INTEGER NOT NULL DEFAULT 0,
  last_hint_at TEXT,
  tutor_contact INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT,
  checkpoint_id TEXT,
  diagnostic_id TEXT,
  presented_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX presentations_learner ON presentations(learner_id, status, presented_at);
CREATE TABLE evidence (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  journey_id TEXT,
  presentation_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  course_version TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  grader_id TEXT NOT NULL,
  grader_trusted INTEGER NOT NULL,
  mode TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  counts_for_mastery INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  grade_json TEXT NOT NULL,
  hint_level INTEGER NOT NULL,
  assisted INTEGER NOT NULL,
  assistance_json TEXT NOT NULL,
  channel TEXT NOT NULL,
  latency_ms INTEGER,
  confidence TEXT,
  item_facts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_learner ON evidence(learner_id, seq);
CREATE TABLE hint_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  presentation_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  channel TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE skill_states (
  learner_id TEXT NOT NULL REFERENCES learners(id),
  skill_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  p_mastered REAL NOT NULL,
  gate_open INTEGER NOT NULL,
  derived_through_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, skill_id)
);
CREATE TABLE skill_priors (
  learner_id TEXT NOT NULL REFERENCES learners(id),
  skill_id TEXT NOT NULL,
  prior REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('diagnostic', 'self-report')),
  diagnosed_known INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, skill_id)
);
CREATE TABLE item_calibration (
  item_key TEXT PRIMARY KEY,
  b REAL NOT NULL,
  m INTEGER NOT NULL
);
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  journey_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'passed', 'failed', 'abandoned')),
  item_ids_json TEXT NOT NULL,
  tutor_contact INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  journey_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'skipped')),
  scope_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  observations_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE overlays (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  journey_id TEXT,
  skill_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lesson', 'remedial')),
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE lesson_checks (
  learner_id TEXT NOT NULL REFERENCES learners(id),
  lesson_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, lesson_id, check_id)
);
CREATE TABLE env_state (
  learner_id TEXT NOT NULL REFERENCES learners(id),
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, plugin_id, key)
);
CREATE TABLE security_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  learner_id TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
]
