import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A project's assistant works several issues at once, each with its own team
 * and worktree, so 052's one-active-task-per-project index no longer holds.
 * One team per issue still does, through `assistant_issue_claim`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS assistant_one_active_task`;
});
