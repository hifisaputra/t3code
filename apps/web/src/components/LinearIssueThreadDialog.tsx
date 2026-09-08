import type {
  EnvironmentId,
  LinearBranchNaming,
  LinearIssueDetail,
  LinearIssueSummary,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  DEFAULT_SERVER_SETTINGS,
  defaultLinearBranchPrefix,
  linearIssueBranchName,
  LINEAR_DEFAULT_BRANCH_PREFIXES,
  LINEAR_DEFAULT_LABEL_BRANCH_PREFIXES,
  resolveLinearRepositoryMapping,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CircleDotIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GitBranchIcon,
  PlayIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { newMessageId, newThreadId } from "~/lib/utils";
import { formatLinearIssueKickoff, hasLinearWorkSkill } from "~/linearIssueComposerSeed";
import { parseLinearIssueReference } from "~/linearIssueReference";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useEnvironments } from "~/state/environments";
import { linearEnvironment } from "~/state/linear";
import { usePrepareIssueThreadAction, useLinearIssueResolution } from "~/state/linearActions";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "~/types";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import ChatMarkdown from "./ChatMarkdown";
import { IssueStateDot } from "./issues/IssueRow";
import {
  filterLinearIssues,
  linearBranchPrefixOptions,
  linearBranchProblem,
  linearIssueThreadMessage,
  linearIssueThreadTitle,
} from "./linearIssueThreadDialog.logic";
import { useOpenIssueLink } from "./ThreadStatusIndicators";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "./ui/autocomplete";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

/** How many of my issues the picker lists. Enough to recognise one, short enough to scan. */
const MY_ISSUES_LIMIT = 20;

type ThreadMode = "local" | "worktree";

interface LinearIssueThreadDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  /** Every project on this environment; the dialog picks the one the issue belongs to. */
  projects: ReadonlyArray<EnvironmentProject>;
  /** Where the caller was, used when no mapping claims the issue. */
  defaultProjectId: ProjectId | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  /** The thread is created and its first turn is running; the caller shows it. */
  onStarted: (threadRef: ScopedThreadRef) => void;
}

/** What the branch row falls back to before the environment's settings arrive. */
const DEFAULT_BRANCH_NAMING: LinearBranchNaming = {
  style: "linear",
  prefixes: LINEAR_DEFAULT_BRANCH_PREFIXES,
  labelPrefixes: LINEAR_DEFAULT_LABEL_BRANCH_PREFIXES,
};

/**
 * Start a thread from a Linear issue.
 *
 * Two panes: the left one picks an issue, by reference or from the list of
 * mine, and the right one reads it, description included, so what the thread
 * is for is on screen before it is started. Under the reader sits the launch
 * panel: which checkout the thread starts in, whether it gets its own
 * worktree, what the branch is called, which model runs it, and an optional
 * note for the agent.
 *
 * Starting is one step. The dialog checks the branch out, then creates the
 * thread and its first turn in a single command, so there is no draft to
 * press Enter in: the kickoff prompt that used to be seeded into the composer
 * is sent as the first message. The caller only has to show the thread.
 *
 * The branch row follows the `linear.branchNaming` setting: under Linear's own
 * format there is nothing to decide and the issue's `branchName` is shown as a
 * fact, while the repository convention offers the prefix and lets the whole
 * name be typed over. Either way it has to carry the issue identifier, which
 * is what makes Linear recognise the pull request later. The checkout is not
 * the caller's either: the issue's team or Linear project decides it through
 * the repository mapping, and the caller's project is only the fallback.
 */
