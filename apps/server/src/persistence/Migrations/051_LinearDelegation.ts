import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE linear_agent_sessions (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, thread_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', context TEXT NOT NULL, active_turn_id TEXT,
    pending_question TEXT, updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX linear_agent_sessions_thread ON linear_agent_sessions(thread_id)`;
  yield* sql`CREATE INDEX linear_agent_sessions_issue ON linear_agent_sessions(issue_id)`;
  yield* sql`CREATE TABLE linear_agent_deliveries (
    id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
    received_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE linear_agent_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO linear_agent_cursor SELECT 1, COALESCE(MAX(sequence), 0) FROM orchestration_events`;
  yield* sql`CREATE TABLE linear_agent_outbox (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0
  )`;
});
