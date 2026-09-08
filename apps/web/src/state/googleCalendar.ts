import { createGoogleCalendarEnvironmentAtoms } from "@t3tools/client-runtime/state/googleCalendar";
import { connectionAtomRuntime } from "../connection/runtime";

export const googleCalendarEnvironment =
  createGoogleCalendarEnvironmentAtoms(connectionAtomRuntime);
