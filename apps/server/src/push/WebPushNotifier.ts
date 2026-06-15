/**
 * WebPushNotifier — sends Web Push notifications to subscribed browsers when an
 * agent thread finishes or needs attention.
 *
 * VAPID keys and subscriptions are persisted in the ServerSecretStore. The
 * notifier watches the orchestration event stream, computes per-thread agent
 * awareness (the same logic the cloud relay uses), and pushes on transitions
 * into a terminal (completed/failed) or interruptive (needs approval/input)
 * phase. Delivery is best-effort; gone subscriptions are pruned automatically.
 *
 * @module WebPushNotifier
 */
import * as webpush from "web-push";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type {
  PushStatusResult,
  PushSubscribeResult,
  PushUnsubscribeInput,
  PushUnsubscribeResult,
  ThreadId,
} from "@t3tools/contracts";
import { PushError, PushSubscriptionInput } from "@t3tools/contracts";
import {
  type AgentAwarenessPhase,
  isInterruptiveAgentAwarenessPhase,
  isTerminalAgentAwarenessPhase,
  projectThreadAwareness,
} from "@t3tools/shared/agentAwareness";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { eventThreadId, shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";

const VAPID_SECRET = "t3/webPush/vapidKeys";
const SUBSCRIPTIONS_SECRET = "t3/webPush/subscriptions";
const VAPID_SUBJECT = "mailto:web-push@t3code.local";

const VapidKeys = Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String });
type VapidKeys = typeof VapidKeys.Type;
const VapidKeysJson = Schema.fromJsonString(VapidKeys);
const decodeVapidKeys = Schema.decodeUnknownEffect(VapidKeysJson);
const encodeVapidKeys = Schema.encodeEffect(VapidKeysJson);

const SubscriptionList = Schema.Array(PushSubscriptionInput);
const SubscriptionListJson = Schema.fromJsonString(SubscriptionList);
const decodeSubscriptionList = Schema.decodeUnknownEffect(SubscriptionListJson);
const encodeSubscriptionList = Schema.encodeEffect(SubscriptionListJson);

const PushPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  tag: Schema.String,
});
type PushPayload = typeof PushPayload.Type;
const encodePushPayload = Schema.encodeEffect(Schema.fromJsonString(PushPayload));

