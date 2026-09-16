import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import assistantLinearReplies from "./059_AssistantLinearReplies.ts";

it.layer(NodeSqliteClient.layerMemory())("059_AssistantLinearReplies", (it) => {
  it.effect("records each handled delivery once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`INSERT OR IGNORE INTO assistant_linear_replies (delivery_id, task_id, handled_at) VALUES ('d1', 'task-1', 'now')`;
      yield* sql`INSERT OR IGNORE INTO assistant_linear_replies (delivery_id, task_id, handled_at) VALUES ('d1', 'task-1', 'later')`;
      // Running it again changes nothing.
      yield* assistantLinearReplies;
      assert.deepEqual(yield* sql`SELECT delivery_id, handled_at FROM assistant_linear_replies`, [
        { delivery_id: "d1", handled_at: "now" },
      ]);
    }),
  );
});
