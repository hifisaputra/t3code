import { afterEach, expect, it, vi } from "vite-plus/test";
import { watchCalendarRefresh } from "./useCalendarRefresh";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("refreshes on return and periodically, skips hidden/offline/pending work, and cleans up", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T10:00:00Z"));
  const windowEvents = new EventTarget();
  const documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const network = { onLine: true };
  vi.stubGlobal("window", Object.assign(windowEvents, { setInterval, clearInterval }));
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("navigator", network);
  const request = vi.fn();
  let pending = false;
  const stop = watchCalendarRefresh(request, () => pending);
  vi.advanceTimersByTime(60_000);
  expect(request).toHaveBeenCalledTimes(1);
  windowEvents.dispatchEvent(new Event("focus"));
  expect(request).toHaveBeenCalledTimes(1);
  documentEvents.visibilityState = "hidden";
  vi.advanceTimersByTime(60_000);
  expect(request).toHaveBeenCalledTimes(1);
  documentEvents.visibilityState = "visible";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  expect(request).toHaveBeenCalledTimes(2);
  pending = true;
  vi.advanceTimersByTime(60_000);
  expect(request).toHaveBeenCalledTimes(2);
  pending = false;
  network.onLine = false;
  vi.advanceTimersByTime(60_000);
  expect(request).toHaveBeenCalledTimes(2);
  network.onLine = true;
  windowEvents.dispatchEvent(new Event("online"));
  expect(request).toHaveBeenCalledTimes(3);
  stop();
  vi.advanceTimersByTime(60_000);
  windowEvents.dispatchEvent(new Event("focus"));
  expect(request).toHaveBeenCalledTimes(3);
});
