import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AssistantProjectConfig,
  AssistantSetupInput,
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
const encodePreferences = Schema.encodeSync(Schema.fromJsonString(AssistantSetupInput));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AssistantProjectConfig));
const fail = (detail: string) => new DeveloperAssistantError({ detail });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export function validateDeploymentConfig(config: AssistantProjectConfig) {
  const targets = config.deploymentTargets ?? [];
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
    return {
      setup,
      instructions: setupInstructions(
        setup.preferences,
        configured[0] ? yield* decodeConfig(configured[0].config) : null,
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
    const active =
      yield* sql`SELECT id FROM assistant_tasks WHERE project_id = ${input.projectId} AND status IN ('preparing','working','waiting','blocked')`;
    if (configured[0]?.status === "running" || active.length)
      return yield* fail(
        "Stop the assistant and finish or skip its active issue before changing setup.",
      );
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
    if (!row) {
      const threadId = ThreadId.make(`assistant-setup-${NodeCrypto.randomUUID()}`);
      yield* sql`INSERT INTO assistant_setups (project_id, repository_key, thread_id, preferences) VALUES (${input.projectId}, ${repositoryKey}, ${threadId}, ${encodePreferences(input)})`;
      row = yield* get(threadId);
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
        runtimeMode: "approval-required",
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
    // A stable command id makes retries after a disconnect reuse the first turn.
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`${value.threadId}:start`),
      threadId: value.threadId,
      message: {
        messageId: MessageId.make(`${value.threadId}:start`),
        role: "user",
        attachments: [],
        text: "Help me set up the developer assistant for this project. Read the saved setup brief using your assistant setup tools, then inspect the repository and its staging deployment. Ask me for missing details and propose a setup I can review and save. This is an inspection and discussion; do not change files, deploy, or start issues.",
      },
      modelSelection: value.preferences.modelSelection,
      runtimeMode: "approval-required",
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
    const { context: _context, ...selected } = preferences;
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
