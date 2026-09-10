import { CalendarFeed, type Snapshot } from "./CalendarFeed";
import type { EnvironmentId, LinearIssueSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  CalendarOffIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GripVerticalIcon,
  SettingsIcon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ensureLocalApi } from "~/localApi";
import { cn, randomUUID } from "~/lib/utils";
import { googleCalendarEnvironment as calendar } from "~/state/googleCalendar";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { validPlanningHours } from "./calendarAvailability";
import { calendarBlockRange, calendarDayRange, localCalendarDate } from "./calendarTime";
import {
  calendarWeek,
  overlappingEvents,
  shiftCalendarDay,
  type CalendarEntry,
} from "./calendarPlanning";
import { CalendarDraftPanel, type Draft, type Placement } from "./CalendarDraftPanel";
import { CalendarPickerPopover } from "./CalendarPickerPopover";
import { CalendarPlanningPreferences } from "./CalendarPlanningPreferences";
import { CalendarToday } from "./CalendarToday";
import { CalendarWeekGrid, type Drag } from "./CalendarWeekGrid";
import { calendarColorDotClass, clockTimeOf, formatWeekRangeLabel } from "./calendarPresentation";
import { calendarSyncLabel, useCalendarNow, useCalendarRefresh } from "./useCalendarRefresh";
import { useCalendarPreferences } from "./calendarPreferences";

const newRequestId = () => randomUUID().replaceAll("-", "");

