import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createGoogleCalendarEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "calendar:status",
      tag: WS_METHODS.googleCalendarStatus,
      staleTimeMs: 0,
    }),
    calendars: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "calendar:calendars",
      tag: WS_METHODS.googleCalendarCalendars,
      staleTimeMs: 60_000,
    }),
    events: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "calendar:events",
      tag: WS_METHODS.googleCalendarEvents,
      staleTimeMs: 0,
    }),
    authorize: createEnvironmentRpcCommand(runtime, {
      label: "calendar:authorize",
      tag: WS_METHODS.googleCalendarAuthorize,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "calendar:disconnect",
      tag: WS_METHODS.googleCalendarDisconnect,
    }),
    schedule: createEnvironmentRpcCommand(runtime, {
      label: "calendar:schedule",
      tag: WS_METHODS.googleCalendarSchedule,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "calendar:update",
      tag: WS_METHODS.googleCalendarUpdate,
    }),
  };
}
