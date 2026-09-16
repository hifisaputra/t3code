/**
 * Multi-environment view of the processes agents left running.
 *
 * Every connected environment pushes its own snapshot; the client flattens
 * them and attaches the thread and project each chain came from, so the page
 * and the thread banner read the same list. Nothing here polls: the atom is a
 * server-push subscription and the sidebar badge is what keeps it open.
 *
 * @module state/agentProcesses
 */
import { useAtomValue } from "@effect/atom-react";
import type { AgentProcess, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import type { AgentProcessEntry } from "../components/processes/agentProcessesModel";
import { useProjects, useThreadShells } from "./entities";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

interface EnvironmentAgentProcesses {
  readonly environmentId: EnvironmentId;
  readonly supported: boolean;
  readonly processes: ReadonlyArray<AgentProcess>;
}

const EMPTY_PROCESSES: ReadonlyArray<AgentProcess> = [];

const agentProcessesAtom = Atom.make((get): ReadonlyArray<EnvironmentAgentProcesses> => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const snapshots: EnvironmentAgentProcesses[] = [];
  for (const environmentId of presentations.keys()) {
    const result = get(serverEnvironment.agentProcesses({ environmentId, input: {} }));
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    // An environment that has not answered yet contributes nothing rather than
    // an empty list, so "no processes" never flickers on a slow connection.
    if (snapshot === null) continue;
    snapshots.push({
      environmentId,
      supported: snapshot.supported,
      processes: snapshot.processes,
    });
  }
  return snapshots;
}).pipe(Atom.withLabel("web-agent-processes"));

/** Total running chains across every environment, for the sidebar badge. */
const agentProcessCountAtom = Atom.make((get): number => {
  let count = 0;
  for (const snapshot of get(agentProcessesAtom)) count += snapshot.processes.length;
  return count;
}).pipe(Atom.withLabel("web-agent-processes:count"));

export function useAgentProcessCount(): number {
  return useAtomValue(agentProcessCountAtom);
}

export interface AgentProcessesView {
  readonly entries: ReadonlyArray<AgentProcessEntry>;
  /** Environments that cannot read process environments, such as Windows. */
  readonly unsupportedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

export function useAgentProcesses(): AgentProcessesView {
  const snapshots = useAtomValue(agentProcessesAtom);
  const threadShells = useThreadShells();
  const projects = useProjects();

  const threadsByKey = useMemo(
    () => new Map(threadShells.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threadShells],
  );
  const projectsByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );

  return useMemo(() => {
    const entries: AgentProcessEntry[] = [];
    const unsupportedEnvironmentIds: EnvironmentId[] = [];
    for (const snapshot of snapshots) {
      if (!snapshot.supported) {
        unsupportedEnvironmentIds.push(snapshot.environmentId);
        continue;
      }
      for (const process of snapshot.processes) {
        const thread =
          process.threadId === null
            ? null
            : (threadsByKey.get(`${snapshot.environmentId}:${process.threadId}`) ?? null);
        const project =
          thread === null
            ? null
            : (projectsByKey.get(`${snapshot.environmentId}:${thread.projectId}`) ?? null);
        entries.push({ environmentId: snapshot.environmentId, process, thread, project });
      }
    }
    return { entries, unsupportedEnvironmentIds };
  }, [projectsByKey, snapshots, threadsByKey]);
}

/**
 * The chains one thread started, for its composer banner. Reads the same
 * subscription as the page, so opening a thread costs no extra server work.
 */
export function useThreadAgentProcesses(
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
): ReadonlyArray<AgentProcess> {
  const snapshots = useAtomValue(agentProcessesAtom);
  const environmentId = target?.environmentId ?? null;
  const threadId = target?.threadId ?? null;
  return useMemo(() => {
    if (environmentId === null || threadId === null) return EMPTY_PROCESSES;
    const snapshot = snapshots.find((candidate) => candidate.environmentId === environmentId);
    if (snapshot === undefined || !snapshot.supported) return EMPTY_PROCESSES;
    const matches = snapshot.processes.filter((process) => process.threadId === threadId);
    return matches.length === 0 ? EMPTY_PROCESSES : matches;
  }, [environmentId, snapshots, threadId]);
}
