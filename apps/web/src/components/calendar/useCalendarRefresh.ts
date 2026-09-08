import { useEffect, useRef, useState } from "react";
import type { EnvironmentQueryView } from "~/state/query";

/** Refresh visible calendars without interrupting drafts or overlapping requests. */
export function useCalendarRefresh<A>(
  query: EnvironmentQueryView<A>,
  enabled: boolean,
  key: string,
) {
  const latest = useRef(query);
  useEffect(() => {
    latest.current = query;
  }, [query]);
  const [success, setSuccess] = useState<{ key: string; time: number } | null>(null);
  useEffect(() => {
    if (enabled && query.data !== null && !query.isPending && !query.error) {
      // Record a successful external query result, retaining its time through failures.
      // eslint-disable-next-line react/set-state-in-effect
      setSuccess({ key, time: Date.now() });
    }
  }, [enabled, key, query.data, query.isPending, query.error]);
  useEffect(() => {
    if (!enabled) return;
    return watchCalendarRefresh(
      () => latest.current.refresh(),
      () => latest.current.isPending,
    );
  }, [enabled]);
  return success?.key === key ? success.time : null;
}

export function useCalendarNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}

export function calendarSyncLabel(time: number | null) {
  return time
    ? `Last refreshed ${new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "Waiting for calendar data";
}

export function watchCalendarRefresh(request: () => void, isPending: () => boolean) {
  let lastRequest = 0;
  const refresh = () => {
    if (document.visibilityState === "hidden" || !navigator.onLine || isPending()) return;
    const now = Date.now();
    if (now - lastRequest < 5_000) return;
    lastRequest = now;
    request();
  };
  const timer = window.setInterval(refresh, 60_000);
  window.addEventListener("focus", refresh);
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("online", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}
