import * as NodeCrypto from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export interface McpApprovalRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  readonly turnId?: TurnId;
  /**
   * What an `acceptForSession` grant covers. Two writes from the same provider
   * session share a key; a new session starts asking again.
   */
  readonly sessionKey: string;
  readonly appName: string;
  readonly detail: string;
  readonly args?: unknown;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly timeout?: Duration.Duration;
}

export interface McpApprovalResponse {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly decision: ProviderApprovalDecision;
}

/**
 * Raises approvals for the server's own tools and answers them from the chat
 * UI, by speaking the same `request.opened`/`request.resolved` runtime events a
 * provider adapter emits. Ingestion turns those into the pending-approval
 * projection, so an integration write gets the composer card, the work log
 * entry and the mobile surface for free.
 *
 * The provider adapters never see these requests: `ProviderCommandReactor`
 * offers every approval response here first, and only falls through to the
 * provider when `respond` says the broker did not own it.
 */
export class McpApprovalBroker extends Context.Service<
  McpApprovalBroker,
  {
    /** Merged into the ingestion worker alongside the provider's own event stream. */
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
    /** Suspends until the user answers, the request times out, or the caller goes away. */
    readonly request: (input: McpApprovalRequest) => Effect.Effect<ProviderApprovalDecision>;
    /** True when this broker owned the request, so the caller must not route it onward. */
    readonly respond: (input: McpApprovalResponse) => Effect.Effect<boolean>;
  }
>()("t3/mcp/McpApprovalBroker") {}

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly deferred: Deferred.Deferred<ProviderApprovalDecision>;
}

/**
 * An unanswered request cannot hold the MCP request fiber open forever: the
 * agent's own tool-call timeout would fire first and leave the card stranded.
 */
const DEFAULT_TIMEOUT = Duration.minutes(10);

const DEFAULT_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "accept", label: "Approve" },
];

const grantsSession = (decision: ProviderApprovalDecision): boolean =>
  decision === "acceptForSession" || decision === "acceptAlways";

const nowIso = Effect.map(DateTime.now, (now) => IsoDateTime.make(DateTime.formatIso(now)));

export const make = Effect.gen(function* McpApprovalBrokerMake() {
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const pending = new Map<ApprovalRequestId, PendingApproval>();
  const sessionGrants = new Set<string>();

  const request = Effect.fn("McpApprovalBroker.request")(function* (input: McpApprovalRequest) {
    if (sessionGrants.has(input.sessionKey)) return "acceptForSession" as const;

    // Ids are minted here rather than through `Crypto` so the layer stays
    // dependency-free and can be dropped into the runtime, the routes and a
    // test without dragging platform services along.
    const requestId = ApprovalRequestId.make(NodeCrypto.randomUUID());
    const deferred = yield* Deferred.make<ProviderApprovalDecision>();
    pending.set(requestId, { threadId: input.threadId, deferred });

    const base = {
      provider: input.provider,
      providerInstanceId: input.providerInstanceId,
      threadId: input.threadId,
      requestId: RuntimeRequestId.make(requestId),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    };

    yield* Queue.offer(events, {
      ...base,
      type: "request.opened",
      eventId: EventId.make(NodeCrypto.randomUUID()),
      createdAt: yield* nowIso,
      payload: {
        requestType: "integration_write_approval",
        appName: input.appName,
        detail: input.detail,
        options: input.options ?? DEFAULT_OPTIONS,
        ...(input.args === undefined ? {} : { args: input.args }),
      },
    } satisfies ProviderRuntimeEvent);

    // Every exit — answered, timed out, or interrupted because the agent's HTTP
    // request was aborted — has to resolve the card exactly once, or the thread
    // keeps a pending approval nobody can answer.
    let settled = false;
    const settle = (decision: ProviderApprovalDecision) =>
      Effect.suspend(() => {
        if (settled) return Effect.void;
        settled = true;
        pending.delete(requestId);
        if (grantsSession(decision)) sessionGrants.add(input.sessionKey);
        return nowIso.pipe(
          Effect.flatMap((createdAt) =>
            Queue.offer(events, {
              ...base,
              type: "request.resolved",
              eventId: EventId.make(NodeCrypto.randomUUID()),
              createdAt,
              payload: { requestType: "integration_write_approval", decision },
            } satisfies ProviderRuntimeEvent),
          ),
          Effect.asVoid,
        );
      });

    const decision = yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(input.timeout ?? DEFAULT_TIMEOUT),
      Effect.map(Option.getOrElse((): ProviderApprovalDecision => "cancel")),
      Effect.onInterrupt(() => settle("cancel")),
    );
    yield* settle(decision);
    return decision;
  });

  const respond = Effect.fn("McpApprovalBroker.respond")(function* (input: McpApprovalResponse) {
    const entry = pending.get(input.requestId);
    // A thread mismatch is somebody else's request, not ours to answer.
    if (!entry || entry.threadId !== input.threadId) return false;
    pending.delete(input.requestId);
    return yield* Deferred.succeed(entry.deferred, input.decision);
  });

  return McpApprovalBroker.of({
    streamEvents: Stream.fromQueue(events),
    request,
    respond,
  });
}).pipe(Effect.withSpan("McpApprovalBroker.make"));

export const layer = Layer.effect(McpApprovalBroker, make);
