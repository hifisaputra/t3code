import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  availableCalendarSlots,
  defaultPlanningHours,
  readPlanningHours,
} from "./calendarAvailability";
import type { CalendarEntry } from "./calendarPlanning";
afterEach(() => vi.unstubAllEnvs());
const event = (start: string, end: string, extra: Partial<CalendarEntry> = {}): CalendarEntry => ({
  id: "a",
  etag: "a",
  title: "Meeting",
  url: "",
  calendarId: "work",
  calendarTitle: "Work",
  start,
  end,
  allDay: false,
  recurring: false,
  createdByT3: false,
  issueIdentifier: null,
  ...extra,
});
const base = () => ({
  days: ["2026-09-08"],
  entries: [] as CalendarEntry[],
  minutes: 60,
  hours: defaultPlanningHours,
  now: Date.parse("2026-09-08T00:00:00Z"),
});
it("respects busy intervals, breaks, past times, and Free transparency", () => {
  vi.stubEnv("TZ", "UTC");
  const slots = availableCalendarSlots({
    ...base(),
    now: Date.parse("2026-09-08T09:01:00Z"),
    entries: [
      event("2026-09-08T10:00:00Z", "2026-09-08T11:00:00Z"),
      event("2026-09-08T11:00:00Z", "2026-09-08T12:00:00Z", { blocksTime: false }),
    ],
  });
  expect(slots[0]?.time).toBe("11:15");
  expect(slots.every((s) => Date.parse(s.end) <= Date.parse("2026-09-08T17:00:00Z"))).toBe(true);
});
it("blocks all-day and overnight events with exclusive ends and skips non-working days", () => {
  vi.stubEnv("TZ", "UTC");
  const slots = availableCalendarSlots({
    ...base(),
    days: ["2026-09-08", "2026-09-09", "2026-09-12"],
    entries: [
      event("2026-09-08", "2026-09-09", { allDay: true }),
      event("2026-09-08T23:00:00Z", "2026-09-09T10:00:00Z"),
    ],
  });
  expect(slots[0]?.day).toBe("2026-09-09");
  expect(slots[0]?.time).toBe("10:15");
  expect(slots.every((s) => s.day === "2026-09-09")).toBe(true);
});
it("counts overlapping linked focus time once and rejects proposals exceeding the cap", () => {
  vi.stubEnv("TZ", "UTC");
  const entries = [
    event("2026-09-08T09:00:00Z", "2026-09-08T11:00:00Z", { issueIdentifier: "DEL-1" }),
  ];
  entries.push({ ...entries[0]!, calendarId: "other" });
  expect(
    availableCalendarSlots({
      ...base(),
      entries,
      hours: { ...defaultPlanningHours, focusMinutes: 180 },
    })[0]?.time,
  ).toBe("11:15");
  expect(
    availableCalendarSlots({
      ...base(),
      entries,
      hours: { ...defaultPlanningHours, focusMinutes: 179 },
    }),
  ).toEqual([]);
});
it("uses real elapsed durations across DST and rejects nonexistent working boundaries", () => {
  vi.stubEnv("TZ", "Europe/Berlin");
  const options = {
    ...base(),
    days: ["2026-03-29"],
    now: 0,
    minutes: 120,
    hours: {
      ...defaultPlanningHours,
      weekdays: [0],
      start: "01:00",
      end: "04:00",
      breakMinutes: 0,
    },
  };
  const slots = availableCalendarSlots(options);
  expect(slots).toHaveLength(1);
  expect(slots[0]?.start).toBe("2026-03-29T00:00:00.000Z");
  expect(slots[0]?.end).toBe("2026-03-29T02:00:00.000Z");
  expect(
    availableCalendarSlots({ ...options, hours: { ...options.hours, start: "02:30" } }),
  ).toEqual([]);
});
it("rejects invalid durations, settings and unreadable busy data", () => {
  vi.stubEnv("TZ", "UTC");
  expect(availableCalendarSlots({ ...base(), minutes: NaN })).toEqual([]);
  expect(
    availableCalendarSlots({ ...base(), hours: { ...defaultPlanningHours, weekdays: [] } }),
  ).toEqual([]);
  expect(availableCalendarSlots({ ...base(), entries: [event("bad", "bad")] })).toEqual([]);
  expect(readPlanningHours({ ...defaultPlanningHours, start: "25:00" })).toEqual(
    defaultPlanningHours,
  );
  expect(readPlanningHours({ ...defaultPlanningHours, weekdays: ["1"] })).toEqual(
    defaultPlanningHours,
  );
  expect(readPlanningHours(null)).toEqual(defaultPlanningHours);
});
