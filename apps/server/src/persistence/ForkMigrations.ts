import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration001 from "./ForkMigrations/001_ProjectionThreadLinkedIssue.ts";
import ForkMigration002 from "./ForkMigrations/002_LinearDelegation.ts";
import ForkMigration003 from "./ForkMigrations/003_DeveloperAssistant.ts";
import ForkMigration004 from "./ForkMigrations/004_AssistantSetup.ts";
import ForkMigration005 from "./ForkMigrations/005_AssistantHotQueryIndexes.ts";
import ForkMigration006 from "./ForkMigrations/006_AssistantParallelIssues.ts";
import ForkMigration007 from "./ForkMigrations/007_AssistantUsageLimit.ts";
import ForkMigration008 from "./ForkMigrations/008_RetireAssistantCoordinator.ts";
import ForkMigration009 from "./ForkMigrations/009_LinearAgentSessionTask.ts";
import ForkMigration010 from "./ForkMigrations/010_AssistantLinearReplies.ts";
import ForkMigration011 from "./ForkMigrations/011_AssistantProjectNotes.ts";
import ForkMigration012 from "./ForkMigrations/012_AssistantCoordinatorStageTasks.ts";

/**
 * Fork-only schema lives in its own ledger. The upstream migrator skips every
 * id at or below the highest recorded one, so any id the fork takes in
 * `effect_sql_migrations` masks a future upstream migration forever (see
 * docs/internals/legacy-orchestration-migration.md, "Divergent migration ids").
 * Fork migrations run after upstream's, so they may rely on upstream's schema.
 */
export const FORK_MIGRATIONS_TABLE = "t3_fork_migrations";

const forkMigrationEntries = [
  [1, "ProjectionThreadLinkedIssue", ForkMigration001],
  [2, "LinearDelegation", ForkMigration002],
  [3, "DeveloperAssistant", ForkMigration003],
  [4, "AssistantSetup", ForkMigration004],
  [5, "AssistantHotQueryIndexes", ForkMigration005],
  [6, "AssistantParallelIssues", ForkMigration006],
  [7, "AssistantUsageLimit", ForkMigration007],
  [8, "RetireAssistantCoordinator", ForkMigration008],
  [9, "LinearAgentSessionTask", ForkMigration009],
  [10, "AssistantLinearReplies", ForkMigration010],
  [11, "AssistantProjectNotes", ForkMigration011],
  [12, "AssistantCoordinatorStageTasks", ForkMigration012],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

/** Builds before the split recorded fork migration N in the upstream ledger as N + 49. */
const LEGACY_FORK_ID_OFFSET = 49;

/** Upstream's 50-54, which those builds ran as 62-66 because the fork held 50-61. */
const RELOCATED_UPSTREAM_MIGRATIONS = [
  [62, 50, "ProjectionThreadPullRequests"],
  [63, 51, "ProjectionThreadMessageContext"],
  [64, 52, "ProjectionThreadTitleState"],
  [65, 53, "PullRequestFilesViewed"],
  [66, 54, "ProjectionThreadsAutoSettleDisabledAt"],
] as const;

const ensureForkLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Same shape the Migrator creates, so it adopts the table as its own.
  yield* sql`CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
    migration_id integer PRIMARY KEY NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL
  )`;
});

/**
 * Moves a pre-split fork history into the fork ledger before the upstream
 * migrator reads `effect_sql_migrations`: fork rows (50-61 under fork names)
 * move to the fork ledger so they are not re-run, and upstream's 50-54 move
 * back from 62-66. Rows are matched by id and name, so fresh and upstream-only
 * databases are untouched and a second run is a no-op.
 */
export const reconcileForkMigrationLedger = Effect.fn("reconcileForkMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
      if (tables.length === 0) return false;
      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id >= 50`;
      const recorded = new Map(history.map((row) => [row.migration_id, row]));

      const forkRows = forkMigrationEntries.flatMap(([id, name]) => {
        const row = recorded.get(id + LEGACY_FORK_ID_OFFSET);
        return row !== undefined && row.name === name ? [{ forkId: id, row }] : [];
      });
      const relocated = RELOCATED_UPSTREAM_MIGRATIONS.filter(
        ([legacyId, , name]) => recorded.get(legacyId)?.name === name,
      );
      if (forkRows.length === 0 && relocated.length === 0) return false;

      if (forkRows.length > 0) {
        yield* ensureForkLedger;
        for (const { forkId, row } of forkRows) {
          yield* sql`
              INSERT OR IGNORE INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name, created_at)
              VALUES (${forkId}, ${row.name}, ${row.created_at})
            `;
          yield* sql`
              DELETE FROM effect_sql_migrations
              WHERE migration_id = ${row.migration_id} AND name = ${row.name}
            `;
          recorded.delete(row.migration_id);
        }
      }
      for (const [legacyId, upstreamId, name] of relocated) {
        // An unrelated row at the upstream id is left for runMigrations to report.
        if (recorded.has(upstreamId)) continue;
        yield* sql`
            UPDATE effect_sql_migrations SET migration_id = ${upstreamId}
            WHERE migration_id = ${legacyId} AND name = ${name}
          `;
        recorded.delete(legacyId);
      }
      return true;
    }),
  );
});

const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

/** Runs pending fork migrations. Call only after every upstream migration has run. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* (
  toMigrationInclusive?: number,
) {
  return yield* run({
    loader: makeForkMigrationLoader(toMigrationInclusive),
    table: FORK_MIGRATIONS_TABLE,
  });
});
