import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ASSISTANT_INSTRUCTION_BUDGET,
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
import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StagingVerifier } from "./StagingVerifier.ts";
import { setupInstructions } from "./prompts.ts";
import { openProjectNotes } from "./projectNotes.ts";

type SetupRow = {
  project_id: string;
  thread_id: string;
  preferences: string;
  proposal: string | null;
  summary: string;
  revision: number;
  proposed_after: string | null;
  /** JSON array: the ids of every project note this conversation was shown. */
  notes_read: string | null;
  /** JSON array: the note ids read when the current proposal was made; a save absorbs them. */
  proposal_notes: string | null;
};
const decodePreferences = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantSetupInput));
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantProjectConfig));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantTask));
const encodePreferences = Schema.encodeSync(Schema.fromJsonString(AssistantSetupInput));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AssistantProjectConfig));
const fail = (detail: string) => new DeveloperAssistantError({ detail });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const decodeNoteIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeNoteIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

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

// Stored setups may still carry an "assistant" section from the retired
// assistant chat. No thread reads it, so it is neither budgeted nor refused.
const INSTRUCTION_SECTIONS = ["lead", "implement", "review", "e2e"] as const;
/** A count as the refusals quote it, so it reads the way the budget is written. */
const characters = (count: number) => count.toLocaleString("en-US");

/**
 * The budgets only bite once the setup writes sections: a setup from before they
 * existed keeps sending its one string to every thread. They exist so that
 * repository facts end up in a repository document, which every thread can read,
 * instead of in four prompts.
 */
function validateInstructions(config: AssistantProjectConfig) {
  const sections = INSTRUCTION_SECTIONS.map((audience) => ({
    audience,
    text: config.roleInstructions?.[audience] ?? "",
  }));
  if (sections.some((section) => section.text.trim())) {
    if (config.instructions.length > ASSISTANT_INSTRUCTION_BUDGET.shared)
      return fail(
        `The shared policy is ${characters(config.instructions.length)} characters; its budget is ${characters(ASSISTANT_INSTRUCTION_BUDGET.shared)} once role sections are present. Move repository facts into a repository document and point at it, and put role-specific facts in that role's section.`,
      );
    const over = sections.find(
      (section) => section.text.length > ASSISTANT_INSTRUCTION_BUDGET.section,
    );
    if (over)
      return fail(
        `The ${over.audience} section is ${characters(over.text.length)} characters; its budget is ${characters(ASSISTANT_INSTRUCTION_BUDGET.section)}. Move repository facts into a repository document and point at it, and keep the section to what that role alone needs.`,
      );
  }
  const total = sections.reduce(
    (sum, section) => sum + section.text.length,
    config.instructions.length,
  );
  if (total > ASSISTANT_INSTRUCTION_BUDGET.total)
    return fail(
      `The instructions and their sections are ${characters(total)} characters together; the budget is ${characters(ASSISTANT_INSTRUCTION_BUDGET.total)}. Move repository facts into a repository document and point at it.`,
    );
  return null;
}

