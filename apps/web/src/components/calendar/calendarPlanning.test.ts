import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  calendarWeek,
  dailyWork,
  layoutCalendarDay,
  overlappingEvents,
  type CalendarEntry,
} from "./calendarPlanning";
import { calendarDayRange } from "./calendarTime";
import { defaultPlanningHours } from "./calendarAvailability";
import { readCalendarPreferences } from "./calendarPreferences";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const event = (
  id: string,
  start: string,
  end: string,
  extra: Partial<CalendarEntry> = {},
): CalendarEntry => ({
  id,
  start,
  end,
  calendarId: "work",
  calendarTitle: "Work",
  title: id,
  etag: id,
  url: "",
  allDay: false,
  recurring: false,
  issueIdentifier: "DEL-1",
  createdByT3: true,
  ...extra,
});

it("keeps a Monday-to-Sunday week across year and DST boundaries", () => {
  vi.stubEnv("TZ", "Europe/Berlin");
  expect(calendarWeek("2026-01-01")).toEqual([
    "2025-12-29",
    "2025-12-30",
    "2025-12-31",
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
    "2026-01-04",
  ]);
  const week = calendarWeek("2026-03-29");
  expect(week[0]).toBe("2026-03-23");
  expect(
    Date.parse(calendarDayRange(week[6]!)!.end) - Date.parse(calendarDayRange(week[0]!)!.start),
  ).toBe(167 * 3600_000);
  expect(calendarWeek("2026-02-30")).toEqual([]);
});

it("clips overnight blocks and separates overlapping groups into columns", () => {
  vi.stubEnv("TZ", "UTC");
  const layout = layoutCalendarDay(
    [
      event("overnight", "2026-09-07T23:00:00Z", "2026-09-08T01:00:00Z"),
      event("a", "2026-09-08T09:00:00Z", "2026-09-08T11:00:00Z"),
      event("b", "2026-09-08T10:00:00Z", "2026-09-08T12:00:00Z"),
      event("c", "2026-09-08T11:00:00Z", "2026-09-08T11:30:00Z"),
      event("separate", "2026-09-08T12:00:00Z", "2026-09-08T13:00:00Z"),
    ],
    "2026-09-08",
  );
  expect(layout.map(({ top, bottom, lane, lanes }) => ({ top, bottom, lane, lanes }))).toEqual([
    { top: 0, bottom: 60, lane: 0, lanes: 1 },
    { top: 540, bottom: 660, lane: 0, lanes: 2 },
    { top: 600, bottom: 720, lane: 1, lanes: 2 },
    { top: 660, bottom: 690, lane: 0, lanes: 2 },
    { top: 720, bottom: 780, lane: 0, lanes: 1 },
  ]);
});

it("checks overlays, excludes only the edited calendar copy, and respects exclusive ends", () => {
  vi.stubEnv("TZ", "Europe/Berlin");
  const original = event("a", "2026-09-08T08:00:00Z", "2026-09-08T09:00:00Z");
  const otherCopy = { ...original, calendarId: "personal" };
  const adjacent = event("b", "2026-09-08T09:00:00Z", "2026-09-08T10:00:00Z");
  const allDay = event("day", "2026-09-08", "2026-09-09", { allDay: true });
  expect(
    overlappingEvents([original, otherCopy, adjacent, allDay], original, original).map(
      (e) => e.calendarId + e.id,
    ),
  ).toEqual(["personala", "workday"]);
  expect(
    overlappingEvents([allDay], { start: "2026-09-08T22:00:00Z", end: "2026-09-08T23:00:00Z" }),
  ).toEqual([]);
});

it("isolates saved preferences by environment and tolerates corrupt or denied storage", () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) =>
      key === "t3.calendar.one"
        ? JSON.stringify({
            writeCalendarId: "work",
            overlayIds: ["personal", 1],
            minutes: 30,
            ignoredConflictIds: ["personal", 2],
          })
        : "broken",
  });
  expect(readCalendarPreferences("one")).toEqual({
    planningHours: defaultPlanningHours,
    writeCalendarId: "work",
    overlayIds: ["personal"],
    minutes: 30,
    ignoredConflictIds: ["personal"],
  });
  expect(readCalendarPreferences("two")).toEqual({
    planningHours: defaultPlanningHours,
    writeCalendarId: "",
    overlayIds: [],
    minutes: 60,
    ignoredConflictIds: [],
  });
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("denied");
    },
  });
  expect(readCalendarPreferences("one").minutes).toBe(60);
});

it("ignores free events without hiding them from the calendar", () => {
  const free = event("free", "2026-09-08T09:00:00Z", "2026-09-08T10:00:00Z", { blocksTime: false });
  expect(
    overlappingEvents([free, { ...free, id: "busy", blocksTime: true }], free).map((e) => e.id),
  ).toEqual(["busy"]);
  expect(layoutCalendarDay([free], "2026-09-08")).toHaveLength(1);
});

it("classifies daily work at exact boundaries and excludes meetings and all-day links", () => {
  const now = Date.parse("2026-09-08T10:00:00Z");
  const current = event("now", "2026-09-08T10:00:00Z", "2026-09-08T11:00:00Z");
  const ended = event("ended", "2026-09-08T09:00:00Z", "2026-09-08T10:00:00Z");
  const next = event("next", "2026-09-08T11:00:00Z", "2026-09-08T12:00:00Z");
  const result = dailyWork(
    [
      next,
      ended,
      current,
      { ...current, id: "meeting", issueIdentifier: null },
      { ...current, id: "all-day", allDay: true },
    ],
    now,
  );
  expect(result.current.map((e) => e.id)).toEqual(["now"]);
  expect(result.upcoming.map((e) => e.id)).toEqual(["next"]);
  expect(result.ended.map((e) => e.id)).toEqual(["ended"]);
});
