import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
