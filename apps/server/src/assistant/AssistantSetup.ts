import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AssistantProjectConfig,
  AssistantSetupInput,
  AssistantTask,
  CommandId,
  DeveloperAssistantError,
  MessageId,
  ThreadId,
  type AssistantSetup,
  type AssistantSetupPlan,
  type AssistantSetupResolveInput,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { LinearApi } from "../linear/LinearApi.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StagingVerifier } from "./StagingVerifier.ts";
import { setupInstructions } from "./prompts.ts";

type SetupRow = {
  project_id: string;
  thread_id: string;
  preferences: string;
  proposal: string | null;
  summary: string;
  revision: number;
  proposed_after: string | null;
};
const decodePreferences = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantSetupInput));
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantProjectConfig));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantTask));
const encodePreferences = Schema.encodeSync(Schema.fromJsonString(AssistantSetupInput));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AssistantProjectConfig));
const fail = (detail: string) => new DeveloperAssistantError({ detail });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * A branch name git itself would accept. The setup plan is agent-proposed and the
 * name reaches git as an argument, so a leading `-` (an option, not a ref) and the
 * rest of `git check-ref-format --branch`'s rules are refused here rather than
 * changing what a git command means.
 */
export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 255 || branch === "@") return false;
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.endsWith(".") || branch.endsWith(".lock") || branch.includes("..")) return false;
  // Control characters and space, then the characters git reserves for refspecs and globs.
  if ([...branch].some((character) => character <= " " || character === "\u007f")) return false;
  if (/[~^:?*[\\]/.test(branch) || branch.includes("@{")) return false;
  return branch
    .split("/")
    .every((segment) => segment !== "" && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

export function validateDeploymentConfig(config: AssistantProjectConfig) {
  const targets = config.deploymentTargets ?? [];
  if (!isValidBranchName(config.baseBranch))
    return fail(
      `"${config.baseBranch}" is not a usable branch name. Use the integration branch's exact name, such as main or develop.`,
    );
  if (config.stagingCheckCommand.trim()) {
    if (targets.length)
      return fail("Choose provider deployment checks or a custom command, not both.");
    return null;
  }
  if (!targets.length || !config.stagingUrl)
    return fail(
      "Discover staging deployment targets and a review URL, or supply an existing staging check.",
    );
  if (new Set(targets.map((t) => t.id)).size !== targets.length)
    return fail("Each staging deployment target needs a distinct id.");
  return null;
}

export const makeSetup = Effect.fn("Assistant.makeSetup")(function* (options: {
  changed: Effect.Effect<void>;
  threadBusy: (thread: OrchestrationThreadShell) => Effect.Effect<boolean, DeveloperAssistantError>;
  configure: (config: AssistantProjectConfig) => Effect.Effect<void, DeveloperAssistantError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const verifier = yield* StagingVerifier;
  const linear = yield* LinearApi;
  const settings = yield* ServerSettingsService;

  const decode = Effect.fn(function* (
    row: SetupRow,
  ): Effect.fn.Return<AssistantSetup, Schema.SchemaError> {
    return {
      preferences: yield* decodePreferences(row.preferences),
      threadId: ThreadId.make(row.thread_id),
      proposal: row.proposal ? yield* decodeConfig(row.proposal) : null,
      summary: row.summary,
      revision: row.revision,
    };
  });
  const get = Effect.fn(function* (threadId: ThreadId) {
    const rows = yield* sql<SetupRow>`SELECT * FROM assistant_setups WHERE thread_id = ${threadId}`;
    if (!rows[0]) return yield* fail("This setup conversation is no longer active.");
    return rows[0];
  });
  const list = Effect.fn(function* (projectId: string | null) {
    const rows =
      yield* sql<SetupRow>`SELECT * FROM assistant_setups WHERE (${projectId} IS NULL OR project_id = ${projectId})`;
    return yield* Effect.forEach(rows, decode);
  });
  const read = Effect.fn(function* (caller: ThreadId) {
    const setup = yield* decode(yield* get(caller));
    const configured = yield* sql<{
      config: string;
    }>`SELECT config FROM assistant_projects WHERE project_id = ${setup.preferences.projectId}`;
    const active = yield* sql<{
      data: string;
    }>`SELECT data FROM assistant_tasks WHERE project_id = ${setup.preferences.projectId} AND status IN ('preparing','working','waiting','blocked')`;
    // A project can work several issues at once; each of them keeps its branch.
    const inProgress = yield* Effect.forEach(active, (row) =>
      decodeTask(row.data).pipe(Effect.map((t) => t.issue.identifier)),
    );
    return {
      setup,
      instructions: setupInstructions(
        setup.preferences,
        configured[0] ? yield* decodeConfig(configured[0].config) : null,
        inProgress.length ? inProgress.join(", ") : null,
      ),
    };
  });
  const begin = Effect.fn(function* (input: AssistantSetupInput) {
    if (
      (yield* linear.status).status !== "connected" ||
      !(yield* settings.getSettings).linear.agentAccess
    )
      return yield* fail(
        "Connect Linear and enable Agent access in Settings → Integrations → Linear before setup.",
      );
    const root = yield* snapshots.getProjectShellById(input.projectId);
    if (Option.isNone(root)) return yield* fail("Select an existing T3 project.");
    const configured = yield* sql<{
      config: string;
      status: string;
      thread_id: string;
    }>`SELECT config, status, thread_id FROM assistant_projects WHERE project_id = ${input.projectId}`;
    // An issue in progress may stay: saving keeps what it depends on unchanged.
    if (configured[0]?.status === "running")
      return yield* fail("Pause the assistant before changing its setup.");
    if (configured[0]) {
      const coordinator = yield* snapshots.getThreadShellById(
        ThreadId.make(configured[0].thread_id),
      );
      if (Option.isSome(coordinator) && (yield* options.threadBusy(coordinator.value)))
        return yield* fail("Wait for the assistant's turn to finish before setup.");
    }
    const repositoryKey = yield* verifier.repositoryKey(root.value.workspaceRoot);
    const conflicts =
      yield* sql`SELECT project_id FROM assistant_projects WHERE repository_key = ${repositoryKey} AND project_id != ${input.projectId}
      UNION SELECT project_id FROM assistant_setups WHERE repository_key = ${repositoryKey} AND project_id != ${input.projectId}`;
    if (conflicts.length)
      return yield* fail(
        "This repository already has an assistant or setup conversation in another T3 project.",
      );
    const existing =
      yield* sql<SetupRow>`SELECT * FROM assistant_setups WHERE project_id = ${input.projectId}`;
    let row = existing[0];
    // Archived conversations resume in place; only a deleted thread starts over.
    const thread = row
      ? yield* snapshots.getThreadShellById(ThreadId.make(row.thread_id), {
          includeArchived: true,
        })
      : Option.none();
    if (row && Option.isNone(thread)) {
      yield* sql`DELETE FROM assistant_setups WHERE project_id = ${input.projectId}`;
      row = undefined;
    }
    const encoded = encodePreferences(input);
    let revised = false;
    if (!row) {
      const threadId = ThreadId.make(`assistant-setup-${NodeCrypto.randomUUID()}`);
      yield* sql`INSERT INTO assistant_setups (project_id, repository_key, thread_id, preferences) VALUES (${input.projectId}, ${repositoryKey}, ${threadId}, ${encoded})`;
      row = yield* get(threadId);
    } else if (row.preferences !== encoded) {
      // Reopening "Revise setup" with different choices rewrites the brief the
      // conversation works from. A proposal made from the old brief is no longer
      // the person's, so it goes with it and the revision moves past any pending save.
      if (Option.isSome(thread) && (yield* options.threadBusy(thread.value)))
        return yield* fail(
          "Wait for the setup conversation's turn to finish before changing its brief.",
        );
      yield* sql`UPDATE assistant_setups SET preferences = ${encoded}, proposal = NULL, summary = '',
        proposed_after = NULL, revision = revision + 1 WHERE project_id = ${input.projectId}`;
      row = yield* get(ThreadId.make(row.thread_id));
      revised = true;
    }
    const value = yield* decode(row);
    // The engine rejects unarchiving a live thread, so only restore an archived one.
    if (Option.isNone(thread))
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${value.threadId}:create`),
        threadId: value.threadId,
        projectId: input.projectId,
        title: `Assistant setup · ${root.value.title}`,
        modelSelection: value.preferences.modelSelection,
        runtimeMode: value.preferences.setupRuntimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: yield* now,
      });
    else if (thread.value.archivedAt !== null)
      yield* engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: value.threadId,
      });
    yield* options.changed;
    // A stable command id makes retries after a disconnect reuse the first turn; a
    // revised brief is a different turn and carries the revision it was written for.
    const start = revised ? `${value.threadId}:start:${value.revision}` : `${value.threadId}:start`;
    const note = value.preferences.context.trim();
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(start),
      threadId: value.threadId,
      message: {
        messageId: MessageId.make(start),
        role: "user",
        attachments: [],
        text: revised
          ? `I changed the setup brief: my models, Linear project, permissions or notes are not what they were. Read the saved brief again using your assistant setup tools, check what it changes about the repository and staging deployment you inspected, and propose a setup that matches it. Any earlier proposal is out of date. This is an inspection and discussion; do not change files, deploy, or start issues.${note ? `\n\nWhat I asked for this time:\n${note}` : ""}`
          : "Help me set up the developer assistant for this project. Read the saved setup brief using your assistant setup tools, then inspect the repository and its staging deployment. Ask me for missing details and propose a setup I can review and save. This is an inspection and discussion; do not change files, deploy, or start issues.",
      },
      modelSelection: value.preferences.modelSelection,
      runtimeMode: value.preferences.setupRuntimeMode,
      interactionMode: "default",
      createdAt: yield* now,
    });
    return value;
  });
  const propose = Effect.fn(function* (
    caller: ThreadId,
    plan: AssistantSetupPlan,
    summary: string,
  ) {
    const row = yield* get(caller);
    const preferences = yield* decodePreferences(row.preferences);
    const { context: _context, setupRuntimeMode: _setupRuntimeMode, ...selected } = preferences;
    const proposal: AssistantProjectConfig = { ...plan, ...selected };
    const error = validateDeploymentConfig(proposal);
    if (error) return yield* error;
    const thread = yield* snapshots.getThreadShellById(caller);
    if (Option.isNone(thread)) return yield* fail("The setup thread no longer exists.");
    yield* sql`UPDATE assistant_setups SET proposal = ${encodeConfig(proposal)}, summary = ${summary},
      revision = revision + 1, proposed_after = ${thread.value.latestUserMessageAt} WHERE thread_id = ${caller}`;
    yield* options.changed;
    return yield* decode(yield* get(caller));
  });
  const resolve = Effect.fn(function* (input: typeof AssistantSetupResolveInput.Type) {
    const row = yield* get(input.threadId);
    if (input.action === "save") {
      if (!row.proposal || row.revision !== input.revision)
        return yield* fail("The setup proposal changed. Review the latest proposal before saving.");
      const thread = yield* snapshots.getThreadShellById(input.threadId);
      if (Option.isNone(thread))
        return yield* fail("The setup thread no longer exists. Start setup again.");
      if (
        (yield* options.threadBusy(thread.value)) ||
        thread.value.hasPendingApprovals ||
        thread.value.hasPendingUserInput
      )
        return yield* fail(
          "Wait for the setup turn to finish and answer its requests before saving.",
        );
      if (thread.value.latestUserMessageAt !== row.proposed_after)
        return yield* fail(
          "The conversation continued after this proposal. Ask the assistant to update its proposal before saving.",
        );
      yield* options.configure(yield* decodeConfig(row.proposal));
    } else {
      yield* engine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId: input.threadId,
          createdAt: yield* now,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    yield* sql`DELETE FROM assistant_setups WHERE thread_id = ${input.threadId}`;
    yield* options.changed;
    // Retain the conversation in history, including cancelled setup discussions.
    yield* engine
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`${input.threadId}:archive`),
        threadId: input.threadId,
      })
      .pipe(Effect.catch(() => Effect.void));
  });
  return { begin, propose, resolve, list, read };
});
