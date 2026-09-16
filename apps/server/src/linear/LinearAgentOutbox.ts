import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LinearOperationError } from "@t3tools/contracts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { LinearAgentApi, type ExternalLink, type PlanStep } from "./LinearAgentApi.ts";
import { LinearOAuth } from "./LinearOAuth.ts";

export type { AgentActivityContent, ExternalLink, PlanStep } from "./LinearAgentApi.ts";

const Link = Schema.Struct({ label: Schema.String, url: Schema.String });
export const OutboxContent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["thought", "elicitation", "response", "error"]),
    body: Schema.String,
    ephemeral: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("action"),
    action: Schema.String,
    parameter: Schema.String,
    result: Schema.optional(Schema.String),
    ephemeral: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("links"), links: Schema.Array(Link) }),
  // Resolved when sent, so a retry pushes the task's current plan and links.
  Schema.Struct({ type: Schema.Literal("syncTask"), taskId: Schema.String }),
]);
export type OutboxContent = typeof OutboxContent.Type;
export type TaskSync = {
  readonly plan: ReadonlyArray<PlanStep>;
  readonly links: ReadonlyArray<ExternalLink>;
};
/** Returns null when the task has nothing to show (the sync row is then marked sent). */
export type TaskSyncResolver = (taskId: string) => Effect.Effect<TaskSync | null, Error>;
/** A person's reply or stop on a team's session; `deliveryId` makes a repeat a no-op. */
export type TeamPromptInput = {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly body: string;
  readonly signal: string | null;
};
export type TeamPromptHandler = (input: TeamPromptInput) => Effect.Effect<void, Error>;

const encodeContent = Schema.encodeEffect(Schema.fromJsonString(OutboxContent));
const decodeContent = Schema.decodeUnknownEffect(Schema.fromJsonString(OutboxContent));
const isLinearOperationError = Schema.is(LinearOperationError);
const failure = (detail: string) => new LinearOperationError({ operation: "agentSession", detail });

export const LinearAgentOutboxWorkers = Context.Reference<boolean>("t3/linear/outboxWorkers", {
  defaultValue: () => true,
});

