import { ArrowLeftIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { PlanningHours } from "./calendarAvailability";
import { CalendarFindTime } from "./CalendarFindTime";
import type { CalendarEntry } from "./calendarPlanning";

export type Draft = {
  reference: string;
  day: string;
  time: string;
  minutes: number;
  event?: CalendarEntry;
  requestId: string;
};
export type Placement = Omit<Draft, "requestId">;

/**
 * The side column while a block is being placed: what is being scheduled,
 * when, where it saves, and the free slots that fit. Replacing the issue
 * list keeps the week grid still, so the dashed preview stays put.
 */
export function CalendarDraftPanel({
  draft,
  issueTitle,
  busy,
  valid,
  conflicts,
  incompleteOverlapCheck,
  calendars,
  calendarId,
  onCalendarChange,
  onChange,
  onSave,
  onCancel,
  suggestions,
}: {
  draft: Draft;
  issueTitle: string | undefined;
  busy: boolean;
  /** The date, time and duration make a real block. */
  valid: boolean;
  conflicts: readonly CalendarEntry[];
  incompleteOverlapCheck: boolean;
  /** Writable calendars a new block can save to. */
  calendars: readonly { id: string; title: string }[];
  calendarId: string;
  onCalendarChange: (id: string) => void;
  onChange: (patch: Partial<Pick<Placement, "day" | "time" | "minutes">>) => void;
  onSave: () => void;
  onCancel: () => void;
  /** Free-slot inputs for a new block; `null` while rescheduling an existing one. */
  suggestions: {
    days: readonly string[];
    entries: readonly CalendarEntry[];
    hours: PlanningHours;
    incomplete: boolean;
  } | null;
}) {
  const rescheduling = !!draft.event;
  return (
    <div className="flex flex-col gap-4 px-3 py-2">
      <div>
        <Button size="xs" variant="ghost" className="-ml-2" disabled={busy} onClick={onCancel}>
          <ArrowLeftIcon aria-hidden />
          Issues
        </Button>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {rescheduling ? "Reschedule" : "Schedule"}
        </p>
        {rescheduling ? (
          <p className="mt-0.5 line-clamp-2 text-sm font-medium">{draft.event?.title}</p>
        ) : (
          <>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{draft.reference}</p>
            {issueTitle ? <p className="line-clamp-2 text-sm font-medium">{issueTitle}</p> : null}
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Date</span>
          <Input
            aria-label="Block date"
            size="sm"
            type="date"
            value={draft.day}
            disabled={busy}
            onChange={(e) => onChange({ day: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Start</span>
          <Input
            aria-label="Start time"
            size="sm"
            type="time"
            value={draft.time}
            disabled={busy}
            onChange={(e) => onChange({ time: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Length</span>
          <InputGroup>
            <InputGroupInput
              type="number"
              min={5}
              max={1440}
              className="tabular-nums"
              aria-label="Duration in minutes"
              value={draft.minutes}
              disabled={busy}
              onChange={(e) => onChange({ minutes: Number(e.target.value) })}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText className="text-xs">min</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </label>
        {!rescheduling ? (
          <div className="col-span-2 flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Calendar</span>
            <Select
              value={calendarId}
              disabled={busy || !calendars.length}
              onValueChange={(value) => onCalendarChange(value as string)}
            >
              <SelectTrigger size="sm" aria-label="Calendar to save the block to">
                <SelectValue className="truncate">
                  {(value: string) =>
                    calendars.find((c) => c.id === value)?.title ?? "No writable calendar"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {calendars.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Or click a time in the week to move the block there.
      </p>

      {!valid ? (
        <p role="alert" className="text-xs text-destructive">
          Enter a valid local date, time and length between 5 and 1,440 minutes.
        </p>
      ) : null}
      {conflicts.length ? (
        <Alert variant="warning" className="py-2">
          <AlertTitle className="text-xs">
            Overlaps{" "}
            {conflicts.map((event) => `${event.title} (${event.calendarTitle})`).join(", ")}.
          </AlertTitle>
          <AlertDescription className="text-xs">
            Free events and calendars not checked for conflicts do not warn.
          </AlertDescription>
        </Alert>
      ) : null}
      {incompleteOverlapCheck ? (
        <p className="text-xs text-muted-foreground">
          Overlap checks are incomplete. Check Google Calendar before saving.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !valid || (!rescheduling && !calendarId)}
          onClick={onSave}
        >
          {busy ? "Saving…" : conflicts.length ? "Save despite overlap" : "Save to calendar"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {suggestions ? (
        <div className="border-t border-border/60 pt-4">
          <CalendarFindTime
            days={suggestions.days}
            entries={suggestions.entries}
            minutes={draft.minutes}
            hours={suggestions.hours}
            incomplete={suggestions.incomplete}
            disabled={busy || !calendarId}
            onSelect={(day, time) => onChange({ day, time })}
          />
        </div>
      ) : null}
    </div>
  );
}
