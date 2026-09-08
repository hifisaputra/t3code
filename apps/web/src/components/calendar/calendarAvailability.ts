import { calendarBlockRange, calendarDayRange } from "./calendarTime";
import type { CalendarEntry } from "./calendarPlanning";

export interface PlanningHours {
  weekdays: number[];
  start: string;
  end: string;
  breakMinutes: number;
  focusMinutes: number;
}
export const defaultPlanningHours: PlanningHours = {
  weekdays: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
  breakMinutes: 15,
  focusMinutes: 240,
};
const clockMinute = (time: string) =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
    : NaN;
export function validPlanningHours(value: PlanningHours): boolean {
  return (
    value.weekdays.length > 0 &&
    value.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    clockMinute(value.start) < clockMinute(value.end) &&
    Number.isInteger(value.breakMinutes) &&
    value.breakMinutes >= 0 &&
    value.breakMinutes <= 120 &&
    Number.isInteger(value.focusMinutes) &&
    value.focusMinutes >= 5 &&
    value.focusMinutes <= 1440
  );
}
export function readPlanningHours(value: unknown): PlanningHours {
  if (!value || typeof value !== "object") return defaultPlanningHours;
  const candidate = value as Partial<PlanningHours>;
  return Array.isArray(candidate.weekdays) &&
    typeof candidate.start === "string" &&
    typeof candidate.end === "string" &&
    typeof candidate.breakMinutes === "number" &&
    typeof candidate.focusMinutes === "number" &&
    validPlanningHours(candidate as PlanningHours)
    ? (candidate as PlanningHours)
    : defaultPlanningHours;
}

/** Suggest non-overlapping alternatives, using absolute durations and local working boundaries. */
export function availableCalendarSlots({
  days,
  entries,
  minutes,
  hours,
  now,
}: {
  days: readonly string[];
  entries: readonly CalendarEntry[];
  minutes: number;
  hours: PlanningHours;
  now: number;
}) {
  const slots: { day: string; time: string; start: string; end: string }[] = [];
  if (!validPlanningHours(hours) || !Number.isInteger(minutes) || minutes < 5 || minutes > 1440)
    return slots;
  const busy = entries
    .filter((event) => event.blocksTime !== false)
    .map((event) => ({
      start: Date.parse(event.allDay ? (calendarDayRange(event.start)?.start ?? "") : event.start),
      end: Date.parse(event.allDay ? (calendarDayRange(event.end)?.start ?? "") : event.end),
      focus: !event.allDay && !!event.issueIdentifier,
    }));
  // Unparseable busy data cannot establish availability.
  if (
    busy.some(
      (event) =>
        !Number.isFinite(event.start) || !Number.isFinite(event.end) || event.end <= event.start,
    )
  )
    return slots;
  const buffer = hours.breakMinutes * 60_000;
  for (const day of days) {
    const daily = calendarDayRange(day);
    if (!daily || !hours.weekdays.includes(new Date(`${day}T12:00:00`).getDay())) continue;
    const from = calendarBlockRange(day, hours.start, 5);
    const until = calendarBlockRange(day, hours.end, 5);
    if (!from || !until) continue;
    // Merge focus intervals so overlapping calendar copies don't consume the limit twice.
    const focus = busy
      .filter((event) => event.focus)
      .map((event) => ({
        start: Math.max(event.start, Date.parse(daily.start)),
        end: Math.min(event.end, Date.parse(daily.end)),
      }))
      .filter((event) => event.end > event.start)
      .sort((a, b) => a.start - b.start);
    let used = 0;
    let previousEnd = -Infinity;
    for (const event of focus) {
      used += Math.max(0, event.end - Math.max(event.start, previousEnd));
      previousEnd = Math.max(previousEnd, event.end);
    }
    if (used / 60_000 + minutes > hours.focusMinutes) continue;
    for (
      let minute = Math.ceil(clockMinute(hours.start) / 15) * 15;
      minute < clockMinute(hours.end);
      minute += 15
    ) {
      const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      const range = calendarBlockRange(day, time, minutes);
      if (!range) continue;
      const start = Date.parse(range.start),
        end = Date.parse(range.end);
      if (start < now || end > Date.parse(until.start)) continue;
      if (busy.some((event) => event.start - buffer < end && event.end + buffer > start)) continue;
      slots.push({ day, time, ...range });
      if (slots.length === 6) return slots;
      minute += Math.ceil((minutes + hours.breakMinutes) / 15) * 15 - 15;
    }
  }
  return slots;
}