export function LinearIssueThreadDialog({
  open,
  environmentId,
  projects,
  defaultProjectId,
  initialReference,
  onOpenChange,
  onStarted,
}: LinearIssueThreadDialogProps) {
  const navigate = useNavigate();
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState("");
  const [modeOverride, setModeOverride] = useState<ThreadMode | null>(null);
  // "preparing" while the branch is being checked out, "starting" while the
  // thread and its first turn are being created. The footer names each.
  const [phase, setPhase] = useState<"preparing" | "starting" | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Tied to the issue it was chosen for, so resolving a different issue falls
  // back to that issue's own mapping instead of keeping a stale override.
  const [override, setOverride] = useState<{ issueId: string; projectId: ProjectId } | null>(null);
  // Tied to the project, whose default it replaces: the mapping can move the
  // thread to another checkout, and that one has a default of its own.
  const [modelPick, setModelPick] = useState<{
    projectId: ProjectId;
    selection: ModelSelection;
  } | null>(null);
  // Tied to its issue the same way, so resolving another issue starts from
  // that issue's own default rather than the branch typed for the last one.
  const [branchDraft, setBranchDraft] = useState<{
    issueId: string;
    prefix: string;
    branch: string;
  } | null>(null);
  // The dialog stays mounted between openings, so a branch left in the box
  // would greet the next issue that happens to resolve to the same id.
  // Dropped while rendering the closed dialog, since an effect would have to
  // render the stale draft once before clearing it.
  const [branchDraftOpen, setBranchDraftOpen] = useState(open);
  if (branchDraftOpen !== open) {
    setBranchDraftOpen(open);
    if (!open) {
      setBranchDraft(null);
      setNote("");
      setStartError(null);
    }
  }
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parseLinearIssueReference(reference);
  const parsedDebouncedReference = parseLinearIssueReference(debouncedReference);
  const issueResolution = useLinearIssueResolution({
    environmentId,
    reference: open ? parsedDebouncedReference : null,
  });

  const status = useEnvironmentQuery(
    open ? linearEnvironment.status({ environmentId, input: {} }) : null,
  );
  const linearConnected = status.data?.status === "connected";
  const linearNeedsSetup =
    status.data?.status === "unconfigured" || status.data?.status === "unauthenticated";
  // Nothing to list until the key works; the sentence below says which of the
  // three reasons it is rather than showing an empty box.
  const linearUnavailableSentence =
    status.data?.status === "failed" ? status.data.detail : (status.error ?? "Checking Linear…");
  const myIssues = useEnvironmentQuery(
    open && linearConnected
      ? linearEnvironment.issues({ environmentId, input: { limit: MY_ISSUES_LIMIT } })
      : null,
  );
  const listedIssues = useMemo(
    () => (myIssues.data ? filterLinearIssues(myIssues.data.issues, reference) : null),
    [myIssues.data, reference],
  );

  const resolvedIssue =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? issueResolution.data
      : null;

  const { environments } = useEnvironments();
  const serverConfig = useMemo(
    () =>
      environments.find((environment) => environment.environmentId === environmentId)
        ?.serverConfig ?? null,
    [environmentId, environments],
  );
  const serverSettings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const linearSettings = serverConfig?.settings.linear ?? null;
  const repositories = linearSettings?.repositories ?? [];
  const branchNaming = linearSettings?.branchNaming ?? DEFAULT_BRANCH_NAMING;
  const mappedProjectId = resolvedIssue
    ? (resolveLinearRepositoryMapping(repositories, resolvedIssue)?.projectId ?? null)
    : null;
  const overrideProjectId =
    override !== null && resolvedIssue !== null && override.issueId === resolvedIssue.id
      ? override.projectId
      : null;
  const findProject = (projectId: ProjectId | null) =>
    projectId === null ? undefined : projects.find((project) => project.id === projectId);
  const targetProject =
    findProject(overrideProjectId) ??
    findProject(mappedProjectId) ??
    findProject(defaultProjectId) ??
    projects[0] ??
    null;
  const cwd = targetProject?.workspaceRoot ?? null;
  const scope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const prepareIssueThreadAction = usePrepareIssueThreadAction(scope);
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  // Worktree unless the project, or the server, says threads start locally.
  const mode: ThreadMode =
    modeOverride ?? targetProject?.defaultThreadEnvMode ?? serverSettings.defaultThreadEnvMode;

  // The model row is the composer's picker fed the same way the project
  // defaults page feeds it, defaulting like a new draft would: the project's
  // pinned model, then the server's, then whatever was picked last.
  const providers = serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const clientSettings = useClientSettings();
  const unifiedSettings = useMemo(
    () => ({ ...serverSettings, ...clientSettings }),
    [clientSettings, serverSettings],
  );
  const providerEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), unifiedSettings),
      ),
    [providers, unifiedSettings],
  );
  const stickyProvider = useComposerDraftStore((store) => store.stickyActiveProvider);
  const stickySelection = useComposerDraftStore((store) =>
    stickyProvider ? (store.stickyModelSelectionByProvider[stickyProvider] ?? null) : null,
  );
  const pickedSelection =
    modelPick !== null && targetProject !== null && modelPick.projectId === targetProject.id
      ? modelPick.selection
      : null;
  const modelSelection = resolveDefaultProviderModelSelection(
    providers,
    pickedSelection ??
      targetProject?.defaultModelSelection ??
      serverSettings.defaultModelSelection ??
      stickySelection,
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        unifiedSettings,
        providers,
        modelSelection?.instanceId,
        modelSelection?.model,
      ),
    [modelSelection?.instanceId, modelSelection?.model, providers, unifiedSettings],
  );

  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedIssue === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      issueResolution.isPending ||
      issueResolution.isFetching);

  // Only the prefixed style has anything to choose; under Linear's own format
  // the branch is the issue's, and the row states it instead of offering it.
  const branchIsEditable = resolvedIssue !== null && branchNaming.style === "prefixed";
  const activeBranchDraft =
    branchDraft !== null && resolvedIssue !== null && branchDraft.issueId === resolvedIssue.id
      ? branchDraft
      : null;
  const branchPrefix =
    activeBranchDraft?.prefix ??
    (resolvedIssue === null ? null : defaultLinearBranchPrefix(resolvedIssue, branchNaming));
  const branchPrefixOptions = branchIsEditable
    ? linearBranchPrefixOptions(branchNaming.prefixes, branchPrefix)
    : [];
  const branchName =
    activeBranchDraft?.branch ??
    (resolvedIssue === null ? "" : linearIssueBranchName(resolvedIssue, branchNaming));
  const branchProblem =
    branchIsEditable && resolvedIssue !== null
      ? linearBranchProblem(branchName, resolvedIssue.identifier)
      : null;

  const editBranch = (patch: { prefix?: string; branch?: string }) => {
    if (resolvedIssue === null) return;
    const prefix = patch.prefix ?? branchPrefix ?? "";
    setBranchDraft({
      issueId: resolvedIssue.id,
      prefix,
      // A prefix change renames the branch even after it was typed over: the
      // suffix is the part worth keeping, and the person just asked for a
      // different namespace.
      branch: patch.branch ?? linearIssueBranchName(resolvedIssue, branchNaming, prefix),
    });
  };

  const busy = phase !== null;
  const canStart =
    targetProject !== null &&
    resolvedIssue !== null &&
    modelSelection !== null &&
    !isResolving &&
    !busy &&
    branchProblem === null;

  const handleStart = useCallback(async () => {
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    if (!resolvedIssue || !targetProject || !modelSelection || branchProblem !== null) {
      return;
    }
    // Minted here so the worktree setup script can already run for the
    // thread that is about to exist.
    const threadId = newThreadId();
    setStartError(null);
    setPhase("preparing");
    const prepared = await prepareIssueThreadAction.run({
      reference: parsedReference,
      mode,
      // Under Linear's own format there is nothing the dialog knows that the
      // server does not, so it names the branch itself.
      ...(branchIsEditable ? { branch: branchName.trim() } : {}),
      ...(mode === "worktree" ? { threadId } : {}),
    });
    if (prepared._tag === "Failure") {
      if (isAtomCommandInterrupted(prepared)) {
        prepareIssueThreadAction.resetError();
      }
      setPhase(null);
      return;
    }
    const { branch, worktreePath, issue, movedToState } = prepared.value;

    setPhase("starting");
    // The issue's own server decides the kickoff: it owns the Linear key and
    // the toggle that gives the agent tools, and it discovered the skills.
    const linear = serverConfig?.settings.linear;
    const kickoff = formatLinearIssueKickoff(issue, {
      agentTools: (linear?.agentAccess ?? false) && (linear?.apiKey ?? "").length > 0,
      skill: hasLinearWorkSkill(
        serverConfig?.providers ?? [],
        worktreePath ?? targetProject.workspaceRoot,
      ),
    });
    const title = linearIssueThreadTitle(issue);
    const createdAt = new Date().toISOString();
    const started = await startThreadTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: linearIssueThreadMessage(kickoff, note),
          attachments: [],
        },
        modelSelection,
        titleSeed: title,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        bootstrap: {
          createThread: {
            projectId: targetProject.id,
            title,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch,
            worktreePath,
            // On the create, so the thread has the link from its first event
            // rather than in a second command that could lose the race with
            // the turn.
            linkedIssue: {
              provider: "linear",
              id: issue.id,
              identifier: issue.identifier,
              url: issue.url,
            },
            createdAt,
          },
        },
        createdAt,
      },
    });
    setPhase(null);
    if (started._tag === "Failure") {
      if (!isAtomCommandInterrupted(started)) {
        const error = squashAtomCommandFailure(started);
        // The branch is checked out by now; saying so keeps a retry from
        // reading as a second checkout.
        setStartError(
          `${branch} is ready, but the thread could not start: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
      return;
    }
    if (movedToState) {
      toastManager.add({
        type: "success",
        title: `Moved to ${movedToState.name}`,
        description: issue.identifier,
      });
    }
    onStarted(scopeThreadRef(environmentId, threadId));
    onOpenChange(false);
  }, [
    branchIsEditable,
    branchName,
    branchProblem,
    environmentId,
    mode,
    modelSelection,
    note,
    onOpenChange,
    onStarted,
    parsedReference,
    prepareIssueThreadAction,
    resolvedIssue,
    serverConfig,
    startThreadTurn,
    targetProject,
  ]);

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? "Paste a Linear issue URL, or enter DEL-123."
      : parsedReference === null && (listedIssues?.length ?? 0) === 0
        ? "Use a Linear issue URL or an identifier such as DEL-123."
        : null;
  const resolutionError =
    resolvedIssue === null && parsedReference !== null && !isResolving
      ? issueResolution.error
      : null;
  const prepareError =
    prepareIssueThreadAction.error instanceof Error
      ? prepareIssueThreadAction.error.message
      : prepareIssueThreadAction.error
        ? "Could not check out the issue's branch."
        : null;
  const footerError = startError ?? prepareError;

  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    if (event.currentTarget.tagName === "TEXTAREA" && !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (canStart) void handleStart();
  };
  // Enter in the box picks the highlighted suggestion while the list is up,
  // and starts the thread once it is down; the two never share a keypress.
  const pickerHasSuggestions = pickerOpen && (listedIssues?.length ?? 0) > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-5xl sm:h-[48rem]">
        <DialogHeader className="pb-3">
          <DialogTitle className="flex items-center gap-2">
            <CircleDotIcon className="size-4" />
            Start thread from issue
          </DialogTitle>
          <DialogDescription>
            Pick an issue and check where it runs. The agent starts on it as soon as you do.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5 px-6 pb-3">
          <Autocomplete
            items={listedIssues ?? []}
            itemToStringValue={(issue) => issue.identifier}
            filter={null}
            mode="none"
            autoHighlight
            openOnInputClick
            open={pickerOpen && linearConnected}
            onOpenChange={setPickerOpen}
            value={reference}
            onValueChange={(value) => {
              setReferenceDirty(true);
              setReference(value);
            }}
          >
            <AutocompleteInput
              ref={referenceInputRef}
              aria-label="Issue"
              startAddon={<SearchIcon />}
              placeholder="Search your issues, or paste DEL-123 or a Linear link"
              spellCheck={false}
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter" && pickerHasSuggestions) return;
                submitOnEnter(event);
              }}
            />
            {linearConnected ? (
              <AutocompletePopup>
                <IssueSuggestions
                  issues={listedIssues}
                  filtered={reference.trim().length > 0}
                  isPending={myIssues.isPending}
                  error={myIssues.error}
                />
              </AutocompletePopup>
            ) : null}
          </Autocomplete>
          {validationMessage ? (
            <span className="text-destructive text-xs">{validationMessage}</span>
          ) : !linearConnected && !linearNeedsSetup ? (
            <span className="text-muted-foreground text-xs">{linearUnavailableSentence}</span>
          ) : linearNeedsSetup ? (
            <span className="text-muted-foreground text-xs">
              Linear is not connected.{" "}
              <Link
                to="/settings/integrations"
                className="underline underline-offset-2"
                onClick={() => onOpenChange(false)}
              >
                Connect it in Settings → Integrations
              </Link>
              .
            </span>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <ScrollArea scrollFade className="min-h-0 flex-1 border-border/60 border-t">
            <div className="px-6 py-4">
              {resolvedIssue ? (
                <IssueReader
                  issue={resolvedIssue}
                  environmentId={environmentId}
                  cwd={cwd}
                  // The reader may already show an older answer while a fresh
                  // one is on its way; that one refresh does not deserve a
                  // spinner over a description the person is reading.
                  refreshing={issueResolution.isFetching}
                />
              ) : isResolving ? (
                <ReaderNotice>
                  <Spinner className="size-3.5" />
                  Resolving {parsedReference}...
                </ReaderNotice>
              ) : resolutionError ? (
                <ReaderNotice tone="error">{resolutionError}</ReaderNotice>
              ) : (
                <EmptyReader />
              )}
            </div>
          </ScrollArea>

          {resolvedIssue && targetProject ? (
            <LaunchPanel
              projects={projects}
              targetProject={targetProject}
              onProjectChange={(projectId) => setOverride({ issueId: resolvedIssue.id, projectId })}
              mode={mode}
              onModeChange={setModeOverride}
              branch={
                branchIsEditable
                  ? {
                      editable: true,
                      prefix: branchPrefix ?? "",
                      prefixOptions: branchPrefixOptions,
                      name: branchName,
                      problem: branchProblem,
                      onEdit: editBranch,
                    }
                  : { editable: false, name: resolvedIssue.branchName }
              }
              model={
                modelSelection
                  ? {
                      selection: modelSelection,
                      entries: providerEntries,
                      optionsByInstance: modelOptionsByInstance,
                      onChange: (instanceId, model) =>
                        setModelPick({
                          projectId: targetProject.id,
                          selection: createModelSelection(instanceId, model),
                        }),
                      onOpenProviderSetup: (instanceId) => {
                        onOpenChange(false);
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId, instanceId },
                        });
                      },
                    }
                  : null
              }
              note={note}
              onNoteChange={setNote}
              onNoteKeyDown={submitOnEnter}
              disabled={busy}
            />
          ) : null}
        </div>

        <DialogFooter className="items-center">
          <p
            className={
              footerError
                ? "min-w-0 flex-1 text-destructive text-xs"
                : "min-w-0 flex-1 truncate text-muted-foreground text-xs"
            }
          >
            {footerError ??
              (resolvedIssue && targetProject
                ? `${mode === "worktree" ? "New worktree" : "Local checkout"} on ${branchName || resolvedIssue.branchName}`
                : "")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleStart();
            }}
            disabled={!canStart}
          >
            {phase === "preparing" ? (
              <>
                <Spinner className="size-3.5" />
                Checking out branch...
              </>
            ) : phase === "starting" ? (
              <>
                <Spinner className="size-3.5" />
                Starting agent...
              </>
            ) : (
              <>
                <PlayIcon className="size-3.5" />
                Start thread
                <Kbd className="ml-1">↵</Kbd>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface LaunchPanelProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly targetProject: EnvironmentProject;
  readonly onProjectChange: (projectId: ProjectId) => void;
  readonly mode: ThreadMode;
  readonly onModeChange: (mode: ThreadMode) => void;
  readonly branch:
    | {
        readonly editable: true;
        readonly prefix: string;
        readonly prefixOptions: ReadonlyArray<string>;
        readonly name: string;
        readonly problem: string | null;
        readonly onEdit: (patch: { prefix?: string; branch?: string }) => void;
      }
    | { readonly editable: false; readonly name: string };
  readonly model: {
    readonly selection: ModelSelection;
    readonly entries: Parameters<typeof ProviderModelPicker>[0]["instanceEntries"];
    readonly optionsByInstance: Parameters<typeof ProviderModelPicker>[0]["modelOptionsByInstance"];
    readonly onChange: (instanceId: ProviderInstanceId, model: string) => void;
    readonly onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  } | null;
  readonly note: string;
  readonly onNoteChange: (note: string) => void;
  readonly onNoteKeyDown: (event: React.KeyboardEvent) => void;
  readonly disabled: boolean;
}

/**
 * Everything the thread needs decided, in one strip under the issue: the
 * checkout, the worktree choice, the branch, the model, and a note. Each row
 * is a fact with a control next to it, so the panel reads as a summary of
 * what "Start thread" will do rather than as a form.
 */
function LaunchPanel({
  projects,
  targetProject,
  onProjectChange,
  mode,
  onModeChange,
  branch,
  model,
  note,
  onNoteChange,
  onNoteKeyDown,
  disabled,
}: LaunchPanelProps) {
  return (
    <div className="grid gap-2.5 border-border/60 border-t bg-muted/24 px-6 py-3.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <LaunchField label="Project">
          {projects.length > 1 ? (
            <Select
              value={targetProject.id}
              onValueChange={(next) => onProjectChange(String(next) as ProjectId)}
              disabled={disabled}
            >
              <SelectTrigger size="xs" className="w-auto min-w-36" aria-label="Project">
                <SelectValue>
                  <span className="flex items-center gap-1.5 truncate">
                    <FolderGit2Icon className="size-3.5 text-muted-foreground" />
                    {targetProject.title}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {projects.map((project) => (
                  <SelectItem hideIndicator key={project.id} value={project.id}>
                    <span className="truncate">{project.title}</span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : (
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <FolderGit2Icon className="size-3.5 text-muted-foreground" />
              {targetProject.title}
            </span>
          )}
        </LaunchField>

        <LaunchField label="Run in">
          <ToggleGroup
            aria-label="Where the thread runs"
            variant="segmented"
            value={[mode]}
            disabled={disabled}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "worktree" || next === "local") onModeChange(next);
            }}
          >
            <Toggle value="worktree">New worktree</Toggle>
            <Toggle value="local">This checkout</Toggle>
          </ToggleGroup>
        </LaunchField>

        <LaunchField label="Model">
          {model ? (
            <ProviderModelPicker
              activeInstanceId={model.selection.instanceId}
              model={model.selection.model}
              lockedProvider={null}
              instanceEntries={model.entries}
              modelOptionsByInstance={model.optionsByInstance}
              size="xs"
              triggerVariant="outline"
              disabled={disabled}
              onOpenProviderSetup={model.onOpenProviderSetup}
              onInstanceModelChange={model.onChange}
            />
          ) : (
            <span className="text-muted-foreground">No provider is set up on this server.</span>
          )}
        </LaunchField>
      </div>

      <LaunchField label="Branch" className="items-start">
        {branch.editable ? (
          <div className="grid min-w-0 flex-1 gap-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <Select
                value={branch.prefix}
                onValueChange={(next) => branch.onEdit({ prefix: String(next) })}
                disabled={disabled}
              >
                <SelectTrigger size="xs" className="w-auto min-w-20" aria-label="Branch prefix">
                  <SelectValue>
                    <span className="truncate font-mono">{branch.prefix}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {branch.prefixOptions.map((prefix) => (
                    <SelectItem hideIndicator key={prefix} value={prefix}>
                      <span className="truncate font-mono">{prefix}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Input
                size="sm"
                spellCheck={false}
                aria-label="Branch name"
                aria-invalid={branch.problem !== null}
                className="min-w-0 flex-1 font-mono text-xs"
                value={branch.name}
                disabled={disabled}
                onChange={(event) => branch.onEdit({ branch: event.target.value })}
              />
            </div>
            {branch.problem ? <p className="text-destructive">{branch.problem}</p> : null}
          </div>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-foreground">
            <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{branch.name}</span>
          </span>
        )}
      </LaunchField>

      <LaunchField label="Note" className="items-start">
        <Textarea
          size="sm"
          className="flex-1"
          rows={1}
          placeholder="Anything the ticket does not say. Optional."
          aria-label="Note for the agent"
          value={note}
          disabled={disabled}
          onChange={(event) => onNoteChange(event.target.value)}
          onKeyDown={onNoteKeyDown}
        />
      </LaunchField>
    </div>
  );
}

function LaunchField({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-2 ${className ?? ""}`}>
      <span className="w-14 shrink-0 pt-px text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ReaderNotice({
  tone = "muted",
  children,
}: {
  readonly tone?: "muted" | "error";
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className={
        tone === "error"
          ? "flex items-center gap-2 text-destructive text-xs"
          : "flex items-center gap-2 text-muted-foreground text-xs"
      }
    >
      {children}
    </div>
  );
}

