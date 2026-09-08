import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  availableCalendarSlots,
  defaultPlanningHours,
  validPlanningHours,
  type PlanningHours,
} from "./calendarAvailability";
import type { CalendarEntry } from "./calendarPlanning";
import { useCalendarNow } from "./useCalendarRefresh";

export function CalendarFindTime({
  days,
  entries,
  minutes,
  hours,
  onHours,
  onSelect,
  incomplete,
  disabled,
}: {
  days: readonly string[];
  entries: readonly CalendarEntry[];
  minutes: number;
  hours: PlanningHours;
  onHours: (hours: PlanningHours) => void;
  onSelect: (day: string, time: string) => void;
  incomplete: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const now = useCalendarNow();
  const valid = validPlanningHours(hours);
  const slots =
    open && !incomplete && valid
      ? availableCalendarSlots({ days, entries, minutes, hours, now })
      : [];
  return (
    <div className="space-y-2 text-xs">
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(!open)}>
        {open ? "Hide suggestions" : "Find time"}
      </Button>
      {open ? (
        <div className="space-y-2 rounded border p-3">
          <p className="font-medium">Find time this week · {minutes} minutes</p>
          <p>
            Uses busy events on calendars selected for conflict checks. Times use your device’s
            timezone. Choose a slot to preview, then save.
          </p>
          <details>
            <summary className="cursor-pointer">Working hours and planning limits</summary>
            <div className="space-y-2 py-2">
              <div className="flex flex-wrap gap-3">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => (
                  <label key={label}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={hours.weekdays.includes(day)}
                      onChange={(e) =>
                        onHours({
                          ...hours,
                          weekdays: e.target.checked
                            ? [...hours.weekdays, day]
                            : hours.weekdays.filter((d) => d !== day),
                        })
                      }
                    />{" "}
                    {label}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                <label>
                  Work starts
                  <Input
                    type="time"
                    value={hours.start}
                    disabled={disabled}
                    onChange={(e) => onHours({ ...hours, start: e.target.value })}
                  />
                </label>
                <label>
                  Work ends
                  <Input
                    type="time"
                    value={hours.end}
                    disabled={disabled}
                    onChange={(e) => onHours({ ...hours, end: e.target.value })}
                  />
                </label>
                <label>
                  Break around events (minutes)
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    value={hours.breakMinutes}
                    disabled={disabled}
                    onChange={(e) => onHours({ ...hours, breakMinutes: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Daily focus limit (minutes)
                  <Input
                    type="number"
                    min={5}
                    max={1440}
                    value={hours.focusMinutes}
                    disabled={disabled}
                    onChange={(e) => onHours({ ...hours, focusMinutes: Number(e.target.value) })}
                  />
                </label>
              </div>
              <p>
                The focus limit counts busy issue blocks on these calendars, including time already
                scheduled today. Preferences are saved on this device for this environment.
              </p>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onHours(defaultPlanningHours)}
              >
                Reset planning preferences
              </Button>
            </div>
          </details>
          {!valid ? (
            <p role="alert">
              Select a working day, an end after the start, a break of 0–120 minutes, and a focus
              limit of 5–1,440 minutes.
            </p>
          ) : incomplete ? (
            <p role="status">
              Waiting for complete calendar data. Use Refresh if a calendar failed to load.
            </p>
          ) : !slots.length ? (
            <p role="status">
              No time fits this week. Try another week, a shorter session, or different working
              hours and limits.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => (
                <Button
                  key={slot.start}
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    // A suggestion can age while the tab is hidden.
                    if (Date.parse(slot.start) >= Date.now()) onSelect(slot.day, slot.time);
                  }}
                >
                  {new Date(slot.start).toLocaleDateString([], {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}{" "}
                  · {slot.time}–
                  {new Date(slot.end).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Button>
              ))}
            </div>
          )}
          <p>
            Availability can change in Google before you save. Hidden and excluded calendars are not
            checked.
          </p>
        </div>
      ) : null}
    </div>
  );
}
