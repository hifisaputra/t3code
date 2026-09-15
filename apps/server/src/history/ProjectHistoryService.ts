/**
 * ProjectHistoryService - answers "what did I work on each day" for one project.
 *
 * The read is two queries over the turn projection: every turn whose start
 * could land inside the requested window, then one lifetime aggregate for the
 * threads that actually appear. Day bucketing happens in TypeScript because the
 * client's IANA zone is the only thing that can decide which calendar day a
 * turn belongs to, and SQLite cannot resolve zone rules.
 *
 * @module ProjectHistoryService
 */
import {
  IsoDateTime,
  ProjectHistory,
  ProjectHistoryDay,
  ProjectHistoryInput,
  ProjectHistoryInterval,
  ProjectHistoryReadError,
  ProjectHistoryThreadDay,
  ProjectHistoryThreadTotals,
  ProjectId,
  ThreadId,
  ThreadLinkedIssue,
  type HistoryDay,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Widest window a client may ask for, so one read stays bounded. */
const MAX_WINDOW_DAYS = 400;

/** Turns closer together than this are one work session, not two. */
const INTERVAL_MERGE_GAP_MS = 60_000;

/** SQLite's variable limit is far higher, but keep statements sane. */
const THREAD_ID_CHUNK = 500;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ProjectHistoryTurnsRequest = Schema.Struct({
  projectId: ProjectId,
  /** Inclusive lower bound on `requested_at`, with a day of zone slack. */
  fromInstant: Schema.String,
  /** Exclusive upper bound on `requested_at`, with two days of zone slack. */
  toInstant: Schema.String,
});

const ProjectHistoryTurnRow = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.String,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  linkedIssue: Schema.NullOr(Schema.fromJsonString(ThreadLinkedIssue)),
  archivedAt: Schema.NullOr(IsoDateTime),
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectHistoryTurnRow = typeof ProjectHistoryTurnRow.Type;

const decodeThreadTotals = Schema.decodeUnknownEffect(Schema.Array(ProjectHistoryThreadTotals));

const isoFromMs = (timestampMs: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(timestampMs));

const msFromIso = (iso: string): number | null =>
  Option.match(DateTime.make(iso), {
    onNone: () => null,
    onSome: (instant) => DateTime.toEpochMillis(instant),
  });

/**
 * Parses a `YYYY-MM-DD` day as the UTC midnight that starts it, rejecting
 * calendar-invalid days (`2026-02-31`) that date parsing would roll over.
 */
function parseDayStartMs(day: string): number | null {
  if (!DAY_PATTERN.test(day)) return null;
  const ms = msFromIso(`${day}T00:00:00.000Z`);
  if (ms === null) return null;
  return isoFromMs(ms).slice(0, 10) === day ? ms : null;
}

function shiftDayToInstant(dayStartMs: number, days: number): string {
  return isoFromMs(dayStartMs + days * DAY_MS);
}

/** One turn reduced to the span it occupied, in the reporting zone. */
export interface TurnSpan {
  readonly day: string;
  readonly threadId: ProjectHistoryTurnRow["threadId"];
  readonly turnId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly running: boolean;
}

interface MutableThreadDay {
  readonly threadId: ProjectHistoryTurnRow["threadId"];
  readonly title: string;
  readonly branch: string | null;
  readonly linkedIssue: ThreadLinkedIssue | null;
  readonly archivedAt: string | null;
  turns: number;
  activeMs: number;
  firstStartMs: number;
  lastEndMs: number;
  running: boolean;
  readonly spans: TurnSpan[];
}

export interface AggregateHistoryOptions {
  /** Resolves an instant to its `YYYY-MM-DD` day in the reporting zone. */
  readonly dayFormat: Intl.DateTimeFormat;
  readonly sinceDay: string;
  readonly untilDay: string;
  /** Instant the read happened; a running turn counts up to it. */
  readonly readAtMs: number;
}

/**
 * The zone database lives in Intl, so an unknown zone is only discoverable by
 * trying to build a formatter with it. `en-CA` yields ISO-ordered parts.
 */
export function makeDayFormat(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return null;
  }
}

/**
 * Turns a turn row into the span it occupied. A turn that never started is
 * treated as an instant at its request time, and a running turn runs to now.
 */
function toTurnSpan(
  row: ProjectHistoryTurnRow,
  readAtMs: number,
  toDay: (timestampMs: number) => string,
): TurnSpan | null {
  const startMs = msFromIso(row.startedAt ?? row.requestedAt);
  if (startMs === null) return null;

  const running = row.state === "running" && row.completedAt === null;
  const rawEndMs =
    row.completedAt !== null ? msFromIso(row.completedAt) : running ? readAtMs : startMs;
  // A completion stamped before its start would make the day's total negative.
  const endMs = rawEndMs !== null && rawEndMs > startMs ? rawEndMs : startMs;

  return {
    day: toDay(startMs),
    threadId: row.threadId,
    turnId: row.turnId,
    startMs,
    endMs,
    running,
  };
}