function EmptyReader() {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        <CircleDotIcon className="size-4.5" />
      </span>
      <p className="font-medium text-foreground text-sm">No issue picked yet</p>
      <p className="max-w-64 text-muted-foreground text-xs">
        Choose one of your issues, or paste an identifier or link, to read it here before the agent
        starts on it.
      </p>
    </div>
  );
}

/**
 * The issue as Linear has it right now: who owns it, where it stands, and the
 * description in full. Comments and sub-issues stay on the Issues page; this
 * pane exists so the thread is started by somebody who has read the brief.
 */
function IssueReader({
  issue,
  environmentId,
  cwd,
  refreshing,
}: {
  readonly issue: LinearIssueDetail;
  readonly environmentId: EnvironmentId;
  /** Anchors relative links in the markdown, once a checkout is chosen. */
  readonly cwd: string | null;
  readonly refreshing: boolean;
}) {
  const openIssueLink = useOpenIssueLink();
  const description = issue.description?.trim() ?? "";
  const facts = [
    `${issue.team.name} · ${issue.team.key}`,
    issue.assignee?.displayName ?? issue.assignee?.name ?? "Unassigned",
    ...(issue.project ? [issue.project.name] : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <a
          href={issue.url}
          onClick={(event) => openIssueLink(event, issue.url)}
          className="inline-flex items-center gap-1 font-mono text-muted-foreground text-xs underline-offset-2 hover:underline"
        >
          {issue.identifier}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
        <span className="flex shrink-0 items-center gap-2 text-xs">
          {refreshing ? <Spinner className="size-3" /> : null}
          <IssueStateLabel name={issue.state.name} color={issue.state.color} />
        </span>
      </div>
      <div className="min-w-0">
        <h2 className="font-medium text-base text-foreground leading-snug">{issue.title}</h2>
        <p className="mt-1 truncate text-muted-foreground text-xs">{facts.join(" · ")}</p>
      </div>
      {issue.labels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.labels.map((label) => (
            <span
              key={label.id}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0.5 pr-2 pl-1.5 text-[10px] text-muted-foreground"
            >
              <IssueStateDot color={label.color} className="size-1.5" />
              {label.name}
            </span>
          ))}
        </div>
      ) : null}
      {description.length > 0 ? (
        <ChatMarkdown
          text={description}
          cwd={cwd ?? undefined}
          environmentId={environmentId}
          className="text-sm"
        />
      ) : (
        <p className="text-muted-foreground text-xs">No description.</p>
      )}
      {issue.comments.length > 0 ? (
        <a
          href={issue.url}
          onClick={(event) => openIssueLink(event, issue.url)}
          className="text-muted-foreground text-xs underline-offset-2 hover:underline"
        >
          {issue.comments.length === 1
            ? "1 comment on Linear"
            : `${issue.comments.length} comments on Linear`}
        </a>
      ) : null}
    </div>
  );
}

