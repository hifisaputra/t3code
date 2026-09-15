/**
 * Project history contract.
 *
 * Answers "what did I work on each day, and how long did each thread take"
 * for one project. The server reads its own turn projection (every turn
 * records when it was requested, started and completed) and buckets turns
 * into calendar days in the client's time zone, so a turn lands on the day the
 * user experienced it rather than the UTC day.
 *
 * Only `(day, thread)` rows cross the wire, never individual turns; a thread's
 * intervals within a day are merged so a busy day stays a few hundred bytes.
 *
 * @module history
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadLinkedIssue } from "./orchestration.ts";

const HISTORY_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day in the reporting time zone, formatted `YYYY-MM-DD`. */
export const HistoryDay = TrimmedNonEmptyString.check(Schema.isPattern(HISTORY_DAY_PATTERN)).pipe(
  Schema.brand("HistoryDay"),
);
export type HistoryDay = typeof HistoryDay.Type;

export const ProjectHistoryInput = Schema.Struct({
  projectId: ProjectId,
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: HistoryDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: HistoryDay,
  /** IANA zone the client wants days bucketed in. */
  timeZone: TrimmedNonEmptyString,
});
export type ProjectHistoryInput = typeof ProjectHistoryInput.Type;

/**
 * A stretch of agent work inside one day. Consecutive turns of the same
 * thread with less than a minute between them are merged into one interval,
 * so the timeline shows work sessions rather than every prompt.
 */
export const ProjectHistoryInterval = Schema.Struct({
  start: IsoDateTime,
  end: IsoDateTime,
});
export type ProjectHistoryInterval = typeof ProjectHistoryInterval.Type;

/** One thread's work on one day. */
export const ProjectHistoryThreadDay = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  linkedIssue: Schema.NullOr(ThreadLinkedIssue),
  archivedAt: Schema.NullOr(IsoDateTime),
  /** Turns that started on this day. */
  turns: NonNegativeInt,
  /**
   * Agent working time on this day: the sum of each turn's start-to-completion
   * span. A running turn counts up to `readAt`.
   */
  activeMs: NonNegativeInt,
  firstActivityAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
  /** A turn of this thread was still running when the history was read. */
  running: Schema.Boolean,
  /** Merged work intervals, earliest first. */
  intervals: Schema.Array(ProjectHistoryInterval),
});
export type ProjectHistoryThreadDay = typeof ProjectHistoryThreadDay.Type;

export const ProjectHistoryDay = Schema.Struct({
  day: HistoryDay,
  activeMs: NonNegativeInt,
  turns: NonNegativeInt,
  /** Threads worked on this day, earliest activity first. */
  threads: Schema.Array(ProjectHistoryThreadDay),
});
export type ProjectHistoryDay = typeof ProjectHistoryDay.Type;

/**
 * A thread's lifetime figures, independent of the window, so a day row can
 * say "40m today, 5h 20m in total".
 */
export const ProjectHistoryThreadTotals = Schema.Struct({
  threadId: ThreadId,
  turns: NonNegativeInt,
  activeMs: NonNegativeInt,
  firstActivityAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
});
export type ProjectHistoryThreadTotals = typeof ProjectHistoryThreadTotals.Type;

export const ProjectHistory = Schema.Struct({
  projectId: ProjectId,
  timeZone: TrimmedNonEmptyString,
  sinceDay: HistoryDay,
  untilDay: HistoryDay,
  readAt: IsoDateTime,
  /** Days with at least one turn, newest first. Quiet days are omitted. */
  days: Schema.Array(ProjectHistoryDay),
  /** Lifetime totals for every thread that appears in `days`. */
  threads: Schema.Array(ProjectHistoryThreadTotals),
});
export type ProjectHistory = typeof ProjectHistory.Type;

export class ProjectHistoryReadError extends Schema.TaggedErrorClass<ProjectHistoryReadError>()(
  "ProjectHistoryReadError",
  {
    reason: Schema.Literals(["invalidWindow", "readFailed"]),
    /** Stable, bounded description. The underlying failure travels in `cause`. */
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Project history read failed (${this.reason}): ${this.detail}`;
  }
}
