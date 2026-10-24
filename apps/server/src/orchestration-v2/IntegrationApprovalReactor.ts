import {
  ApprovalRequestId,
  CommandId,
  type OrchestrationV2DomainEvent,
  ProviderApprovalDecision,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { McpApprovalBroker } from "../mcp/McpApprovalBroker.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

const isApprovalDecision = Schema.is(ProviderApprovalDecision);

/**
 * Fork: connects `McpApprovalBroker` to orchestration. The broker's opened and
 * resolved events become `integration_approval.record` commands, so the
 * approval shows as an `approval_request` turn item and the thread's pending
 * request. When the user answers, `runtime-request.respond` settles the
 * request in orchestration and this hands the decision to the broker, which
 * releases the waiting tool call.
 */
export class IntegrationApprovalReactor extends Context.Service<
  IntegrationApprovalReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handleBrokerEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    readonly handleDomainEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/IntegrationApprovalReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const broker = yield* McpApprovalBroker;

  const handleBrokerEvent: IntegrationApprovalReactor["Service"]["handleBrokerEvent"] =
    Effect.fnUntraced(
      function* (event) {
        if (event.type === "request.opened") {
          if (event.payload.requestType !== "integration_write_approval") return;
          if (event.requestId === undefined || event.providerInstanceId === undefined) return;
          yield* engine.dispatch({
            type: "integration_approval.record",
            commandId: CommandId.make(`server:integration-approval:${event.requestId}:open`),
            threadId: event.threadId,
            requestId: event.requestId,
            providerInstanceId: event.providerInstanceId,
            appName: event.payload.appName ?? "Integration",
            detail: event.payload.detail ?? "",
            ...(event.payload.options === undefined ? {} : { options: event.payload.options }),
            ...(event.payload.change === undefined ? {} : { change: event.payload.change }),
          });
          return;
        }
        if (event.type !== "request.resolved") return;
        if (event.payload.requestType !== "integration_write_approval") return;
        if (event.requestId === undefined || event.providerInstanceId === undefined) return;
        const decision = event.payload.decision;
        yield* engine.dispatch({
          type: "integration_approval.record",
          commandId: CommandId.make(`server:integration-approval:${event.requestId}:resolve`),
          threadId: event.threadId,
          requestId: event.requestId,
          providerInstanceId: event.providerInstanceId,
          appName: "",
          detail: "",
          decision: isApprovalDecision(decision) ? decision : "cancel",
        });
      },
      (effect, event) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("recording an integration approval failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
    );

  const handleDomainEvent: IntegrationApprovalReactor["Service"]["handleDomainEvent"] = (event) => {
    if (
      event.type !== "runtime-request.updated" ||
      event.payload.kind !== "integration" ||
      event.payload.status !== "resolved" ||
      event.payload.decision === undefined
    ) {
      return Effect.void;
    }
    // The broker ignores requests it no longer holds: its own settlement and
    // answers to a request whose wait already ended both land here too.
    return broker
      .respond({
        threadId: event.threadId,
        requestId: ApprovalRequestId.make(event.payload.id),
        decision: event.payload.decision,
      })
      .pipe(Effect.asVoid);
  };

  const start: IntegrationApprovalReactor["Service"]["start"] = () =>
    Effect.all(
      [
        forkParked(Stream.runForEach(broker.streamEvents, handleBrokerEvent)),
        forkParked(
          Stream.runForEach(engine.streamDomainEvents, handleDomainEvent).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("integration approval event stream failed", { cause }),
            ),
          ),
        ),
      ],
      { discard: true },
    );

  return {
    start,
    handleBrokerEvent,
    handleDomainEvent,
  } satisfies IntegrationApprovalReactor["Service"];
});

export const layer = Layer.effect(IntegrationApprovalReactor, make);