/**
 * Linear owns the state colour, so it arrives as a hex string rather than a
 * class. Inline is the only way to render a colour the design system does not
 * know about.
 */
function IssueStateLabel({ name, color }: { readonly name: string; readonly color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2 py-0.5 text-xs"
      style={{ color }}
    >
      <IssueStateDot color={color} className="size-1.5" />
      {name}
    </span>
  );
}

/**
 * The rows under the search box: my issues, narrowed by what is typed. Each
 * row is a suggestion whose value is the identifier, so picking one fills
 * the box and the reader below takes over.
 */
function IssueSuggestions({
  issues,
  filtered,
  isPending,
  error,
}: {
  readonly issues: ReadonlyArray<LinearIssueSummary> | null;
  /** Whether the box holds text, so an empty list can say it is the filter's doing. */
  readonly filtered: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
}) {
  if (issues === null && isPending) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
        <Spinner className="size-3.5" />
        Loading your issues...
      </div>
    );
  }
  if (error !== null && issues === null) {
    return <p className="px-3 py-2 text-muted-foreground text-xs">{error}</p>;
  }
  if (issues === null || issues.length === 0) {
    return (
      <AutocompleteEmpty className="px-3 py-2 text-left text-xs">
        {filtered
          ? "None of your issues match. Paste an identifier or link to start from any issue."
          : "No issues are assigned to you right now."}
      </AutocompleteEmpty>
    );
  }
  return (
    <AutocompleteList className="max-h-80">
      {issues.map((issue) => (
        <AutocompleteItem key={issue.id} value={issue} className="gap-2">
          <IssueStateDot color={issue.state.color} className="size-2 shrink-0" />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {issue.identifier}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{issue.state.name}</span>
        </AutocompleteItem>
      ))}
    </AutocompleteList>
  );
}
