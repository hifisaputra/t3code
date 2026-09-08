import { useState } from "react";
import {
  defaultPlanningHours,
  readPlanningHours,
  type PlanningHours,
} from "./calendarAvailability";

export interface CalendarPreferences {
  writeCalendarId: string;
  overlayIds: string[];
  minutes: number;
  ignoredConflictIds: string[];
  planningHours: PlanningHours;
}
const defaults: CalendarPreferences = {
  writeCalendarId: "",
  overlayIds: [],
  minutes: 60,
  ignoredConflictIds: [],
  planningHours: defaultPlanningHours,
};
export function readCalendarPreferences(environmentId: string): CalendarPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(`t3.calendar.${environmentId}`) ?? "null");
    if (!value || typeof value !== "object") return defaults;
    return {
      planningHours: readPlanningHours(value.planningHours),
      writeCalendarId: typeof value.writeCalendarId === "string" ? value.writeCalendarId : "",
      overlayIds: Array.isArray(value.overlayIds)
        ? value.overlayIds
            .filter((id: unknown): id is string => typeof id === "string")
            .slice(0, 20)
        : [],
      ignoredConflictIds: Array.isArray(value.ignoredConflictIds)
        ? value.ignoredConflictIds
            .filter((id: unknown): id is string => typeof id === "string")
            .slice(0, 100)
        : [],
      minutes:
        Number.isInteger(value.minutes) && value.minutes >= 5 && value.minutes <= 1440
          ? value.minutes
          : 60,
    };
  } catch {
    return defaults;
  }
}

// Callers are keyed by environment so preferences never cross server boundaries.
export function useCalendarPreferences(environmentId: string) {
  const [preferences, setPreferences] = useState(() => readCalendarPreferences(environmentId));
  const save = (patch: Partial<CalendarPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(`t3.calendar.${environmentId}`, JSON.stringify(next));
      } catch {
        /* Keep this visit usable when storage is denied. */
      }
      return next;
    });
  };
  return [preferences, save] as const;
}
