import type {
  EnvironmentId,
  GoogleCalendarEvent,
  GoogleCalendarUpdateInput,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  CalendarIcon,
  CalendarOffIcon,
  CalendarPlusIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDotIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  Link2Icon,
  Link2OffIcon,
  MessageSquareIcon,
  PlayIcon,
  RepeatIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { cn, randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { googleCalendarEnvironment as calendar } from "~/state/googleCalendar";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertAction, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { shiftCalendarDay } from "./calendarPlanning";
import { useCalendarPreferences } from "./calendarPreferences";
import { formatDayLabel, formatEventTimeRange } from "./calendarPresentation";
import { calendarBlockRange, calendarDayRange, localCalendarDate } from "./calendarTime";
import { calendarSyncLabel, useCalendarRefresh } from "./useCalendarRefresh";

/**
 * Scheduling for one issue, folded away until asked for. The agenda mounts only
 * while the panel is open so the issue detail costs nothing until then.
 */
export function IssueCalendar({
  environmentId,
  identifier,
}: {
  environmentId: EnvironmentId;
  identifier: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
        <CalendarPlusIcon aria-hidden className="size-3.5" />
        {open ? "Hide scheduling" : "Schedule time"}
        <ChevronDownIcon aria-hidden className={cn("size-3.5", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {open ? (
          <div className="pt-3">
            <CalendarAgenda environmentId={environmentId} issueIdentifier={identifier} />
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Bars in the geometry of an event row, pulsing on one composited layer. */
function AgendaGhost() {
  return (
    <div
      role="status"
      aria-label="Loading events"
      className="divide-y divide-border/60 motion-safe:animate-skeleton"
    >
      {["w-3/5", "w-2/5", "w-1/2"].map((width) => (
        <div
          key={width}
          className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5"
        >
          <div aria-hidden className="h-3.5 w-16 rounded bg-muted-foreground/15" />
          <div className="min-w-0 space-y-1.5">
            <div aria-hidden className={cn("h-3.5 rounded bg-muted-foreground/15", width)} />
            <div aria-hidden className="h-3 w-1/4 rounded bg-muted-foreground/15" />
          </div>
          <div aria-hidden className="h-6 w-20 rounded bg-muted-foreground/15" />
        </div>
      ))}
    </div>
  );
}

export function CalendarAgenda({
  environmentId,
  issueIdentifier,
  onWork,
  hasThread,
}: {
  environmentId: EnvironmentId;
  issueIdentifier?: string;
  onWork?: (identifier: string) => void;
  hasThread?: (identifier: string) => boolean;
}) {
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const status = useEnvironmentQuery(calendar.status({ environmentId, input: {} }));
  const calendars = useEnvironmentQuery(
    status.data?.connected ? calendar.calendars({ environmentId, input: {} }) : null,
  );
  const [preferences, savePreferences] = useCalendarPreferences(environmentId);
  const selectedCalendar = preferences.writeCalendarId;
  const calendarId =
    calendars.data?.find((c) => c.id === selectedCalendar)?.id ||
    calendars.data?.find((c) => c.writable)?.id ||
    calendars.data?.[0]?.id ||
    "";
  const writable = calendars.data?.find((c) => c.id === calendarId)?.writable ?? false;
  const [day, setDay] = useState(localCalendarDate);
  const [time, setTime] = useState("09:00");
  const [minutes, setMinutes] = useState(preferences.minutes);
  const dayRange = calendarDayRange(day);
  const blockRange = calendarBlockRange(day, time, minutes);
  const events = useEnvironmentQuery(
    status.data?.connected && calendarId && dayRange
      ? calendar.events({ environmentId, input: { calendarId, ...dayRange } })
      : null,
  );
  useCalendarRefresh(status, true, `${environmentId}:status`);
  useCalendarRefresh(calendars, !!status.data?.connected, `${environmentId}:calendars`);
  const refreshedAt = useCalendarRefresh(
    events,
    !!status.data?.connected && !!calendarId && !!dayRange,
    JSON.stringify([environmentId, calendarId, day]),
  );
  const schedule = useAtomCommand(calendar.schedule);
  const update = useAtomCommand(calendar.update);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<GoogleCalendarEvent | null>(null);
  const creation = useRef<{ signature: string; requestId: string } | null>(null);
  const refresh = () => {
    setEditing(null);
    setNotice(null);
    status.refresh();
    calendars.refresh();
    events.refresh();
  };

  const mutate = async (input: GoogleCalendarUpdateInput) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await update({ environmentId, input });
      if (result._tag === "Success") {
        events.refresh();
        setEditing(null);
        if (input.action === "delete") creation.current = null;
        setNotice("Calendar updated.");
      }
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!blockRange || !issueIdentifier) return;
    const signature = JSON.stringify({ calendarId, issueIdentifier, ...blockRange });
    if (creation.current?.signature !== signature)
      creation.current = { signature, requestId: randomUUID().replaceAll("-", "") };
    setBusy(true);
    setNotice(null);
    try {
      const result = await schedule({
        environmentId,
        input: {
          calendarId,
          reference: issueIdentifier,
          ...blockRange,
          requestId: creation.current.requestId,
        },
      });
      if (result._tag === "Success") {
        events.refresh();
        // Retain the request ID until the form changes, so a repeated click cannot
        // create an identical block after a slow response or retry.
        setNotice(`Scheduled ${issueIdentifier}. Change the time to add another session.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const embedded = !!issueIdentifier;

  if (!status.data?.connected) {
    if (status.isPending && !status.data)
      return (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3.5" />
          Checking Google Calendar…
        </p>
      );
    // Inside the issue detail the connection story is one line; the page can afford the
    // full empty state.
    if (embedded)
      return (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span role="status">{status.error ?? "Google Calendar is not connected."}</span>
          <Button size="xs" variant="link" render={<Link to="/settings/integrations" />}>
            Open Integrations
          </Button>
        </div>
      );
    return (
      <Empty className="px-4 py-12 md:px-4">
        <EmptyMedia variant="icon">
          <CalendarOffIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Google Calendar is not connected</EmptyTitle>
          <EmptyDescription>
            {status.error ??
              "Connect it in Settings → Integrations to see your day and schedule issues."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          <Button size="sm" render={<Link to="/settings/integrations" />}>
            <SettingsIcon aria-hidden className="size-3.5" />
            Open Integrations
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={status.refresh}
            disabled={status.isPending}
            aria-busy={status.isPending}
          >
            <RefreshIcon className="size-3.5" refreshing={status.isPending} />
            Check connection
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const loading =
    (calendars.data === null && calendars.isPending) || (events.data === null && events.isPending);
  const selectedTitle = calendars.data?.find((c) => c.id === calendarId)?.title;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-card p-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Previous day"
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDay(shiftCalendarDay(day, -1));
                    setNotice(null);
                  }}
                />
              }
            >
              <ChevronLeftIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>Previous day</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Next day"
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDay(shiftCalendarDay(day, 1));
                    setNotice(null);
                  }}
                />
              }
            >
              <ChevronRightIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>Next day</TooltipPopup>
          </Tooltip>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDay(localCalendarDate());
            setNotice(null);
          }}
        >
          Today
        </Button>
        {embedded ? (
          <span className="text-sm font-medium tabular-nums">{formatDayLabel(day)}</span>
        ) : (
          <Input
            aria-label="Date"
            className="w-40 text-sm"
            size="sm"
            type="date"
            value={day}
            disabled={busy}
            onChange={(e) => {
              setDay(e.target.value);
              setNotice(null);
            }}
          />
        )}
        <Select
          value={calendarId}
          onValueChange={(value) => {
            if (value) {
              savePreferences({ writeCalendarId: value });
              setEditing(null);
              setNotice(null);
            }
          }}
          disabled={busy}
        >
          <SelectTrigger aria-label="Calendar" className="w-52 min-w-0" size="sm">
            <CalendarIcon aria-hidden className="size-3.5" />
            <SelectValue>{selectedTitle ?? "Choose calendar"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {calendars.data?.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {c.writable ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground">Read only</span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <div className="ms-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Refresh calendar"
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || events.isPending}
                  aria-busy={events.isPending}
                  onClick={refresh}
                />
              }
            >
              <RefreshIcon className="size-3.5" refreshing={events.isPending} />
            </TooltipTrigger>
            <TooltipPopup className="max-w-64" side="bottom">
              {calendarSyncLabel(refreshedAt)}. Refreshes every minute while visible.
            </TooltipPopup>
          </Tooltip>
          <span className="hidden text-xs text-muted-foreground sm:inline">{timeZone}</span>
        </div>
      </div>

      {notice ? (
        <Alert role="status" variant="success">
          <CheckCircle2Icon />
          <AlertTitle>{notice}</AlertTitle>
          <AlertAction>
            <Button
              aria-label="Dismiss"
              size="icon-xs"
              variant="ghost"
              onClick={() => setNotice(null)}
            >
              <XIcon aria-hidden />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {calendars.error || events.error ? (
        <Alert role="alert" variant="error">
          <AlertTitle>{calendars.error ?? events.error}</AlertTitle>
        </Alert>
      ) : null}
      {!dayRange ? (
        <Alert role="alert" variant="error">
          <AlertTitle>Choose a valid date.</AlertTitle>
        </Alert>
      ) : null}

      {dayRange ? (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
          {loading ? (
            <AgendaGhost />
          ) : calendars.data?.length === 0 ? (
            <Empty className="p-6 md:p-8">
              <EmptyHeader>
                <EmptyDescription>No readable calendars were found.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : events.data?.length === 0 ? (
            <Empty className="p-6 md:p-8">
              <EmptyHeader>
                <EmptyDescription>No events on this day.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y divide-border/60">
              {events.data?.map((event) => {
                const editable = writable && !event.allDay && !event.recurring;
                const target = { calendarId, eventId: event.id, etag: event.etag };
                const canLink = editable && !!issueIdentifier && !event.issueIdentifier;
                const canUnlink = editable && !!event.issueIdentifier;
                const canMove = editable && event.createdByT3;
                const hasMenu = !!event.url || canLink || canUnlink || canMove;
                return (
                  <li
                    key={event.id}
                    className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5"
                  >
                    <div className="text-xs tabular-nums text-muted-foreground">
                      <div>{formatEventTimeRange(event)}</div>
                      {event.blocksTime === false ? (
                        <div className="text-muted-foreground/70">Free</div>
                      ) : null}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{event.title}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        {event.issueIdentifier ? (
                          <Badge size="sm" variant="info">
                            <CircleDotIcon aria-hidden />
                            {event.issueIdentifier}
                          </Badge>
                        ) : null}
                        {event.createdByT3 ? (
                          <span className="text-[11px] text-muted-foreground">
                            Scheduled from T3
                          </span>
                        ) : null}
                        {event.recurring ? (
                          <Tooltip>
                            <TooltipTrigger render={<span className="inline-flex" />}>
                              <RepeatIcon
                                aria-label="Recurring event"
                                className="size-3 text-muted-foreground"
                              />
                            </TooltipTrigger>
                            <TooltipPopup>Recurring event</TooltipPopup>
                          </Tooltip>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {event.issueIdentifier && onWork ? (
                        <Button
                          size="xs"
                          onClick={() => {
                            if (event.issueIdentifier) onWork(event.issueIdentifier);
                          }}
                        >
                          {hasThread?.(event.issueIdentifier) ? (
                            <>
                              <MessageSquareIcon aria-hidden />
                              Resume thread
                            </>
                          ) : (
                            <>
                              <PlayIcon aria-hidden />
                              Start working
                            </>
                          )}
                        </Button>
                      ) : null}
                      {hasMenu ? (
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                aria-label={`Actions for ${event.title}`}
                                size="icon-xs"
                                variant="ghost-muted"
                                disabled={busy}
                              />
                            }
                          >
                            <EllipsisIcon aria-hidden />
                          </MenuTrigger>
                          <MenuPopup align="end" side="bottom" className="min-w-52">
                            {event.url ? (
                              <MenuItem
                                onClick={() => {
                                  void ensureLocalApi()
                                    .shell.openExternal(event.url)
                                    .catch(() => setNotice("Could not open Google Calendar."));
                                }}
                              >
                                <ExternalLinkIcon aria-hidden />
                                Open in Google
                              </MenuItem>
                            ) : null}
                            {canLink ? (
                              <MenuItem
                                onClick={() =>
                                  void mutate({
                                    ...target,
                                    action: "link",
                                    reference: issueIdentifier,
                                  })
                                }
                              >
                                <Link2Icon aria-hidden />
                                Link to {issueIdentifier}
                              </MenuItem>
                            ) : null}
                            {canUnlink ? (
                              <MenuItem
                                onClick={() => void mutate({ ...target, action: "unlink" })}
                              >
                                <Link2OffIcon aria-hidden />
                                Unlink issue
                              </MenuItem>
                            ) : null}
                            {canMove ? (
                              <>
                                <MenuSeparator />
                                <MenuItem
                                  onClick={() => {
                                    const start = new Date(event.start);
                                    setTime(
                                      `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
                                    );
                                    setMinutes(
                                      Math.round(
                                        (Date.parse(event.end) - Date.parse(event.start)) / 60_000,
                                      ),
                                    );
                                    setEditing(event);
                                  }}
                                >
                                  <CalendarIcon aria-hidden />
                                  Reschedule
                                </MenuItem>
                                <MenuItem
                                  variant="destructive"
                                  onClick={async () => {
                                    const confirmed = await ensureLocalApi().dialogs.confirm(
                                      `Remove “${event.title}” from Google Calendar? The Linear issue and its T3 thread will remain.`,
                                    );
                                    if (confirmed) void mutate({ ...target, action: "delete" });
                                  }}
                                >
                                  <Trash2Icon aria-hidden />
                                  Unschedule
                                </MenuItem>
                              </>
                            ) : null}
                          </MenuPopup>
                        </Menu>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {issueIdentifier || editing ? (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <p className="text-sm font-medium">
            {editing ? `Reschedule ${editing.title}` : `Schedule ${issueIdentifier}`}
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            {embedded ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Date</span>
                <Input
                  aria-label="Date"
                  className="w-40 text-sm"
                  size="sm"
                  type="date"
                  value={day}
                  disabled={busy}
                  onChange={(e) => {
                    setDay(e.target.value);
                    setNotice(null);
                  }}
                />
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Start</span>
              <Input
                aria-label="Start time"
                className="w-28 text-sm"
                size="sm"
                type="time"
                value={time}
                disabled={busy}
                onChange={(e) => {
                  setTime(e.target.value);
                  setNotice(null);
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Duration</span>
              <span className="flex items-center gap-1.5">
                <Input
                  aria-label="Duration in minutes"
                  className="w-20 text-sm"
                  size="sm"
                  type="number"
                  min={5}
                  max={1440}
                  step={5}
                  value={minutes}
                  disabled={busy}
                  onChange={(e) => {
                    setMinutes(Number(e.target.value));
                    setNotice(null);
                  }}
                />
                <span className="text-xs text-muted-foreground">min</span>
              </span>
            </label>
            {editing ? (
              <>
                <Button
                  size="sm"
                  disabled={busy || !writable || !blockRange}
                  onClick={() => {
                    const event = editing;
                    if (event && blockRange)
                      void mutate({
                        action: "move",
                        calendarId,
                        eventId: event.id,
                        etag: event.etag,
                        ...blockRange,
                      });
                  }}
                >
                  Save time
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={busy || !writable || !blockRange}
                onClick={() => void create()}
              >
                Schedule
              </Button>
            )}
          </div>
          {!blockRange ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              Choose a valid local time and a duration between 5 and 1,440 minutes.
            </p>
          ) : null}
          {!writable ? (
            <p className="mt-2 text-xs text-muted-foreground">This calendar is read only.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