/**
 * Merges a thread's spans within one day into work sessions: consecutive turns
 * less than {@link INTERVAL_MERGE_GAP_MS} apart become a single interval, so a
 * chatty hour renders as one bar rather than forty.
 */
export function mergeSpans(spans: readonly TurnSpan[]): ProjectHistoryInterval[] {
  const ordered = [...spans].sort(
    (left, right) => left.startMs - right.startMs || left.turnId.localeCompare(right.turnId),
  );
  const intervals: { startMs: number; endMs: number }[] = [];
  for (const span of ordered) {
    const current = intervals.at(-1);
    if (current !== undefined && span.startMs - current.endMs <= INTERVAL_MERGE_GAP_MS) {
      current.endMs = Math.max(current.endMs, span.endMs);
      continue;
    }
    intervals.push({ startMs: span.startMs, endMs: span.endMs });
  }
  return intervals.map((interval) => ({
    start: isoFromMs(interval.startMs),
    end: isoFromMs(interval.endMs),
  }));
}

/**
 * Folds turn rows into `(day, thread)` rows for the requested window. Days
 * come back newest first; threads inside a day come back earliest first.
 */
export function aggregateHistoryDays(
  rows: readonly ProjectHistoryTurnRow[],
  options: AggregateHistoryOptions,
): ProjectHistoryDay[] {
  const toDay = (timestampMs: number) => options.dayFormat.format(timestampMs);

  const byDay = new Map<string, Map<string, MutableThreadDay>>();
  for (const row of rows) {
    const span = toTurnSpan(row, options.readAtMs, toDay);
    // The SQL window is padded for zone offsets, so the exact day filter is here.
    if (span === null || span.day < options.sinceDay || span.day > options.untilDay) continue;

    let threads = byDay.get(span.day);
    if (threads === undefined) {
      threads = new Map();
      byDay.set(span.day, threads);
    }
    const existing = threads.get(row.threadId);
    if (existing === undefined) {
      threads.set(row.threadId, {
        threadId: row.threadId,
        title: row.title,
        branch: row.branch,
        linkedIssue: row.linkedIssue,
        archivedAt: row.archivedAt,
        turns: 1,
        activeMs: span.endMs - span.startMs,
        firstStartMs: span.startMs,
        lastEndMs: span.endMs,
        running: span.running,
        spans: [span],
      });
      continue;
    }
    existing.turns += 1;
    existing.activeMs += span.endMs - span.startMs;
    existing.firstStartMs = Math.min(existing.firstStartMs, span.startMs);
    existing.lastEndMs = Math.max(existing.lastEndMs, span.endMs);
    existing.running ||= span.running;
    existing.spans.push(span);
  }

  const days: ProjectHistoryDay[] = [];
  for (const [day, threadsByDay] of byDay) {
    const threads: ProjectHistoryThreadDay[] = [...threadsByDay.values()]
      .sort(
        (left, right) =>
          left.firstStartMs - right.firstStartMs || left.threadId.localeCompare(right.threadId),
      )
      .map((thread) => ({
        threadId: thread.threadId,
        title: thread.title,
        branch: thread.branch,
        linkedIssue: thread.linkedIssue,
        archivedAt: thread.archivedAt,
        turns: thread.turns,
        activeMs: Math.round(thread.activeMs),
        firstActivityAt: isoFromMs(thread.firstStartMs),
        lastActivityAt: isoFromMs(thread.lastEndMs),
        running: thread.running,
        intervals: mergeSpans(thread.spans),
      }));

    days.push({
      day: day as HistoryDay,
      activeMs: threads.reduce((total, thread) => total + thread.activeMs, 0),
      turns: threads.reduce((total, thread) => total + thread.turns, 0),
      threads,
    });
  }

  return days.sort((left, right) => right.day.localeCompare(left.day));
}

export class ProjectHistoryService extends Context.Service<
  ProjectHistoryService,
  {
    readonly readProjectHistory: (
      input: ProjectHistoryInput,
    ) => Effect.Effect<ProjectHistory, ProjectHistoryReadError>;
  }
>()("t3/history/ProjectHistoryService") {}

