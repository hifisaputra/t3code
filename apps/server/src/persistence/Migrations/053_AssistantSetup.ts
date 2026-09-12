import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE assistant_setups (
    project_id TEXT PRIMARY KEY, repository_key TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL UNIQUE, preferences TEXT NOT NULL,
    proposal TEXT, summary TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
    proposed_after TEXT
  )`;
});
