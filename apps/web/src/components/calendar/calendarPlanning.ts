import type { GoogleCalendarEvent } from "@t3tools/contracts";
import { calendarDayRange, localCalendarDate } from "./calendarTime";

export function calendarWeek(day: string): string[] {
  const range = calendarDayRange(day);
  if (!range) return [];
  const date = new Date(range.start);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const next = new Date(date);
    next.setDate(next.getDate() + index);
    return localCalendarDate(next);
  });
}

export function shiftCalendarDay(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return localCalendarDate(date);
}

export type CalendarEntry = GoogleCalendarEvent & { calendarId: string; calendarTitle: string };

export function overlappingEvents(
  entries: readonly CalendarEntry[],
  range: { start: string; end: string },
  excluding?: CalendarEntry,
): CalendarEntry[] {
  return entries.filter((event) => {
    if (event.blocksTime === false) return false;
    if (excluding?.calendarId === event.calendarId && excluding.id === event.id) return false;
    const start = event.allDay ? calendarDayRange(event.start)?.start : event.start;
    const end = event.allDay ? calendarDayRange(event.end)?.start : event.end;
    return (
      !!start &&
      !!end &&
      Date.parse(start) < Date.parse(range.end) &&
      Date.parse(end) > Date.parse(range.start)
    );
  });
}

/** Clip multi-day blocks to each local day and give simultaneous events separate columns. */
export function layoutCalendarDay(entries: readonly CalendarEntry[], day: string) {
  const range = calendarDayRange(day);
  if (!range) return [];
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  const blocks = entries
    .filter(
      (event) => !event.allDay && Date.parse(event.start) < end && Date.parse(event.end) > start,
    )
    .map((event) => {
      const from = new Date(Math.max(start, Date.parse(event.start)));
      const to = new Date(Math.min(end, Date.parse(event.end)));
      const top = from.getHours() * 60 + from.getMinutes();
      return {
        event,
        top,
        bottom:
          to.getTime() === end ? 1440 : Math.max(top + 15, to.getHours() * 60 + to.getMinutes()),
        lane: 0,
        lanes: 1,
      };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let group: typeof blocks = [];
  let groupEnd = -1;
  const finish = () => {
    const lanes = Math.max(1, ...group.map((block) => block.lane + 1));
    for (const block of group) block.lanes = lanes;
  };
  for (const block of blocks) {
    if (block.top >= groupEnd) {
      finish();
      group = [];
      groupEnd = -1;
    }
    while (group.some((other) => other.lane === block.lane && other.bottom > block.top))
      block.lane++;
    group.push(block);
    groupEnd = Math.max(groupEnd, block.bottom);
  }
  finish();
  return blocks;
}

/** Only timed linked blocks participate in daily execution; meeting context stays in the grid. */
export function dailyWork(entries: readonly CalendarEntry[], now: number) {
  const timed = entries
    .filter((event) => event.issueIdentifier && !event.allDay)
    .toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return {
    current: timed.filter((event) => Date.parse(event.start) <= now && Date.parse(event.end) > now),
    upcoming: timed.filter((event) => Date.parse(event.start) > now),
    ended: timed.filter((event) => Date.parse(event.end) <= now),
  };
}
