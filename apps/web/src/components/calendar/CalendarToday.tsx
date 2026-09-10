import type { EnvironmentId, LinearIssueSummary } from "@t3tools/contracts";
import { CalendarPlusIcon, ClockIcon, EllipsisIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CalendarFeed, type Snapshot } from "./CalendarFeed";
import { dailyWork, type CalendarEntry } from "./calendarPlanning";
import { formatClockTime } from "./calendarPresentation";
import { calendarDayRange, localCalendarDate } from "./calendarTime";
import { useCalendarNow } from "./useCalendarRefresh";

/** What each block is called, and the badge tone that says it at a glance. */
const BLOCK_LABELS = {
  now: { label: "Now", variant: "success" },
  next: { label: "Up next", variant: "info" },
  later: { label: "Later", variant: "outline" },
  ended: { label: "Ended", variant: "warning" },
} as const;

type BlockKind = keyof typeof BLOCK_LABELS;

/**
 * Today's linked work blocks, stacked for the planner's side column. Reads
 * today on its own so it stays right while the grid shows another week.
 */
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
  const renderBlock = (event: CalendarEntry, kind: BlockKind) => {
    const tone = BLOCK_LABELS[kind];
    return (
      <li
        key={`${event.calendarId}:${event.id}`}
        className="rounded-lg px-2.5 py-1.5 transition-colors hover:bg-accent/40"
      >
        <div className="flex items-center gap-2">
          <Badge size="sm" variant={tone.variant}>
            {tone.label}
          </Badge>
          <span className="tabular-nums text-xs text-muted-foreground">
            {formatClockTime(event.start)}–{formatClockTime(event.end)}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button size="xs" variant="ghost" onClick={() => onWork(event.issueIdentifier!)}>
              {hasThread(event.issueIdentifier!) ? "Resume" : "Start"}
            </Button>
            {kind === "ended" ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label={`More for ${event.title}`}
                      size="icon-xs"
                      variant="ghost-muted"
                    />
                  }
                >
                  <EllipsisIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-52">
                  <MenuItem
                    disabled={disabled}
                    onClick={() => {
                      const next = new Date(
                        Math.ceil((Date.now() + 60_000) / 1_800_000) * 1_800_000,
                      );
                      onSchedule(
                        event.issueIdentifier!,
                        localCalendarDate(next),
                        `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`,
                      );
                    }}
                  >
                    <CalendarPlusIcon aria-hidden />
                    Plan another session
                  </MenuItem>
                  <MenuItem onClick={() => setDismissed((current) => [...current, keyFor(event)])}>
                    <XIcon aria-hidden />
                    Dismiss
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger render={<p className="mt-0.5 truncate text-sm" />}>
            {event.title}
          </TooltipTrigger>
          <TooltipPopup>
            {event.title} · {event.calendarTitle}
          </TooltipPopup>
        </Tooltip>
      </li>
    );
  };
  return (
    <section className="flex flex-col gap-1">
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
      <div className="flex items-center gap-2 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <ClockIcon aria-hidden className="size-3.5" />
        Today
        {incomplete ? (
          <span role="status" className="font-normal normal-case tracking-normal">
            incomplete, refresh to retry
          </span>
        ) : null}
        {dismissed.length ? (
          <Button
            className="ms-auto normal-case tracking-normal"
            size="xs"
            variant="ghost"
            onClick={() => setDismissed([])}
          >
            Restore dismissed
          </Button>
        ) : null}
      </div>
      {selected
        .filter(({ snapshot }) => snapshot?.error)
        .map(({ calendar, snapshot }) => (
          <p key={calendar.id} role="alert" className="px-2.5 text-xs text-destructive">
            {calendar.title}: {snapshot?.error}
          </p>
        ))}
      {work.current.length || work.upcoming.length ? (
        <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          {work.current.map((event) => renderBlock(event, "now"))}
          {work.upcoming.map((event, index) => renderBlock(event, index === 0 ? "next" : "later"))}
        </ul>
      ) : incomplete ? null : (
        <p className="px-2.5 text-xs text-muted-foreground">Nothing more scheduled today.</p>
      )}
      {ended.length ? (
        <Collapsible>
          <CollapsibleTrigger className="px-2.5 text-xs text-muted-foreground hover:text-foreground">
            Ended ({ended.length})
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="flex flex-col gap-1 pt-1">
              <p className="px-2.5 text-xs text-muted-foreground">
                Ending a block never completes the Linear issue. Dismiss hides it for this visit.
              </p>
              <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                {ended.map((event) => renderBlock(event, "ended"))}
              </ul>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </section>
  );
}
