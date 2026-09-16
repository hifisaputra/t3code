import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Each project's developer assistant chat thread is retired: team leaders run
 * every issue and the person works the loop from the board. Its open messages
 * and decisions are closed, and its thread is recorded so the assistant's
 * recovery archives it (a migration cannot dispatch orchestration commands).
 * `assistant_projects` loses the chat's columns and the dead issue fingerprint;
 * `thread_id` is UNIQUE, which SQLite cannot drop, so the table is rebuilt.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS assistant_retired_threads (thread_id TEXT PRIMARY KEY)`;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(assistant_projects)`;
  if (!columns.some((column) => column.name === "thread_id")) return;
  yield* sql`INSERT OR IGNORE INTO assistant_retired_threads (thread_id) SELECT thread_id FROM assistant_projects`;
  yield* sql`UPDATE assistant_messages SET delivered = 1
    WHERE delivered = 0 AND thread_id IN (SELECT thread_id FROM assistant_retired_threads)`;
  yield* sql`UPDATE assistant_decisions SET resolved = 1
    WHERE resolved = 0 AND thread_id IN (SELECT thread_id FROM assistant_retired_threads)`;
  yield* sql`CREATE TABLE assistant_projects_next (
    project_id TEXT PRIMARY KEY, repository_key TEXT NOT NULL UNIQUE, config TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'stopped', error TEXT, limited_until TEXT
  )`;
  // A "Waiting:" error was the chat's own wait, which nothing clears any more.
  yield* sql`INSERT INTO assistant_projects_next (project_id, repository_key, config, status, error, limited_until)
    SELECT project_id, repository_key, config, status,
      CASE WHEN error LIKE 'Waiting:%' THEN NULL ELSE error END, limited_until
    FROM assistant_projects`;
  yield* sql`DROP TABLE assistant_projects`;
  yield* sql`ALTER TABLE assistant_projects_next RENAME TO assistant_projects`;
});
