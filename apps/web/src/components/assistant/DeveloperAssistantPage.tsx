import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type AssistantBoard,
  type AssistantProjectConfig,
  type AssistantTask,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CheckIcon,
  MessageCircleQuestionIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { developerAssistant } from "../../state/developerAssistant";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const textareaClass = "min-h-24 w-full rounded-md border border-input bg-background p-3 text-sm";

export function DeveloperAssistantPage() {
  const { environments } = useEnvironments();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((e) => e.environmentId === chosen) ??
    environments.find((e) => e.serverConfig?.settings.linear.apiKey) ??
    environments[0];
  return (
    <SidebarInset className="flex h-full min-h-0 flex-col">
      <WorkspacePageHeader className="border-b">
        <SidebarTrigger className="md:hidden" />
        <BotIcon className="size-4" />
        <h1 className="font-medium">Developer assistant</h1>
        <select
          aria-label="Environment"
          className={`${selectClass} ml-auto max-w-56`}
          value={environment?.environmentId ?? ""}
          onChange={(e) => setChosen(e.target.value as EnvironmentId)}
        >
          {environments.map((e) => (
            <option key={e.environmentId} value={e.environmentId}>
              {e.label}
            </option>
          ))}
        </select>
      </WorkspacePageHeader>
      {environment ? (
        <AssistantEnvironment key={environment.environmentId} environment={environment} />
      ) : (
        <p className="p-6 text-muted-foreground">Connect an environment to manage development.</p>
      )}
    </SidebarInset>
  );
}

