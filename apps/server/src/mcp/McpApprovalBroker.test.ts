import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpApprovalBroker from "./McpApprovalBroker.ts";

const threadId = ThreadId.make("thread-approval-broker");
const otherThreadId = ThreadId.make("thread-somebody-else");

const write = {
  threadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  provider: ProviderDriverKind.make("codex"),
  sessionKey: "thread-approval-broker:provider-session-1",
  appName: "Linear",
  detail: "Comment on DEL-123\n\nShipped it.",
} as const;

/** The next event the broker emits; the queue buffers, so this never races the request. */
const nextEvent = (broker: McpApprovalBroker.McpApprovalBroker["Service"]) =>
  Stream.runCollect(Stream.take(broker.streamEvents, 1)).pipe(
    Effect.map(([event]) => event as ProviderRuntimeEvent),
  );

const requestIdOf = (event: ProviderRuntimeEvent) =>
  ApprovalRequestId.make(String(event.requestId));

it.effect("raises an approval and resolves it with the user's decision", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* McpApprovalBroker.make;
      const pending = yield* Effect.forkScoped(broker.request(write));

      const opened = yield* nextEvent(broker);
      assert.strictEqual(opened.type, "request.opened");
      assert.deepStrictEqual(opened.payload, {
        requestType: "integration_write_approval",
        appName: "Linear",
        detail: write.detail,
        options: [
          { decision: "decline", label: "Decline" },
          { decision: "acceptForSession", label: "Allow for this session" },
          { decision: "accept", label: "Approve" },
        ],
      });

      assert.isTrue(
        yield* broker.respond({
          threadId,
          requestId: requestIdOf(opened),
          decision: "accept",
        }),
      );

      assert.strictEqual(yield* Fiber.join(pending), "accept");
      const resolved = yield* nextEvent(broker);
      assert.strictEqual(resolved.type, "request.resolved");
      assert.strictEqual(resolved.requestId, opened.requestId);
      assert.deepStrictEqual(resolved.payload, {
        requestType: "integration_write_approval",
        decision: "accept",
      });
    }),
  ),
);

it.effect("declines to answer requests it does not own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* McpApprovalBroker.make;
      assert.isFalse(
        yield* broker.respond({
          threadId,
          requestId: ApprovalRequestId.make("never-issued"),
          decision: "accept",
        }),
      );

      yield* Effect.forkScoped(broker.request(write));
      const opened = yield* nextEvent(broker);
      // Same id, wrong thread: not this thread's approval to answer.
      assert.isFalse(
        yield* broker.respond({
          threadId: otherThreadId,
          requestId: requestIdOf(opened),
          decision: "accept",
        }),
      );
    }),
  ),
);

it.effect("stops asking for the rest of a session the user allowed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* McpApprovalBroker.make;
      const first = yield* Effect.forkScoped(broker.request(write));
      const opened = yield* nextEvent(broker);
      yield* broker.respond({
        threadId,
        requestId: requestIdOf(opened),
        decision: "acceptForSession",
      });
      assert.strictEqual(yield* Fiber.join(first), "acceptForSession");

      // Nothing answers this one: it only completes because the grant
      // short-circuits it before any approval is raised.
      assert.strictEqual(yield* broker.request(write), "acceptForSession");

      const resolved = yield* nextEvent(broker);
      assert.strictEqual(resolved.type, "request.resolved");
      assert.strictEqual(resolved.requestId, opened.requestId);
    }),
  ),
);

it.effect("cancels the approval when the caller goes away", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* McpApprovalBroker.make;
      const pending = yield* Effect.forkScoped(broker.request(write));
      const opened = yield* nextEvent(broker);

      yield* Fiber.interrupt(pending);

      const resolved = yield* nextEvent(broker);
      assert.strictEqual(resolved.type, "request.resolved");
      assert.deepStrictEqual(resolved.payload, {
        requestType: "integration_write_approval",
        decision: "cancel",
      });
      // The entry is gone, so a late answer falls through to the provider.
      assert.isFalse(
        yield* broker.respond({
          threadId,
          requestId: requestIdOf(opened),
          decision: "accept",
        }),
      );
    }),
  ),
);

it.effect("cancels the approval when nobody answers in time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* McpApprovalBroker.make;
      const pending = yield* Effect.forkScoped(
        broker.request({ ...write, timeout: Duration.minutes(10) }),
      );
      yield* nextEvent(broker);

      yield* TestClock.adjust(Duration.minutes(11));

      assert.strictEqual(yield* Fiber.join(pending), "cancel");
      const resolved = yield* nextEvent(broker);
      assert.deepStrictEqual(resolved.payload, {
        requestType: "integration_write_approval",
        decision: "cancel",
      });
    }),
  ),
);
