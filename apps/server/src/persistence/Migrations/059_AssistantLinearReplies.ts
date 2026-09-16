import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Replies a person wrote on a team's Linear agent session that the assistant has
 * handled, by webhook delivery, so a redelivered or retried reply is not applied twice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS assistant_linear_replies (
    delivery_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    handled_at TEXT NOT NULL
  )`;
});