function AssistantEnvironment({ environment }: { environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const allProjects = useProjects();
  const projects = allProjects.filter((p) => p.environmentId === environmentId);
  const board = useEnvironmentQuery(developerAssistant.board({ environmentId, input: {} }));
  const control = useAtomCommand(developerAssistant.control);
  const answer = useAtomCommand(developerAssistant.answer);
  const review = useAtomCommand(developerAssistant.review);
  const navigate = useNavigate();
  const [editing, setEditing] = useState<ProjectId | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId }),
    });
  const act = async (action: () => Promise<AtomCommandResult<AssistantBoard, unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  };
  const pending = board.data?.decisions.filter((d) => d.answer === null) ?? [];
  const reviews = board.data?.tasks.filter((t) => t.status === "review") ?? [];
  const active =
    board.data?.tasks.filter((t) =>
      ["preparing", "working", "waiting", "blocked"].includes(t.status),
    ) ?? [];
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Decisions and reviews, in one place</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Your assistant manages issue threads and delivery. Each project works on one issue at
              a time and continues after staging is verified.
            </p>
          </div>
          <Button
            onClick={() => setEditing("new")}
            disabled={
              !projects.some(
                (project) => !board.data?.projects.some((p) => p.config.projectId === project.id),
              ) || board.isPending
            }
          >
            <PlusIcon className="size-4" />
            Set up project
          </Button>
        </div>
        {(error || board.error) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
          >
            {error ?? board.error}
          </p>
        )}
        {editing && (
          <AssistantSetup
            key={editing}
            environment={environment}
            projectIds={
              editing === "new"
                ? projects
                    .filter(
                      (project) =>
                        !board.data?.projects.some((p) => p.config.projectId === project.id),
                    )
                    .map((project) => project.id)
                : [editing]
            }
            initial={
              board.data?.projects.find((p) => p.config.projectId === editing)?.config ?? null
            }
            onClose={() => setEditing(null)}
          />
        )}
        <section aria-label="Projects" className="grid gap-3 sm:grid-cols-2">
          {board.data?.projects.map((p) => (
            <article key={p.config.projectId} className="rounded-xl border p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">
                  {projects.find((x) => x.id === p.config.projectId)?.title ?? p.config.projectId}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {p.status === "running" ? "Running" : "Stopped"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {p.config.assignedToMe
                  ? "Assigned to the connected Linear account"
                  : "All assignees"}{" "}
                · {p.config.baseBranch}
              </p>
              {p.error && (
                <p role="status" className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                  {p.error}
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => openThread(p.threadId)}>
                  Conversation
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      control({
                        environmentId,
                        input: {
                          projectId: p.config.projectId,
                          action: p.status === "running" ? "stop" : "start",
                        },
                      }),
                    )
                  }
                >
                  {p.status === "running" ? (
                    <SquareIcon className="size-3" />
                  ) : (
                    <PlayIcon className="size-3" />
                  )}
                  {p.status === "running" ? "Stop queue" : "Start"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      control({
                        environmentId,
                        input: { projectId: p.config.projectId, action: "interrupt" },
                      }),
                    )
                  }
                >
                  Interrupt work
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={p.status === "running"}
                  onClick={() => setEditing(p.config.projectId)}
                >
                  Setup
                </Button>
                {p.status === "running" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        control({
                          environmentId,
                          input: { projectId: p.config.projectId, action: "wake" },
                        }),
                      )
                    }
                  >
                    Check now
                  </Button>
                )}
              </div>
            </article>
          ))}
          {!board.data?.projects.length && !board.isPending && (
            <p className="col-span-full rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Set up a project, choose the models, and tell your assistant what to focus on.
            </p>
          )}
        </section>
        <section aria-label="Decisions">
          <h2 className="mb-3 flex items-center gap-2 font-medium">
            <MessageCircleQuestionIcon className="size-4" />
            Needs your decision <span className="text-muted-foreground">{pending.length}</span>
          </h2>
          <div className="space-y-3">
            {pending.map((d) => (
              <article key={d.id} className="rounded-xl border p-4">
                <p className="whitespace-pre-wrap text-sm">{d.question}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => openThread(d.threadId)}>
                    Open thread
                  </Button>
                </div>
                {d.kind === "decision" ? (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(() =>
                        answer({
                          environmentId,
                          input: { decisionId: d.id, answer: answers[d.id] ?? "" },
                        }),
                      );
                    }}
                  >
                    <Input
                      aria-label="Your decision"
                      placeholder="Your answer…"
                      value={answers[d.id] ?? ""}
                      onChange={(e) => setAnswers({ ...answers, [d.id]: e.target.value })}
                    />
                    <Button type="submit" size="sm" disabled={busy || !answers[d.id]?.trim()}>
                      Send answer
                    </Button>
                  </form>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Respond to this {d.kind === "approval" ? "permission request" : "question"} in
                    its thread.
                  </p>
                )}
              </article>
            ))}
            {!pending.length && (
              <p className="text-sm text-muted-foreground">No decisions waiting.</p>
            )}
          </div>
        </section>
        <section aria-label="Staging reviews">
          <h2 className="mb-3 flex items-center gap-2 font-medium">
            <CheckIcon className="size-4" />
            Ready for review <span className="text-muted-foreground">{reviews.length}</span>
          </h2>
          <div className="space-y-3">
            {reviews.map((t) => (
              <ReviewCard
                key={t.id}
                task={t}
                busy={busy}
                openThread={openThread}
                onReview={(action, feedback) =>
                  void act(() =>
                    review({ environmentId, input: { taskId: t.id, action, feedback } }),
                  )
                }
              />
            ))}
            {!reviews.length && (
              <p className="text-sm text-muted-foreground">
                Verified staging deployments will appear here. Your review does not hold up the next
                issue.
              </p>
            )}
          </div>
        </section>
        <section aria-label="Work in progress">
          <h2 className="mb-3 font-medium">Work in progress</h2>
          <div className="space-y-3">
            {active.map((t) => (
              <article key={t.id} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    className="text-left text-sm font-medium hover:underline"
                    onClick={() => openThread(t.threadId)}
                  >
                    {t.issue.identifier} · {t.issue.title}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {t.status} · {t.turns} turns
                  </span>
                </div>
                {t.error && (
                  <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">{t.error}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        review({
                          environmentId,
                          input: {
                            taskId: t.id,
                            action: "retry",
                            feedback: "Please inspect the blocker and continue.",
                          },
                        }),
                      )
                    }
                  >
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        review({
                          environmentId,
                          input: {
                            taskId: t.id,
                            action: "skip",
                            feedback: "Skipped from the assistant board.",
                          },
                        }),
                      )
                    }
                  >
                    Skip issue
                  </Button>
                </div>
              </article>
            ))}
            {!active.length && (
              <p className="text-sm text-muted-foreground">No issue is executing.</p>
            )}
          </div>
        </section>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Completed and skipped work
          </summary>
          <ul className="mt-3 space-y-2">
            {board.data?.tasks
              .filter((t) => ["accepted", "skipped", "changes-requested"].includes(t.status))
              .map((t) => (
                <li key={t.id}>
                  <button className="hover:underline" onClick={() => openThread(t.threadId)}>
                    {t.issue.identifier} · {t.issue.title}
                  </button>
                  <span className="ml-2 text-muted-foreground">{t.status}</span>
                  {t.error && <p className="text-destructive">{t.error}</p>}
                </li>
              ))}
          </ul>
        </details>
      </div>
    </main>
  );
}

