import type { GoogleCalendarEvent } from "@t3tools/contracts";

/**
 * How the calendar surfaces name times and days. Every view formats through
 * here so the agenda, the planner and the issue detail read the same way.
 */

export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** `HH:MM` in local time, the shape the date inputs and block ranges work in. */
export function clockTimeOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatEventTimeRange(
  event: Pick<GoogleCalendarEvent, "start" | "end" | "allDay">,
): string {
  if (event.allDay) return "All day";
  return `${formatClockTime(event.start)} – ${formatClockTime(event.end)}`;
}

/** A `YYYY-MM-DD` day as "Tue, 10 Sep" (or "Tue 10" when `short`). */
export function formatDayLabel(day: string, options?: { readonly short?: boolean }): string {
  const date = new Date(`${day}T12:00:00`);
  return options?.short
    ? date.toLocaleDateString([], { weekday: "short", day: "numeric" })
    : date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** "8 – 14 Sep 2026" for the seven `YYYY-MM-DD` days of a planner week. */
export function formatWeekRangeLabel(days: ReadonlyArray<string>): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return "";
  const from = new Date(`${first}T12:00:00`);
  const to = new Date(`${last}T12:00:00`);
  const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
  const start = sameMonth
    ? from.toLocaleDateString([], { day: "numeric" })
    : from.toLocaleDateString([], { day: "numeric", month: "short" });
  const end = to.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return `${start} – ${end}`;
}

/**
 * One colour per calendar, by its position in the calendar list. Blocks wear
 * the tinted background and border; dots and legends wear the solid colour.
 */
export const CALENDAR_COLOR_CLASSES = [
  {
    block: "border-blue-500/50 bg-blue-500/15 text-blue-950 dark:text-blue-100",
    dot: "bg-blue-500",
  },
  {
    block: "border-violet-500/50 bg-violet-500/15 text-violet-950 dark:text-violet-100",
    dot: "bg-violet-500",
  },
  {
    block: "border-emerald-500/50 bg-emerald-500/15 text-emerald-950 dark:text-emerald-100",
    dot: "bg-emerald-500",
  },
  {
    block: "border-amber-500/50 bg-amber-500/15 text-amber-950 dark:text-amber-100",
    dot: "bg-amber-500",
  },
] as const;

export function calendarColorClass(index: number): string {
  return CALENDAR_COLOR_CLASSES[Math.max(0, index) % CALENDAR_COLOR_CLASSES.length]!.block;
}

export function calendarColorDotClass(index: number): string {
  return CALENDAR_COLOR_CLASSES[Math.max(0, index) % CALENDAR_COLOR_CLASSES.length]!.dot;
}
