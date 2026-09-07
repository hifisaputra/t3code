import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const CREATED_AT = "2026-08-24T10:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const LINKED_ISSUE = {
  provider: "linear",
  id: "issue-uuid",
  identifier: "DEL-123",
  url: "https://linear.app/t3/issue/DEL-123/do-the-thing",
} as const;

const makeProjectReadModel = Effect.fn(function* () {
  return yield* projectEvent(createEmptyReadModel(CREATED_AT), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "project.created",
    occurredAt: CREATED_AT,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  });
});

const createCommand = {
  type: "thread.create" as const,
  commandId: CommandId.make("command-create"),
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Issue thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdAt: CREATED_AT,
};

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

const applyEvents = Effect.fn(function* (
  readModel: OrchestrationReadModel,
  decided: PlannedEvent | ReadonlyArray<PlannedEvent>,
) {
  const events = Array.isArray(decided) ? decided : [decided as PlannedEvent];
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, {
      ...event,
      sequence: next.snapshotSequence + 1,
    } as OrchestrationEvent);
  }
  return next;
});

it.layer(NodeServices.layer)("thread linked issue", (it) => {
  it.effect("copies a linked issue from thread.create into thread.created", () =>
    Effect.gen(function* () {
      const readModel = yield* makeProjectReadModel();

      const withIssue = yield* decideOrchestrationCommand({
        command: { ...createCommand, linkedIssue: LINKED_ISSUE },
        readModel,
      });
      expect(withIssue).toMatchObject({
        type: "thread.created",
        payload: { threadId: THREAD_ID, linkedIssue: LINKED_ISSUE },
      });

      const withoutIssue = yield* decideOrchestrationCommand({
        command: createCommand,
        readModel,
      });
      expect(withoutIssue).not.toHaveProperty("payload.linkedIssue");
    }),
  );

  it.effect("sets and clears the link through thread.meta.update", () =>
    Effect.gen(function* () {
      let readModel = yield* makeProjectReadModel();
      readModel = yield* applyEvents(
        readModel,
        yield* decideOrchestrationCommand({ command: createCommand, readModel }),
      );
      expect(readModel.threads[0]?.linkedIssue).toBeNull();

      const linked = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("command-link"),
          threadId: THREAD_ID,
          linkedIssue: LINKED_ISSUE,
        },
        readModel,
      });
      expect(linked).toMatchObject({
        type: "thread.meta-updated",
        payload: { threadId: THREAD_ID, linkedIssue: LINKED_ISSUE },
      });
      readModel = yield* applyEvents(readModel, linked);
      expect(readModel.threads[0]?.linkedIssue).toEqual(LINKED_ISSUE);

      // A rename must not disturb the link.
      const renamed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("command-rename"),
          threadId: THREAD_ID,
          title: "Renamed",
        },
        readModel,
      });
      expect(renamed).not.toHaveProperty("payload.linkedIssue");
      readModel = yield* applyEvents(readModel, renamed);
      expect(readModel.threads[0]?.linkedIssue).toEqual(LINKED_ISSUE);

      const unlinked = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("command-unlink"),
          threadId: THREAD_ID,
          linkedIssue: null,
        },
        readModel,
      });
      readModel = yield* applyEvents(readModel, unlinked);
      expect(readModel.threads[0]?.linkedIssue).toBeNull();
    }),
  );
});
