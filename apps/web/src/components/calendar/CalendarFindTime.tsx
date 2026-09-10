import { SparklesIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  availableCalendarSlots,
  formatPlanningHours,
  validPlanningHours,
  type PlanningHours,
} from "./calendarAvailability";
import type { CalendarEntry } from "./calendarPlanning";
import { formatClockTime, formatDayLabel } from "./calendarPresentation";
import { useCalendarNow } from "./useCalendarRefresh";

/**
 * Free slots for a new block, listed as soon as the block is being placed.
 * Working hours live in the planning preferences; this only reads them.
 */
export function CalendarFindTime({
  days,
  entries,
  minutes,
  hours,
  onSelect,
  incomplete,
  disabled,
}: {
  days: readonly string[];
  entries: readonly CalendarEntry[];
  minutes: number;
  hours: PlanningHours;
  onSelect: (day: string, time: string) => void;
  incomplete: boolean;
  disabled: boolean;
}) {
  const now = useCalendarNow();
  const valid = validPlanningHours(hours);
  const slots =
    !incomplete && valid ? availableCalendarSlots({ days, entries, minutes, hours, now }) : [];
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <SparklesIcon aria-hidden className="size-3.5" />
        Suggested times
      </h3>
      {!valid ? (
        <p role="alert" className="text-xs text-destructive">
          Working hours are invalid. Fix them in planning preferences to see suggestions.
        </p>
      ) : incomplete ? (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for complete calendar data. Refresh if a calendar failed to load.
        </p>
      ) : !slots.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          Nothing fits this week. Try a shorter block, another week, or wider working hours.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {slots.map((slot) => (
            <li key={slot.start}>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-between"
                disabled={disabled}
                onClick={() => {
                  // A suggestion can age while the tab is hidden.
                  if (Date.parse(slot.start) >= Date.now()) onSelect(slot.day, slot.time);
                }}
              >
                <span className="font-medium">{formatDayLabel(slot.day, { short: true })}</span>
                <span className="tabular-nums text-muted-foreground">
                  {slot.time} – {formatClockTime(slot.end)}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {valid ? (
        <p className="text-xs text-muted-foreground">
          Within {formatPlanningHours(hours)}. Availability can change in Google before you save.
        </p>
      ) : null}
    </section>
  );
}
