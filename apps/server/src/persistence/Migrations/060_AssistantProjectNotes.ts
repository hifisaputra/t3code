import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Facts a developer assistant team wrote down about its project for later teams,
 * or the person added on the board. An open note reaches every team's first
 * message; a setup revision that folds it into the instructions sets
 * `absorbed_at`. The setup conversation records which notes it read
 * (`notes_read`) and which its proposal was made from (`proposal_notes`), so a
 * save absorbs exactly those.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS assistant_project_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    text TEXT NOT NULL,
    role TEXT NOT NULL,
    task_id TEXT,
    issue_identifier TEXT,
    created_at TEXT NOT NULL,
    absorbed_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_project_notes_open
    ON assistant_project_notes(project_id, absorbed_at)`;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(assistant_setups)`;
  if (!columns.some((column) => column.name === "notes_read"))
    yield* sql`ALTER TABLE assistant_setups ADD COLUMN notes_read TEXT`;
  if (!columns.some((column) => column.name === "proposal_notes"))
    yield* sql`ALTER TABLE assistant_setups ADD COLUMN proposal_notes TEXT`;
});
