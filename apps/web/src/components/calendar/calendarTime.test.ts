import { afterEach, expect, it, vi } from "vite-plus/test";
import { calendarBlockRange, calendarDayRange } from "./calendarTime";

afterEach(() => vi.unstubAllEnvs());

it("uses local midnight boundaries across daylight saving transitions", () => {
  vi.stubEnv("TZ", "Europe/Berlin");
  const spring = calendarDayRange("2026-03-29")!;
  const autumn = calendarDayRange("2026-10-25")!;
  expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(23 * 3600_000);
  expect(Date.parse(autumn.end) - Date.parse(autumn.start)).toBe(25 * 3600_000);
});

it("converts local scheduling time to an absolute instant", () => {
  vi.stubEnv("TZ", "Europe/Berlin");
  expect(calendarBlockRange("2026-09-09", "10:00", 60)).toEqual({
    start: "2026-09-09T08:00:00.000Z",
    end: "2026-09-09T09:00:00.000Z",
  });
});

it("rejects nonexistent dates, times, and invalid durations", () => {
  vi.stubEnv("TZ", "Europe/Berlin");
  expect(calendarDayRange("2026-02-30")).toBeNull();
  expect(calendarBlockRange("2026-03-29", "02:30", 60)).toBeNull();
  expect(calendarBlockRange("2026-09-09", "25:00", 60)).toBeNull();
  expect(calendarBlockRange("2026-09-09", "10:00", 0)).toBeNull();
});
