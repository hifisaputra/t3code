import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds an optional project-scope restriction to pairing links and authenticated
 * sessions.
 *
 * The column stores a JSON-encoded array of project ids the credential is
 * limited to. A `NULL` column means the credential is unrestricted (every
 * project), preserving the historical environment-wide behavior for existing
 * rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  if (!pairingLinkColumns.some((column) => column.name === "project_ids")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN project_ids TEXT
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "project_ids")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN project_ids TEXT
    `;
  }
});
