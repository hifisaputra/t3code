/**
 * Lists the processes agents left running, and stops them.
 *
 * Provider CLIs are direct children of the server, but anything they start in
 * the background outlives them: when the CLI exits the OS reparents the dev
 * server to init, so the tree no longer connects it to T3. Every provider
 * session is therefore spawned with `T3CODE_THREAD_ID` (see
 * `@t3tools/shared/agentProcessMarker`), which children inherit, and this
 * service finds leftovers by scanning process environments for it.
 *
 * Polling is reference-counted through scoped `retain`, like `PortDiscovery`:
 * the layer-scoped fiber ticks forever but does nothing while no client is
 * watching the list.
 */
import type {
  AgentProcess,
  AgentProcessesSnapshot,
  StopAgentProcessInput,
  StopAgentProcessResult,
} from "@t3tools/contracts";
import { AgentProcessStopError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
// Reading `/proc/<pid>/environ` and `/proc/<pid>/cwd` needs raw filesystem
// access and tolerates EACCES per pid; keeping it on node:fs leaves this
// service depending on `ProcessRunner` alone.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as ProcessRunner from "../processRunner.ts";
import {
  agentProcessesFingerprint,
  buildAgentProcesses,
  parseEnviron,
  parsePsEnvironmentDump,
  parseLsofListeners,
  parsePsTable,
  parseSsListeners,
  selectStopTarget,
  type ProcessTableRow,
} from "./agentProcessModel.ts";
import * as ProviderProcessRegistry from "./ProviderProcessRegistry.ts";

export class AgentProcessTracker extends Context.Service<
  AgentProcessTracker,
  {
    readonly scan: Effect.Effect<AgentProcessesSnapshot>;
    readonly subscribe: (
      input: { readonly initialSnapshot: AgentProcessesSnapshot },
      listener: (snapshot: AgentProcessesSnapshot) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly stop: (
      input: StopAgentProcessInput,
    ) => Effect.Effect<StopAgentProcessResult, AgentProcessStopError>;
  }
>()("t3/agentProcesses/AgentProcessTracker") {}

const POLL_INTERVAL = Duration.seconds(4);
/** Uptime keeps moving even when nothing else does; refresh it this often. */
const MAX_EMIT_INTERVAL_MS = 20_000;
const PROCESS_TABLE_TIMEOUT_MS = 5_000;
const PROCESS_TABLE_MAX_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_DUMP_MAX_BYTES = 8 * 1024 * 1024;
const ENVIRONMENT_READ_CONCURRENCY = 32;
/** `ps -p` takes a pid list; keep each invocation's argument bounded. */
const ENVIRONMENT_DUMP_CHUNK = 128;
const STOP_GRACE_POLL_INTERVAL = Duration.millis(250);
const STOP_GRACE_ATTEMPTS = 20;
const STOP_KILL_ATTEMPTS = 4;

type Listener = (snapshot: AgentProcessesSnapshot) => Effect.Effect<void>;

interface ListenerSubscription {
  readonly fingerprint: string;
  readonly lastEmitAtMillis: number;
}

interface TrackerState {
  readonly listeners: ReadonlyMap<Listener, ListenerSubscription>;
  readonly retainCount: number;
}

const UNSUPPORTED_SNAPSHOT = (generatedAt: string): AgentProcessesSnapshot => ({
  supported: false,
  generatedAt,
  processes: [],
});

/** Kernel threads: `ps` brackets their name and they have no environment. */
const isKernelThread = (row: ProcessTableRow): boolean =>
  row.args.startsWith("[") && row.args.endsWith("]");

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { readonly code?: unknown }).code)
    : undefined;

/** EPERM means the process exists but belongs to someone else. */
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) === "EPERM";
  }
};

const chunk = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

