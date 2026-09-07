import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

/**
 * Reads of the server's Linear connection. Every call is made by the server
 * with the key it holds, so these atoms are keyed by environment and carry no
 * credential of their own.
 *
 * Nothing polls: a personal API key and the workspace behind it change only
 * when somebody changes them, and issues move on Linear's clock rather than
 * ours. Settings and the issue pickers refresh explicitly instead, and the
 * minute of staleness keeps reopening a picker from spending a request.
 */
export function createLinearEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:status",
      tag: WS_METHODS.linearStatus,
      staleTimeMs: 60_000,
    }),
    /**
     * Teams and their projects, for the repository mapping picker. A workspace
     * gains a team or a project rarely, so a reopened picker reuses the answer
     * rather than asking again.
     */
    workspace: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:workspace",
      tag: WS_METHODS.linearWorkspace,
      staleTimeMs: 5 * 60_000,
    }),
    issues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:issues",
      tag: WS_METHODS.linearListIssues,
      staleTimeMs: 60_000,
    }),
    issue: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:issue",
      tag: WS_METHODS.linearGetIssue,
      staleTimeMs: 60_000,
    }),
    /**
     * Checks out the issue's own branch. It touches the working tree, so it
     * shares the git command lane with the other VCS mutations rather than
     * racing a checkout the user started elsewhere.
     */
    prepareIssueThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:prepare-issue-thread",
      tag: WS_METHODS.linearPrepareIssueThread,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
