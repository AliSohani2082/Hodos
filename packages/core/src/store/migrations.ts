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
  {
    version: 2,
    name: 'learning sessions',
    sql: `
CREATE TABLE learn_sessions (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  host_session_id TEXT UNIQUE,
  goal TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('probe', 'plan', 'teach', 'closed')),
  assessment_json TEXT,
  plan_json TEXT,
  plan_source TEXT,
  plan_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX learn_sessions_learner ON learn_sessions(learner_id, updated_at);
CREATE TABLE learn_questions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES learn_sessions(id),
  role TEXT NOT NULL CHECK (role IN ('probe', 'predict', 'check', 'review')),
  node_id TEXT,
  prompt TEXT NOT NULL,
  details TEXT,
  body_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('model', 'bank')),
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'superseded')),
  progress_json TEXT,
  response_json TEXT,
  answer_text TEXT,
  thinking TEXT,
  verdict_json TEXT,
  asked_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX learn_questions_session ON learn_questions(session_id, seq);
CREATE TABLE learn_transcript (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES learn_sessions(id),
  role TEXT NOT NULL CHECK (role IN ('teacher', 'learner')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX learn_transcript_session ON learn_transcript(session_id, seq);
CREATE TABLE learn_node_states (
  session_id TEXT NOT NULL REFERENCES learn_sessions(id),
  node_id TEXT NOT NULL,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  p_mastered REAL NOT NULL,
  card_json TEXT,
  due_at TEXT,
  observations INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, node_id)
);
CREATE INDEX learn_node_states_due ON learn_node_states(learner_id, due_at);
`,
  },
  {
    version: 3,
    name: 'knowledge graph and practice sessions',
    sql: `
CREATE TABLE kg_sources (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  kind TEXT NOT NULL CHECK (kind IN ('session', 'notes')),
  title TEXT NOT NULL,
  covered_through INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX kg_sources_learner ON kg_sources(learner_id);
CREATE TABLE kg_notes (
  source_id TEXT PRIMARY KEY REFERENCES kg_sources(id) ON DELETE CASCADE,
  text TEXT NOT NULL
);
CREATE TABLE kg_propositions (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  name TEXT NOT NULL,
  statement TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX kg_propositions_learner ON kg_propositions(learner_id, created_at);
CREATE TABLE kg_assertions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  proposition_id TEXT NOT NULL REFERENCES kg_propositions(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  anchor INTEGER,
  statement TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX kg_assertions_proposition ON kg_assertions(proposition_id, seq);
CREATE INDEX kg_assertions_source ON kg_assertions(source_id);
CREATE TABLE kg_chains (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  chain_key TEXT NOT NULL,
  premises_json TEXT NOT NULL,
  conclusion_id TEXT NOT NULL REFERENCES kg_propositions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (learner_id, chain_key)
);
CREATE TABLE kg_chain_sources (
  chain_id TEXT NOT NULL REFERENCES kg_chains(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, source_id)
);
CREATE TABLE model_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  purpose TEXT NOT NULL,
  ok INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX model_calls_learner ON model_calls(learner_id, created_at);
CREATE TABLE practice_sessions (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  host_session_id TEXT UNIQUE,
  title TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX practice_sessions_learner ON practice_sessions(learner_id, updated_at);
CREATE TABLE practice_problems (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES practice_sessions(id),
  statement TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('recall', 'discrimination', 'composition')),
  targets_json TEXT NOT NULL,
  model_solution TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'concluded')),
  conclusion_json TEXT,
  posed_at TEXT NOT NULL,
  concluded_at TEXT
);
CREATE INDEX practice_problems_session ON practice_problems(session_id, seq);
CREATE TABLE practice_thinking (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id TEXT NOT NULL REFERENCES practice_problems(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
]
