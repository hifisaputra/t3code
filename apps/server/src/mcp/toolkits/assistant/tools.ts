import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  ASSISTANT_PROJECT_NOTES,
  AssistantCriteria,
  AssistantDecision,
  AssistantE2eCheck,
  AssistantTask,
  AssistantSetup,
  AssistantSetupPlan,
  AssistantThreadRole,
  DeveloperAssistantError,
  PreviewAutomationUnavailableError,
  assistantTaskE2eEnvironment,
} from "@t3tools/contracts";
import { DeveloperAssistant } from "../../../assistant/DeveloperAssistant.ts";
import { McpInvocationContext, requireMcpCapability } from "../../McpInvocationContext.ts";

const dependencies = [DeveloperAssistant, McpInvocationContext];
const failure = Schema.Union([DeveloperAssistantError, PreviewAutomationUnavailableError]);
const text = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(20000));
const smokeCriteria = Schema.Array(Schema.Int).annotate({
  description:
    "For depth smoke: the 1-based numbers of the acceptance criteria the smoke test covers, at least one. The tester checks only these; T3 records the rest as not in the smoke test.",
});
const thread = Schema.optionalKey(
  AssistantThreadRole.annotate({
    description: 'Which of the issue\'s threads: "implement" (default), "review" or "e2e".',
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
  Tool.make("assistant_accept_issue", {
    description:
      "Team leader only: take your issue, with the acceptance criteria and the plan for its e2e test. T3 moves it to started in Linear and starts the implementation worker in this worktree with your brief. The worker and the code reviewer then work together on their own, and T3 verifies staging and starts the tester with your e2e brief at the depth you plan. End your turn afterward; T3 messages you when the issue needs a decision.",
    parameters: Schema.Struct({
      brief: text.annotate({
        description:
          "For the worker: the scope, the acceptance criteria, and what the issue leaves implicit.",
      }),
      criteria: AssistantCriteria.annotate({
        description:
          "Each criterion is one check a person could perform on the product, not a diff. T3 gives them, numbered, to the worker, the reviewer and the tester.",
      }),
      e2e: Schema.Struct({
        depth: Schema.Literals(["full", "smoke", "none"]).annotate({
          description:
            "How deep the e2e test goes; it sets which criteria are tested, not a time or screenshot budget. full: every acceptance criterion with screenshots. smoke: only the criteria in smokeCriteria; the tester checks that the pages the change touches load, walks the happy path of each and watches the console and network for errors. none: no tester runs, and T3 delivers once staging verifies the merge; give a reason. When in doubt choose full. Choose none only when nothing a user sees or does changes: tooling, lint, CI, dependency bumps with no behaviour change, refactors covered by tests, docs. The code reviewer can raise the depth to full, and the person can change it on the board until the test starts.",
        }),
        brief: Schema.String.check(Schema.isMaxLength(20000)).annotate({
          description:
            "For the tester: the pages or endpoints affected, the data it needs and what to clean up. Required for full and smoke; may be empty for none. T3 starts the tester with it, plus the criteria and the implementer's test notes, once staging verifies the merge (or, when the project tests in the worktree, once review approves).",
        }),
        reason: Schema.optionalKey(
          text.annotate({
            description:
              "For depth none, required: why nothing a user sees or does changes. It goes on the Linear issue with the delivery. Omit for full and smoke.",
          }),
        ),
        smokeCriteria: Schema.optionalKey(smokeCriteria),
        targetIds: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description:
              "The configured deployment target ids this change affects; omit to check all.",
          }),
        ),
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
      "Team leader: read one of a managed issue's threads (lead, implement, review or e2e): the end of its conversation, its session status, the shared worktree path, the messages queued for it that have not started yet, and the issue's recorded review, merge, deployment and e2e results.",
    parameters: Schema.Struct({ thread }),
    success: Schema.Struct({
      task: AssistantTask,
      transcript: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
      sessionStatus: Schema.String,
      worktreePath: Schema.NullOr(Schema.String),
      queued: Schema.Array(
        Schema.Struct({ queuedAt: Schema.String, preview: Schema.String }),
      ).annotate({
        description:
          "Messages T3 queued for this thread that have not started a turn yet, oldest first: each starts once the issue's running turn ends.",
      }),
    }),
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("assistant_message_worker", {
    description:
      "Team leader: send follow-up work to one of your issue's threads: the implementer (default), the code reviewer, or the e2e tester once its run has started. Use it when a thread stalls, an e2e failure needs a fix, or the person redirected the work; the implementer and reviewer hand work to each other on their own. Waits while another of the issue's threads runs; refuses with unanswered decisions or past the worker turn limit. End your turn afterward.",
    parameters: Schema.Struct({ message: text, thread }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_ask_decision", {
    description:
      "Ask the person a product question in the decision inbox, preserving the issue/thread link. Include context and a recommendation. Available to every thread of an active managed issue. After asking, end your turn and wait; the answer arrives in the thread that asked.",
    parameters: Schema.Struct({ question: text }),
    success: AssistantDecision,
    failure,
    dependencies,
  }),
  Tool.make("assistant_request_review", {
    description:
      "Implementation thread only: hand your committed, pushed work to the issue's code reviewer. Say what changed, how you verified it, the PR, and what deserves a close look, and give testNotes and planChanged for the e2e tester on every request. The reviewer works in this worktree, so end your turn and do not edit files until its verdict arrives here.",
    parameters: Schema.Struct({
      message: text,
      testNotes: Schema.optionalKey(
        text.annotate({
          description:
            "For the e2e tester: what the change does now for a user, the pages, endpoints and flows to test, and the data they need. Required.",
        }),
      ),
      planChanged: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "true when the work differs from the team leader's brief in a way the e2e test depends on (a different page, flow or data). The leader then revises the test plan.",
        }),
      ),
    }),
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
      needsE2e: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "true when the diff changes behaviour a user sees or uses that the planned e2e depth would not test: a plan with no test, or a smoke test that leaves out what changed. T3 raises the test to full, with either verdict. Omit otherwise.",
        }),
      ),
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
      "Team leader, after the implementer reports the merge: check the saved deployment targets or custom check. T3 runs this check itself when the merge is reported on an issue taken with an e2e plan, and messages you when it fails; call it by hand to check again, for example once a failed deployment is fixed. Every selected deployment must contain the approved commit and belong to origin's integration branch. Supply the targetIds this change affects, or omit to check all. On success T3 posts the update on the Linear issue; in staging mode T3 then starts the tester with your planned brief (call assistant_start_e2e yourself for an issue taken without an e2e plan), and in worktree mode this is the delivery: T3 then puts the issue in review. While staging is still deploying T3 watches it for you and messages you when it fails (or, for an issue taken without an e2e plan, when it is verified), so end your turn; a deployment that failed comes back here for you to decide.",
    parameters: Schema.Struct({
      targetIds: Schema.optionalKey(Schema.Array(text)),
    }),
    success: Schema.Struct({
      task: AssistantTask,
      outcome: Schema.Literals(["verified", "watching"]),
      note: Schema.String,
    }),
    failure,
    dependencies,
  }),
  Tool.make("assistant_start_e2e", {
    description:
      "Team leader: start (or rerun) the issue's e2e tester, on staging once the deploy is verified, or in the team's worktree on the approved commit before the merge when the project is set up that way. T3 starts the tester itself with the e2e brief you planned when taking the issue; use this to rerun it after a failure, or when the implementer reports the plan changed, with a revised brief or the original one. The brief gives the tester the pages or endpoints affected, the data it needs and what to clean up; T3 adds the acceptance criteria you listed and the implementer's test notes. The tester reports one result per criterion with screenshots. Give depth to change how deep the test goes (full, or smoke with smokeCriteria); it becomes the plan, and without it the planned depth stays. End your turn afterward.",
    parameters: Schema.Struct({
      brief: text,
      depth: Schema.optionalKey(
        Schema.Literals(["full", "smoke"]).annotate({
          description:
            "full tests every acceptance criterion; smoke tests only smokeCriteria: the pages the change touches load, the happy path of each, and no console or network errors. Omit to keep the planned depth.",
        }),
      ),
      smokeCriteria: Schema.optionalKey(smokeCriteria),
    }),
    success: AssistantTask,
    failure,
    dependencies,
  }),
  Tool.make("assistant_submit_e2e", {
    description:
      "E2E thread only: report your test, on staging or in the team's worktree, wherever you ran it. T3 uploads the screenshots and records the result; on passed or partial the issue moves on (in staging mode straight to review, in worktree mode to the merge and the staging deploy), and on failed the team leader decides the fix. End your turn after submitting.",
    parameters: Schema.Struct({
      checks: Schema.optionalKey(
        Schema.Array(AssistantE2eCheck).annotate({
          description:
            "checks is required when the issue has acceptance criteria (the brief lists them numbered): one entry per criterion, in order; in a smoke test, one per criterion the brief lists. Never report skipped: T3 records the criteria outside a smoke test itself. T3 derives the verdict from them: one failed criterion fails the run, otherwise any not-checked criterion makes it partial, and each not-checked criterion needs a matching entry in humanChecks. screenshot is the 1-based position in screenshots of the one that proves the check.",
        }),
      ),
      verdict: Schema.optionalKey(
        Schema.Literals(["passed", "partial", "failed"]).annotate({
          description:
            "Only read for an issue with no acceptance criteria; with criteria T3 derives it from checks. passed: every criterion verified where you tested. partial: what could be checked passed, and humanChecks lists what a person must check. failed: a criterion does not hold.",
        }),
      ),
      report: text.annotate({
        description:
          "Markdown for the Linear issue, collapsed below the table T3 renders from checks: what the run covered beyond the criteria, what it did not cover and why, and the test data it created, changed or left behind; for a failure the expected versus actual and the steps to reproduce. For an issue with no acceptance criteria, give one line per criterion marked passed, failed or not checked, with its evidence. No first person or 'you'.",
      }),
      humanChecks: Schema.Array(text).annotate({
        description:
          "Checks a person should still do on staging before accepting, each with exact steps. Empty when passed.",
      }),
      worthALook: Schema.optionalKey(
        Schema.Array(Schema.String).annotate({
          description:
            "Things the person should look at that are not failures, one short line each (at most 15, 400 characters each): leftover wording, inconsistencies, suspicious behavior outside the criteria. A failure belongs in checks, and coverage, gaps and test data in report. Omit when there is nothing.",
        }),
      ),
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
  Tool.make("assistant_add_note", {
    description:
      'Team leader, implementation worker or e2e tester: write down a fact about this project or its environments that a later team would otherwise have to rediscover, for example "staging has no Search Console data, so Search Visibility cannot be checked there; use local projects 9585662 or 10137794". Not issue progress (that goes in your report or handoff) and not code style (that belongs in the repository\'s docs). Every later team of the project sees the open notes in its first message, until a setup revision folds them into the project instructions. One fact per note, at most 300 characters. A note that repeats an open one is not added again. A project keeps at most 20 open notes: when the list is full the call fails, and the fact goes in your report or final message instead.',
    parameters: Schema.Struct({
      text: Schema.String.check(
        Schema.isNonEmpty(),
        Schema.isMaxLength(ASSISTANT_PROJECT_NOTES.maxLength),
      ).annotate({
        description:
          "The fact, in one or two sentences a later team can act on: what holds, where, and what to do about it.",
      }),
    }),
    success: Schema.String,
    failure,
    dependencies,
  }),
  Tool.make("assistant_wait", {
    description:
      "Team leader: wait for external progress, such as CI or a staging deployment, without polling in the agent. Supply a concrete reason and end your turn. T3 wakes you in about a minute. Use assistant_ask_decision instead for a lasting blocker requiring a person.",
    parameters: Schema.Struct({ reason: text }),
    success: Schema.String,
    failure,
    dependencies,
  }),
);

/** What the team leader does next with the deployment T3 just checked. */
const verifyNote = (result: {
  readonly task: AssistantTask;
  readonly outcome: "verified" | "watching";
}) => {
  if (result.outcome === "watching")
    return `Staging is still deploying: ${result.task.deployWait?.detail ?? "the deploy has not landed yet"}. T3 checks every minute for up to 45 minutes and messages you when it is verified or fails. End your turn.`;
  if (result.task.status === "review" || assistantTaskE2eEnvironment(result.task) === "worktree")
    return "Verified: the issue is delivered and in review. End your turn.";
  if (result.task.e2ePlan && result.task.stage === "e2e")
    return "Verified. T3 started the e2e tester with the brief you planned. End your turn.";
  if (result.task.e2ePlan)
    return "Verified, but T3 did not start the e2e tester: its message to you says why, and arrives when you end your turn. Then start it with assistant_start_e2e.";
  return "Verified. Start the e2e check with assistant_start_e2e.";
};

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
  assistant_accept_issue: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.acceptIssue(
        caller,
        input.brief.trim(),
        input.criteria.map((criterion) => criterion.trim()),
        {
          depth: input.e2e.depth,
          brief: input.e2e.brief.trim(),
          ...(input.e2e.reason !== undefined ? { reason: input.e2e.reason.trim() } : {}),
          ...(input.e2e.smokeCriteria ? { smokeCriteria: input.e2e.smokeCriteria } : {}),
          ...(input.e2e.targetIds
            ? { targetIds: input.e2e.targetIds.map((id) => id.trim()).filter(Boolean) }
            : {}),
        },
      );
    }),
  assistant_decline_issue: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.declineIssue(caller, input.reason.trim());
    }),
  assistant_read_thread: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.readThread(caller, input.thread);
    }),
  assistant_message_worker: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.messageWorker(caller, input.message.trim(), input.thread);
    }),
  assistant_ask_decision: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.askDecision(caller, input.question.trim());
    }),
  assistant_request_review: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.requestReview(caller, input.message.trim(), {
        ...(input.testNotes !== undefined ? { testNotes: input.testNotes.trim() } : {}),
        ...(input.planChanged !== undefined ? { planChanged: input.planChanged } : {}),
      });
    }),
  assistant_submit_review: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.submitReview(
        caller,
        input.verdict,
        input.findings.trim(),
        input.summary.trim(),
        input.needsE2e,
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
      const result = yield* service.verifyStaging(caller, input.targetIds);
      return { ...result, note: verifyNote(result) };
    }),
  assistant_start_e2e: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.startE2e(caller, input.brief.trim(), {
        ...(input.depth ? { depth: input.depth } : {}),
        ...(input.smokeCriteria ? { smokeCriteria: input.smokeCriteria } : {}),
      });
    }),
  assistant_submit_e2e: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      return yield* service.submitE2e(caller, {
        ...(input.verdict ? { verdict: input.verdict } : {}),
        ...(input.checks ? { checks: input.checks } : {}),
        report: input.report.trim(),
        humanChecks: input.humanChecks.map((check) => check.trim()).filter(Boolean),
        ...(input.worthALook
          ? { worthALook: input.worthALook.map((note) => note.trim()).filter(Boolean) }
          : {}),
        screenshots: input.screenshots.map((shot) => ({
          path: shot.path.trim(),
          caption: shot.caption.trim(),
        })),
      });
    }),
  assistant_add_note: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      const { note, added } = yield* service.addProjectNoteFromThread(caller, input.text);
      return added
        ? "Noted. Later teams of this project see it in their first message."
        : `Already noted, so nothing was added. The open note reads: ${note.text}`;
    }),
  assistant_wait: (input) =>
    Effect.gen(function* () {
      const { service, caller } = yield* scope;
      const result = yield* service.waitForExternal(caller, input.reason.trim());
      if (result.outcome === "limit")
        return "T3 has checked back 15 times without this completing, so the issue is now blocked for the person to look at. End your turn.";
      return "T3 checks back in about a minute. End your turn now.";
    }),
});