export interface WebPushNotifierShape {
  readonly getStatus: () => Effect.Effect<PushStatusResult>;
  readonly subscribe: (
    input: PushSubscriptionInput,
  ) => Effect.Effect<PushSubscribeResult, PushError>;
  readonly unsubscribe: (input: PushUnsubscribeInput) => Effect.Effect<PushUnsubscribeResult>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WebPushNotifier extends Context.Service<WebPushNotifier, WebPushNotifierShape>()(
  "t3/push/WebPushNotifier",
) {}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function notifiablePhase(phase: AgentAwarenessPhase): boolean {
  return isTerminalAgentAwarenessPhase(phase) || isInterruptiveAgentAwarenessPhase(phase);
}

function webNotificationUrl(environmentId: string, threadId: string): string {
  return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function isGoneSubscriptionError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: number }).statusCode;
  return statusCode === 404 || statusCode === 410;
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverEnvironment = yield* ServerEnvironment;

  // Load or generate the VAPID keypair, then register it with web-push.
  const vapidKeys = yield* Effect.gen(function* () {
    const encoded = yield* secrets.get(VAPID_SECRET).pipe(Effect.orElseSucceed(() => null));
    if (encoded !== null) {
      const parsed = yield* decodeVapidKeys(decoder.decode(encoded)).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (parsed !== null) {
        return parsed;
      }
    }
    const generated = yield* Effect.sync(() => webpush.generateVAPIDKeys());
    const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    const serialized = yield* encodeVapidKeys(keys).pipe(Effect.orElseSucceed(() => null));
    if (serialized !== null) {
      yield* secrets
        .set(VAPID_SECRET, encoder.encode(serialized))
        .pipe(Effect.orElseSucceed(() => undefined));
    }
    return keys;
  });
  yield* Effect.sync(() => {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);
    } catch {
      // Invalid keys would only surface on send; ignore here.
    }
  });

  // Subscriptions: in-memory map keyed by endpoint, mirrored to the secret store.
  const loadedSubscriptions = yield* secrets.get(SUBSCRIPTIONS_SECRET).pipe(
    Effect.flatMap((bytes) =>
      bytes === null
        ? Effect.succeed<ReadonlyArray<PushSubscriptionInput>>([])
        : decodeSubscriptionList(decoder.decode(bytes)),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<PushSubscriptionInput>),
  );
  const subscriptionsRef = yield* Ref.make(
    new Map<string, PushSubscriptionInput>(
      loadedSubscriptions.map((subscription) => [subscription.endpoint, subscription]),
    ),
  );
  const lastPhaseByThreadRef = yield* Ref.make(new Map<ThreadId, AgentAwarenessPhase>());

  const persistSubscriptions = Effect.gen(function* () {
    const subscriptions = [...(yield* Ref.get(subscriptionsRef)).values()];
    const serialized = yield* encodeSubscriptionList(subscriptions);
    yield* secrets.set(SUBSCRIPTIONS_SECRET, encoder.encode(serialized));
  });

  const getStatus: WebPushNotifierShape["getStatus"] = () =>
    Effect.succeed({ enabled: true, vapidPublicKey: vapidKeys.publicKey });

  const subscribe: WebPushNotifierShape["subscribe"] = (input) =>
    Effect.gen(function* () {
      yield* Ref.update(subscriptionsRef, (subscriptions) =>
        new Map(subscriptions).set(input.endpoint, input),
      );
      yield* persistSubscriptions;
      return { ok: true };
    }).pipe(
      Effect.mapError(
        (cause) => new PushError({ message: "Failed to store push subscription.", cause }),
      ),
    );

  const unsubscribe: WebPushNotifierShape["unsubscribe"] = (input) =>
    Effect.gen(function* () {
      yield* Ref.update(subscriptionsRef, (subscriptions) => {
        const next = new Map(subscriptions);
        next.delete(input.endpoint);
        return next;
      });
      yield* persistSubscriptions;
      return { ok: true } as const;
    }).pipe(Effect.orElseSucceed(() => ({ ok: true })));

  const removeEndpoints = (endpoints: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (endpoints.length === 0) return;
      yield* Ref.update(subscriptionsRef, (subscriptions) => {
        const next = new Map(subscriptions);
        for (const endpoint of endpoints) {
          next.delete(endpoint);
        }
        return next;
      });
      yield* persistSubscriptions.pipe(Effect.orElseSucceed(() => undefined));
    });

  const sendToAll = (payload: PushPayload) =>
    Effect.gen(function* () {
      const subscriptions = [...(yield* Ref.get(subscriptionsRef)).values()];
      if (subscriptions.length === 0) {
        return;
      }
      const serialized = yield* encodePushPayload(payload).pipe(Effect.orElseSucceed(() => null));
      if (serialized === null) {
        return;
      }
      const goneEndpoints = yield* Effect.forEach(
        subscriptions,
        (subscription) =>
          Effect.promise(() =>
            webpush
              .sendNotification(
                {
                  endpoint: subscription.endpoint,
                  keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
                },
                serialized,
              )
              .then<string | null>(() => null)
              .catch((error: unknown) =>
                isGoneSubscriptionError(error) ? subscription.endpoint : null,
              ),
          ),
        { concurrency: 4 },
      );
      yield* removeEndpoints(
        goneEndpoints.filter((endpoint): endpoint is string => endpoint !== null),
      );
    });

  const notifyForThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const thread = yield* snapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(thread)) {
        return;
      }
      const project = yield* snapshotQuery.getProjectShellById(thread.value.projectId);
      if (Option.isNone(project)) {
        return;
      }
      const state = projectThreadAwareness({
        environmentId,
        project: project.value,
        thread: thread.value,
      });
      if (state === null) {
        return;
      }

      const lastPhaseByThread = yield* Ref.get(lastPhaseByThreadRef);
      const previousPhase = lastPhaseByThread.get(threadId);
      yield* Ref.update(lastPhaseByThreadRef, (phases) =>
        new Map(phases).set(threadId, state.phase),
      );

      if (!notifiablePhase(state.phase) || state.phase === previousPhase) {
        return;
      }

      yield* sendToAll({
        title: state.headline,
        body: state.detail ? `${state.threadTitle} — ${state.detail}` : state.threadTitle,
        url: webNotificationUrl(environmentId, threadId),
        tag: threadId,
      });
    }).pipe(Effect.catchCause(() => Effect.void));

  const start: WebPushNotifierShape["start"] = () =>
    Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = eventThreadId(event);
        if (threadId === null || !shouldPublishAgentAwarenessEvent(event)) {
          return Effect.void;
        }
        return notifyForThread(threadId);
      }),
    ).pipe(Effect.asVoid);

  return { getStatus, subscribe, unsubscribe, start } satisfies WebPushNotifierShape;
});

export const layer = Layer.effect(WebPushNotifier, make);