function ReviewCard({
  task,
  busy,
  openThread,
  onReview,
}: {
  task: AssistantTask;
  busy: boolean;
  openThread: (id: ThreadId) => void;
  onReview: (action: "accept" | "request-changes", feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  return (
    <article className="rounded-xl border p-4">
      <h3 className="font-medium">
        {task.issue.identifier} · {task.issue.title}
      </h3>
      <p className="mt-2 whitespace-pre-wrap text-sm">{task.summary}</p>
      <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
        {task.reviewInstructions}
      </p>
      {task.error && <p className="mt-2 text-sm text-destructive">{task.error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {task.deployment && (
          <a
            href={task.deployment.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm underline"
          >
            Open staging
          </a>
        )}
        <button className="text-sm underline" onClick={() => openThread(task.threadId)}>
          Worker thread
        </button>
        <span className="text-xs text-muted-foreground">
          Verified {task.deployment?.revision.slice(0, 8)} · staging may include later changes
        </span>
      </div>
      <textarea
        aria-label={`Review feedback for ${task.issue.identifier}`}
        className={`${textareaClass} mt-3 min-h-16`}
        placeholder="Feedback or changes you'd like…"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => onReview("accept", feedback)}>
          Accept
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !feedback.trim()}
          onClick={() => onReview("request-changes", feedback)}
        >
          Request changes
        </Button>
      </div>
    </article>
  );
}

function AssistantSetup({
  environment,
  projectIds,
  initial,
  onClose,
}: {
  environment: EnvironmentPresentation;
  projectIds: ReadonlyArray<ProjectId>;
  initial: AssistantProjectConfig | null;
  onClose: () => void;
}) {
  const allProjects = useProjects();
  const projects = allProjects.filter(
    (p) => p.environmentId === environment.environmentId && projectIds.includes(p.id),
  );
  const workspace = useEnvironmentQuery(
    linearEnvironment.workspace({ environmentId: environment.environmentId, input: {} }),
  );
  const configure = useAtomCommand(developerAssistant.configure);
  const providers = environment.serverConfig?.providers ?? [];
  const defaultModel = resolveDefaultProviderModelSelection(providers, initial?.modelSelection);
  const [projectId, setProjectId] = useState(initial?.projectId ?? projects[0]?.id ?? "");
  const [linearProjectId, setLinearProjectId] = useState(initial?.linearProjectId ?? "");
  const [model, setModel] = useState<ModelSelection | null>(defaultModel);
  const [workerModel, setWorkerModel] = useState<ModelSelection | null>(
    initial?.workerModelSelection ?? defaultModel,
  );
  const [assignedToMe, setAssignedToMe] = useState(initial?.assignedToMe ?? true);
  const [readyStates, setReadyStates] = useState(initial?.readyStates.join(", ") ?? "");
  const [baseBranch, setBaseBranch] = useState(initial?.baseBranch ?? "develop");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [command, setCommand] = useState(initial?.stagingCheckCommand ?? "");
  const [runtimeMode, setRuntimeMode] = useState(initial?.runtimeMode ?? "approval-required");
  const [reviewState, setReviewState] = useState(initial?.reviewState ?? "In Review");
  const [acceptedState, setAcceptedState] = useState(initial?.acceptedState ?? "Done");
  const [maxTurns, setMaxTurns] = useState(initial?.maxWorkerTurns ?? 6);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linearProjects = [
    ...new Map(
      workspace.data?.teams.flatMap((t) => t.projects).map((p) => [p.id, p]) ?? [],
    ).values(),
  ];
  const picker = (selection: ModelSelection | null, set: (value: ModelSelection) => void) =>
    selection ? (
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries(providers)}
        modelOptionsByInstance={getCustomModelOptionsByInstance(
          {
            ...DEFAULT_SERVER_SETTINGS,
            ...DEFAULT_CLIENT_SETTINGS,
            ...environment.serverConfig?.settings,
          },
          providers,
          selection.instanceId,
          selection.model,
        )}
        onInstanceModelChange={(instanceId, model) => set(createModelSelection(instanceId, model))}
      />
    ) : (
      <p className="text-sm text-muted-foreground">Configure a provider first.</p>
    );
  return (
    <form
      className="rounded-xl border bg-muted/20 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!model || !workerModel || !projectId) return;
        setBusy(true);
        setError(null);
        try {
          const result = await configure({
            environmentId: environment.environmentId,
            input: {
              projectId: ProjectId.make(projectId),
              linearProjectId,
              assignedToMe,
              readyStates: readyStates
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              modelSelection: model,
              workerModelSelection: workerModel,
              runtimeMode,
              baseBranch,
              instructions,
              stagingCheckCommand: command,
              reviewState,
              acceptedState,
              maxWorkerTurns: maxTurns,
            },
          });
          if (result._tag === "Success") onClose();
          else if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="mb-4 font-medium">Project setup</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          T3 project
          <select
            required
            disabled={initial !== null}
            className={selectClass}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Linear project
          <select
            required
            className={selectClass}
            value={linearProjectId}
            onChange={(e) => setLinearProjectId(e.target.value)}
          >
            <option value="">Choose project</option>
            {linearProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-1 text-sm">
          <span>Assistant model</span>
          {picker(model, setModel)}
        </div>
        <div className="grid gap-1 text-sm">
          <span>Coding model</span>
          {picker(workerModel, setWorkerModel)}
        </div>
        <label className="grid gap-1 text-sm">
          Issue scope
          <select
            className={selectClass}
            value={assignedToMe ? "me" : "all"}
            onChange={(e) => setAssignedToMe(e.target.value === "me")}
          >
            <option value="me">Assigned to the connected Linear account</option>
            <option value="all">All issues in the project</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Ready state names
          <Input
            value={readyStates}
            onChange={(e) => setReadyStates(e.target.value)}
            placeholder="Empty: all unstarted issues"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Integration branch
          <Input required value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          <span className="text-xs text-muted-foreground">
            The assistant reviews and merges passing work into this branch on origin. Use merge
            commits or fast-forward merges and enable staging deployment from it.
          </span>
        </label>
        <label className="grid gap-1 text-sm">
          Agent permissions
          <select
            className={selectClass}
            value={runtimeMode}
            onChange={(e) =>
              setRuntimeMode(e.target.value as AssistantProjectConfig["runtimeMode"])
            }
          >
            <option value="approval-required">Ask for command approvals</option>
            <option value="full-access">Run unattended with full access</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          Project instructions
          <textarea
            className={textareaClass}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Environment setup, isolated database, verification commands, code review requirements, and deployment workflow…"
          />
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          Staging verification command
          <Input
            required
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="node scripts/check-staging.mjs"
          />
          <span className="text-xs text-muted-foreground">
            Runs on the T3 server at the project root. Check the actual staging deployment and its
            health, then print JSON with a full commit SHA in “revision” and the review address in
            “url”. Exit nonzero while deployment is pending or failed.
          </span>
        </label>
        <label className="grid gap-1 text-sm">
          Linear state after staging
          <Input
            value={reviewState}
            onChange={(e) => setReviewState(e.target.value)}
            placeholder="Leave empty to keep the state"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Linear state after acceptance
          <Input
            value={acceptedState}
            onChange={(e) => setAcceptedState(e.target.value)}
            placeholder="Leave empty to keep the state"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Worker turns before asking for help
          <Input
            type="number"
            min={1}
            max={30}
            value={maxTurns}
            onChange={(e) => setMaxTurns(Number(e.target.value))}
          />
        </label>
      </div>
      {(error || workspace.error) && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error ?? workspace.error}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={busy || !model || !workerModel || !linearProjectId}>
          Save setup
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
