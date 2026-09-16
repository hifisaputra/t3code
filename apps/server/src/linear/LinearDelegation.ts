import { forkParked } from "../serverActivation.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  UserInputQuestion,
  CommandId,
  MessageId,
  ThreadId,
  ApprovalRequestId,
  LinearOperationError,
  resolveLinearRepositoryMapping,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import { LinearOAuth } from "./LinearOAuth.ts";
import { LinearAgentOutbox } from "./LinearAgentOutbox.ts";
import { LinearApi, LinearAppCredential } from "./LinearApi.ts";
import { LinearThreadService } from "./LinearThreadService.ts";

export const AgentEvent = Schema.Struct({
  type: Schema.Literal("AgentSessionEvent"),
  action: Schema.Literals(["created", "prompted"]),
  webhookTimestamp: Schema.Number,
  organizationId: Schema.String,
  oauthClientId: Schema.optional(Schema.String),
  agentSession: Schema.Struct({
    id: Schema.String,
    creatorId: Schema.optional(Schema.NullOr(Schema.String)),
    issue: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
    comment: Schema.optional(Schema.NullOr(Schema.Struct({ body: Schema.String }))),
  }),
  agentActivity: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        body: Schema.optional(Schema.String),
        content: Schema.optional(Schema.Struct({ body: Schema.optional(Schema.String) })),
        signal: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  promptContext: Schema.optional(Schema.NullOr(Schema.String)),
  guidance: Schema.optional(Schema.Unknown),
  actor: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
});
type AgentEvent = typeof AgentEvent.Type;
type Session = {
  active_turn_id?: string | null;
  id: string;
  issue_id: string;
  thread_id: string | null;
  status: string;
  context: string;
  pending_question: string | null;
};
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEvent));
const isLinearOperationError = Schema.is(LinearOperationError);
const fail = (detail: string) => new LinearOperationError({ operation: "delegation", detail });
const Question = Schema.Struct({
  kind: Schema.Literals(["repository", "input", "approval"]),
  requestId: Schema.optional(Schema.String),
  ids: Schema.optional(Schema.Array(Schema.String)),
  questions: Schema.optional(Schema.Array(UserInputQuestion)),
});

const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(AgentEvent));
const encodeQuestion = Schema.encodeEffect(Schema.fromJsonString(Question));
const decodeQuestion = Schema.decodeUnknownEffect(Schema.fromJsonString(Question));
const encodeGuidance = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, webhookTimestamp: Schema.Number })),
);
const decodeResolvedRequest = Schema.decodeUnknownEffect(
  Schema.Struct({ requestId: Schema.String }),
);
const decodeRequestedInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    requestId: Schema.String,
    questions: Schema.optional(Schema.Array(UserInputQuestion)),
    detail: Schema.optional(Schema.String),
  }),
);

export function validLinearSignature(body: Uint8Array, signature: string, secret: string): boolean {
  if (!secret || !/^[a-f\d]{64}$/i.test(signature)) return false;
  return NodeCrypto.timingSafeEqual(
    NodeCrypto.createHmac("sha256", secret).update(body).digest(),
    Buffer.from(signature, "hex"),
  );
}

function isRelevantEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.session-set" ||
    event.type === "thread.deleted" ||
    (event.type === "thread.meta-updated" &&
      (event.payload.branchPullRequest != null || event.payload.linkedPullRequest != null)) ||
    (event.type === "thread.activity-appended" &&
      [
        "user-input.requested",
        "approval.requested",
        "user-input.resolved",
        "approval.resolved",
      ].includes(event.payload.activity.kind))
  );
}

