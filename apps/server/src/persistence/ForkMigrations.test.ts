import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { FORK_MIGRATIONS_TABLE, forkMigrationManifest } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import ForkLinkedIssue from "./ForkMigrations/001_ProjectionThreadLinkedIssue.ts";
import ForkLinearDelegation from "./ForkMigrations/002_LinearDelegation.ts";
import ForkDeveloperAssistant from "./ForkMigrations/003_DeveloperAssistant.ts";
import ForkAssistantSetup from "./ForkMigrations/004_AssistantSetup.ts";
import ForkHotQueryIndexes from "./ForkMigrations/005_AssistantHotQueryIndexes.ts";
import ForkParallelIssues from "./ForkMigrations/006_AssistantParallelIssues.ts";
import ForkUsageLimit from "./ForkMigrations/007_AssistantUsageLimit.ts";
import ForkRetireCoordinator from "./ForkMigrations/008_RetireAssistantCoordinator.ts";
import ForkSessionTask from "./ForkMigrations/009_LinearAgentSessionTask.ts";
import ForkLinearReplies from "./ForkMigrations/010_AssistantLinearReplies.ts";
import ForkProjectNotes from "./ForkMigrations/011_AssistantProjectNotes.ts";
import ForkStageTasks from "./ForkMigrations/012_AssistantCoordinatorStageTasks.ts";
import ThreadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import ThreadMessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import ThreadTitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

const ledger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });

// develop-v5's manifest after 49: fork migrations at 50-61, upstream's 50-54 at 62-66.
const preSplitForkHistory = [
  ["50_ProjectionThreadLinkedIssue", ForkLinkedIssue],
  ["51_LinearDelegation", ForkLinearDelegation],
  ["52_DeveloperAssistant", ForkDeveloperAssistant],
  ["53_AssistantSetup", ForkAssistantSetup],
  ["54_AssistantHotQueryIndexes", ForkHotQueryIndexes],
  ["55_AssistantParallelIssues", ForkParallelIssues],
  ["56_AssistantUsageLimit", ForkUsageLimit],
  ["57_RetireAssistantCoordinator", ForkRetireCoordinator],
  ["58_LinearAgentSessionTask", ForkSessionTask],
  ["59_AssistantLinearReplies", ForkLinearReplies],
  ["60_AssistantProjectNotes", ForkProjectNotes],
  ["61_AssistantCoordinatorStageTasks", ForkStageTasks],
  ["62_ProjectionThreadPullRequests", ThreadPullRequests],
  ["63_ProjectionThreadMessageContext", ThreadMessageContext],
  ["64_ProjectionThreadTitleState", ThreadTitleState],
  ["65_PullRequestFilesViewed", PullRequestFilesViewed],
  ["66_ProjectionThreadsAutoSettleDisabledAt", AutoSettleDisabledAt],
] as const;

const writePreSplitForkDatabase = (throughId: number) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 49 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          preSplitForkHistory.filter(([key]) => Number.parseInt(key, 10) <= throughId),
        ),
      ),
    });
  });

describe("fork migration ledger", () => {
  it.effect("migrates a fresh database into both ledgers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* ledger(FORK_MIGRATIONS_TABLE), forkMigrationManifest);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.ok(columns.some((column) => column.name === "linked_issue_json"));

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledger(FORK_MIGRATIONS_TABLE), forkMigrationManifest);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adds the fork schema to an upstream-only database", () =>
    Effect.gen(function* () {
      const upstreamOnly = yield* runMigrations({
        toMigrationInclusive: Math.max(...migrationManifest.map(([id]) => id)),
      });
      assert.deepStrictEqual(upstreamOnly, migrationManifest);

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* ledger(FORK_MIGRATIONS_TABLE), forkMigrationManifest);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("moves a pre-split fork history out of the upstream ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* writePreSplitForkDatabase(66);
      yield* sql`INSERT INTO assistant_project_notes (id, project_id, text, role, created_at) VALUES ('kept', 'p', 'note', 'lead', 'now')`;

      // Upstream 55+ runs; neither upstream 50-54 nor any fork migration runs again.
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 55),
      );
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* ledger(FORK_MIGRATIONS_TABLE), forkMigrationManifest);
      assert.deepStrictEqual(yield* sql`SELECT id FROM assistant_project_notes`, [{ id: "kept" }]);

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* ledger(FORK_MIGRATIONS_TABLE), forkMigrationManifest);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finishes a fork history that stopped before upstream's 50-54", () =>
    Effect.gen(function* () {
      yield* writePreSplitForkDatabase(55);

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 50),
      );
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* ledger(FORK_MIGRATIONS_TABLE), forkMigrationManifest);
    }).pipe(Effect.provide(layer)),
  );
});