export const make = Effect.gen(function* AgentProcessTrackerMake() {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const serverPid = process.pid;
  const stateRef = yield* Ref.make<TrackerState>({ listeners: new Map(), retainCount: 0 });
  const scanSemaphore = yield* Semaphore.make(1);

  const recoverProbeFailure =
    (probe: "ps" | "ps-environment" | "lsof" | "ss") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("agent process probe failed", {
        cause: error,
        probe,
        platform: hostPlatform,
      }).pipe(Effect.as(null));

  const runProbe = (
    probe: "ps" | "ps-environment" | "lsof" | "ss",
    input: ProcessRunner.ProcessRunInput,
  ): Effect.Effect<string | null> => {
    const recover = recoverProbeFailure(probe);
    return processRunner.run(input).pipe(
      Effect.map((result) => result.stdout),
      Effect.catchTags({
        ProcessSpawnError: recover,
        ProcessStdinError: recover,
        ProcessOutputLimitError: recover,
        ProcessReadError: recover,
        ProcessTimeoutError: recover,
      }),
    );
  };

  const readProcessTable = Effect.fn("AgentProcessTracker.readProcessTable")(function* () {
    const stdout = yield* runProbe("ps", {
      command: "ps",
      args: ["-eo", "pid=,ppid=,pgid=,etimes=,args="],
      timeout: Duration.millis(PROCESS_TABLE_TIMEOUT_MS),
      maxOutputBytes: PROCESS_TABLE_MAX_BYTES,
      outputMode: "truncate",
    });
    return stdout === null ? [] : parsePsTable(stdout);
  });

  const readLinuxEnvironments = Effect.fn("AgentProcessTracker.readLinuxEnvironments")(function* (
    pids: ReadonlyArray<number>,
  ) {
    const entries = yield* Effect.forEach(
      pids,
      (pid) =>
        Effect.promise(() =>
          NodeFSP.readFile(`/proc/${pid}/environ`, "utf8").then(
            (raw) => [pid, parseEnviron(raw)] as const,
            // EACCES (another user's process) and ENOENT (already exited) are
            // the expected outcomes for most of the table.
            () => null,
          ),
        ),
      { concurrency: ENVIRONMENT_READ_CONCURRENCY },
    );
    return new Map(entries.filter((entry) => entry !== null));
  });

  const readMacEnvironments = Effect.fn("AgentProcessTracker.readMacEnvironments")(function* (
    pids: ReadonlyArray<number>,
  ) {
    const byPid = new Map<number, ReadonlyArray<string>>();
    for (const batch of chunk(pids, ENVIRONMENT_DUMP_CHUNK)) {
      const stdout = yield* runProbe("ps-environment", {
        command: "ps",
        args: ["-Eww", "-o", "pid=,command=", "-p", batch.join(",")],
        timeout: Duration.millis(PROCESS_TABLE_TIMEOUT_MS),
        maxOutputBytes: ENVIRONMENT_DUMP_MAX_BYTES,
        outputMode: "truncate",
      });
      if (stdout === null) continue;
      for (const [pid, tokens] of parsePsEnvironmentDump(stdout)) byPid.set(pid, tokens);
    }
    return byPid;
  });

  const readListeningPorts = Effect.fn("AgentProcessTracker.readListeningPorts")(function* () {
    if (hostPlatform === "linux") {
      // `lsof` silently omits some listeners (wildcard IPv6 sockets among
      // them), which would hide the port a leftover dev server is holding.
      const ss = yield* runProbe("ss", {
        command: "ss",
        args: ["-H", "-ltnp"],
        timeout: Duration.millis(PROCESS_TABLE_TIMEOUT_MS),
        maxOutputBytes: PROCESS_TABLE_MAX_BYTES,
        outputMode: "truncate",
      });
      if (ss !== null) return parseSsListeners(ss);
    }
    const stdout = yield* runProbe("lsof", {
      command: "lsof",
      args: ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
      timeout: Duration.millis(PROCESS_TABLE_TIMEOUT_MS),
      maxOutputBytes: PROCESS_TABLE_MAX_BYTES,
      outputMode: "truncate",
    });
    return stdout === null ? new Map<number, ReadonlyArray<number>>() : parseLsofListeners(stdout);
  });

  const readWorkingDirectories = Effect.fn("AgentProcessTracker.readWorkingDirectories")(function* (
    pids: ReadonlyArray<number>,
  ) {
    if (hostPlatform !== "linux") return new Map<number, string>();
    const entries = yield* Effect.forEach(
      pids,
      (pid) =>
        Effect.promise(() =>
          NodeFSP.readlink(`/proc/${pid}/cwd`).then(
            (cwd) => (cwd.trim().length > 0 ? ([pid, cwd.trim()] as const) : null),
            () => null,
          ),
        ),
      { concurrency: ENVIRONMENT_READ_CONCURRENCY },
    );
    return new Map(entries.filter((entry) => entry !== null));
  });

  const scanUnlocked = Effect.fn("AgentProcessTracker.scanUnlocked")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const generatedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
    // Windows has no readable process environments, so a leftover cannot be
    // attributed to a thread at all; the client renders an explanation.
    if (hostPlatform === "win32") return UNSUPPORTED_SNAPSHOT(generatedAt);
    const table = yield* readProcessTable();
    const candidates = table
      .filter((row) => row.pid > 1 && row.pid !== serverPid && !isKernelThread(row))
      .map((row) => row.pid);
    const envByPid =
      hostPlatform === "darwin"
        ? yield* readMacEnvironments(candidates)
        : yield* readLinuxEnvironments(candidates);
    const listeningPortsByPid = yield* readListeningPorts();
    const providerPids = ProviderProcessRegistry.snapshot();
    const processes = buildAgentProcesses({
      table,
      envByPid,
      serverPid,
      providerPids,
      listeningPortsByPid,
      now,
    });
    const cwdByPid = yield* readWorkingDirectories(processes.map((entry) => entry.rootPid));
    return {
      supported: true,
      generatedAt,
      processes: processes.map((entry) => ({
        ...entry,
        cwd: cwdByPid.get(entry.rootPid) ?? null,
      })),
    } satisfies AgentProcessesSnapshot;
  });

  const scanSnapshot = Effect.fn("AgentProcessTracker.scan")(() =>
    scanSemaphore.withPermits(1)(scanUnlocked()),
  );

  const pollTick = Effect.fn("AgentProcessTracker.pollTick")(
    function* () {
      if ((yield* Ref.get(stateRef)).retainCount <= 0) return;
      const snapshot = yield* scanSnapshot();
      const fingerprint = agentProcessesFingerprint(snapshot.processes);
      const now = yield* Clock.currentTimeMillis;
      const notifications = yield* Ref.modify(stateRef, (state) => {
        const listeners = new Map(state.listeners);
        const changed: Array<Listener> = [];
        for (const [listener, subscription] of listeners) {
          const stale = now - subscription.lastEmitAtMillis >= MAX_EMIT_INTERVAL_MS;
          if (subscription.fingerprint === fingerprint && !stale) continue;
          listeners.set(listener, { fingerprint, lastEmitAtMillis: now });
          changed.push(listener);
        }
        return [changed, { ...state, listeners }];
      });
      yield* Effect.forEach(notifications, (listener) => listener(snapshot), { discard: true });
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("agent process scan failed", Cause.pretty(cause)),
    ),
  );

  yield* Effect.forkScoped(pollTick().pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const acquireRetention = Effect.fn("AgentProcessTracker.acquireRetention")(function* () {
    const wasIdle = yield* Ref.modify(stateRef, (state) => [
      state.retainCount === 0,
      { ...state, retainCount: state.retainCount + 1 },
    ]);
    // Existing listeners would otherwise wait a full interval for the first
    // scan after the tracker goes from idle to watched.
    if (wasIdle) yield* pollTick();
  });

  const retain: AgentProcessTracker["Service"]["retain"] = Effect.acquireRelease(
    acquireRetention(),
    () =>
      Ref.update(stateRef, (state) => ({
        ...state,
        retainCount: Math.max(0, state.retainCount - 1),
      })),
  );

  const subscribe: AgentProcessTracker["Service"]["subscribe"] = Effect.fn(
    "AgentProcessTracker.subscribe",
  )((input, listener) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.acquireRelease(
        Ref.update(stateRef, (state) => {
          const listeners = new Map(state.listeners);
          listeners.set(listener, {
            fingerprint: agentProcessesFingerprint(input.initialSnapshot.processes),
            lastEmitAtMillis: now,
          });
          return { ...state, listeners };
        }),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Map(state.listeners);
            listeners.delete(listener);
            return { ...state, listeners };
          }),
      );
    }),
  );

  const signalPid = (
    rootPid: number,
    pid: number,
    signal: "SIGTERM" | "SIGKILL",
  ): Effect.Effect<boolean, AgentProcessStopError> =>
    Effect.suspend(() => {
      try {
        process.kill(pid, signal);
        return Effect.succeed(true);
      } catch (cause) {
        // The process exited between the scan and the signal; nothing to do.
        if (errorCode(cause) === "ESRCH") return Effect.succeed(false);
        return Effect.fail(
          new AgentProcessStopError({
            rootPid,
            message: `Failed to send ${signal} to process ${pid}: ${
              errorCode(cause) ?? "unknown error"
            }`,
          }),
        );
      }
    });

  const signalChain = (
    target: AgentProcess,
    pids: ReadonlyArray<number>,
    signal: "SIGTERM" | "SIGKILL",
  ): Effect.Effect<ReadonlyArray<number>, AgentProcessStopError> =>
    Effect.forEach(pids, (pid) =>
      signalPid(target.rootPid, pid, signal).pipe(Effect.map((sent) => (sent ? pid : null))),
    ).pipe(Effect.map((results) => results.filter((pid) => pid !== null)));

  const awaitExit = (
    pids: ReadonlyArray<number>,
    attempts: number,
  ): Effect.Effect<ReadonlyArray<number>> =>
    Effect.gen(function* () {
      let survivors = pids.filter(isProcessAlive);
      for (let attempt = 0; attempt < attempts && survivors.length > 0; attempt += 1) {
        yield* Effect.sleep(STOP_GRACE_POLL_INTERVAL);
        survivors = survivors.filter(isProcessAlive);
      }
      return survivors;
    });

  const stop: AgentProcessTracker["Service"]["stop"] = Effect.fn("AgentProcessTracker.stop")(
    function* (input: StopAgentProcessInput) {
      const snapshot = yield* scanSnapshot();
      const target = selectStopTarget(snapshot.processes, input);
      if (target === null) {
        // Either the chain exited on its own or the pid was reused; both mean
        // the list the client acted on is out of date.
        return { rootPid: input.rootPid, signaled: [], survivors: [], stale: true };
      }
      const providerPids = ProviderProcessRegistry.snapshot();
      const chain = [target.rootPid, ...target.pids.filter((pid) => pid !== target.rootPid)].filter(
        (pid) => pid > 1 && pid !== serverPid && !providerPids.has(pid),
      );
      const signaled = yield* signalChain(
        target,
        chain,
        input.force === true ? "SIGKILL" : "SIGTERM",
      );
      if (input.force === true) {
        return {
          rootPid: target.rootPid,
          signaled,
          survivors: yield* awaitExit(chain, STOP_KILL_ATTEMPTS),
          stale: false,
        };
      }
      const graceSurvivors = yield* awaitExit(chain, STOP_GRACE_ATTEMPTS);
      if (graceSurvivors.length === 0) {
        return { rootPid: target.rootPid, signaled, survivors: [], stale: false };
      }
      yield* signalChain(target, graceSurvivors, "SIGKILL");
      return {
        rootPid: target.rootPid,
        signaled,
        survivors: yield* awaitExit(graceSurvivors, STOP_KILL_ATTEMPTS),
        stale: false,
      };
    },
  );

  return AgentProcessTracker.of({ scan: scanSnapshot(), subscribe, retain, stop });
}).pipe(Effect.withSpan("AgentProcessTracker.make"));

export const layer = Layer.effect(AgentProcessTracker, make);