export const LinearDelegationWorkers = Context.Reference<boolean>("t3/linear/workers", {
  defaultValue: () => true,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const oauth = yield* LinearOAuth;
  const outbox = yield* LinearAgentOutbox;
  const linear = yield* LinearApi;
  const threads = yield* LinearThreadService;
  const engine = yield* OrchestrationEngineService;
  const ingestion = yield* ProviderRuntimeIngestionService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const files = yield* T3ProjectFileLoader;
  const processLock = yield* Semaphore.make(1);
  const queue = yield* Queue.unbounded<string>();
  const ackQueue = yield* Queue.unbounded<string>();
  const enqueueOutgoing = outbox.enqueue;
  const commandId = (id: string, step: string) => CommandId.make(`linear:${id}:${step}`);
  /**
   * Sessions the assistant created for a team come back as `created` webhooks with no
   * creator, like a triage delegation. They are settled here and never start a thread.
   * Returns true when the delivery belonged to such a session.
   */
  const settleTeamDelivery = Effect.fn("LinearDelegation.settleTeamDelivery")(function* (
    deliveryId: string,
    event: AgentEvent,
  ) {
    const rows = yield* outbox.withCreationLock(
      sql<{
        task_id: string;
      }>`SELECT task_id FROM linear_agent_sessions WHERE id = ${event.agentSession.id} AND task_id IS NOT NULL`,
    );
    if (!rows[0]) return false;
    // A reply or stop goes to the team's assistant; the delivery stays pending
    // until it was handled, so a failure is retried.
    if (event.action === "prompted")
      yield* outbox.teamPrompt({
        deliveryId,
        sessionId: event.agentSession.id,
        taskId: rows[0].task_id,
        body: event.agentActivity?.content?.body ?? event.agentActivity?.body ?? "",
        signal: event.agentActivity?.signal ?? null,
      });
    yield* sql`UPDATE linear_agent_deliveries SET processed = 1 WHERE id = ${deliveryId}`;
    return true;
  });
  const process = Effect.fn("LinearDelegation.process")(
    function* (deliveryId: string) {
      const deliveries = yield* sql<{
        payload: string;
      }>`SELECT payload FROM linear_agent_deliveries WHERE id = ${deliveryId} AND processed = 0`;
      if (!deliveries[0]) return;
      const event = yield* decodeEvent(deliveries[0].payload);
      if (yield* settleTeamDelivery(deliveryId, event)) return;
      const sessionId = event.agentSession.id;
      const allSettings = yield* settings.getSettings;
      const c = allSettings.linear.delegation;
      const identity = yield* oauth.status;
      if (
        !identity.connected ||
        identity.organizationId !== event.organizationId ||
        (event.oauthClientId && event.oauthClientId !== c.clientId)
      )
        return yield* fail(
          "The Linear connection changed. Delegate this issue again after reconnecting the correct workspace.",
        );
      if (!c.enabled) return yield* fail("Delegation is disabled on this environment.");
      const sessionRows =
        yield* sql<Session>`SELECT * FROM linear_agent_sessions WHERE id = ${sessionId}`;
      let session = sessionRows[0];
      if (session?.status === "stopped") {
        yield* sql`UPDATE linear_agent_deliveries SET processed = 1 WHERE id = ${deliveryId}`;
        return;
      }
      const issueId = event.agentSession.issue?.id ?? session?.issue_id;
      if (!issueId) return yield* fail("Mention T3 Code on an issue to start a coding thread.");
      const issue = yield* linear.getIssue({ reference: issueId });
      if (
        c.allowedTeamKeys.length &&
        !c.allowedTeamKeys.some((key) => key.toUpperCase() === issue.team.key.toUpperCase())
      )
        return yield* fail(`Delegation is not enabled for team ${issue.team.key}.`);
      if (
        (event.actor?.type === "automation" || event.agentSession.creatorId === null) &&
        issue.state.type === "triage"
      )
        return yield* fail("A person must delegate this triage issue before T3 starts work.");
      if (!session) {
        const previous =
          yield* sql<Session>`SELECT * FROM linear_agent_sessions WHERE issue_id = ${issueId} AND thread_id IS NOT NULL AND status != 'stopped' ORDER BY updated_at DESC LIMIT 1`;
        const threadId = previous[0]?.thread_id ?? null;
        yield* sql`INSERT INTO linear_agent_sessions (id, issue_id, thread_id, context, updated_at) VALUES (${sessionId}, ${issueId}, ${threadId}, ${yield* encodeEvent(event)}, ${yield* Clock.currentTimeMillis})`;
        if (previous[0])
          yield* sql`UPDATE linear_agent_sessions SET status = 'stopped' WHERE id = ${previous[0].id}`;
        session = {
          id: sessionId,
          issue_id: issueId,
          thread_id: threadId,
          status: "pending",
          context: yield* encodeEvent(event),
          pending_question: null,
        };
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const prompt =
        event.agentActivity?.content?.body ??
        event.agentActivity?.body ??
        event.agentSession.comment?.body ??
        "";
      if (
        event.agentActivity?.signal === "stop" ||
        prompt.trim().toLowerCase() === "stop delegation"
      ) {
        yield* stopSession(session, deliveryId);
      } else {
        let threadId = session.thread_id ? ThreadId.make(session.thread_id) : null;
        const pending = session.pending_question
          ? yield* decodeQuestion(session.pending_question)
          : null;
        if (threadId && pending && pending.kind !== "repository") {
          if (!pending.requestId)
            return yield* fail("The pending question could not be restored. Open the T3 thread.");
          if (pending.kind === "approval") {
            const answer = prompt.trim().toLowerCase();
            if (!["approve", "deny"].includes(answer))
              return yield* fail("Reply approve or deny to the pending permission request.");
            yield* engine.dispatch({
              type: "thread.approval.respond",
              commandId: commandId(deliveryId, "approval"),
              threadId,
              requestId: ApprovalRequestId.make(pending.requestId),
              decision: answer === "approve" ? "accept" : "decline",
              createdAt: now,
            });
          } else {
            const ids = pending.ids ?? [];
            const answers: Record<string, unknown> = {};
            if (ids.length === 1) answers[ids[0]!] = prompt;
            else {
              for (const id of ids) {
                const line = prompt.split("\n").find((line) => line.startsWith(`${id}:`));
                if (!line)
                  return yield* fail(`Reply with one line per question, using ${id}: your answer.`);
                answers[id] = line.slice(id.length + 1).trim();
              }
            }
            yield* engine.dispatch({
              type: "thread.user-input.respond",
              commandId: commandId(deliveryId, "answer"),
              threadId,
              requestId: ApprovalRequestId.make(pending.requestId),
              answers: yield* Effect.try({
                try: () =>
                  Object.fromEntries(
                    Object.entries(answers).map(([id, raw]) => {
                      const question = pending.questions?.find((q) => q.id === id);
                      const resolve = (answer: string) => {
                        const option = question?.options.find(
                          (o) => o.label === answer || o.value === answer,
                        );
                        if (option) return option.value ?? option.label;
                        if (question?.allowCustomAnswer === false)
                          throw new Error("Select one of the offered options.");
                        return answer;
                      };
                      return [
                        id,
                        question?.multiSelect
                          ? String(raw)
                              .split(",")
                              .map((part) => resolve(part.trim()))
                          : resolve(String(raw)),
                      ];
                    }),
                  ),
                catch: () =>
                  fail(
                    "Select one of the offered options. Separate multiple selections with commas.",
                  ),
              }),
              createdAt: now,
            });
          }
          yield* sql`UPDATE linear_agent_sessions SET pending_question = NULL, status = 'running' WHERE id = ${sessionId} AND pending_question = ${session.pending_question}`;
        } else {
          const initial = yield* decodeEvent(session.context);
          if (!threadId) {
            if (!c.modelSelection)
              return yield* fail("Choose a delegation model in T3 Settings first.");
            const snapshot = yield* snapshots.getShellSnapshot();
            const projects = snapshot.projects;
            const mapping = resolveLinearRepositoryMapping(allSettings.linear.repositories, issue);
            const candidates = mapping
              ? projects.filter((p) => p.id === mapping.projectId)
              : yield* Effect.filter(projects, (p) =>
                  files
                    .load(p.workspaceRoot)
                    .pipe(
                      Effect.map(
                        (file) =>
                          Option.isSome(file) &&
                          (file.value.linear?.teams?.includes(issue.team.key) ?? false) &&
                          (!file.value.linear?.projects?.length ||
                            (issue.project !== null &&
                              file.value.linear.projects.includes(issue.project.id))),
                      ),
                    ),
                );
            const offered = candidates.length ? candidates : projects;
            let project = candidates.length === 1 ? candidates[0] : undefined;
            if (!project && pending?.kind === "repository") {
              const allowed = (pending.ids ?? []).map((id) => offered.find((p) => p.id === id));
              const named = allowed.filter(
                (p) =>
                  p !== undefined &&
                  (p.title.toLowerCase() === prompt.trim().toLowerCase() || p.id === prompt.trim()),
              );
              project = named.length === 1 ? named[0] : allowed[Number(prompt.trim()) - 1];
            }
            if (!project) {
              yield* sql`UPDATE linear_agent_sessions SET pending_question = ${yield* encodeQuestion({ kind: "repository", ids: offered.map((p) => p.id) })}, status = 'awaiting-input' WHERE id = ${sessionId}`;
              yield* enqueueOutgoing(`${deliveryId}:repository`, sessionId, {
                type: "elicitation",
                body: offered.length
                  ? `Which repository should I use? Reply with its name or number.\n${offered.map((p, i) => `${i + 1}. ${p.title}`).join("\n")}`
                  : "Register a repository in T3 Code, then reply here to continue.",
              });
              yield* sql`UPDATE linear_agent_deliveries SET processed = 1 WHERE id = ${deliveryId}`;
              return;
            }
            threadId = ThreadId.make(`linear-${sessionId}`);
            const prepared = yield* threads.prepareIssueThread({
              reference: issueId,
              cwd: project.workspaceRoot,
              threadId,
              mode: "worktree",
            });
            if (!prepared.worktreePath)
              return yield* fail("Delegation requires an isolated worktree.");
            yield* engine.dispatch({
              type: "thread.create",
              commandId: commandId(sessionId, "create"),
              threadId,
              projectId: project.id,
              title: `${issue.identifier}: ${issue.title}`,
              modelSelection: c.modelSelection,
              runtimeMode: c.runtimeMode,
              interactionMode: "default",
              branch: prepared.branch,
              worktreePath: prepared.worktreePath,
              linkedIssue: {
                provider: "linear",
                id: issue.id,
                identifier: issue.identifier,
                url: issue.url,
              },
              createdAt: now,
            });
            yield* sql`UPDATE linear_agent_sessions SET thread_id = ${threadId} WHERE id = ${sessionId}`;
          }
          const link = yield* outbox.threadLink(threadId);
          if (link)
            yield* enqueueOutgoing(`${deliveryId}:links`, sessionId, {
              type: "links",
              links: [link],
            });
          const text =
            session.status === "pending" || pending?.kind === "repository"
              ? `$linear-work ${issue.identifier}: ${issue.title}\n${issue.url}\nYou were delegated this issue in Linear. Read the current issue description and comments with the get_issue and list_comments MCP tools before starting. Work in this thread's prepared worktree. Ask questions through the provider's user-input tool so replies from Linear can resume you.\n${initial.guidance ? yield* encodeGuidance(initial.guidance) : ""}`
              : prompt ||
                "Read the current issue description and comments with the get_issue and list_comments MCP tools, then continue working on the delegated issue.";
          yield* sql`UPDATE linear_agent_sessions SET status = 'running', pending_question = NULL, updated_at = ${yield* Clock.currentTimeMillis} WHERE id = ${sessionId}`;
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: commandId(deliveryId, "turn"),
            threadId,
            message: {
              messageId: MessageId.make(`linear-${deliveryId}`),
              role: "user",
              text,
              attachments: [],
            },
            ...(c.modelSelection ? { modelSelection: c.modelSelection } : {}),
            runtimeMode: c.runtimeMode,
            interactionMode: "default",
            createdAt: now,
          });
        }
      }
      yield* sql`UPDATE linear_agent_deliveries SET processed = 1 WHERE id = ${deliveryId}`;
    },
    Effect.provideService(LinearAppCredential, oauth.accessToken(false)),
    processLock.withPermits(1),
  );
  const stopSession = Effect.fn("LinearDelegation.stopSession")(function* (
    session: Session,
    id: string,
  ) {
    yield* sql`UPDATE linear_agent_sessions SET status = 'stopped', pending_question = NULL WHERE id = ${session.id}`;
    if (session.thread_id)
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: commandId(id, "stop"),
        threadId: ThreadId.make(session.thread_id),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
    yield* enqueueOutgoing(`${id}:stopped`, session.id, {
      type: "response",
      body: "Delegation stopped. You can continue from the T3 Code thread.",
    });
  });
  const isActive = (threadId: ThreadId | undefined) =>
    threadId
      ? sql<{
          id: string;
        }>`SELECT id FROM linear_agent_sessions WHERE thread_id = ${threadId} AND status != 'stopped' LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(() => fail("Could not read delegation status.")),
        )
      : Effect.succeed(false);
  const stop = Effect.fn("LinearDelegation.stop")(
    function* (threadId: ThreadId) {
      const rows =
        yield* sql<Session>`SELECT * FROM linear_agent_sessions WHERE thread_id = ${threadId} AND status != 'stopped'`;
      for (const row of rows) yield* stopSession(row, `${row.id}:stop`);
    },
    Effect.mapError(() => fail("Could not stop delegation.")),
  );
  const receive = Effect.fn("LinearDelegation.receive")(
    function* (body: Uint8Array, signature: string, deliveryId: string) {
      const c = (yield* settings.getSettings).linear.delegation;
      if (!validLinearSignature(body, signature, c.webhookSecret))
        return yield* fail("Invalid webhook signature.");
      const raw = new TextDecoder().decode(body);
      const envelope = yield* decodeEnvelope(raw);
      if (Math.abs((yield* Clock.currentTimeMillis) - envelope.webhookTimestamp) > 60_000)
        return yield* fail("Expired webhook.");
      if (envelope.type !== "AgentSessionEvent") return;
      if (!c.enabled) return yield* fail("Delegation is disabled.");
      if (!deliveryId || deliveryId.length > 200)
        return yield* fail("Missing webhook delivery ID.");
      const event = yield* decodeEvent(raw);
      const identity = yield* oauth.status;
      if (
        !identity.connected ||
        identity.organizationId !== event.organizationId ||
        (event.oauthClientId && event.oauthClientId !== c.clientId)
      )
        return yield* fail("Webhook belongs to a different app or workspace.");
      const eventKey = `${event.organizationId}:${event.agentSession.id}:${event.action}:${event.action === "created" ? "created" : (event.agentActivity?.id ?? NodeCrypto.createHash("sha256").update(body).digest("hex"))}`;
      yield* sql`INSERT OR IGNORE INTO linear_agent_deliveries (id, event_key, payload, received_at) VALUES (${deliveryId}, ${eventKey}, ${raw}, ${yield* Clock.currentTimeMillis})`;
      yield* Queue.offer(ackQueue, deliveryId);
    },
    Effect.mapError(() => fail("Webhook was not accepted.")),
  );
  const observe = Effect.fn("LinearDelegation.observe")(function* (event: OrchestrationEvent) {
    if (!isRelevantEvent(event) || !("threadId" in event.payload)) return;
    const rows =
      yield* sql<Session>`SELECT * FROM linear_agent_sessions WHERE thread_id = ${event.payload.threadId} AND status != 'stopped'`;
    for (const row of rows) {
      const id = `event:${event.sequence}:${row.id}`;
      if (event.type === "thread.session-set" && event.payload.session.status === "running") {
        yield* sql`UPDATE linear_agent_sessions SET active_turn_id = ${event.payload.session.activeTurnId} WHERE id = ${row.id}`;
      } else if (
        event.type === "thread.session-set" &&
        event.payload.session.status === "ready" &&
        row.active_turn_id
      ) {
        yield* ingestion.drain;
        const detail = yield* snapshots.getThreadDetailById(ThreadId.make(row.thread_id!));
        if (Option.isSome(detail)) {
          const last = detail.value.messages.findLast(
            (m) => m.role === "assistant" && m.turnId === row.active_turn_id && m.text.trim(),
          );
          yield* enqueueOutgoing(id, row.id, {
            type: "response",
            body:
              last?.text ??
              "The turn finished without a final message. Open the T3 thread to review the result.",
          });
        }
        yield* sql`UPDATE linear_agent_sessions SET status = 'complete', active_turn_id = NULL WHERE id = ${row.id}`;
      } else if (event.type === "thread.session-set" && event.payload.session.status === "error") {
        yield* sql`UPDATE linear_agent_sessions SET status = 'failed', active_turn_id = NULL WHERE id = ${row.id}`;
        yield* enqueueOutgoing(id, row.id, {
          type: "error",
          body:
            event.payload.session.lastError ??
            "The provider failed. Open the T3 thread for details.",
        });
      } else if (
        event.type === "thread.session-set" &&
        ["stopped", "interrupted"].includes(event.payload.session.status) &&
        row.active_turn_id
      ) {
        yield* sql`UPDATE linear_agent_sessions SET status = 'complete', active_turn_id = NULL WHERE id = ${row.id}`;
        yield* enqueueOutgoing(id, row.id, {
          type: "response",
          body: "The agent stopped before finishing. Open the T3 thread to review its progress, or reply here to continue.",
        });
      } else if (
        event.type === "thread.meta-updated" &&
        (event.payload.branchPullRequest || event.payload.linkedPullRequest)
      ) {
        const link = yield* outbox.threadLink(row.thread_id!);
        yield* enqueueOutgoing(id, row.id, {
          type: "links",
          links: [
            ...(link ? [link] : []),
            {
              label: "Pull request",
              url: (event.payload.branchPullRequest ?? event.payload.linkedPullRequest)!.url,
            },
          ],
        });
      } else if (event.type === "thread.activity-appended") {
        const activity = event.payload.activity;
        if (activity.kind === "user-input.resolved" || activity.kind === "approval.resolved") {
          const resolved = yield* decodeResolvedRequest(activity.payload);
          if (row.pending_question) {
            const pending = yield* decodeQuestion(row.pending_question);
            if (pending.requestId === resolved.requestId)
              yield* sql`UPDATE linear_agent_sessions SET pending_question = NULL WHERE id = ${row.id} AND pending_question = ${row.pending_question}`;
          }
          continue;
        }
        if (activity.kind !== "user-input.requested" && activity.kind !== "approval.requested")
          continue;
        const payload = yield* decodeRequestedInput(activity.payload);
        const approval = activity.kind === "approval.requested";
        yield* sql`UPDATE linear_agent_sessions SET pending_question = ${yield* encodeQuestion({ kind: approval ? "approval" : "input", requestId: payload.requestId, ids: payload.questions?.map((q) => q.id) ?? [], ...(payload.questions ? { questions: payload.questions } : {}) })}, status = 'awaiting-input' WHERE id = ${row.id}`;
        yield* enqueueOutgoing(id, row.id, {
          type: "elicitation",
          body: approval
            ? `${activity.summary}\n${payload.detail ?? ""}\nReview the request in your T3 thread. Reply approve or deny.`
            : `${payload.questions?.map((q) => `${q.id}: ${q.question}${q.options.length ? "\n" + q.options.map((o) => "- " + o.label + (o.description ? ": " + o.description : "")).join("\n") : ""}${q.multiSelect ? "\nSeparate multiple selections with commas." : ""}`).join("\n") ?? activity.summary}\nReply with your answer${(payload.questions?.length ?? 0) > 1 ? ", using one question-id: answer per line" : ""}.`,
        });
      } else if (event.type === "thread.deleted") {
        yield* sql`UPDATE linear_agent_sessions SET status = 'stopped' WHERE id = ${row.id}`;
        yield* enqueueOutgoing(id, row.id, {
          type: "response",
          body: "The T3 Code thread was deleted. Delegation stopped.",
        });
      }
    }
  });
  /** Acknowledges a delivery at once (Linear wants a reply within 10 seconds), then processes it. */
  const acknowledge = Effect.fn("LinearDelegation.acknowledge")(function* (id: string) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM linear_agent_deliveries WHERE id = ${id} AND processed = 0`;
    if (!rows[0]) return;
    const event = yield* decodeEvent(rows[0].payload);
    if (yield* settleTeamDelivery(id, event)) return;
    yield* enqueueOutgoing(`${id}:ack`, event.agentSession.id, {
      type: "thought",
      body:
        event.action === "created"
          ? "Picking this up on the T3 Code environment."
          : "Received your reply. Continuing in T3 Code.",
    });
    yield* outbox.send(event.agentSession.id);
    yield* Queue.offer(queue, id);
  });
  if (!(yield* LinearDelegationWorkers))
    return { receive, stop, isActive, process, observe, acknowledge };
  const events = yield* engine.subscribeDomainEvents;
  const recordEvent = Effect.fn("LinearDelegation.recordEvent")(function* (
    event: OrchestrationEvent,
  ) {
    const rows = yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM linear_agent_cursor WHERE id = 1`;
    if ((rows[0]?.sequence ?? 0) >= event.sequence) return;
    yield* observe(event);
    yield* sql`UPDATE linear_agent_cursor SET sequence = ${event.sequence} WHERE id = 1`;
  });
  const replay = Effect.gen(function* () {
    while (true) {
      const rows = yield* sql<{
        sequence: number;
      }>`SELECT sequence FROM linear_agent_cursor WHERE id = 1`;
      const cursor = rows[0]?.sequence ?? 0;
      const batch = yield* engine.readEvents(cursor, 500).pipe(Stream.runCollect);
      if (!batch.length) break;
      for (const event of batch) if (isRelevantEvent(event)) yield* recordEvent(event);
      yield* sql`UPDATE linear_agent_cursor SET sequence = ${batch[batch.length - 1]!.sequence} WHERE id = 1`;
    }
  });
  yield* replay;
  yield* events.pipe(
    Stream.filter(isRelevantEvent),
    Stream.runForEach((event) =>
      recordEvent(event).pipe(Effect.retry(Schedule.exponential("1 second"))),
    ),
    forkParked,
  );
  const processSafely = (id: string) =>
    process(id).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            payload: string;
          }>`SELECT payload FROM linear_agent_deliveries WHERE id = ${id}`;
          if (rows[0]) {
            const event = yield* decodeEvent(rows[0].payload);
            yield* enqueueOutgoing(`${id}:error`, event.agentSession.id, {
              type: "error",
              body: isLinearOperationError(error)
                ? error.detail
                : "T3 could not start or continue the delegated thread. Check the server and reply to try again.",
            });
          }
          yield* sql`UPDATE linear_agent_deliveries SET processed = 1 WHERE id = ${id}`;
        }),
      ),
      Effect.catch(() => Effect.logWarning("Linear delegation failed.")),
    );
  yield* Queue.take(queue).pipe(Effect.flatMap(processSafely), Effect.forever, forkParked);
  yield* Queue.take(ackQueue).pipe(
    Effect.flatMap((id) =>
      acknowledge(id).pipe(
        Effect.catch(() =>
          Effect.logWarning("Linear acknowledgement failed; delivery remains pending."),
        ),
      ),
    ),
    Effect.forever,
    forkParked,
  );
  const recover = Effect.gen(function* () {
    if (!(yield* oauth.status).connected) return;
    const pendingDeliveries = yield* sql<{
      id: string;
    }>`SELECT id FROM linear_agent_deliveries WHERE processed = 0 ORDER BY received_at`;
    for (const row of pendingDeliveries) yield* Queue.offer(ackQueue, row.id);
  });
  yield* recover;
  yield* recover.pipe(
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.catch(() => Effect.logWarning("Linear recovery paused until restart.")),
    forkParked,
  );
  return { receive, stop, isActive, process, observe, acknowledge };
});
export class LinearDelegation extends Context.Service<
  LinearDelegation,
  Effect.Success<typeof make>
>()("t3/linear/LinearDelegation") {}
export const layer = Layer.effect(LinearDelegation, make);
