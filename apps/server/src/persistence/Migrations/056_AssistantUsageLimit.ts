import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A provider's usage limit stops every turn on the account at once. The
 * project records when the limit resets, so its deliveries and new teams wait
 * for that instead of failing again, and the stopped threads are resumed then.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(assistant_projects)`;
  if (!columns.some((column) => column.name === "limited_until")) {
    yield* sql`ALTER TABLE assistant_projects ADD COLUMN limited_until TEXT`;
  }
});
