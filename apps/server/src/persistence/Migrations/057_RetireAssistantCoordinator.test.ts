import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import retireCoordinator from "./057_RetireAssistantCoordinator.ts";

it.layer(NodeSqliteClient.layerMemory())("057_RetireAssistantCoordinator", (it) => {
  it.effect("records each assistant chat thread, closes its work and drops its columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`INSERT INTO assistant_projects (project_id, repository_key, thread_id, config, status, error, wake_version, external_waits, limited_until)
        VALUES ('project-1', '/repo/.git', 'assistant-chat', '{}', 'running', 'Waiting: CI', 3, 2, '2026-09-16T00:00:00.000Z')`;
      yield* sql`INSERT INTO assistant_messages (id, project_id, thread_id, text, created_at) VALUES
        ('wake', 'project-1', 'assistant-chat', 'Wake', 'now'),
        ('lead', 'project-1', 'assistant-lead-task', 'Go', 'now')`;
      yield* sql`INSERT INTO assistant_decisions (id, project_id, thread_id, data) VALUES
        ('asked', 'project-1', 'assistant-chat', '{}'),
        ('team', 'project-1', 'assistant-lead-task', '{}')`;
      yield* runMigrations({ toMigrationInclusive: 57 });

      const retired = yield* sql<{
        readonly thread_id: string;
      }>`SELECT * FROM assistant_retired_threads`;
      assert.deepEqual(retired, [{ thread_id: "assistant-chat" }]);
      const messages = yield* sql<{ readonly id: string; readonly delivered: number }>`
        SELECT id, delivered FROM assistant_messages ORDER BY id`;
      assert.deepEqual(messages, [
        { id: "lead", delivered: 0 },
        { id: "wake", delivered: 1 },
      ]);
      const decisions = yield* sql<{ readonly id: string; readonly resolved: number }>`
        SELECT id, resolved FROM assistant_decisions ORDER BY id`;
      assert.deepEqual(decisions, [
        { id: "asked", resolved: 1 },
        { id: "team", resolved: 0 },
      ]);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(assistant_projects)`;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["project_id", "repository_key", "config", "status", "error", "limited_until"],
      );
      const projects = yield* sql`SELECT * FROM assistant_projects`;
      assert.deepEqual(projects, [
        {
          project_id: "project-1",
          repository_key: "/repo/.git",
          config: "{}",
          status: "running",
          error: null,
          limited_until: "2026-09-16T00:00:00.000Z",
        },
      ]);
      // One repository still has one assistant.
      const duplicate =
        yield* sql`INSERT INTO assistant_projects (project_id, repository_key, config)
        VALUES ('project-2', '/repo/.git', '{}')`.pipe(Effect.isFailure);
      assert.isTrue(duplicate);
      // Running it again changes nothing.
      yield* retireCoordinator;
      assert.lengthOf(yield* sql`SELECT * FROM assistant_projects`, 1);
    }),
  );
});
