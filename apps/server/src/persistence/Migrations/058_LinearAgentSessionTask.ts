import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A developer assistant team opens its own Linear agent session. `task_id` links the
 * session to the team's task, so the webhook receiver can tell the app's own sessions
 * from delegations and find the team a reply belongs to.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(linear_agent_sessions)`;
  if (!columns.some((column) => column.name === "task_id")) {
    yield* sql`ALTER TABLE linear_agent_sessions ADD COLUMN task_id TEXT`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS linear_agent_sessions_task ON linear_agent_sessions(task_id)`;
});
