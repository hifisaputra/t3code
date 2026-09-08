import type { EnvironmentId, GoogleCalendarEvent } from "@t3tools/contracts";
import { useEffect } from "react";
import { googleCalendarEnvironment as calendar } from "~/state/googleCalendar";
import { useEnvironmentQuery } from "~/state/query";
import { useCalendarRefresh } from "./useCalendarRefresh";
export type Snapshot = {
  refreshedAt: number | null;
  events: readonly GoogleCalendarEvent[];
  error: string | null;
  loading: boolean;
};
export function CalendarFeed({
  environmentId,
  calendarId,
  start,
  end,
  refreshKey,
  report,
}: {
  environmentId: EnvironmentId;
  calendarId: string;
  start: string;
  end: string;
  refreshKey: number;
  report: (key: string, snapshot: Snapshot) => void;
}) {
  const query = useEnvironmentQuery(
    calendar.events({ environmentId, input: { calendarId, start, end } }),
  );
  const refreshedAt = useCalendarRefresh(
    query,
    true,
    JSON.stringify([environmentId, calendarId, start, end]),
  );
  const refresh = query.refresh;
  useEffect(() => {
    if (refreshKey) refresh();
  }, [refreshKey, refresh]);
  useEffect(() => {
    report(JSON.stringify([calendarId, start, end]), {
      refreshedAt,
      events: query.data ?? [],
      error: query.error,
      // Cached events remain usable during background refreshes. Only a first
      // load should introduce loading UI or hide availability suggestions.
      loading: query.data === null && !query.error,
    });
  }, [calendarId, start, end, query.data, query.error, refreshedAt, report]);
  return null;
}
