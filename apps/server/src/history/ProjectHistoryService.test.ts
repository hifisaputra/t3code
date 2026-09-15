import { assert, it } from "@effect/vitest";
import type { HistoryDay, ProjectHistoryInput, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectHistoryService from "./ProjectHistoryService.ts";

const layer = it.layer(
  ProjectHistoryService.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const MODEL_SELECTION = '{"instanceId":"codex","model":"gpt-5.6-sol"}';
const READ_AT = "2026-09-15T10:00:00.000Z";

interface ThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title?: string;
  readonly branch?: string | null;
  readonly linkedIssue?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}

interface TurnRow {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly state?: string;
  readonly requestedAt: string;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

const insertThread = (sql: SqlClient.SqlClient, row: ThreadRow) =>
  sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, branch,
      linked_issue_json, archived_at, created_at, updated_at, deleted_at
    )
    VALUES (
      ${row.threadId}, ${row.projectId}, ${row.title ?? row.threadId}, ${MODEL_SELECTION},
      ${row.branch ?? null}, ${row.linkedIssue ?? null}, ${row.archivedAt ?? null},
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ${row.deletedAt ?? null}
    )
  `;

const insertTurn = (sql: SqlClient.SqlClient, row: TurnRow) =>
  sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json
    )
    VALUES (
      ${row.threadId}, ${row.turnId}, ${row.state ?? "completed"}, ${row.requestedAt},
      ${row.startedAt ?? null}, ${row.completedAt ?? null}, '[]'
    )
  `;

const makeInput = (overrides: {
  readonly projectId: string;
  readonly timeZone?: string;
  readonly sinceDay?: string;
  readonly untilDay?: string;
}): ProjectHistoryInput => ({
  projectId: overrides.projectId as ProjectId,
  sinceDay: (overrides.sinceDay ?? "2026-09-01") as HistoryDay,
  untilDay: (overrides.untilDay ?? "2026-09-30") as HistoryDay,
  timeZone: overrides.timeZone ?? "UTC",
});

/** Every test shares one in-memory database, so each seeds its own project. */
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* TestClock.setTime(Date.parse(READ_AT));
  return sql;
});

