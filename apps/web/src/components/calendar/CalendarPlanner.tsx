import { CalendarFeed, type Snapshot } from "./CalendarFeed";
import type { EnvironmentId, LinearIssueSummary } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";
import { ensureLocalApi } from "~/localApi";
import { randomUUID } from "~/lib/utils";
import { googleCalendarEnvironment as calendar } from "~/state/googleCalendar";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { calendarBlockRange, calendarDayRange, localCalendarDate } from "./calendarTime";
import {
  calendarWeek,
  layoutCalendarDay,
  overlappingEvents,
  shiftCalendarDay,
  type CalendarEntry,
} from "./calendarPlanning";
import { CalendarMultiSelect } from "./CalendarMultiSelect";
import { CalendarFindTime } from "./CalendarFindTime";
import { CalendarToday } from "./CalendarToday";
import { calendarSyncLabel, useCalendarRefresh } from "./useCalendarRefresh";
import { useCalendarPreferences } from "./calendarPreferences";

type Draft = {
  reference: string;
  day: string;
  time: string;
  minutes: number;
  event?: CalendarEntry;
  requestId: string;
};
type Placement = Omit<Draft, "requestId">;
type Drag = { reference: string } | { event: CalendarEntry; resize: boolean };
const colors = [
  "bg-blue-500/20 border-blue-500/60",
  "bg-violet-500/20 border-violet-500/60",
  "bg-emerald-500/20 border-emerald-500/60",
  "bg-amber-500/20 border-amber-500/60",
];

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
  const scrollToMorning = useCallback((node: HTMLDivElement | null) => {
    if (node) node.scrollTop = 480;
  }, []);
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
  const entries = displayed.flatMap((c) =>
    (snapshots[JSON.stringify([c.id, start, end])]?.events ?? []).map((event) => ({
      ...event,
      calendarId: c.id,
      calendarTitle: c.title,
    })),
  );
  const loading = displayed.some(
    (c) =>
      !snapshots[JSON.stringify([c.id, start, end])] ||
      snapshots[JSON.stringify([c.id, start, end])]?.loading,
  );
  const errors = displayed.flatMap((c) => {
    const error = snapshots[JSON.stringify([c.id, start, end])]?.error;
    return error ? [`${c.title}: ${error}`] : [];
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hoverPlacement, setHoverPlacement] = useState<Placement | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const schedule = useAtomCommand(calendar.schedule);
  const update = useAtomCommand(calendar.update);
  const range = draft ? calendarBlockRange(draft.day, draft.time, draft.minutes) : null;
  const conflictEntries = entries.filter(
    (event) => !preferences.ignoredConflictIds.includes(event.calendarId),
  );
  const conflicts = range ? overlappingEvents(conflictEntries, range, draft?.event) : [];
  const refreshedTimes = displayed.map(
    (c) => snapshots[JSON.stringify([c.id, start, end])]?.refreshedAt,
  );
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
      time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
      minutes: Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000),
      event,
      requestId: randomUUID().replaceAll("-", ""),
    });
    setNotice(null);
  };
  const selectIssue = (reference: string, date = day, time = "09:00") => {
    setDraft({
      reference,
      day: date,
      time,
      minutes: preferences.minutes,
      requestId: randomUUID().replaceAll("-", ""),
    });
    setNotice(null);
  };
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
        time: `${String(from.getHours()).padStart(2, "0")}:${String(from.getMinutes()).padStart(2, "0")}`,
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
  const drop = (date: string, minute: number) => {
    const payload = drag.current;
    drag.current = null;
    setHoverPlacement(null);
    if (!payload || busy) return;
    const placement = dragPlacement(payload, date, minute);
    if (!placement) {
      setNotice("Choose a valid time and an end after the start, within 24 hours.");
      return;
    }
    setDraft({ ...placement, requestId: randomUUID().replaceAll("-", "") });
    setNotice(null);
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
        setNotice("Saved to Google Calendar.");
      }
    } finally {
      setBusy(false);
    }
  };
  if (!status.data?.connected)
    return (
      <div className="p-5 text-sm">
        <p role="status">
          {status.error ??
            (status.isPending
              ? "Checking Google Calendar…"
              : "Connect Google Calendar in Settings → Integrations to plan your week.")}
        </p>
        <Button variant="outline" size="sm" onClick={status.refresh}>
          Check connection
        </Button>
      </div>
    );
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
      <div className="space-y-2 border-b p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setDay(shiftCalendarDay(day, -7))}
          >
            Previous week
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setDay(localCalendarDate())}
          >
            Today
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setDay(shiftCalendarDay(day, 7))}
          >
            Next week
          </Button>
          <Input
            aria-label="Week containing date"
            type="date"
            className="w-40"
            value={day}
            disabled={busy}
            onChange={(e) => {
              if (calendarDayRange(e.target.value)) setDay(e.target.value);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setRefreshKey((n) => n + 1);
              calendars.refresh();
            }}
          >
            Refresh
          </Button>
          <label className="text-xs">
            Schedule into{" "}
            <select
              className="rounded border bg-background p-2"
              value={writeId}
              disabled={busy}
              onChange={(e) => {
                savePreferences({ writeCalendarId: e.target.value });
                setDraft(null);
              }}
            >
              {calendars.data
                ?.filter((c) => c.writable)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-xs">
            Default minutes{" "}
            <Input
              className="inline-block w-20"
              type="number"
              min={5}
              max={1440}
              value={preferences.minutes}
              onChange={(e) => {
                const minutes = Number(e.target.value);
                if (Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440)
                  savePreferences({ minutes });
              }}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <CalendarMultiSelect
            label="Visible calendars"
            description="Choose calendars to show. Your scheduling calendar always stays visible."
            disabled={busy}
            options={(calendars.data ?? []).map((c, index) => ({
              id: c.id,
              title: c.title,
              selected: c.id === writeId || preferences.overlayIds.includes(c.id),
              locked: c.id === writeId,
              detail:
                c.id === writeId ? "Scheduling calendar" : c.writable ? undefined : "Read only",
              color: colors[index % colors.length],
            }))}
            onChange={(id, selected) =>
              savePreferences({
                overlayIds: selected
                  ? [...preferences.overlayIds, id]
                  : preferences.overlayIds.filter((entry) => entry !== id),
              })
            }
          />
          <CalendarMultiSelect
            label="Conflict calendars"
            description="Check busy events on these visible calendars. Hidden calendars are excluded."
            disabled={busy}
            options={displayed.map((c) => ({
              id: c.id,
              title: c.title,
              selected: !preferences.ignoredConflictIds.includes(c.id),
            }))}
            onChange={(id, selected) =>
              savePreferences({
                ignoredConflictIds: selected
                  ? preferences.ignoredConflictIds.filter((entry) => entry !== id)
                  : [...preferences.ignoredConflictIds, id],
              })
            }
          />
        </div>
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
        <p className="text-xs text-muted-foreground">
          {timeZone} · Drag an issue onto a time, or select it and enter a time below. Drag a work
          block to move it; drag its end handle to resize. Calendars refresh every minute while
          visible and when you return to T3. {calendarSyncLabel(refreshedAt)}.
        </p>
        {calendars.error ? <p role="alert">{calendars.error}</p> : null}
        {(calendars.data === null && calendars.isPending) || loading ? (
          <p role="status" className="text-xs">
            Loading calendars…
          </p>
        ) : null}
        {errors.map((error) => (
          <p key={error} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ))}
        {!writeId && calendars.data !== null ? (
          <p role="status">No writable calendar available.</p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm">
            {notice}
          </p>
        ) : null}
        {draft ? (
          <div className="space-y-2 rounded border p-2">
            <p className="text-sm font-medium">
              {draft.event ? `Reschedule ${draft.event.title}` : `Schedule ${draft.reference}`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                className="w-40"
                aria-label="Block date"
                type="date"
                value={draft.day}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    day: e.target.value,
                    requestId: randomUUID().replaceAll("-", ""),
                  })
                }
              />
              <Input
                className="w-32"
                aria-label="Start time"
                type="time"
                value={draft.time}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    time: e.target.value,
                    requestId: randomUUID().replaceAll("-", ""),
                  })
                }
              />
              <Input
                className="w-24"
                aria-label="Duration in minutes"
                type="number"
                min={5}
                max={1440}
                value={draft.minutes}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    minutes: Number(e.target.value),
                    requestId: randomUUID().replaceAll("-", ""),
                  })
                }
              />
              <Button
                size="sm"
                disabled={busy || !range || (!draft.event && !writeId)}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : conflicts.length ? "Save despite overlap" : "Save to calendar"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
            {!draft.event ? (
              <CalendarFindTime
                days={days}
                entries={conflictEntries}
                minutes={draft.minutes}
                hours={preferences.planningHours}
                onHours={(planningHours) => savePreferences({ planningHours })}
                incomplete={
                  loading ||
                  errors.length > 0 ||
                  (calendars.data === null && calendars.isPending) ||
                  !!calendars.error ||
                  !displayed.length
                }
                disabled={busy || !writeId}
                onSelect={(date, time) =>
                  setDraft({
                    ...draft,
                    day: date,
                    time,
                    requestId: randomUUID().replaceAll("-", ""),
                  })
                }
              />
            ) : null}
            {!range ? (
              <p role="alert" className="text-xs">
                Enter a valid local date, time and duration between 5 and 1,440 minutes.
              </p>
            ) : null}
            {conflicts.length ? (
              <p role="status" className="text-xs text-amber-600">
                Overlaps{" "}
                {conflicts.map((event) => `${event.title} (${event.calendarTitle})`).join(", ")}.
                Free events and calendars excluded from conflict checks do not warn.
              </p>
            ) : null}
            {loading ||
            errors.length ||
            !days.includes(draft.day) ||
            (range && (range.start < start || range.end > end)) ? (
              <p className="text-xs">
                Overlap checks are incomplete. Check Google Calendar before saving.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="max-h-60 overflow-y-auto border-b p-2 lg:max-h-none lg:border-r lg:border-b-0">
          <p className="p-2 text-xs font-medium">Issues · blocks shown for this week</p>
          {issuesPending ? <p className="p-2 text-xs">Loading issues…</p> : null}
          {issuesError ? (
            <p role="alert" className="p-2 text-xs">
              {issuesError}
            </p>
          ) : null}
          {!issues.length && !issuesPending ? (
            <p className="p-2 text-xs">No issues match the current filters.</p>
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
                onDragEnd={() => {
                  drag.current = null;
                  setHoverPlacement(null);
                }}
                onClick={() => selectIssue(issue.identifier)}
                className="mb-1 block w-full rounded border p-3 text-left text-sm hover:bg-accent disabled:opacity-50"
              >
                <span className="text-xs text-muted-foreground">
                  {issue.identifier} ·{" "}
                  {loading || errors.length
                    ? "Schedule incomplete"
                    : count
                      ? `${count} block${count === 1 ? "" : "s"}`
                      : "Unscheduled this week"}
                </span>
                <span className="block">{issue.title}</span>
              </button>
            );
          })}
        </aside>
        <div ref={scrollToMorning} className="min-h-0 overflow-auto">
          <div className="grid min-w-[900px] grid-cols-[52px_repeat(7,minmax(0,1fr))]">
            <div className="sticky top-0 z-20 border-b bg-background" />
            {days.map((date) => (
              <div
                key={date}
                className="sticky top-0 z-20 border-b border-l bg-background p-2 text-center text-xs font-medium"
              >
                {new Date(`${date}T12:00:00`).toLocaleDateString([], {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
                {date === localCalendarDate() ? " · Today" : ""}
                <div className="mt-1 space-y-1">
                  {entries
                    .filter((event) => event.allDay && event.start <= date && event.end > date)
                    .map((event) => (
                      <p
                        key={`${event.calendarId}:${event.id}`}
                        className="truncate rounded bg-muted p-1 text-left"
                        aria-label={`${event.calendarTitle}: ${event.title}`}
                      >
                        {event.title}
                      </p>
                    ))}
                </div>
              </div>
            ))}
            <div className="relative h-[1440px]">
              {Array.from({ length: 24 }, (_, hour) => (
                <span
                  key={hour}
                  className="absolute right-1 text-[10px] text-muted-foreground"
                  style={{ top: hour * 60 }}
                >
                  {String(hour).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            {days.map((date) => (
              <div
                key={date}
                className="relative h-[1440px] border-l"
                onDragOver={(e) => {
                  const payload = drag.current;
                  if (!payload || busy) return;
                  e.preventDefault();
                  const minute = Math.max(
                    0,
                    Math.min(
                      1410,
                      Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top) / 30) *
                        30,
                    ),
                  );
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
                onDragLeave={(e) => {
                  if (
                    !(e.relatedTarget instanceof Node) ||
                    !e.currentTarget.contains(e.relatedTarget)
                  )
                    setHoverPlacement(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const minute = Math.max(
                    0,
                    Math.min(
                      1410,
                      Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top) / 30) *
                        30,
                    ),
                  );
                  drop(date, minute);
                }}
              >
                {Array.from({ length: 48 }, (_, slot) => (
                  <button
                    key={slot}
                    type="button"
                    aria-label={`${date} ${Math.floor(slot / 2)}:${slot % 2 ? "30" : "00"}`}
                    className="absolute left-0 h-[30px] w-full border-t border-border/40 hover:bg-accent/40"
                    style={{ top: slot * 30 }}
                    disabled={busy}
                    onClick={() => {
                      if (draft && !busy)
                        setDraft({
                          ...draft,
                          day: date,
                          time: `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`,
                          requestId: randomUUID().replaceAll("-", ""),
                        });
                    }}
                  />
                ))}
                {layoutCalendarDay(entries, date).map(({ event, top, bottom, lane, lanes }) => (
                  <div
                    key={`${event.calendarId}:${event.id}`}
                    draggable={!busy && writable(event)}
                    onDragStart={(e) => {
                      drag.current = { event, resize: false };
                      e.dataTransfer.setData("text/plain", event.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      drag.current = null;
                      setHoverPlacement(null);
                    }}
                    className={`absolute overflow-hidden rounded border px-1 text-[10px] ${colors[(calendars.data?.findIndex((c) => c.id === event.calendarId) ?? 0) % colors.length]}`}
                    style={{
                      top,
                      height: Math.max(15, bottom - top),
                      left: `${(lane / lanes) * 100}%`,
                      width: `${100 / lanes}%`,
                    }}
                    aria-label={`${event.calendarTitle}: ${event.title}`}
                  >
                    <button
                      type="button"
                      className="block w-full truncate text-left font-medium"
                      disabled={busy}
                      onClick={() => {
                        if (writable(event)) edit(event);
                        else if (event.url)
                          void ensureLocalApi()
                            .shell.openExternal(event.url)
                            .catch(() => setNotice("Could not open Google Calendar."));
                      }}
                    >
                      {event.title}
                      {event.blocksTime === false ? " · Free" : ""}
                    </button>
                    <p>
                      {new Date(event.start).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      –{" "}
                      {new Date(event.end).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                    {event.issueIdentifier ? (
                      <button
                        type="button"
                        className="underline"
                        onClick={() => {
                          if (event.issueIdentifier) onWork(event.issueIdentifier);
                        }}
                      >
                        {hasThread(event.issueIdentifier) ? "Resume" : "Start working"}
                      </button>
                    ) : null}
                    {writable(event) ? (
                      <button
                        type="button"
                        aria-label={`Resize ${event.title}`}
                        disabled={busy}
                        draggable={!busy}
                        className="absolute right-0 bottom-0 left-0 h-2 cursor-ns-resize bg-foreground/20"
                        onClick={() => edit(event)}
                        onDragStart={(e) => {
                          e.stopPropagation();
                          drag.current = { event, resize: true };
                          e.dataTransfer.setData("text/plain", event.id);
                        }}
                        onDragEnd={() => {
                          drag.current = null;
                          setHoverPlacement(null);
                        }}
                      />
                    ) : null}
                  </div>
                ))}
                {previewEvent
                  ? layoutCalendarDay([previewEvent], date).map(({ top, bottom }) => (
                      <div
                        key="preview"
                        role="status"
                        className={`pointer-events-none absolute inset-x-0.5 z-10 overflow-hidden rounded border-2 border-dashed px-1 text-[11px] shadow-sm ${previewOverlaps ? "border-amber-500 bg-amber-100/90 text-amber-950 dark:bg-amber-950/90 dark:text-amber-100" : "border-blue-500 bg-blue-100/90 text-blue-950 dark:bg-blue-950/90 dark:text-blue-100"}`}
                        style={{ top, height: Math.max(15, bottom - top) }}
                      >
                        <p className="truncate font-semibold">
                          {hoverPlacement ? "Drop here" : "Not saved"} · {previewEvent.title}
                        </p>
                        <p>
                          {new Date(previewEvent.start).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}{" "}
                          –{" "}
                          {new Date(previewEvent.end).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                        {previewOverlaps ? <p>Overlaps an event</p> : null}
                      </div>
                    ))
                  : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
