/**
 * The day-by-day timeline: a 24-hour strip per day with one lane per thread,
 * then a row per thread.
 *
 * A 90-day window can hold hundreds of thread rows, so every day section is
 * memoised and every row is plain markup: no atoms, no effects, no animation.
 *
 * @module components/history/HistoryTimeline
 */
import type {
  EnvironmentId,
  ProjectHistoryDay,
  ProjectHistoryThreadDay,
  ProjectHistoryThreadTotals,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import {
  formatDayHeading,
  formatDurationMs,
  HISTORY_HOUR_TICKS,
  intervalToLanePercent,
  laneColorClass,
  pluralize,
} from "./historyPage.logic";

export interface HistoryTimelineProps {
  readonly days: readonly ProjectHistoryDay[];
  readonly environmentId: EnvironmentId;
  readonly timeZone: string;
  readonly timestampFormat: TimestampFormat;
  readonly locale: string | undefined;
  readonly lifetimeByThread: ReadonlyMap<ThreadId, ProjectHistoryThreadTotals>;
}

export function HistoryTimeline({
  days,
  environmentId,
  timeZone,
  timestampFormat,
  locale,
  lifetimeByThread,
}: HistoryTimelineProps) {
  return (
    <div className="flex flex-col gap-8">
      {days.map((day) => (
        <HistoryDaySection
          key={day.day}
          day={day}
          environmentId={environmentId}
          timeZone={timeZone}
          timestampFormat={timestampFormat}
          locale={locale}
          lifetimeByThread={lifetimeByThread}
        />
      ))}
    </div>
  );
}

const HistoryDaySection = memo(function HistoryDaySection({
  day,
  environmentId,
  timeZone,
  timestampFormat,
  locale,
  lifetimeByThread,
}: {
  readonly day: ProjectHistoryDay;
  readonly environmentId: EnvironmentId;
  readonly timeZone: string;
  readonly timestampFormat: TimestampFormat;
  readonly locale: string | undefined;
  readonly lifetimeByThread: ReadonlyMap<ThreadId, ProjectHistoryThreadTotals>;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">{formatDayHeading(day.day, locale)}</h3>
        <span className="text-xs text-muted-foreground">
          {formatDurationMs(day.activeMs)} · {pluralize(day.threads.length, "thread")} ·{" "}
          {pluralize(day.turns, "turn")}
        </span>
      </div>

      <DayStrip day={day} timeZone={timeZone} timestampFormat={timestampFormat} />

      <ul className="flex flex-col">
        {day.threads.map((thread, index) => (
          <HistoryThreadRow
            key={thread.threadId}
            thread={thread}
            laneIndex={index}
            environmentId={environmentId}
            timestampFormat={timestampFormat}
            lifetime={lifetimeByThread.get(thread.threadId) ?? null}
          />
        ))}
      </ul>
    </section>
  );
});

/** The 0-24h axis with one lane per thread. */
function DayStrip({
  day,
  timeZone,
  timestampFormat,
}: {
  readonly day: ProjectHistoryDay;
  readonly timeZone: string;
  readonly timestampFormat: TimestampFormat;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="relative">
        <div className="relative overflow-hidden rounded-md border border-border bg-muted/30 px-0 py-1.5">
          {HISTORY_HOUR_TICKS.slice(1, -1).map((hour) => (
            <span
              aria-hidden
              key={hour}
              className="absolute inset-y-0 w-px bg-border/70"
              style={{ left: `${(hour / 24) * 100}%` }}
            />
          ))}
          <div className="relative flex flex-col gap-0.5">
            {day.threads.map((thread, index) => (
              <ThreadLane
                key={thread.threadId}
                thread={thread}
                day={day.day}
                laneIndex={index}
                timeZone={timeZone}
                timestampFormat={timestampFormat}
              />
            ))}
          </div>
        </div>
      </div>
      <div aria-hidden className="relative h-3 text-[10px] text-muted-foreground tabular-nums">
        {HISTORY_HOUR_TICKS.map((hour) => (
          <span
            key={hour}
            className={cn(
              "absolute top-0",
              hour === 0 ? "left-0" : hour === 24 ? "right-0" : "-translate-x-1/2",
            )}
            style={hour === 0 || hour === 24 ? undefined : { left: `${(hour / 24) * 100}%` }}
          >
            {hour}
          </span>
        ))}
      </div>
    </div>
  );
}

function ThreadLane({
  thread,
  day,
  laneIndex,
  timeZone,
  timestampFormat,
}: {
  readonly thread: ProjectHistoryThreadDay;
  readonly day: string;
  readonly laneIndex: number;
  readonly timeZone: string;
  readonly timestampFormat: TimestampFormat;
}) {
  const from = formatShortTimestamp(thread.firstActivityAt, timestampFormat);
  const to = formatShortTimestamp(thread.lastActivityAt, timestampFormat);
  return (
    <div
      aria-label={`${thread.title}, ${from} to ${to}, ${formatDurationMs(thread.activeMs)}`}
      className="relative h-2"
      role="img"
    >
      {thread.intervals.map((interval) => {
        const span = intervalToLanePercent(interval, day, timeZone);
        if (span === null) return null;
        return (
          <span
            aria-hidden
            key={`${interval.start}-${interval.end}`}
            className={cn(
              "absolute inset-y-0 min-w-[2px] rounded-[2px]",
              laneColorClass(laneIndex),
              thread.archivedAt !== null && "opacity-50",
            )}
            style={{ left: `${span.leftPercent}%`, width: `${span.widthPercent}%` }}
          />
        );
      })}
    </div>
  );
}

const HistoryThreadRow = memo(function HistoryThreadRow({
  thread,
  laneIndex,
  environmentId,
  timestampFormat,
  lifetime,
}: {
  readonly thread: ProjectHistoryThreadDay;
  readonly laneIndex: number;
  readonly environmentId: EnvironmentId;
  readonly timestampFormat: TimestampFormat;
  readonly lifetime: ProjectHistoryThreadTotals | null;
}) {
  const archived = thread.archivedAt !== null;
  const from = formatShortTimestamp(thread.firstActivityAt, timestampFormat);
  const to = formatShortTimestamp(thread.lastActivityAt, timestampFormat);
  // Lifetime figures only earn their space once they say something the day
  // row does not already say.
  const showLifetime =
    lifetime !== null && (lifetime.activeMs !== thread.activeMs || lifetime.turns !== thread.turns);

  return (
    <li className="flex min-w-0 items-start gap-3 border-b border-border/50 py-2 last:border-b-0">
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 shrink-0 rounded-[2px]", laneColorClass(laneIndex))}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            className={cn(
              "min-w-0 truncate rounded-sm text-sm outline-hidden ring-ring hover:underline focus-visible:ring-2",
              archived ? "text-muted-foreground" : "text-foreground",
            )}
            params={{ environmentId, threadId: thread.threadId }}
            to="/$environmentId/$threadId"
          >
            {thread.title}
          </Link>
          {thread.linkedIssue ? (
            <a
              className="shrink-0 rounded-sm border border-border px-1.5 py-px text-[11px] text-muted-foreground outline-hidden ring-ring hover:text-foreground focus-visible:ring-2"
              href={thread.linkedIssue.url}
              rel="noreferrer"
              target="_blank"
            >
              {thread.linkedIssue.identifier}
            </a>
          ) : null}
          {thread.branch ? (
            <span className="min-w-0 max-w-48 shrink-0 truncate rounded-sm bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
              {thread.branch}
            </span>
          ) : null}
          {thread.running ? (
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-info">
              <span aria-hidden className="size-1.5 rounded-full bg-info" />
              running
            </span>
          ) : null}
          {archived ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">archived</span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
          <span>
            {from} – {to}
          </span>
          <span aria-hidden>·</span>
          <span>{formatDurationMs(thread.activeMs)}</span>
          <span aria-hidden>·</span>
          <span>{pluralize(thread.turns, "turn")}</span>
          {showLifetime ? (
            <span className="text-muted-foreground/70">
              total {formatDurationMs(lifetime.activeMs)} over {pluralize(lifetime.turns, "turn")}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
});
