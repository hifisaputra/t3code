import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // The V1 table is only the legacy import source in V2; tolerate a database without it.
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "linked_issue_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN linked_issue_json TEXT
    `;
  }
});
