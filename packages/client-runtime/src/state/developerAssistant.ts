import {
  WS_METHODS,
  type AssistantBoard,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** A detail is only re-read when the board says the issue changed, so it never expires on its own. */
const TASK_DETAIL_IDLE_TTL_MS = 30 * 60_000;

export function getAssistantSetupState(
  projectIds: ReadonlyArray<ProjectId>,
  board: { readonly data: AssistantBoard | null; readonly error: string | null },
) {
  const configured = new Set(board.data?.projects.map((p) => p.config.projectId));
  for (const setup of board.data?.setups ?? []) configured.add(setup.preferences.projectId);
  const availableProjectIds = projectIds.filter((id) => !configured.has(id));
  // Stream atoms keep waiting=true while listening for the next update. Setup
  // needs the first snapshot, not completion of the live subscription.
  const unavailableReason =
    board.error !== null
      ? "connection"
      : board.data === null
        ? "loading"
        : projectIds.length === 0
          ? "no-projects"
          : availableProjectIds.length === 0
            ? "all-configured"
            : null;
  return { availableProjectIds, unavailableReason };
}

export function createDeveloperAssistantAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const board = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "assistant:board",
    tag: WS_METHODS.assistantSubscribe,
  });
  /**
   * When the board last rewrote one issue. A detail request follows this
   * rather than the board itself: the board changes whenever any issue does,
   * and re-reading every open issue for a neighbour's heartbeat is the churn
   * the summaries were meant to avoid.
   */
  const boardTaskStamp = Atom.family((key: string) => {
    const [environmentId, taskId] = JSON.parse(key) as [EnvironmentId, string];
    return Atom.map(board({ environmentId, input: {} }), (result) =>
      AsyncResult.isSuccess(result)
        ? (result.value.tasks.find((task) => task.id === taskId)?.updatedAt ?? null)
        : null,
    );
  });
  const taskStampFor = (environmentId: EnvironmentId, taskId: string) =>
    boardTaskStamp(JSON.stringify([environmentId, taskId]));
  return {
    beginSetup: createEnvironmentRpcCommand(runtime, {
      label: "assistant:setup-begin",
      tag: WS_METHODS.assistantSetupBegin,
    }),
    resolveSetup: createEnvironmentRpcCommand(runtime, {
      label: "assistant:setup-resolve",
      tag: WS_METHODS.assistantSetupResolve,
    }),
    board,
    /**
     * One issue's whole record: the text and evidence the board leaves out.
     * Re-read when the board says the issue changed, and not otherwise, so
     * reading a review costs one request however long it stays open.
     */
    taskDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "assistant:task-detail",
      tag: WS_METHODS.assistantTaskDetail,
      idleTtlMs: TASK_DETAIL_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId, input }) => taskStampFor(environmentId, input.taskId),
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "assistant:configure",
      tag: WS_METHODS.assistantConfigure,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "assistant:control",
      tag: WS_METHODS.assistantControl,
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "assistant:answer",
      tag: WS_METHODS.assistantAnswer,
    }),
    review: createEnvironmentRpcCommand(runtime, {
      label: "assistant:review",
      tag: WS_METHODS.assistantReview,
    }),
    dispatch: createEnvironmentRpcCommand(runtime, {
      label: "assistant:dispatch",
      tag: WS_METHODS.assistantDispatch,
    }),
    setE2eDepth: createEnvironmentRpcCommand(runtime, {
      label: "assistant:set-e2e-depth",
      tag: WS_METHODS.assistantSetE2eDepth,
    }),
    addProjectNote: createEnvironmentRpcCommand(runtime, {
      label: "assistant:add-project-note",
      tag: WS_METHODS.assistantAddProjectNote,
    }),
    deleteProjectNote: createEnvironmentRpcCommand(runtime, {
      label: "assistant:delete-project-note",
      tag: WS_METHODS.assistantDeleteProjectNote,
    }),
  };
}
