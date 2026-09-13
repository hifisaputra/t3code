import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type AssistantProjectConfig,
  type ModelSelection,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { Link } from "@tanstack/react-router";
import { FolderGit2Icon, SparklesIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
} from "~/providerInstances";
import { developerAssistant } from "~/state/developerAssistant";
import { useProjects } from "~/state/entities";
import type { EnvironmentPresentation } from "~/state/environments";
import { linearEnvironment } from "~/state/linear";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useAssistantAction } from "./assistantUi";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <span className="font-medium text-sm">{label}</span>
      {children}
      {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-border/60 border-t pt-5 first:border-t-0 first:pt-0">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

function PermissionToggle({
  value,
  onChange,
  label,
  first,
}: {
  value: RuntimeMode;
  onChange: (value: RuntimeMode) => void;
  label: string;
  first: RuntimeMode;
}) {
  const ask = { value: "approval-required", label: "Ask before commands" } as const;
  const full = { value: "full-access", label: "Full access" } as const;
  // Each choice leads with its default, so the first option is the usual one.
  const options = first === "full-access" ? [full, ask] : [ask, full];
  return (
    <ToggleGroup
      aria-label={label}
      variant="segmented"
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0];
        if (picked === "full-access" || picked === "approval-required") onChange(picked);
      }}
    >
      {options.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/**
 * Starts (or restarts, for an existing project) the setup conversation. The
 * choices here are the ones the assistant cannot discover for itself; the
 * conversation finds everything else and proposes it for review.
 */
export function AssistantSetupDialog({
  open,
  onOpenChange,
  environment,
  projectIds,
  initial,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: EnvironmentPresentation;
  projectIds: ReadonlyArray<ProjectId>;
  initial: AssistantProjectConfig | null;
  onStarted: (threadId: ThreadId) => void;
}) {
  const environmentId = environment.environmentId;
  const allProjects = useProjects();
  const projects = allProjects.filter(
    (p) => p.environmentId === environmentId && projectIds.includes(p.id),
  );
  const workspace = useEnvironmentQuery(
    open ? linearEnvironment.workspace({ environmentId, input: {} }) : null,
  );
  const beginSetup = useAtomCommand(developerAssistant.beginSetup);
  const { pending, run } = useAssistantAction();
  const providers = environment.serverConfig?.providers ?? [];
  const defaultModel = resolveDefaultProviderModelSelection(providers, initial?.modelSelection);
  const [projectId, setProjectId] = useState<string>(initial?.projectId ?? projects[0]?.id ?? "");
  const [linearProjectId, setLinearProjectId] = useState(initial?.linearProjectId ?? "");
  const [model, setModel] = useState<ModelSelection | null>(defaultModel);
  const [workerModel, setWorkerModel] = useState<ModelSelection | null>(
    initial?.workerModelSelection ?? defaultModel,
  );
  const [assignedToMe, setAssignedToMe] = useState(initial?.assignedToMe ?? true);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    initial?.runtimeMode ?? "approval-required",
  );
  const [setupRuntimeMode, setSetupRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [context, setContext] = useState("");

  const linearProjects = [
    ...new Map(
      workspace.data?.teams.flatMap((t) => t.projects).map((p) => [p.id, p]) ?? [],
    ).values(),
  ].toSorted((a, b) => a.name.localeCompare(b.name));
  const project = projects.find((p) => p.id === projectId) ?? null;
  const linearProject = linearProjects.find((p) => p.id === linearProjectId) ?? null;
  const busy = pending !== null;
  const missing = !project
    ? "Choose a repository."
    : !linearProjectId
      ? "Choose the Linear project to take issues from."
      : !model || !workerModel
        ? "Set up a provider first."
        : null;

  const picker = (
    selection: ModelSelection | null,
    set: (value: ModelSelection) => void,
    label: string,
  ) =>
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
        size="sm"
        triggerVariant="outline"
        triggerClassName="w-full justify-between"
        triggerAriaLabel={label}
        disabled={busy}
        onInstanceModelChange={(instanceId, next) => set(createModelSelection(instanceId, next))}
      />
    ) : (
      <span className="text-muted-foreground text-sm">
        No provider is set up.{" "}
        <Link to="/settings/providers" className="underline underline-offset-2">
          Add one in Settings
        </Link>
        .
      </span>
    );

  const submit = async () => {
    if (missing || !model || !workerModel) return;
    let threadId: ThreadId | null = null;
    const ok = await run(
      "begin",
      async () => {
        const result = await beginSetup({
          environmentId,
          input: {
            projectId: ProjectId.make(projectId),
            linearProjectId,
            assignedToMe,
            modelSelection: model,
            workerModelSelection: workerModel,
            runtimeMode,
            setupRuntimeMode,
            context,
          },
        });
        if (result._tag === "Success") threadId = result.value.threadId;
        return result;
      },
      { failure: "Could not start the setup conversation" },
    );
    if (ok && threadId) {
      onOpenChange(false);
      onStarted(threadId);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4" />
            {initial ? `Revise ${project?.title ?? "project"} setup` : "Add a project"}
          </DialogTitle>
          <DialogDescription>
            Pick the repository, its Linear project and the models. Your assistant then reads the
            repository and its deployments, asks you what it cannot find, and proposes a setup for
            you to review. It reads only: nothing changes and nothing deploys.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-5">
          <Group title="Work">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Repository">
                <Select
                  value={projectId}
                  onValueChange={(next) => setProjectId(String(next))}
                  disabled={initial !== null || busy}
                >
                  <SelectTrigger aria-label="Repository">
                    <SelectValue>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <FolderGit2Icon className="size-3.5 text-muted-foreground" />
                        <span className="truncate">{project?.title ?? "Choose a repository"}</span>
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="truncate">{p.title}</span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field
                label="Linear project"
                hint={
                  workspace.error ? (
                    <span className="text-destructive">{workspace.error}</span>
                  ) : undefined
                }
              >
                <Select
                  value={linearProjectId}
                  onValueChange={(next) => setLinearProjectId(String(next))}
                  disabled={busy || linearProjects.length === 0}
                >
                  <SelectTrigger aria-label="Linear project">
                    <SelectValue>
                      <span className="truncate">
                        {linearProject?.name ??
                          (workspace.data ? "Choose a project" : "Loading Linear projects…")}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {linearProjects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="truncate">{p.name}</span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            <Field
              label="Which issues"
              hint={
                assignedToMe
                  ? "Issues assigned to the Linear account connected on this server."
                  : "Any issue in the project, whoever it is assigned to."
              }
            >
              <ToggleGroup
                aria-label="Which issues"
                variant="segmented"
                value={[assignedToMe ? "me" : "all"]}
                onValueChange={(next) => {
                  if (next[0]) setAssignedToMe(next[0] === "me");
                }}
              >
                <Toggle value="me">Assigned to me</Toggle>
                <Toggle value="all">Everyone&apos;s</Toggle>
              </ToggleGroup>
            </Field>
          </Group>

          <Group title="Models">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Assistant" hint="Picks issues, reviews and merges the work.">
                {picker(model, setModel, "Assistant model")}
              </Field>
              <Field label="Coding worker" hint="Writes the code, one issue at a time.">
                {picker(workerModel, setWorkerModel, "Coding model")}
              </Field>
            </div>
          </Group>

          <Group title="Permissions">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="While working on issues"
                hint={
                  runtimeMode === "full-access"
                    ? "Runs commands unattended, within the provider's own limits."
                    : "Each command waits for your approval in its thread."
                }
              >
                <PermissionToggle
                  label="Permissions while working on issues"
                  value={runtimeMode}
                  onChange={setRuntimeMode}
                  first="approval-required"
                />
              </Field>
              <Field label="During setup" hint="Setup only reads the project, whichever you pick.">
                <PermissionToggle
                  label="Permissions during setup"
                  value={setupRuntimeMode}
                  onChange={setSetupRuntimeMode}
                  first="full-access"
                />
              </Field>
            </div>
          </Group>

          <Group title="Anything it should know?">
            <Textarea
              aria-label="Notes for your assistant"
              maxLength={20000}
              value={context}
              disabled={busy}
              onChange={(event) => setContext(event.target.value)}
              placeholder="For example: staging is called “test” in Railway. Use the existing test account for browser checks."
              className="[&_textarea]:min-h-20"
            />
            <p className="-mt-2 text-muted-foreground text-xs">
              Optional. Don&apos;t paste credentials: sign in to providers the usual way on the
              server instead.
            </p>
          </Group>
        </DialogPanel>
        <DialogFooter className="items-center">
          <p className="min-w-0 flex-1 text-muted-foreground text-xs">
            {missing ?? "Nothing runs on its own until you save the setup and press Start."}
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || missing !== null} onClick={() => void submit()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            {busy ? "Opening conversation…" : "Start setup conversation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
