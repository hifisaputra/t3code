import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import assistantProjectNotes from "./060_AssistantProjectNotes.ts";

it.layer(NodeSqliteClient.layerMemory())("060_AssistantProjectNotes", (it) => {
  it.effect("adds the notes table and keeps existing setups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`INSERT INTO assistant_setups (project_id, repository_key, thread_id, preferences)
        VALUES ('project-1', '/repo/.git', 'assistant-setup-1', '{}')`;
      yield* runMigrations({ toMigrationInclusive: 60 });

      yield* sql`INSERT INTO assistant_project_notes (id, project_id, text, role, task_id, issue_identifier, created_at)
        VALUES ('note-1', 'project-1', 'Staging has no Search Console data.', 'e2e', 'task-1', 'APP-1', 'now')`;
      assert.deepEqual(
        yield* sql`SELECT id, absorbed_at FROM assistant_project_notes WHERE absorbed_at IS NULL`,
        [{ id: "note-1", absorbed_at: null }],
      );
      assert.deepEqual(
        yield* sql`SELECT project_id, notes_read, proposal_notes FROM assistant_setups`,
        [{ project_id: "project-1", notes_read: null, proposal_notes: null }],
      );
      // Running it again changes nothing.
      yield* assistantProjectNotes;
      assert.lengthOf(yield* sql`SELECT * FROM assistant_project_notes`, 1);
    }),
  );
});
