import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  AssistantBoard,
  AssistantDecision,
  AssistantTask,
  AssistantSetup,
  AssistantSetupPlan,
  AssistantThreadRole,
  DeveloperAssistantError,
  LinearIssueSummary,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import { DeveloperAssistant } from "../../../assistant/DeveloperAssistant.ts";
import { McpInvocationContext, requireMcpCapability } from "../../McpInvocationContext.ts";

const dependencies = [DeveloperAssistant, McpInvocationContext];
const failure = Schema.Union([DeveloperAssistantError, PreviewAutomationUnavailableError]);
const text = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(20000));
const taskId = Schema.optionalKey(
  Schema.String.check(Schema.isNonEmpty()).annotate({
    description:
      "The issue's taskId from assistant_get_board. A team leader leaves it out: its own issue is implied.",
  }),
);
const thread = Schema.optionalKey(
  AssistantThreadRole.annotate({
    description:
      'Which of the issue\'s threads: "implement" (default), "review", "e2e", or "lead" for its team leader.',
  }),
);

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
      "Developer assistant only: pause this project's issue loop when the person asks you to. The loop takes no new issues from Linear; the team at work finishes its issue, and issues the person dispatches still run. The person resumes the loop from the assistant board.",
    // MCP returns text; an empty result fails to encode and reads as a server error.
    success: Schema.String,
    failure,
    dependencies,
  }),
  Tool.make("assistant_get_board", {
    description:
      "Developer assistant only: read the project's setup, the issues the loop would take next (candidates), queued, active, declined and delivered work, and open decisions.",
    success: Schema.Struct({
      ...AssistantBoard.fields,
      candidates: Schema.Array(LinearIssueSummary),
    }),
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("assistant_dispatch_issue", {
    description:
      "Developer assistant only: dispatch a Linear issue to a team when the person asks for it. It goes ahead of the loop's own picks and runs even while the loop is paused: a free project gives it to a new team right away; otherwise it waits for the active issue to finish. Its team leader takes it or asks the person, and cannot decline it. Skipping it from the board removes it from the queue.",
    parameters: Schema.Struct({
      reference: text,
      note: Schema.String.check(Schema.isMaxLength(20000)).annotate({
        description:
          "What the person wants from this issue, for its team leader. Empty when they said nothing more.",
      }),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_accept_issue", {
    description:
      "Team leader only: take your issue. T3 moves it to started in Linear and starts the implementation worker in this worktree with your brief. The worker and the code reviewer then work together on their own. End your turn afterward; T3 messages you when the issue needs you.",
    parameters: Schema.Struct({
      brief: text.annotate({
        description:
          "For the worker: the scope, the acceptance criteria, and what the issue leaves implicit.",
      }),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_decline_issue", {
    description:
      "Team leader only, before taking the issue: do not work on it. T3 posts your reason on the Linear issue, closes this team, and leaves the issue until someone changes it. Use it when the issue cannot be worked as it stands; ask with assistant_ask_decision when one answer from the person would settle it.",
    parameters: Schema.Struct({
      reason: text.annotate({
        description:
          "For the people on the issue: what stops the work and what would change that (missing details, a blocker, an issue to finish first). No first person.",
      }),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_read_thread", {
    description:
      "Read one of a managed issue's threads (lead, implement, review or e2e): the end of its conversation, its session status, the shared worktree path and the issue's recorded review, merge, deployment and e2e results.",
    parameters: Schema.Struct({ taskId, thread }),
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
      "Send follow-up work to one of the active issue's threads: the implementer (default), the code reviewer, the e2e tester once its run has started, or (from the developer assistant) the team leader. Use it when a thread stalls, an e2e failure needs a fix, or the person redirected the work; the implementer and reviewer hand work to each other on their own. Waits while another of the issue's threads runs; refuses with unanswered decisions or past the worker turn limit. End your turn afterward.",
    parameters: Schema.Struct({ taskId, message: text, thread }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_ask_decision", {
    description:
      "Ask the person a product question in the decision inbox, preserving the issue/thread link. Include context and a recommendation. Available to the developer assistant and every thread of a managed issue. After asking, end your turn and wait; the answer arrives in the thread that asked.",
    parameters: Schema.Struct({ question: text }),
    success: AssistantDecision,
    failure,
    dependencies,
  }),
  Tool.make("assistant_answer_decision", {
    description:
      "Developer assistant only: pass on the person's answer to an open decision (yours or one of an issue's threads) when they gave it to you in this chat. T3 records it and sends it to the thread that asked, which then continues. Relay what the person said, with any context the asker needs; never answer from your own judgment. Refuses unless the person has written to you since the question was asked. Get the decision id from assistant_get_board.",
    parameters: Schema.Struct({
      decisionId: text,
      answer: text.annotate({
        description: "The person's answer, in their words, for the thread that asked.",
      }),
    }),
    success: AssistantDecision,
    failure,
    dependencies,
  }),
  Tool.make("assistant_request_review", {
    description:
      "Implementation thread only: hand your committed, pushed work to the issue's code reviewer. Say what changed, how you verified it, the PR, and what deserves a close look. The reviewer works in this worktree, so end your turn and do not edit files until its verdict arrives here.",
    parameters: Schema.Struct({ message: text }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_submit_review", {
    description:
      "Code review thread only: record your verdict on the worktree's current commit. changes-requested sends your findings to the implementer as its next round. approved tells the implementer to merge exactly that commit; any later commit needs another review. End your turn after submitting.",
    parameters: Schema.Struct({
      verdict: Schema.Literals(["approved", "changes-requested"]),
      findings: text.annotate({
        description:
          "For the implementer: each finding with file and line, the problem and what to do. On approval, anything to watch while merging.",
      }),
      summary: Schema.String.check(Schema.isMaxLength(4000)).annotate({
        description:
          "On approval, one or two sentences for the Linear update: what the review covered and any non-blocking notes. No first person.",
      }),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_report_merged", {
    description:
      "Implementation thread only: report that the approved commit is merged into the integration branch. T3 checks that the worktree still sits on the approved commit and that origin's integration branch contains it, posts the merge update on the Linear issue, and hands the issue to the team leader for staging. In worktree mode the e2e check must have passed on this commit first. End your turn afterward.",
    parameters: Schema.Struct({
      summary: text.annotate({
        description:
          'What a user can now do, in plain Markdown for people who read the Linear issue but not the code. T3 puts this in the issue\'s description under "What shipped" once staging verifies it. No first person, no file or branch names, no PR or commit; T3 adds those to its comments.',
      }),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_verify_staging", {
    description:
      "Team leader, after the implementer reports the merge: check the saved deployment targets or custom check. Every selected deployment must contain the approved commit and belong to origin's integration branch. Supply the targetIds this change affects, or omit to check all. On success T3 posts the update on the Linear issue; in staging mode call assistant_start_e2e next, and in worktree mode this is the delivery: T3 then puts the issue in review. If staging is still deploying, use assistant_wait.",
    parameters: Schema.Struct({
      taskId,
      targetIds: Schema.optionalKey(Schema.Array(text)),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_start_e2e", {
    description:
      "Team leader: start (or rerun) the issue's e2e tester, on staging after assistant_verify_staging succeeds, or in the team's worktree on the approved commit before the merge when the project is set up that way. The brief lists each acceptance criterion as a check a person could follow, the affected pages or endpoints, the data it needs and what to clean up. The tester reports passed, partial or failed with screenshots. End your turn afterward.",
    parameters: Schema.Struct({ taskId, brief: text }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_submit_e2e", {
    description:
      "E2E thread only: report your test, on staging or in the team's worktree, wherever you ran it. T3 uploads the screenshots and records the result; on passed or partial the issue moves on (in staging mode straight to review, in worktree mode to the merge and the staging deploy), and on failed the team leader decides the fix. End your turn after submitting.",
    parameters: Schema.Struct({
      verdict: Schema.Literals(["passed", "partial", "failed"]).annotate({
        description:
          "passed: every criterion verified where you tested. partial: what could be checked passed, and humanChecks lists what a person must check. failed: a criterion does not hold.",
      }),
      report: text.annotate({
        description:
          "Markdown for the Linear issue: one line per acceptance criterion marked passed, failed or not checked, with its evidence; then anything not covered and why. For a failure, expected versus actual and steps to reproduce. No first person or 'you'.",
      }),
      humanChecks: Schema.Array(text).annotate({
        description:
          "Checks a person should still do on staging before accepting, each with exact steps. Empty when passed.",
      }),
      screenshots: Schema.Array(
        Schema.Struct({
          path: text.annotate({
            description:
              "Absolute path of a PNG, JPEG or WebP file in the evidence folder T3 named.",
          }),
          caption: text.annotate({ description: "One line: what the screenshot shows." }),
        }),
      ),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_wait", {
    description:
      "Wait for external progress, such as CI or a staging deployment, without polling in the agent. Supply a concrete reason and end your turn. T3 wakes you in about a minute. Use assistant_ask_decision instead for a lasting blocker requiring a person.",
    parameters: Schema.Struct({ reason: text }),
    success: Schema.String,
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
      yield* service.pause(caller);
      return "Paused. The loop takes no new issues; the team at work finishes its issue, and issues the person dispatches still run. The person resumes the loop from the assistant board.";
    }),
  assistant_get_board: () =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.getAgentBoard(caller);
    }),
  assistant_dispatch_issue: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.dispatchFromAssistant(
        caller,
        input.reference.trim(),
        input.note.trim(),
      );
    }),
  assistant_accept_issue: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.acceptIssue(caller, input.brief.trim());
    }),
  assistant_decline_issue: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.declineIssue(caller, input.reason.trim());
    }),
  assistant_read_thread: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.readThread(caller, input.taskId, input.thread);
    }),
  assistant_message_worker: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.messageWorker(caller, input.taskId, input.message.trim(), input.thread);
    }),
  assistant_ask_decision: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.askDecision(caller, input.question.trim());
    }),
  assistant_answer_decision: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.relayAnswer(caller, input.decisionId.trim(), input.answer.trim());
    }),
  assistant_request_review: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.requestReview(caller, input.message.trim());
    }),
  assistant_submit_review: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.submitReview(
        caller,
        input.verdict,
        input.findings.trim(),
        input.summary.trim(),
      );
    }),
  assistant_report_merged: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.reportMerged(caller, input.summary.trim());
    }),
  assistant_verify_staging: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.verifyStaging(caller, input.taskId, input.targetIds);
    }),
  assistant_start_e2e: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.startE2e(caller, input.taskId, input.brief.trim());
    }),
  assistant_submit_e2e: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.submitE2e(caller, {
        verdict: input.verdict,
        report: input.report.trim(),
        humanChecks: input.humanChecks.map((check) => check.trim()).filter(Boolean),
        screenshots: input.screenshots.map((shot) => ({
          path: shot.path.trim(),
          caption: shot.caption.trim(),
        })),
      });
    }),
  assistant_wait: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      const result = yield* service.waitForExternal(caller, input.reason.trim());
      if (result.outcome === "limit")
        return "T3 has checked back 15 times without this completing, so the issue is now blocked for the person to look at. End your turn.";
      if (result.outcome === "stopped") return "The assistant is stopped. End your turn.";
      return "T3 checks back in about a minute. End your turn now.";
    }),
});
