import { Schema } from "effect";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Processes an agent started and left running: dev servers, watchers, build
 * loops. Every provider session is spawned with a thread marker in its
 * environment (see `@t3tools/shared/agentProcessMarker`), and everything the
 * agent launches inherits it, so a leftover keeps pointing at its thread even
 * after the provider CLI is gone and the OS has reparented it. One entry is
 * the root of one command chain (for example `pnpm dev` with the `next dev`
 * it spawned underneath); `pids` lists the whole chain so a stop can take all
 * of it down together.
 */
export const AgentProcessPort = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThan(65536),
);

export const AgentProcess = Schema.Struct({
  /** Pid of the chain root: the process the agent's shell launched. */
  rootPid: PositiveInt,
  /** Process group of the root when the platform reports one. */
  pgid: Schema.NullOr(PositiveInt),
  /**
   * Thread the marker names. Null for a leftover from a session started
   * before the marker existed, recognised by the provider's own environment
   * (Claude Code's sdk entrypoint plus the server's T3CODE variables) when
   * the provider session id could not be mapped back to a thread.
   */
  threadId: Schema.NullOr(ThreadId),
  /** Provider-side session id found in the environment, when any. */
  providerSessionId: Schema.NullOr(TrimmedNonEmptyString),
  /** Full command line of the root, truncated by the server. */
  command: TrimmedNonEmptyString,
  /** Working directory of the root when readable. */
  cwd: Schema.NullOr(TrimmedNonEmptyString),
  /** ISO timestamp derived from the process start; used to detect pid reuse. */
  startedAt: Schema.String,
  uptimeMs: NonNegativeInt,
  /**
   * True when the provider CLI that spawned the chain is gone and the OS
   * reparented it. Orphans are always leftovers; non-orphans may still be a
   * transient command from a running turn.
   */
  orphaned: Schema.Boolean,
  /** TCP ports any process in the chain is listening on, ascending. */
  listeningPorts: Schema.Array(AgentProcessPort),
  /** Every pid in the chain including the root. */
  pids: Schema.Array(PositiveInt),
});
export type AgentProcess = typeof AgentProcess.Type;

export const AgentProcessesSnapshot = Schema.Struct({
  /** False when the platform cannot read process environments (Windows). */
  supported: Schema.Boolean,
  generatedAt: Schema.String,
  processes: Schema.Array(AgentProcess),
});
export type AgentProcessesSnapshot = typeof AgentProcessesSnapshot.Type;

export const StopAgentProcessInput = Schema.Struct({
  rootPid: PositiveInt,
  /** Must match the listed `startedAt`; a mismatch means the pid was reused. */
  startedAt: Schema.String,
  /** Skip the graceful phase and SIGKILL immediately. */
  force: Schema.optional(Schema.Boolean),
});
export type StopAgentProcessInput = typeof StopAgentProcessInput.Type;

export const StopAgentProcessResult = Schema.Struct({
  rootPid: PositiveInt,
  /** Pids that received a signal. Empty when the chain was already gone. */
  signaled: Schema.Array(PositiveInt),
  /** Pids still alive after the kill phase. */
  survivors: Schema.Array(PositiveInt),
  /** The chain listed under this pid no longer exists (exited or pid reused). */
  stale: Schema.Boolean,
});
export type StopAgentProcessResult = typeof StopAgentProcessResult.Type;

export class AgentProcessStopError extends Schema.TaggedErrorClass<AgentProcessStopError>()(
  "AgentProcessStopError",
  {
    rootPid: PositiveInt,
    message: Schema.String,
  },
) {}
