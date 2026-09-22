import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import dropCoordinatorStage from "./061_AssistantCoordinatorStageTasks.ts";

it.layer(NodeSqliteClient.layerMemory())("061_AssistantCoordinatorStageTasks", (it) => {
  it.effect("drops the retired coordinator stage and leaves every other task alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`INSERT INTO assistant_tasks (id, project_id, thread_id, issue_id, status, data) VALUES
        ('old', 'project-1', 'assistant-chat', 'issue-1', 'accepted',
          '{"id":"old","status":"accepted","stage":"coordinator","turns":3}'),
        ('team', 'project-1', 'assistant-lead-team', 'issue-2', 'implementing',
          '{"id":"team","status":"implementing","stage":"lead","turns":1}'),
        ('none', 'project-1', 'assistant-lead-none', 'issue-3', 'accepted',
          '{"id":"none","status":"accepted","turns":2}')`;
      yield* runMigrations({ toMigrationInclusive: 61 });

      const rows = yield* sql<{ readonly id: string; readonly data: string }>`
        SELECT id, data FROM assistant_tasks ORDER BY id`;
      const stages = rows.map((row) => [row.id, JSON.parse(row.data).stage] as const);
      assert.deepEqual(stages, [
        ["none", undefined],
        ["old", undefined],
        ["team", "lead"],
      ]);
      // The rest of a rewritten task survives.
      assert.deepEqual(JSON.parse(rows.find((row) => row.id === "old")!.data), {
        id: "old",
        status: "accepted",
        turns: 3,
      });
      // Running it again changes nothing.
      yield* dropCoordinatorStage;
      assert.lengthOf(yield* sql`SELECT * FROM assistant_tasks`, 3);
    }),
  );
});
