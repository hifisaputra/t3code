import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import linearAgentSessionTask from "./058_LinearAgentSessionTask.ts";

it.layer(NodeSqliteClient.layerMemory())("058_LinearAgentSessionTask", (it) => {
  it.effect("adds an indexed task id and keeps existing delegated sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`INSERT INTO linear_agent_sessions (id, issue_id, thread_id, context, updated_at)
        VALUES ('delegated', 'issue-1', 'thread-1', '{}', 1)`;
      yield* runMigrations({ toMigrationInclusive: 58 });

      yield* sql`INSERT INTO linear_agent_sessions (id, issue_id, status, context, task_id, updated_at)
        VALUES ('team', 'issue-1', 'active', '{}', 'task-1', 2)`;
      const rows = yield* sql<{ readonly id: string; readonly task_id: string | null }>`
        SELECT id, task_id FROM linear_agent_sessions ORDER BY id`;
      assert.deepEqual(rows, [
        { id: "delegated", task_id: null },
        { id: "team", task_id: "task-1" },
      ]);
      const indexes = yield* sql<{
        readonly name: string;
      }>`PRAGMA index_list(linear_agent_sessions)`;
      assert.isTrue(indexes.some((index) => index.name === "linear_agent_sessions_task"));
      // Running it again changes nothing.
      yield* linearAgentSessionTask;
      assert.lengthOf(yield* sql`SELECT * FROM linear_agent_sessions`, 2);
    }),
  );
});