export function CalendarPlanner({
  environmentId,
  issues,
  issuesPending,
  issuesError,
  onWork,
  hasThread,
}: {
  environmentId: EnvironmentId;
  issues: readonly LinearIssueSummary[];
  issuesPending: boolean;
  issuesError: string | null;
  onWork: (identifier: string) => void;
  hasThread: (identifier: string) => boolean;
}) {
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const now = useCalendarNow();
  const today = localCalendarDate(new Date(now));
  const minutesNow = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const status = useEnvironmentQuery(calendar.status({ environmentId, input: {} }));
  const calendars = useEnvironmentQuery(
    status.data?.connected ? calendar.calendars({ environmentId, input: {} }) : null,
  );
  useCalendarRefresh(status, true, `${environmentId}:status`);
  useCalendarRefresh(calendars, !!status.data?.connected, `${environmentId}:calendars`);
  const [preferences, savePreferences] = useCalendarPreferences(environmentId);
  const writeId =
    calendars.data?.find((c) => c.id === preferences.writeCalendarId && c.writable)?.id ??
    calendars.data?.find((c) => c.writable)?.id ??
    "";
  const writableCalendars = calendars.data?.filter((c) => c.writable) ?? [];
  const displayed =
    calendars.data?.filter((c) => c.id === writeId || preferences.overlayIds.includes(c.id)) ?? [];
  const [day, setDay] = useState(localCalendarDate);
  const days = calendarWeek(day);
  const start = calendarDayRange(days[0] ?? "")?.start ?? "";
  const end = calendarDayRange(days[6] ?? "")?.end ?? "";
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const report = useCallback(
    (key: string, snapshot: Snapshot) =>
      setSnapshots((current) =>
        Object.fromEntries([
          ...Object.entries(current)
            .filter(([entryKey]) => entryKey !== key)
            .slice(-139),
          [key, snapshot],
        ]),
      ),
    [],
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const snapshotOf = (calendarId: string) => snapshots[JSON.stringify([calendarId, start, end])];
  const entries = displayed.flatMap((c) =>
    (snapshotOf(c.id)?.events ?? []).map((event) => ({
      ...event,
      calendarId: c.id,
      calendarTitle: c.title,
    })),
  );
  const loading = displayed.some((c) => !snapshotOf(c.id) || snapshotOf(c.id)?.loading);
  const errors = displayed.flatMap((c) => {
    const error = snapshotOf(c.id)?.error;
    return error ? [`${c.title}: ${error}`] : [];
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hoverPlacement, setHoverPlacement] = useState<Placement | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<Drag | null>(null);
  const schedule = useAtomCommand(calendar.schedule);
  const update = useAtomCommand(calendar.update);
  const range = draft ? calendarBlockRange(draft.day, draft.time, draft.minutes) : null;
  const conflictEntries = entries.filter(
    (event) => !preferences.ignoredConflictIds.includes(event.calendarId),
  );
  const conflicts = range ? overlappingEvents(conflictEntries, range, draft?.event) : [];
  const refreshedTimes = displayed.map((c) => snapshotOf(c.id)?.refreshedAt);
  const refreshedAt =
    refreshedTimes.length && refreshedTimes.every((time) => time != null)
      ? Math.min(...refreshedTimes.map((time) => time!))
      : null;
  const writable = (event: CalendarEntry) =>
    event.createdByT3 &&
    !event.allDay &&
    !event.recurring &&
    !!calendars.data?.find((c) => c.id === event.calendarId)?.writable;
  const edit = (event: CalendarEntry) => {
    const date = new Date(event.start);
    setDraft({
      reference: event.issueIdentifier ?? "",
      day: localCalendarDate(date),
      time: clockTimeOf(date),
      minutes: Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000),
      event,
      requestId: newRequestId(),
    });
  };
  // A fresh block lands at the start of the working day, where suggestions begin.
  const selectIssue = (
    reference: string,
    date = day,
    time = validPlanningHours(preferences.planningHours)
      ? preferences.planningHours.start
      : "09:00",
  ) => {
    setDraft({
      reference,
      day: date,
      time,
      minutes: preferences.minutes,
      requestId: newRequestId(),
    });
  };
  const patchDraft = (patch: Partial<Pick<Placement, "day" | "time" | "minutes">>) =>
    setDraft((current) =>
      current ? { ...current, ...patch, requestId: newRequestId() } : current,
    );
  // Hover and drop use exactly the same snapped placement.
  const dragPlacement = (payload: Drag, date: string, minute: number): Placement | null => {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    if ("reference" in payload)
      return { reference: payload.reference, day: date, time, minutes: preferences.minutes };
    const event = payload.event;
    const target = calendarBlockRange(date, time, 5);
    if (!target) return null;
    if (payload.resize) {
      const minutes = Math.round((Date.parse(target.start) - Date.parse(event.start)) / 60_000);
      if (minutes < 5 || minutes > 1440) return null;
      const from = new Date(event.start);
      return {
        reference: event.issueIdentifier ?? "",
        day: localCalendarDate(from),
        time: clockTimeOf(from),
        minutes,
        event,
      };
    }
    return {
      reference: event.issueIdentifier ?? "",
      day: date,
      time,
      minutes: Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000),
      event,
    };
  };
  const endDrag = () => {
    drag.current = null;
    setHoverPlacement(null);
  };
  const drop = (date: string, minute: number) => {
    const payload = drag.current;
    endDrag();
    if (!payload || busy) return;
    const placement = dragPlacement(payload, date, minute);
    if (!placement) {
      toastManager.add({
        type: "warning",
        title: "That time does not work",
        description: "Choose a valid time and an end after the start, within 24 hours.",
      });
      return;
    }
    setDraft({ ...placement, requestId: newRequestId() });
  };
  const previewPlacement = hoverPlacement ?? draft;
  const previewRange = previewPlacement
    ? calendarBlockRange(previewPlacement.day, previewPlacement.time, previewPlacement.minutes)
    : null;
  const previewEvent: CalendarEntry | null =
    previewRange && previewPlacement
      ? {
          id: "preview",
          etag: "",
          url: "",
          allDay: false,
          recurring: false,
          createdByT3: false,
          calendarId: previewPlacement.event?.calendarId ?? writeId,
          calendarTitle: "Preview",
          issueIdentifier: previewPlacement.reference,
          title:
            previewPlacement.event?.title ??
            `${previewPlacement.reference} ${issues.find((issue) => issue.identifier === previewPlacement.reference)?.title ?? ""}`,
          ...previewRange,
        }
      : null;
  const previewOverlaps = previewRange
    ? overlappingEvents(conflictEntries, previewRange, previewPlacement?.event).length > 0
    : false;
  const save = async () => {
    if (!draft || !range || busy) return;
    setBusy(true);
    try {
      const result = draft.event
        ? await update({
            environmentId,
            input: {
              action: "move",
              calendarId: draft.event.calendarId,
              eventId: draft.event.id,
              etag: draft.event.etag,
              ...range,
            },
          })
        : await schedule({
            environmentId,
            input: {
              calendarId: writeId,
              reference: draft.reference,
              requestId: draft.requestId,
              ...range,
            },
          });
      if (result._tag === "Success") {
        setDraft(null);
        setRefreshKey((n) => n + 1);
        toastManager.add({
          type: "success",
          title: draft.event ? "Block moved" : "Block saved to Google Calendar",
        });
      }
    } finally {
      setBusy(false);
    }
  };
  const openBlock = (event: CalendarEntry) => {
    if (writable(event)) edit(event);
    else if (event.url)
      void ensureLocalApi()
        .shell.openExternal(event.url)
        .catch(() => toastManager.add({ type: "error", title: "Could not open Google Calendar" }));
  };
  if (!status.data?.connected) {
    if (status.isPending && !status.data)
      return (
        <div
          role="status"
          className="flex items-center gap-2 p-5 text-sm text-muted-foreground sm:px-5"
        >
          <Spinner className="size-4" />
          Checking Google Calendar…
        </div>
      );
    return (
      <Empty className="px-4 py-16 md:px-4">
        <EmptyMedia variant="icon">
          <CalendarOffIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Google Calendar is not connected</EmptyTitle>
          <EmptyDescription>
            Connect it in Settings → Integrations to plan your week.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="gap-2">
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" render={<Link to="/settings/integrations" />}>
              <SettingsIcon aria-hidden className="size-3.5" />
              Open Integrations
            </Button>
            <Button size="sm" variant="outline" onClick={status.refresh}>
              Check connection
            </Button>
          </div>
          {status.error ? (
            <p role="alert" className="text-xs text-destructive">
              {status.error}
            </p>
          ) : null}
        </EmptyContent>
      </Empty>
    );
  }
  const firstLoad = (calendars.data === null && calendars.isPending) || loading;
  const draftIssueTitle = draft
    ? issues.find((issue) => issue.identifier === draft.reference)?.title
    : undefined;
  const incompleteOverlapCheck =
    !!draft &&
    (loading ||
      errors.length > 0 ||
      !days.includes(draft.day) ||
      (!!range && (range.start < start || range.end > end)));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {start && end
        ? displayed.map((c) => (
            <CalendarFeed
              key={c.id}
              environmentId={environmentId}
              calendarId={c.id}
              start={start}
              end={end}
              refreshKey={refreshKey}
              report={report}
            />
          ))
        : null}

      {/* Navigation on the left, the three things you set once on the right. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 sm:px-5">
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Previous week"
                  disabled={busy}
                  onClick={() => setDay(shiftCalendarDay(day, -7))}
                />
              }
            >
              <ChevronLeftIcon />
            </TooltipTrigger>
            <TooltipPopup>Previous week</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Next week"
                  disabled={busy}
                  onClick={() => setDay(shiftCalendarDay(day, 7))}
                />
              }
            >
              <ChevronRightIcon />
            </TooltipTrigger>
            <TooltipPopup>Next week</TooltipPopup>
          </Tooltip>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || days.includes(today)}
          onClick={() => setDay(localCalendarDate())}
        >
          Today
        </Button>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                className="px-2 font-medium text-sm tabular-nums"
              />
            }
          >
            {formatWeekRangeLabel(days)}
          </PopoverTrigger>
          <PopoverPopup align="start" className="w-64" viewportClassName="p-3">
            <PopoverTitle className="text-sm">Jump to week</PopoverTitle>
            <Input
              className="mt-2 w-full"
              aria-label="Week containing date"
              type="date"
              value={day}
              disabled={busy}
              onChange={(e) => {
                if (calendarDayRange(e.target.value)) setDay(e.target.value);
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">Times are shown in {timeZone}.</p>
          </PopoverPopup>
        </Popover>

        <div className="flex-1" />

        <CalendarPickerPopover
          disabled={busy}
          options={(calendars.data ?? []).map((c, index) => ({
            id: c.id,
            title: c.title,
            shown: c.id === writeId || preferences.overlayIds.includes(c.id),
            conflicts: !preferences.ignoredConflictIds.includes(c.id),
            scheduling: c.id === writeId,
            writable: c.writable,
            color: calendarColorDotClass(index),
          }))}
          onShown={(id, shown) =>
            savePreferences({
              overlayIds: shown
                ? [...preferences.overlayIds, id]
                : preferences.overlayIds.filter((entry) => entry !== id),
            })
          }
          onConflicts={(id, conflicts) =>
            savePreferences({
              ignoredConflictIds: conflicts
                ? preferences.ignoredConflictIds.filter((entry) => entry !== id)
                : [...preferences.ignoredConflictIds, id],
            })
          }
        />
        <CalendarPlanningPreferences
          disabled={busy}
          minutes={preferences.minutes}
          onMinutes={(minutes) => savePreferences({ minutes })}
          hours={preferences.planningHours}
          onHours={(planningHours) => savePreferences({ planningHours })}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh calendars"
                disabled={busy}
                onClick={() => {
                  setRefreshKey((n) => n + 1);
                  calendars.refresh();
                }}
              />
            }
          >
            <RefreshIcon className="size-3.5" refreshing={loading} />
          </TooltipTrigger>
          <TooltipPopup>{calendarSyncLabel(refreshedAt)}</TooltipPopup>
        </Tooltip>
      </div>

      {calendars.error || errors.length || (!writeId && calendars.data !== null) ? (
        <div className="space-y-2 border-b border-border/60 px-3 py-2 sm:px-5">
          {calendars.error || errors.length ? (
            <Alert variant="error" className="py-2">
              <AlertTitle className="text-xs">Some calendars did not load</AlertTitle>
              <AlertDescription className="text-xs">
                {calendars.error ? <span>{calendars.error}</span> : null}
                {errors.map((error) => (
                  <span key={error}>{error}</span>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
          {!writeId && calendars.data !== null ? (
            <Alert variant="warning" className="py-2">
              <AlertTitle className="text-xs">
                No writable calendar available, so blocks cannot be saved.
              </AlertTitle>
            </Alert>
          ) : null}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside
          className={cn(
            "overflow-y-auto border-b border-border/60 lg:max-h-none lg:border-r lg:border-b-0",
            draft ? "max-h-[min(24rem,50dvh)]" : "max-h-72",
          )}
        >
          {draft ? (
            <CalendarDraftPanel
              draft={draft}
              issueTitle={draftIssueTitle}
              busy={busy}
              valid={!!range}
              conflicts={conflicts}
              incompleteOverlapCheck={incompleteOverlapCheck}
              calendars={writableCalendars}
              calendarId={writeId}
              onCalendarChange={(id) => savePreferences({ writeCalendarId: id })}
              onChange={patchDraft}
              onSave={() => void save()}
              onCancel={() => setDraft(null)}
              suggestions={
                draft.event
                  ? null
                  : {
                      days,
                      entries: conflictEntries,
                      hours: preferences.planningHours,
                      incomplete:
                        loading ||
                        errors.length > 0 ||
                        (calendars.data === null && calendars.isPending) ||
                        !!calendars.error ||
                        !displayed.length,
                    }
              }
            />
          ) : (
            <div className="flex flex-col gap-4 px-1.5 py-2">
              <CalendarToday
                environmentId={environmentId}
                calendars={displayed}
                issues={issues}
                refreshKey={refreshKey}
                onWork={onWork}
                hasThread={hasThread}
                disabled={busy || !writeId}
                onSchedule={(reference, date, time) => {
                  setDay(date);
                  selectIssue(reference, date, time);
                }}
              />
              <section className="flex flex-col gap-1">
                <div className="flex items-center gap-2 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Issues
                  <span className="tabular-nums">{issues.length}</span>
                  {firstLoad ? (
                    <span role="status" className="ms-auto">
                      <Spinner className="size-3" />
                      <span className="sr-only">Loading calendars</span>
                    </span>
                  ) : null}
                </div>
                <p className="px-2.5 text-xs text-muted-foreground">
                  Drag an issue onto the week, or click it to pick a time.
                </p>
                <div className="flex flex-col gap-0.5">
                  {issuesPending && !issues.length
                    ? Array.from({ length: 3 }, (_, index) => (
                        <div key={index} className="flex flex-col gap-1.5 px-2.5 py-2">
                          <Skeleton className="h-3 w-16" />
                          <Skeleton className="h-3.5 w-full" />
                        </div>
                      ))
                    : null}
                  {issuesError ? (
                    <p role="alert" className="px-2.5 py-2 text-xs text-destructive">
                      {issuesError}
                    </p>
                  ) : null}
                  {!issues.length && !issuesPending && !issuesError ? (
                    <p className="px-2.5 py-2 text-xs text-muted-foreground">
                      No issues match the current filters.
                    </p>
                  ) : null}
                  {issues.map((issue) => {
                    const count = entries.filter(
                      (event) => event.issueIdentifier === issue.identifier,
                    ).length;
                    return (
                      <button
                        key={issue.id}
                        type="button"
                        draggable={!busy && !!writeId}
                        disabled={busy || !writeId}
                        onDragStart={(e) => {
                          drag.current = { reference: issue.identifier };
                          e.dataTransfer.setData("text/plain", issue.identifier);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        onDragEnd={endDrag}
                        onClick={() => selectIssue(issue.identifier)}
                        className="flex w-full cursor-grab items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing disabled:opacity-50"
                      >
                        <GripVerticalIcon
                          aria-hidden
                          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60"
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="font-mono text-xs text-muted-foreground">
                            {issue.identifier}
                          </span>
                          <span className="line-clamp-2 text-sm">{issue.title}</span>
                        </span>
                        {loading || errors.length ? null : count ? (
                          <Badge size="sm" variant="outline" className="mt-0.5 shrink-0">
                            {count === 1 ? "1 block" : `${count} blocks`}
                          </Badge>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          )}
        </aside>

        <CalendarWeekGrid
          days={days}
          today={today}
          minutesNow={minutesNow}
          entries={entries}
          calendarIds={(calendars.data ?? []).map((c) => c.id)}
          hours={preferences.planningHours}
          busy={busy}
          drag={drag}
          placing={!!draft}
          preview={
            previewEvent
              ? { event: previewEvent, overlaps: previewOverlaps, dropping: !!hoverPlacement }
              : null
          }
          writable={writable}
          onSlotClick={(date, time) => patchDraft({ day: date, time })}
          onDragOver={(date, minute) => {
            const payload = drag.current;
            if (!payload) return;
            const placement = dragPlacement(payload, date, minute);
            setHoverPlacement((current) =>
              current?.day === placement?.day &&
              current?.time === placement?.time &&
              current?.minutes === placement?.minutes &&
              current?.reference === placement?.reference &&
              current?.event === placement?.event
                ? current
                : placement,
            );
          }}
          onDragLeave={() => setHoverPlacement(null)}
          onDrop={drop}
          onDragEnd={endDrag}
          onBlockClick={openBlock}
          onWork={onWork}
          hasThread={hasThread}
        />
      </div>
    </div>
  );
}