layer("ProjectHistoryService", (it) => {
  it.effect("buckets a turn by the requested time zone", () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const history = yield* ProjectHistoryService.ProjectHistoryService;

      yield* insertThread(sql, { threadId: "tz-thread", projectId: "tz-project" });
      yield* insertTurn(sql, {
        threadId: "tz-thread",
        turnId: "tz-turn",
        requestedAt: "2026-09-14T23:30:00.000Z",
        startedAt: "2026-09-14T23:30:00.000Z",
        completedAt: "2026-09-14T23:35:00.000Z",
      });

      const singapore = yield* history.readProjectHistory(
        makeInput({ projectId: "tz-project", timeZone: "Asia/Singapore" }),
      );
      assert.deepStrictEqual(
        singapore.days.map((day) => day.day),
        ["2026-09-15"],
      );

      const utc = yield* history.readProjectHistory(makeInput({ projectId: "tz-project" }));
      assert.deepStrictEqual(
        utc.days.map((day) => day.day),
        ["2026-09-14"],
      );
      assert.strictEqual(utc.readAt, READ_AT);
      assert.strictEqual(utc.days[0]?.threads[0]?.activeMs, 5 * 60 * 1000);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("merges turns a minute apart and keeps distant ones separate", () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const history = yield* ProjectHistoryService.ProjectHistoryService;

      yield* insertThread(sql, { threadId: "merge-close", projectId: "merge-project" });
      yield* insertTurn(sql, {
        threadId: "merge-close",
        turnId: "close-1",
        requestedAt: "2026-09-15T09:00:00.000Z",
        startedAt: "2026-09-15T09:00:00.000Z",
        completedAt: "2026-09-15T09:01:00.000Z",
      });
      yield* insertTurn(sql, {
        threadId: "merge-close",
        turnId: "close-2",
        requestedAt: "2026-09-15T09:01:30.000Z",
        startedAt: "2026-09-15T09:01:30.000Z",
        completedAt: "2026-09-15T09:02:00.000Z",
      });

      yield* insertThread(sql, { threadId: "merge-far", projectId: "merge-project" });
      yield* insertTurn(sql, {
        threadId: "merge-far",
        turnId: "far-1",
        requestedAt: "2026-09-15T09:00:00.000Z",
        startedAt: "2026-09-15T09:00:00.000Z",
        completedAt: "2026-09-15T09:01:00.000Z",
      });
      yield* insertTurn(sql, {
        threadId: "merge-far",
        turnId: "far-2",
        requestedAt: "2026-09-15T09:06:00.000Z",
        startedAt: "2026-09-15T09:06:00.000Z",
        completedAt: "2026-09-15T09:07:00.000Z",
      });

      const result = yield* history.readProjectHistory(makeInput({ projectId: "merge-project" }));
      const threads = result.days[0]?.threads ?? [];
      const close = threads.find((thread) => thread.threadId === "merge-close");
      const far = threads.find((thread) => thread.threadId === "merge-far");

      assert.deepStrictEqual(close?.intervals, [
        { start: "2026-09-15T09:00:00.000Z", end: "2026-09-15T09:02:00.000Z" },
      ]);
      assert.deepStrictEqual(far?.intervals, [
        { start: "2026-09-15T09:00:00.000Z", end: "2026-09-15T09:01:00.000Z" },
        { start: "2026-09-15T09:06:00.000Z", end: "2026-09-15T09:07:00.000Z" },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("counts a running turn up to the read instant", () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const history = yield* ProjectHistoryService.ProjectHistoryService;

      yield* insertThread(sql, { threadId: "running-thread", projectId: "running-project" });
      yield* insertTurn(sql, {
        threadId: "running-thread",
        turnId: "running-turn",
        state: "running",
        requestedAt: "2026-09-15T09:29:00.000Z",
        startedAt: "2026-09-15T09:30:00.000Z",
        completedAt: null,
      });

      const result = yield* history.readProjectHistory(makeInput({ projectId: "running-project" }));
      const thread = result.days[0]?.threads[0];
      assert.strictEqual(thread?.running, true);
      assert.strictEqual(thread?.activeMs, 30 * 60 * 1000);
      assert.strictEqual(thread?.lastActivityAt, READ_AT);
      assert.deepStrictEqual(thread?.intervals, [
        { start: "2026-09-15T09:30:00.000Z", end: READ_AT },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ignores deleted threads, other projects and pending turn starts", () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const history = yield* ProjectHistoryService.ProjectHistoryService;

      yield* insertThread(sql, { threadId: "kept-thread", projectId: "filter-project" });
      yield* insertThread(sql, {
        threadId: "deleted-thread",
        projectId: "filter-project",
        deletedAt: "2026-09-10T00:00:00.000Z",
      });
      yield* insertThread(sql, { threadId: "other-thread", projectId: "other-project" });

      for (const threadId of ["kept-thread", "deleted-thread", "other-thread"]) {
        yield* insertTurn(sql, {
          threadId,
          turnId: `${threadId}-turn`,
          requestedAt: "2026-09-15T08:00:00.000Z",
          startedAt: "2026-09-15T08:00:00.000Z",
          completedAt: "2026-09-15T08:10:00.000Z",
        });
      }
      // A queued start that never became a turn.
      yield* insertTurn(sql, {
        threadId: "kept-thread",
        turnId: null,
        state: "pending",
        requestedAt: "2026-09-15T08:30:00.000Z",
      });

      const result = yield* history.readProjectHistory(makeInput({ projectId: "filter-project" }));
      assert.strictEqual(result.days.length, 1);
      assert.deepStrictEqual(
        result.days[0]?.threads.map((thread) => thread.threadId),
        ["kept-thread"],
      );
      assert.strictEqual(result.days[0]?.turns, 1);
      assert.deepStrictEqual(
        result.threads.map((thread) => thread.threadId),
        ["kept-thread"],
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("orders days newest first and threads by first activity", () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const history = yield* ProjectHistoryService.ProjectHistoryService;

      yield* insertThread(sql, { threadId: "order-late", projectId: "order-project" });
      yield* insertThread(sql, { threadId: "order-early", projectId: "order-project" });

      yield* insertTurn(sql, {
        threadId: "order-late",
        turnId: "late-1",
        requestedAt: "2026-09-14T11:00:00.000Z",
        startedAt: "2026-09-14T11:00:00.000Z",
        completedAt: "2026-09-14T11:20:00.000Z",
      });
      yield* insertTurn(sql, {
        threadId: "order-early",
        turnId: "early-1",
        requestedAt: "2026-09-14T09:00:00.000Z",
        startedAt: "2026-09-14T09:00:00.000Z",
        completedAt: "2026-09-14T09:10:00.000Z",
      });
      yield* insertTurn(sql, {
        threadId: "order-early",
        turnId: "early-2",
        requestedAt: "2026-09-15T09:00:00.000Z",
        startedAt: "2026-09-15T09:00:00.000Z",
        completedAt: "2026-09-15T09:05:00.000Z",
      });

      const result = yield* history.readProjectHistory(makeInput({ projectId: "order-project" }));
      assert.deepStrictEqual(
        result.days.map((day) => day.day),
        ["2026-09-15", "2026-09-14"],
      );
      const older = result.days[1];
      assert.deepStrictEqual(
        older?.threads.map((thread) => thread.threadId),
        ["order-early", "order-late"],
      );
      assert.strictEqual(
        older?.activeMs,
        older?.threads.reduce((total, thread) => total + thread.activeMs, 0),
      );
      assert.strictEqual(
        older?.turns,
        older?.threads.reduce((total, thread) => total + thread.turns, 0),
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reports lifetime totals that include turns outside the window", () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      const history = yield* ProjectHistoryService.ProjectHistoryService;

      yield* insertThread(sql, {
        threadId: "lifetime-thread",
        projectId: "lifetime-project",
        branch: "feat/history",
        linkedIssue: '{"provider":"linear","id":"iss-1","identifier":"DEL-1","url":"https://x/1"}',
        archivedAt: "2026-09-16T00:00:00.000Z",
      });
      yield* insertTurn(sql, {
        threadId: "lifetime-thread",
        turnId: "old-turn",
        requestedAt: "2026-07-01T09:00:00.000Z",
        startedAt: "2026-07-01T09:00:00.000Z",
        completedAt: "2026-07-01T09:10:00.000Z",
      });
      yield* insertTurn(sql, {
        threadId: "lifetime-thread",
        turnId: "window-turn",
        requestedAt: "2026-09-15T09:00:00.000Z",
        startedAt: "2026-09-15T09:00:00.000Z",
        completedAt: "2026-09-15T09:05:00.000Z",
      });

      const result = yield* history.readProjectHistory(
        makeInput({ projectId: "lifetime-project" }),
      );
      const thread = result.days[0]?.threads[0];
      assert.strictEqual(thread?.branch, "feat/history");
      assert.strictEqual(thread?.linkedIssue?.identifier, "DEL-1");
      assert.strictEqual(thread?.archivedAt, "2026-09-16T00:00:00.000Z");
      assert.strictEqual(thread?.turns, 1);

      assert.deepStrictEqual(result.threads, [
        {
          threadId: "lifetime-thread" as ThreadId,
          turns: 2,
          activeMs: 15 * 60 * 1000,
          firstActivityAt: "2026-07-01T09:00:00.000Z",
          lastActivityAt: "2026-09-15T09:05:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rejects a reversed window and an unknown time zone", () =>
    Effect.gen(function* () {
      yield* setup;
      const history = yield* ProjectHistoryService.ProjectHistoryService;

      const reversed = yield* history
        .readProjectHistory(
          makeInput({
            projectId: "invalid-project",
            sinceDay: "2026-09-30",
            untilDay: "2026-09-01",
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(reversed.reason, "invalidWindow");

      const badZone = yield* history
        .readProjectHistory(makeInput({ projectId: "invalid-project", timeZone: "Mars/Olympus" }))
        .pipe(Effect.flip);
      assert.strictEqual(badZone.reason, "invalidWindow");

      const tooWide = yield* history
        .readProjectHistory(
          makeInput({
            projectId: "invalid-project",
            sinceDay: "2024-01-01",
            untilDay: "2026-09-01",
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(tooWide.reason, "invalidWindow");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