export function validateSetupPlan(config: AssistantProjectConfig) {
  const targets = config.deploymentTargets ?? [];
  if (!isValidBranchName(config.baseBranch))
    return fail(
      `"${config.baseBranch}" is not a usable branch name. Use the integration branch's exact name, such as main or develop.`,
    );
  const instructions = validateInstructions(config);
  if (instructions) return instructions;
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
  /**
   * The repository's own skills, discovered the way Claude Code resolves them
   * from the workspace, so a role skill T3 mentions is one that actually runs.
   * Platform services are provided here because this service is built inside
   * the developer assistant, whose context carries none.
   */
  const projectSkills = Effect.fn("Assistant.projectSkills")(function* (workspaceRoot: string) {
    const claude = yield* settings.getSettings.pipe(
      Effect.map((current) => current.providers.claudeAgent),
      Effect.orElseSucceed(() => ({ homePath: "" })),
    );
    const discovered = yield* discoverClaudeSkills(claude, workspaceRoot).pipe(
      Effect.provide(NodeServices.layer),
    );
    return discovered.filter(
      (skill) => skill.scope === "project" && skill.enabled && skill.userInvocable !== false,
    );
  });
  /**
   * A role skill is named in a thread's first message, so it has to be one the
   * repository carries: a user-scope skill of the same name runs on one machine
   * only, and nowhere for the next instance working this repository.
   */
  const checkRoleSkills = Effect.fn("Assistant.checkRoleSkills")(function* (
    config: AssistantProjectConfig,
  ) {
    const named = Object.values(config.roleSkills ?? {}).filter(
      (name): name is string => name !== undefined,
    );
    if (!named.length) return;
    const root = yield* snapshots.getProjectShellById(config.projectId);
    if (Option.isNone(root)) return yield* fail("Select an existing T3 project.");
    const available = yield* projectSkills(root.value.workspaceRoot);
    const unknown = named.find((name) => !available.some((skill) => skill.name === name));
    if (unknown)
      return yield* fail(
        `"${unknown}" is not a skill in this repository's .claude/skills (found: ${available.map((skill) => skill.name).join(", ") || "none"}). User-scope skills are not accepted: they belong to one machine.`,
      );
  });
  /**
   * What the last partial e2e runs left for a person to do, so a revision can
   * turn each one into a fixture, a test account or a documented coverage gap.
   */
  const humanChecks = Effect.fn("Assistant.humanChecks")(function* (projectId: string) {
    const rows = yield* sql<{ data: string }>`SELECT data FROM assistant_tasks
      WHERE project_id = ${projectId} AND json_extract(data, '$.e2e.verdict') = 'partial'
      ORDER BY json_extract(data, '$.updatedAt') DESC LIMIT 5`;
    const tasks = yield* Effect.forEach(rows, (row) => decodeTask(row.data));
    const left = tasks.filter((task) => task.e2e?.humanChecks.length);
    if (!left.length) return "";
    const listed = left
      .map(
        (task) =>
          `${task.issue.identifier}:\n${task.e2e?.humanChecks.map((check) => `- ${check}`).join("\n")}`,
      )
      .join("\n");
    return `\nHuman checks from recent deliveries:\n${listed}\nEach of these is something the tester could not check itself. Turn each into a fixture, a test account, or a documented coverage gap in the e2e section.`;
  });
  /**
   * The notes teams wrote about the project, so a revision can fold the lasting
   * ones into the instructions. The conversation remembers which it was shown:
   * saving a proposal made after reading them absorbs exactly those.
   */
  const projectNotes = Effect.fn("Assistant.setupProjectNotes")(function* (row: SetupRow) {
    const notes = yield* openProjectNotes(sql, row.project_id);
    if (!notes.length) return "";
    const read = row.notes_read ? yield* decodeNoteIds(row.notes_read) : [];
    const ids = [...new Set([...read, ...notes.map((note) => note.id)])];
    yield* sql`UPDATE assistant_setups SET notes_read = ${encodeNoteIds(ids)} WHERE thread_id = ${row.thread_id}`;
    const listed = notes
      .map(
        (note) =>
          `- ${note.text} (${[note.issueIdentifier, note.role === "person" ? "added by the person" : note.role, note.createdAt.slice(0, 10)].filter(Boolean).join(", ")})`,
      )
      .join("\n");
    return `\nProject notes from earlier teams:\n${listed}\nEvery team's first message lists these until this revision is saved; saving it retires them. Fold each one that still holds into the instruction section of the role that needs it (a coverage gap or test account into e2e, a deploy fact into lead, a setup step into implement), or name the repository document that should carry it. Leave out the ones that no longer hold, and say in the summary what you did with each.`;
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
    const row = yield* get(caller);
    const setup = yield* decode(row);
    const projectId = setup.preferences.projectId;
    const configured = yield* sql<{
      config: string;
    }>`SELECT config FROM assistant_projects WHERE project_id = ${projectId}`;
    const active = yield* sql<{
      data: string;
    }>`SELECT data FROM assistant_tasks WHERE project_id = ${projectId} AND status IN ('preparing','working','waiting','blocked')`;
    // A project can work several issues at once; each of them keeps its branch.
    const inProgress = yield* Effect.forEach(active, (row) =>
      decodeTask(row.data).pipe(Effect.map((t) => t.issue.identifier)),
    );
    const root = yield* snapshots.getProjectShellById(projectId);
    const skills = Option.isSome(root) ? yield* projectSkills(root.value.workspaceRoot) : [];
    const existing = configured[0] ? yield* decodeConfig(configured[0].config) : null;
    // A revision is where the checks a person had to run become test data.
    const checks = existing ? yield* humanChecks(projectId) : "";
    const notes = yield* projectNotes(row);
    return {
      setup,
      instructions: `${setupInstructions(
        setup.preferences,
        existing,
        inProgress.length ? inProgress.join(", ") : null,
        skills,
      )}${checks}${notes}`,
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
      status: string;
    }>`SELECT status FROM assistant_projects WHERE project_id = ${input.projectId}`;
    // An issue in progress may stay: saving keeps what it depends on unchanged.
    if (configured[0]?.status === "running")
      return yield* fail("Pause the assistant before changing its setup.");
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
        proposed_after = NULL, proposal_notes = NULL, revision = revision + 1 WHERE project_id = ${input.projectId}`;
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
    const error = validateSetupPlan(proposal);
    if (error) return yield* error;
    yield* checkRoleSkills(proposal);
    const thread = yield* snapshots.getThreadShellById(caller);
    if (Option.isNone(thread)) return yield* fail("The setup thread no longer exists.");
    yield* sql`UPDATE assistant_setups SET proposal = ${encodeConfig(proposal)}, summary = ${summary},
      revision = revision + 1, proposed_after = ${thread.value.latestUserMessageAt},
      proposal_notes = notes_read WHERE thread_id = ${caller}`;
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
      // The proposal was written from these notes, so they stop reaching prompts.
      // A note added after the setup last read them stays open.
      const absorbed = row.proposal_notes ? yield* decodeNoteIds(row.proposal_notes) : [];
      if (absorbed.length)
        yield* sql`UPDATE assistant_project_notes SET absorbed_at = ${yield* now}
          WHERE project_id = ${row.project_id} AND absorbed_at IS NULL AND ${sql.in("id", absorbed)}`;
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
