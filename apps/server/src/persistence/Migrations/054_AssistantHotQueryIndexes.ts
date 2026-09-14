import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The assistant loop scans these tables on every wake: undelivered messages, a
 * thread's own messages and open decisions, and a project's tasks by status.
 * `assistant_tasks(issue_id)` and `assistant_tasks(thread_id)` already have
 * indexes from 052 (the second through its UNIQUE constraint).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_messages_undelivered ON assistant_messages(delivered)`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_messages_thread ON assistant_messages(thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_decisions_thread ON assistant_decisions(thread_id, resolved)`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_tasks_project_status ON assistant_tasks(project_id, status)`;
});