/** Empty history, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  ProjectHistoryService,
  ProjectHistoryService.of({
    readProjectHistory: (input) =>
      Effect.succeed({
        projectId: input.projectId,
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        readAt: "1970-01-01T00:00:00.000Z",
        days: [],
        threads: [],
      }),
  }),
);

const readFailed = (detail: string) => (cause: Cause.Cause<unknown>) =>
  new ProjectHistoryReadError({ reason: "readFailed", detail, cause: Cause.squash(cause) });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listWindowTurns = SqlSchema.findAll({
    Request: ProjectHistoryTurnsRequest,
    Result: ProjectHistoryTurnRow,
    execute: ({ projectId, fromInstant, toInstant }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          threads.title AS "title",
          threads.branch AS "branch",
          threads.linked_issue_json AS "linkedIssue",
          threads.archived_at AS "archivedAt",
          turns.state AS "state",
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt"
        FROM projection_turns AS turns
        JOIN projection_threads AS threads
          ON threads.thread_id = turns.thread_id
        WHERE threads.project_id = ${projectId}
          AND threads.deleted_at IS NULL
          AND turns.turn_id IS NOT NULL
          AND turns.requested_at >= ${fromInstant}
          AND turns.requested_at < ${toInstant}
        ORDER BY turns.requested_at ASC
      `,
  });

  /**
   * Lifetime figures for the threads a window turned up, so a day row can say
   * "40m today, 5h20m in total". Deliberately unfiltered by date.
   */
  const listThreadTotals = Effect.fn("ProjectHistoryService.listThreadTotals")(function* (
    threadIds: readonly string[],
    readAt: string,
  ) {
    const totals: ProjectHistoryThreadTotals[] = [];
    for (let offset = 0; offset < threadIds.length; offset += THREAD_ID_CHUNK) {
      const chunk = threadIds.slice(offset, offset + THREAD_ID_CHUNK);
      const rows = yield* sql`
        SELECT
          thread_id AS "threadId",
          COUNT(*) AS "turns",
          MIN(COALESCE(started_at, requested_at)) AS "firstActivityAt",
          MAX(COALESCE(completed_at, started_at, requested_at)) AS "lastActivityAt",
          CAST(
            ROUND(
              COALESCE(
                SUM(
                  MAX(
                    0,
                    (
                      julianday(COALESCE(completed_at, ${readAt}))
                        - julianday(COALESCE(started_at, requested_at))
                    ) * 86400000
                  )
                ),
                0
              )
            ) AS INTEGER
          ) AS "activeMs"
        FROM projection_turns
        WHERE ${sql.in("thread_id", chunk)}
          AND turn_id IS NOT NULL
        GROUP BY thread_id
      `;
      totals.push(...(yield* decodeThreadTotals(rows)));
    }
    return totals.sort((left, right) => left.threadId.localeCompare(right.threadId));
  });

  const readProjectHistory = Effect.fn("ProjectHistoryService.readProjectHistory")(function* (
    input: ProjectHistoryInput,
  ) {
    const sinceMs = parseDayStartMs(input.sinceDay);
    const untilMs = parseDayStartMs(input.untilDay);
    if (sinceMs === null || untilMs === null) {
      return yield* new ProjectHistoryReadError({
        reason: "invalidWindow",
        detail: `'${input.sinceDay}'..'${input.untilDay}' is not a valid day range`,
      });
    }
    if (sinceMs > untilMs) {
      return yield* new ProjectHistoryReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }
    if ((untilMs - sinceMs) / DAY_MS + 1 > MAX_WINDOW_DAYS) {
      return yield* new ProjectHistoryReadError({
        reason: "invalidWindow",
        detail: `Window must be at most ${MAX_WINDOW_DAYS} days`,
      });
    }
    const dayFormat = makeDayFormat(input.timeZone);
    if (dayFormat === null) {
      return yield* new ProjectHistoryReadError({
        reason: "invalidWindow",
        detail: `'${input.timeZone}' is not a known time zone`,
      });
    }

    const readAtMs = yield* Clock.currentTimeMillis;
    const readAt = isoFromMs(readAtMs);

    const rows = yield* listWindowTurns({
      projectId: input.projectId,
      fromInstant: shiftDayToInstant(sinceMs, -1),
      toInstant: shiftDayToInstant(untilMs, 2),
    }).pipe(Effect.catchCause(readFailed("The project's turns could not be read.")));

    const days = aggregateHistoryDays(rows, {
      dayFormat,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      readAtMs,
    });

    const threadIds = [...new Set(days.flatMap((day) => day.threads.map((t) => t.threadId)))];
    const threads =
      threadIds.length === 0
        ? []
        : yield* listThreadTotals(threadIds, readAt).pipe(
            Effect.catchCause(readFailed("The threads' lifetime totals could not be read.")),
          );

    return {
      projectId: input.projectId,
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      readAt,
      days,
      threads,
    } satisfies ProjectHistory;
  });

  return { readProjectHistory } as const;
});

export const layer = Layer.effect(ProjectHistoryService, make);
