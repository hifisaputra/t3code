import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  AssistantBoard,
  AssistantDecision,
  AssistantTask,
  AssistantSetup,
  AssistantSetupPlan,
  DeveloperAssistantError,
  LinearIssueSummary,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import { DeveloperAssistant } from "../../../assistant/DeveloperAssistant.ts";
import { McpInvocationContext, requireMcpCapability } from "../../McpInvocationContext.ts";

const dependencies = [DeveloperAssistant, McpInvocationContext];
const failure = Schema.Union([DeveloperAssistantError, PreviewAutomationUnavailableError]);
const text = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(20000));
const taskId = Schema.String.check(Schema.isNonEmpty());

export const AssistantToolkit = Toolkit.make(
  Tool.make("assistant_get_setup", {
    description:
      "Read the saved setup brief, selected preferences, existing proposal, and inspection instructions. Call this first when helping the person set up their developer assistant. Only active setup conversations may read it. Setup is read-only inspection and discussion; do not start issues, mutate the repository or deploy.",
    success: Schema.Struct({ setup: AssistantSetup, instructions: Schema.String }),
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("assistant_propose_setup", {
    description:
      "Propose or revise the configuration from an active assistant setup conversation after inspecting the repository and staging workflow. Does not save configuration or start issues. The person reviews and saves it in the web UI. Only the setup thread can use this tool; models, issue scope and permissions remain the person's selected preferences.",
    parameters: Schema.Struct({ plan: AssistantSetupPlan, summary: text }),
    success: AssistantSetup,
    failure,
    dependencies,
  }),
  Tool.make("assistant_pause", {
    description:
      "Pause this project's assistant queue when the person asks you to stop. Existing worker work is preserved. The person can resume from the assistant board.",
    success: Schema.Void,
    failure,
    dependencies,
  }),
  Tool.make("assistant_get_board", {
    description:
      "Read your developer assistant's project setup, eligible Linear issues, managed work, decisions, and staging reviews. Only the coordinator can read this board. Human reviews do not block selecting the next issue after verified staging deployment.",
    success: Schema.Struct({
      ...AssistantBoard.fields,
      candidates: Schema.Array(LinearIssueSummary),
    }),
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("assistant_start_issue", {
    description:
      "Start a coding thread in a fresh worktree with the project's selected worker model. Enforces project scope, readiness, ownership and one active issue. A changes-requested issue gets a new worker with its previous review feedback. Read the full issue first and provide a concrete brief. End your turn after starting; the server wakes you when the worker needs attention.",
    parameters: Schema.Struct({ reference: text, brief: text }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_read_thread", {
    description:
      "Read a managed worker's recent conversation, worktree path, session status and stored result. Use the worktree to review its committed diff and verification evidence.",
    parameters: Schema.Struct({ taskId }),
    success: Schema.Struct({
      task: AssistantTask,
      transcript: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
      sessionStatus: Schema.String,
      worktreePath: Schema.NullOr(Schema.String),
    }),
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("assistant_message_worker", {
    description:
      "Send follow-up work or code review feedback to an idle worker. Refuses parallel work, unanswered decisions and the worker turn limit. The server queues delivery durably; end your turn afterward.",
    parameters: Schema.Struct({ taskId, message: text }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_ask_decision", {
    description:
      "Ask the person a product question in the decision inbox, preserving the issue/thread link. Include context and a recommendation. Available to the coordinator and its coding workers. After asking, end your turn and wait; the answer will arrive in the thread.",
    parameters: Schema.Struct({ question: text }),
    success: AssistantDecision,
    failure,
    dependencies,
  }),
  Tool.make("assistant_verify_staging", {
    description:
      "Verify delivery using the saved deployment targets or custom check, then archive the worker and release the project. Supply relevant targetIds for this issue, or omit to check all targets. First exercise issue-specific staging acceptance checks and include evidence in summary. Requires an idle worker, committed worktree and resolved decisions. Every selected deployment must contain the worker commit and belong to origin's integration branch. Review code, merge with a merge commit or fast-forward, and stop local servers first. On success start the next issue without waiting for human review.",
    parameters: Schema.Struct({
      taskId,
      summary: text,
      reviewInstructions: text,
      targetIds: Schema.optionalKey(Schema.Array(text)),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_wait", {
    description:
      "Wait for external progress, such as CI or a staging deployment, without polling in the agent. Supply a concrete reason and end your turn. T3 wakes you in about a minute. Use assistant_ask_decision instead for a lasting blocker requiring a person.",
    parameters: Schema.Struct({ reason: text }),
    success: Schema.Void,
    failure,
    dependencies,
  }),
);

const scope = Effect.gen(function* () {
  const invocation = yield* requireMcpCapability("linear");
  return { service: yield* DeveloperAssistant, caller: invocation.threadId };
});
export const AssistantToolkitHandlers = AssistantToolkit.toLayer({
  assistant_get_setup: () =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.getSetup(caller);
    }),
  assistant_propose_setup: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.proposeSetup(caller, input.plan, input.summary.trim());
    }),
  assistant_pause: () =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.pause(caller);
    }),
  assistant_get_board: () =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.getAgentBoard(caller);
    }),
  assistant_start_issue: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.startIssue(caller, input.reference.trim(), input.brief.trim());
    }),
  assistant_read_thread: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.readThread(caller, input.taskId);
    }),
  assistant_message_worker: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.messageWorker(caller, input.taskId, input.message.trim());
    }),
  assistant_ask_decision: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.askDecision(caller, input.question.trim());
    }),
  assistant_verify_staging: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.verifyStaging(
        caller,
        input.taskId,
        input.summary.trim(),
        input.reviewInstructions.trim(),
        input.targetIds,
      );
    }),
  assistant_wait: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.waitForExternal(caller, input.reason.trim());
    }),
});
