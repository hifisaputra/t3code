import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderApprovalDecision,
  RuntimeRequestId,
  type RunId,
  type RuntimeMode,
  type ThreadId,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * The thread reads and commands the developer assistant and Linear delegation
 * share, on orchestration v2. Their threads are created and messaged by the
 * server, so messages read as T3 Code's in the client (`agent`/`server`).
 */
export type ThreadShell = OrchestrationV2ThreadShell;

const ACTIVE_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** A run is going or about to, or native background work (a subagent, a watch loop) lives on. */
export const threadBusy = (shell: OrchestrationV2ThreadShell) =>
  shell.activeRunId !== null ||
  ACTIVE_STATUSES.has(shell.status) ||
  (shell.pendingBackgroundTasks?.length ?? 0) > 0;

/** Native background work outlives the thread's last run. */
export const threadHasBackgroundWork = (shell: OrchestrationV2ThreadShell) =>
  (shell.pendingBackgroundTasks?.length ?? 0) > 0;

/** An approval or question waits for an answer. */
export const threadAwaitsAnswer = (shell: OrchestrationV2ThreadShell) =>
  shell.pendingRuntimeRequest !== null;

/** When the thread's latest run ended, or null while none has. */
export const latestRunCompletedMs = (shell: OrchestrationV2ThreadShell) =>
  shell.latestRunCompletedAt ? DateTime.toEpochMillis(shell.latestRunCompletedAt) : null;

export const isoOrNull = (value: DateTime.Utc | null | undefined) =>
  value ? DateTime.formatIso(value) : null;

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;

  /** A deleted thread reads as missing; an archived one only with `includeArchived`. */
  const shell = Effect.fn("AssistantThreads.shell")(function* (
    threadId: ThreadId,
    options?: { readonly includeArchived?: boolean },
  ) {
    const value = yield* threads.getThreadShell(threadId);
    if (value === null || value.deletedAt !== null) return Option.none<ThreadShell>();
    if (value.archivedAt !== null && options?.includeArchived !== true)
      return Option.none<ThreadShell>();
    return Option.some(value);
  });

  const project = (projectId: ProjectId) => projects.getShell(projectId);
  const listProjects = projects.listShells();

  const create = (input: {
    readonly commandId: string;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly linkedIssue?: ThreadLinkedIssue;
  }) =>
    threads.dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make(input.commandId),
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      branch: input.branch,
      worktreePath: input.worktreePath,
      ...(input.linkedIssue ? { linkedIssue: input.linkedIssue } : {}),
    });

  /** Answers an approval (`decision`) or a question (`answers`) the thread's provider asked. */
  const respond = (input: {
    readonly commandId: string;
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly decision?: ProviderApprovalDecision;
    readonly answers?: Record<string, unknown>;
  }) =>
    threads.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(input.commandId),
      threadId: input.threadId,
      requestId: RuntimeRequestId.make(input.requestId),
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.answers ? { answers: input.answers } : {}),
    });

  /** Starts a turn, or queues it behind the thread's active run. */
  const send = (input: {
    readonly commandId: string;
    readonly messageId: string;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly modelSelection?: ModelSelection | null | undefined;
  }) =>
    threads.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(input.commandId),
      threadId: input.threadId,
      messageId: MessageId.make(input.messageId),
      text: input.text,
      attachments: [],
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      dispatchMode: { type: "start_immediately" },
    });

  /** Stops the active run, the queue behind it and the thread's background work. */
  const stop = (commandId: string, threadId: ThreadId, reason: string) =>
    threads.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(commandId),
      threadId,
      reason,
    });

  const archive = (commandId: string, threadId: ThreadId) =>
    threads.dispatch({ type: "thread.archive", commandId: CommandId.make(commandId), threadId });

  const unarchive = (commandId: string, threadId: ThreadId) =>
    threads.dispatch({ type: "thread.unarchive", commandId: CommandId.make(commandId), threadId });

  const settle = (commandId: string, threadId: ThreadId) =>
    threads.dispatch({ type: "thread.settle", commandId: CommandId.make(commandId), threadId });

  /** The finished assistant messages of a run, oldest first. */
  const runAssistantMessages = Effect.fn("AssistantThreads.runAssistantMessages")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const records = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["assistant"],
      messageRunIds: [runId],
    });
    return records.messages.filter((message) => !message.streaming && message.text.trim());
  });

  /** The thread's conversation, oldest first; a v1 thread's transcript is imported on the way. */
  const messages = Effect.fn("AssistantThreads.messages")(function* (
    threadId: ThreadId,
    roles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>,
  ) {
    const records = yield* threads.getThreadRecords(
      threadId,
      ["messages"],
      roles ? { messageRoles: roles } : undefined,
    );
    return records.messages;
  });

  return {
    shell,
    project,
    listProjects,
    create,
    send,
    respond,
    stop,
    archive,
    unarchive,
    settle,
    runAssistantMessages,
    messages,
  };
});

export type AssistantThreads = Effect.Success<typeof make>;
