import type {
  EnvironmentId,
  GoogleCalendarEvent,
  GoogleCalendarUpdateInput,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { googleCalendarEnvironment as calendar } from "~/state/googleCalendar";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { calendarSyncLabel, useCalendarRefresh } from "./useCalendarRefresh";
import { useCalendarPreferences } from "./calendarPreferences";
import { calendarBlockRange, calendarDayRange, localCalendarDate } from "./calendarTime";

export function IssueCalendar({
  environmentId,
  identifier,
}: {
  environmentId: EnvironmentId;
  identifier: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3">
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
        {open ? "Close scheduling" : "Schedule / Link calendar event"}
      </Button>
      {open ? <CalendarAgenda environmentId={environmentId} issueIdentifier={identifier} /> : null}
    </section>
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

  if (!status.data?.connected)
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p role="status">
          {status.error ??
            (status.isPending
              ? "Checking Google Calendar…"
              : "Connect Google Calendar in Settings → Integrations to schedule issues.")}
        </p>
        <Button size="sm" variant="outline" onClick={status.refresh}>
          Check connection
        </Button>
      </div>
    );

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs">
          Calendar
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
            <SelectTrigger className="w-56">
              <SelectValue>
                {calendars.data?.find((c) => c.id === calendarId)?.title ?? "Choose calendar"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {calendars.data?.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title}
                  {c.writable ? "" : " (read only)"}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="space-y-1 text-xs">
          Date
          <Input
            type="date"
            value={day}
            disabled={busy}
            onChange={(e) => {
              setDay(e.target.value);
              setNotice(null);
            }}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setDay(localCalendarDate())}
        >
          Today
        </Button>
        <Button size="sm" variant="outline" disabled={busy || events.isPending} onClick={refresh}>
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Times shown in {timeZone}. Refreshes every minute while visible and when you return.{" "}
        {calendarSyncLabel(refreshedAt)}.
      </p>
      {issueIdentifier || editing ? (
        <div className="flex flex-wrap items-end gap-2 rounded border border-border/60 p-3">
          <label className="space-y-1 text-xs">
            Start time
            <Input
              type="time"
              value={time}
              disabled={busy}
              onChange={(e) => {
                setTime(e.target.value);
                setNotice(null);
              }}
            />
          </label>
          <label className="space-y-1 text-xs">
            Minutes
            <Input
              className="w-24"
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
          </label>
          {!editing ? (
            <Button
              size="sm"
              disabled={busy || !writable || !blockRange}
              onClick={() => void create()}
            >
              Schedule {issueIdentifier}
            </Button>
          ) : (
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
                Save new time
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </>
          )}
          {!blockRange ? (
            <p className="w-full text-xs" role="alert">
              Choose a valid local time and a duration between 5 and 1,440 minutes.
            </p>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {calendars.error || events.error ? (
        <p role="alert" className="text-sm text-destructive">
          {calendars.error ?? events.error}
        </p>
      ) : null}
      {(calendars.data === null && calendars.isPending) ||
      (events.data === null && events.isPending) ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading calendar…
        </p>
      ) : null}
      {!dayRange ? (
        <p role="alert" className="text-sm">
          Choose a valid date.
        </p>
      ) : null}
      {calendars.data?.length === 0 ? (
        <p className="text-sm">No readable calendars were found.</p>
      ) : null}
      {events.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events on this day.</p>
      ) : null}
      <ul className="space-y-2">
        {events.data?.map((event) => {
          const editable = writable && !event.allDay && !event.recurring;
          const target = { calendarId, eventId: event.id, etag: event.etag };
          return (
            <li key={event.id} className="space-y-2 rounded border border-border/60 p-3">
              <div className="text-xs text-muted-foreground">
                {eventTimeLabel(event)}
                {event.blocksTime === false ? " · Free" : " · Busy"}
              </div>
              <p className="text-sm font-medium">{event.title}</p>
              {event.issueIdentifier ? (
                <p className="text-xs text-muted-foreground">Linked to {event.issueIdentifier}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {event.url ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void ensureLocalApi()
                        .shell.openExternal(event.url)
                        .catch(() => setNotice("Could not open Google Calendar."));
                    }}
                  >
                    Open in Google
                  </Button>
                ) : null}
                {event.issueIdentifier && onWork ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      if (event.issueIdentifier) onWork(event.issueIdentifier);
                    }}
                  >
                    {hasThread?.(event.issueIdentifier) ? "Resume thread" : "Start working"}
                  </Button>
                ) : null}
                {editable && issueIdentifier && !event.issueIdentifier ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void mutate({ ...target, action: "link", reference: issueIdentifier })
                    }
                  >
                    Link to {issueIdentifier}
                  </Button>
                ) : null}
                {editable && event.issueIdentifier ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void mutate({ ...target, action: "unlink" })}
                  >
                    Unlink issue
                  </Button>
                ) : null}
                {editable && event.createdByT3 ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const start = new Date(event.start);
                        setTime(
                          `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
                        );
                        setMinutes(
                          Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000),
                        );
                        setEditing(event);
                      }}
                    >
                      Reschedule
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={async () => {
                        const confirmed = await ensureLocalApi().dialogs.confirm(
                          `Remove “${event.title}” from Google Calendar? The Linear issue and its T3 thread will remain.`,
                        );
                        if (confirmed) void mutate({ ...target, action: "delete" });
                      }}
                    >
                      Unschedule
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function eventTimeLabel(event: GoogleCalendarEvent): string {
  if (event.allDay) return "All day";
  const format = (value: string) =>
    new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${format(event.start)} – ${format(event.end)}`;
}
