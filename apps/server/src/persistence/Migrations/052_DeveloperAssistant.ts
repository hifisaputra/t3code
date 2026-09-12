import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE assistant_projects (
    project_id TEXT PRIMARY KEY, repository_key TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL UNIQUE, config TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'stopped', error TEXT,
    wake_version INTEGER NOT NULL DEFAULT 0, delivered_version INTEGER NOT NULL DEFAULT 0,
    wake_reason TEXT NOT NULL DEFAULT '', issue_fingerprint TEXT, external_waits INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE assistant_messages (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    text TEXT NOT NULL, created_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE assistant_tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, issue_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, data TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX assistant_one_active_task ON assistant_tasks(project_id)
    WHERE status IN ('preparing', 'working', 'waiting', 'blocked')`;
  yield* sql`CREATE INDEX assistant_tasks_issue ON assistant_tasks(issue_id)`;
  yield* sql`CREATE UNIQUE INDEX assistant_issue_claim ON assistant_tasks(issue_id)
    WHERE status IN ('preparing', 'working', 'waiting', 'blocked')`;
  yield* sql`CREATE TABLE assistant_decisions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    request_id TEXT, data TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX assistant_pending_decisions ON assistant_decisions(project_id, resolved)`;
  yield* sql`CREATE TABLE assistant_event_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO assistant_event_cursor SELECT 1, COALESCE(MAX(sequence), 0) FROM orchestration_events`;
});
