import { WS_METHODS, type AssistantBoard, type ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function getAssistantSetupState(
  projectIds: ReadonlyArray<ProjectId>,
  board: { readonly data: AssistantBoard | null; readonly error: string | null },
) {
  const configured = new Set(board.data?.projects.map((p) => p.config.projectId));
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
  return {
    board: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "assistant:board",
      tag: WS_METHODS.assistantSubscribe,
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
  };
}