export const make = Effect.gen(function* () {
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const oauth = yield* LinearOAuth;
  const api = yield* LinearAgentApi;
  const sendLock = yield* Semaphore.make(1);
  const creationLock = yield* Semaphore.make(1);
  const sessions = yield* Queue.unbounded<string>();
  let resolver: TaskSyncResolver | undefined;
  let teamPromptHandler: TeamPromptHandler | undefined;

  /**
   * Stores an update and returns without waiting for Linear. `id` is an idempotency key;
   * a `syncTask` ignores it and uses `sync:<sessionId>`, moved to the end and re-armed.
   */
  const enqueue = Effect.fn("LinearAgentOutbox.enqueue")(
    function* (id: string, sessionId: string, content: OutboxContent) {
      const payload = yield* encodeContent(content);
      if (content.type === "syncTask")
        yield* sql`INSERT OR REPLACE INTO linear_agent_outbox (id, session_id, payload, sent) VALUES (${`sync:${sessionId}`}, ${sessionId}, ${payload}, 0)`;
      else
        yield* sql`INSERT OR IGNORE INTO linear_agent_outbox (id, session_id, payload) VALUES (${id}, ${sessionId}, ${payload})`;
      yield* Queue.offer(sessions, sessionId);
    },
    Effect.mapError(() => failure("Could not queue the Linear update.")),
  );

  const deliver = Effect.fn("LinearAgentOutbox.deliver")(function* (
    sessionId: string,
    content: OutboxContent,
  ) {
    if (content.type === "links")
      return yield* api.update(sessionId, { addedExternalUrls: content.links });
    if (content.type === "syncTask") {
      if (!resolver) return yield* failure("Task updates for Linear are not ready yet.");
      const state = yield* resolver(content.taskId).pipe(
        Effect.mapError(() => failure("Could not read the task for its Linear session.")),
      );
      if (!state) return;
      return yield* api.update(sessionId, {
        plan: state.plan,
        ...(state.links.length ? { addedExternalUrls: state.links } : {}),
      });
    }
    return yield* api.activity(sessionId, content, content.ephemeral);
  });

  /**
   * Sends a session's unsent updates oldest first and stops at the first failure, so a
   * retry never lands an older update after a newer one. Rows are marked by rowid: a sync
   * re-armed while it was being sent is a new row and stays unsent.
   */
  const send = Effect.fn("LinearAgentOutbox.send")(
    function* (sessionId: string) {
      const rows = yield* sql<{
        rowid: number;
        payload: string;
      }>`SELECT rowid, payload FROM linear_agent_outbox WHERE session_id = ${sessionId} AND sent = 0 ORDER BY rowid`;
      for (const row of rows) {
        yield* deliver(sessionId, yield* decodeContent(row.payload));
        yield* sql`UPDATE linear_agent_outbox SET sent = 1 WHERE rowid = ${row.rowid}`;
      }
    },
    Effect.mapError((error) =>
      isLinearOperationError(error) ? error : failure("Could not send the Linear update."),
    ),
    sendLock.withPermits(1),
  );

  const offerPending = Effect.gen(function* () {
    const rows = yield* sql<{
      session_id: string;
    }>`SELECT session_id FROM linear_agent_outbox WHERE sent = 0 GROUP BY session_id ORDER BY MIN(rowid)`;
    for (const row of rows) yield* Queue.offer(sessions, row.session_id);
  });

  const setTaskSync = (next: TaskSyncResolver) =>
    Effect.sync(() => {
      resolver = next;
    }).pipe(
      Effect.andThen(offerPending),
      Effect.catch(() => Effect.logWarning("Could not re-offer pending Linear updates.")),
    );

  /**
   * The assistant answers replies on its teams' sessions. Registered here, like the
   * task sync, so delegation reaches the assistant without depending on it.
   */
  const setTeamPrompt = (next: TeamPromptHandler) =>
    Effect.sync(() => {
      teamPromptHandler = next;
    });
  /** Fails until the assistant registered, so the delivery stays pending and is retried. */
  const teamPrompt = (input: TeamPromptInput) =>
    Effect.suspend(() =>
      teamPromptHandler
        ? teamPromptHandler(input)
        : Effect.fail(failure("Replies to teams are not ready yet.")),
    );

  /** The app is connected and delegation is on, so session updates can be sent. */
  const connected = Effect.all([oauth.status, settings.getSettings]).pipe(
    Effect.map(([status, all]) => status.connected && all.linear.delegation.enabled),
    Effect.orElseSucceed(() => false),
  );

  /**
   * Linear sends a `created` webhook for every session the app creates. The row is written
   * before the lock is released, so the receiver (under `withCreationLock`) can tell it apart
   * from a delegation.
   */
  const withCreationLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    creationLock.withPermits(1)(effect);

  const createSession = Effect.fn("LinearAgentOutbox.createSession")(function* (
    issueId: string,
    taskId: string,
  ) {
    const id = yield* api.createOnIssue(issueId);
    yield* sql`INSERT INTO linear_agent_sessions (id, issue_id, thread_id, status, context, task_id, updated_at) VALUES (${id}, ${issueId}, NULL, 'active', '{}', ${taskId}, ${yield* Clock.currentTimeMillis})`.pipe(
      Effect.mapError(() => failure("Could not record the new Linear agent session.")),
    );
    return id;
  }, withCreationLock);

  const threadLink = (threadId: string, label = "T3 Code thread") =>
    settings.getSettings.pipe(
      Effect.map((all): ExternalLink | null => {
        const url = all.linear.delegation.publicUrl.trim().replace(/\/$/, "");
        return url
          ? {
              label,
              url: `${url}/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
            }
          : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  const service = {
    enqueue,
    send,
    setTaskSync,
    setTeamPrompt,
    teamPrompt,
    connected,
    createSession,
    withCreationLock,
    threadLink,
  };
  if (!(yield* LinearAgentOutboxWorkers)) return service;

  yield* Queue.take(sessions).pipe(
    Effect.flatMap((sessionId) =>
      send(sessionId).pipe(
        Effect.catch(() =>
          Effect.logWarning("Linear update pending; it will be retried automatically."),
        ),
      ),
    ),
    Effect.forever,
    forkParked,
  );
  const recover = Effect.gen(function* () {
    if (!(yield* oauth.status).connected) return;
    yield* offerPending;
  });
  yield* recover;
  yield* recover.pipe(
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.catch(() => Effect.logWarning("Linear update recovery paused until restart.")),
    forkParked,
  );
  return service;
});
export class LinearAgentOutbox extends Context.Service<
  LinearAgentOutbox,
  Effect.Success<typeof make>
>()("t3/linear/LinearAgentOutbox") {}
export const layer = Layer.effect(LinearAgentOutbox, make);
