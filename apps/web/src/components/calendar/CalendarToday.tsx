import type { EnvironmentId, LinearIssueSummary } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { Button } from "../ui/button";
import { CalendarFeed, type Snapshot } from "./CalendarFeed";
import { dailyWork, type CalendarEntry } from "./calendarPlanning";
import { calendarDayRange, localCalendarDate } from "./calendarTime";
import { useCalendarNow } from "./useCalendarRefresh";

export function CalendarToday({
  environmentId,
  calendars,
  issues,
  refreshKey,
  onWork,
  hasThread,
  onSchedule,
  disabled,
}: {
  environmentId: EnvironmentId;
  calendars: readonly { id: string; title: string }[];
  issues: readonly LinearIssueSummary[];
  refreshKey: number;
  onWork: (identifier: string) => void;
  hasThread: (identifier: string) => boolean;
  onSchedule: (identifier: string, day: string, time: string) => void;
  disabled: boolean;
}) {
  const now = useCalendarNow();
  const today = localCalendarDate(new Date(now));
  const range = calendarDayRange(today)!;
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const report = useCallback((key: string, snapshot: Snapshot) => {
    setSnapshots((current) =>
      Object.fromEntries([
        ...Object.entries(current)
          .filter(([id]) => id !== key)
          .slice(-99),
        [key, snapshot],
      ]),
    );
  }, []);
  const selected = calendars.map((c) => ({
    calendar: c,
    snapshot: snapshots[JSON.stringify([c.id, range.start, range.end])],
  }));
  const entries = selected.flatMap(({ calendar, snapshot }) =>
    (snapshot?.events ?? []).map((event) => ({
      ...event,
      calendarId: calendar.id,
      calendarTitle: calendar.title,
    })),
  );
  const work = dailyWork(entries, now);
  const incomplete = selected.some(
    ({ snapshot }) => !snapshot || snapshot.loading || snapshot.error,
  );
  const [dismissed, setDismissed] = useState<string[]>([]);
  const keyFor = (event: CalendarEntry) => `${today}:${event.calendarId}:${event.id}:${event.end}`;
  const ended = work.ended.filter((event) => {
    const issue = issues.find((issue) => issue.identifier === event.issueIdentifier);
    return (
      !dismissed.includes(keyFor(event)) &&
      issue?.state.type !== "completed" &&
      issue?.state.type !== "canceled"
    );
  });
  const renderBlock = (event: CalendarEntry, label: string, followUp = false) => (
    <li
      key={`${event.calendarId}:${event.id}`}
      className="flex flex-wrap items-center gap-2 rounded border p-2"
    >
      <span className="text-xs font-medium">{label}</span>
      <span className="text-xs">
        {new Date(event.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–
        {new Date(event.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ·{" "}
        {event.title} · {event.calendarTitle}
      </span>
      <Button size="sm" variant="outline" onClick={() => onWork(event.issueIdentifier!)}>
        {hasThread(event.issueIdentifier!) ? "Resume thread" : "Start working"}
      </Button>
      {followUp ? (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              const next = new Date(Math.ceil((Date.now() + 60_000) / 1_800_000) * 1_800_000);
              onSchedule(
                event.issueIdentifier!,
                localCalendarDate(next),
                `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`,
              );
            }}
          >
            Plan another session
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDismissed((current) => [...current, keyFor(event)])}
          >
            Dismiss
          </Button>
        </>
      ) : null}
    </li>
  );
  return (
    <section className="space-y-2 rounded border p-2">
      {calendars.map((calendar) => (
        <CalendarFeed
          key={calendar.id}
          environmentId={environmentId}
          calendarId={calendar.id}
          {...range}
          refreshKey={refreshKey}
          report={report}
        />
      ))}
      <p className="text-sm font-medium">Today / Up next</p>
      {incomplete ? (
        <p role="status" className="text-xs">
          Today’s schedule is incomplete. Use Refresh to retry.
        </p>
      ) : null}
      {selected
        .filter(({ snapshot }) => snapshot?.error)
        .map(({ calendar, snapshot }) => (
          <p key={calendar.id} role="alert" className="text-xs text-destructive">
            {calendar.title}: {snapshot?.error}
          </p>
        ))}
      <ul className="max-h-48 space-y-1 overflow-auto">
        {work.current.map((event) => renderBlock(event, "Now"))}
        {work.upcoming.map((event, index) =>
          renderBlock(event, index === 0 ? "Up next" : "Later today"),
        )}
      </ul>
      {!work.current.length && !work.upcoming.length && !incomplete ? (
        <p className="text-xs text-muted-foreground">
          No remaining linked work blocks today on the displayed calendars.
        </p>
      ) : null}
      {dismissed.length ? (
        <Button size="sm" variant="ghost" onClick={() => setDismissed([])}>
          Restore dismissed reminders
        </Button>
      ) : null}
      {ended.length ? (
        <details>
          <summary className="cursor-pointer text-xs">
            Ended blocks ({ended.length}) · Still unfinished?
          </summary>
          <p className="py-1 text-xs text-muted-foreground">
            Plan more time if needed. Ending a block never completes the Linear issue. Dismiss hides
            this reminder for this visit.
          </p>
          <ul className="max-h-48 space-y-1 overflow-auto">
            {ended.map((event) => renderBlock(event, "Ended", true))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
