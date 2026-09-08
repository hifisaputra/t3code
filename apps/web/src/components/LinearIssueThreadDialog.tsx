import type {
  EnvironmentId,
  LinearBranchNaming,
  LinearIssueDetail,
  LinearIssueSummary,
  ProjectId,
  ThreadId,
  ThreadLinkedIssue,
} from "@t3tools/contracts";
import {
  defaultLinearBranchPrefix,
  linearIssueBranchName,
  LINEAR_DEFAULT_BRANCH_PREFIXES,
  LINEAR_DEFAULT_LABEL_BRANCH_PREFIXES,
  resolveLinearRepositoryMapping,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Link } from "@tanstack/react-router";
import { CircleDotIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { parseLinearIssueReference } from "~/linearIssueReference";
import { useEnvironments } from "~/state/environments";
import { linearEnvironment } from "~/state/linear";
import { usePrepareIssueThreadAction, useLinearIssueResolution } from "~/state/linearActions";
import { useEnvironmentQuery } from "~/state/query";
import ChatMarkdown from "./ChatMarkdown";
import { IssueStateDot } from "./issues/IssueRow";
import { linearBranchPrefixOptions, linearBranchProblem } from "./linearIssueThreadDialog.logic";
import { useOpenIssueLink } from "./ThreadStatusIndicators";
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
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

/** How many of my issues the picker lists. Enough to recognise one, short enough to scan. */
const MY_ISSUES_LIMIT = 20;

interface LinearIssueThreadDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  /** Present only for a draft thread, whose id the worktree setup script can run for. */
  threadId?: ThreadId | undefined;
  /** Every project on this environment; the dialog picks the one the issue belongs to. */
  projects: ReadonlyArray<EnvironmentProject>;
  /** Where the caller was, used when no mapping claims the issue. */
  defaultProjectId: ProjectId | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
    issue: LinearIssueDetail;
    linkedIssue: ThreadLinkedIssue;
    project: EnvironmentProject;
  }) => Promise<void> | void;
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
 * is for is on screen before it is started. Under the reader sit the two
 * things the thread needs decided: which checkout it starts in and what the
 * branch is called.
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
  threadId,
  projects,
  defaultProjectId,
  initialReference,
  onOpenChange,
  onPrepared,
}: LinearIssueThreadDialogProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  // Tied to the issue it was chosen for, so resolving a different issue falls
  // back to that issue's own mapping instead of keeping a stale override.
  const [override, setOverride] = useState<{ issueId: string; projectId: ProjectId } | null>(null);
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
    if (!open) setBranchDraft(null);
  }
  const [movedToStateName, setMovedToStateName] = useState<string | null>(null);
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

  const resolvedIssue =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? issueResolution.data
      : null;

  const { environments } = useEnvironments();
  const linearSettings = useMemo(
    () =>
      environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
        ?.settings.linear ?? null,
    [environmentId, environments],
  );
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
  // Not `branch`: `handleConfirm` destructures the server's answer under that
  // name, and a shadowed const there would be a temporal-dead-zone read.
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

  const handleConfirm = useCallback(
    async (mode: "local" | "worktree") => {
      if (!parsedReference) {
        setReferenceDirty(true);
        return;
      }
      if (!resolvedIssue || !targetProject || branchProblem !== null) {
        return;
      }
      setPreparingMode(mode);
      const result = await prepareIssueThreadAction.run({
        reference: parsedReference,
        mode,
        // Under Linear's own format there is nothing the dialog knows that the
        // server does not, so it names the branch itself.
        ...(branchIsEditable ? { branch: branchName.trim() } : {}),
        ...(mode === "worktree" && threadId ? { threadId } : {}),
      });
      setPreparingMode(null);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          prepareIssueThreadAction.resetError();
        }
        return;
      }
      const { branch, worktreePath, issue, movedToState } = result.value;
      // The note below only survives if `onPrepared` fails; on the happy path
      // the dialog closes and the thread takes over the screen, so the state
      // change is reported where the person will still be looking.
      setMovedToStateName(movedToState?.name ?? null);
      if (movedToState) {
        toastManager.add({
          type: "success",
          title: `Moved to ${movedToState.name}`,
          description: issue.identifier,
        });
      }
      await onPrepared({
        branch,
        worktreePath,
        issue,
        linkedIssue: {
          provider: "linear",
          id: issue.id,
          identifier: issue.identifier,
          url: issue.url,
        },
        project: targetProject,
      });
      onOpenChange(false);
    },
    [
      branchIsEditable,
      branchName,
      branchProblem,
      onOpenChange,
      onPrepared,
      parsedReference,
      prepareIssueThreadAction,
      resolvedIssue,
      targetProject,
      threadId,
    ],
  );

  const fillReference = useCallback((identifier: string) => {
    setReferenceDirty(true);
    setReference(identifier);
    // Enter in the box starts the thread, so a picked row leaves it focused.
    referenceInputRef.current?.focus();
  }, []);

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? "Paste a Linear issue URL, or enter DEL-123."
      : parsedReference === null
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
        ? "Failed to start a thread from this issue."
        : null;

  const busy = prepareIssueThreadAction.isPending;
  const canStart =
    targetProject !== null &&
    resolvedIssue !== null &&
    !isResolving &&
    !busy &&
    branchProblem === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-4xl sm:h-[42rem]">
        <DialogHeader className="pb-3">
          <DialogTitle className="flex items-center gap-2">
            <CircleDotIcon className="size-4" />
            Start thread from issue
          </DialogTitle>
          <DialogDescription>
            Pick an issue and read it, then create the draft thread on its branch in the main repo
            or in a dedicated worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] sm:grid-rows-none">
          <div className="flex min-h-0 flex-col gap-3 border-border/60 border-b px-6 pb-4 sm:border-r sm:border-b-0 sm:pr-4 sm:pb-6">
            <label className="grid gap-1.5">
              <span className="font-medium text-foreground text-xs">Issue</span>
              <Input
                ref={referenceInputRef}
                placeholder="DEL-123 or a linear.app issue URL"
                value={reference}
                onChange={(event) => {
                  setReferenceDirty(true);
                  setReference(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  if (canStart) {
                    void handleConfirm("worktree");
                  }
                }}
              />
              {validationMessage ? (
                <span className="text-destructive text-xs">{validationMessage}</span>
              ) : null}
            </label>

            {!linearConnected && !linearNeedsSetup ? (
              <p className="text-muted-foreground text-xs">{linearUnavailableSentence}</p>
            ) : linearNeedsSetup ? (
              <p className="text-muted-foreground text-xs">
                Linear is not connected.{" "}
                <Link
                  to="/settings/integrations"
                  className="underline underline-offset-2"
                  onClick={() => onOpenChange(false)}
                >
                  Connect it in Settings → Integrations
                </Link>
                .
              </p>
            ) : (
              <MyIssuesList
                issues={myIssues.data?.issues ?? null}
                isPending={myIssues.isPending}
                error={myIssues.error}
                selectedIdentifier={parsedReference}
                onSelect={fillReference}
              />
            )}
          </div>

          <div className="flex min-h-0 flex-col">
            <ScrollArea scrollFade className="min-h-0 flex-1">
              <div className="px-6 py-4 sm:pt-0 sm:pl-4">
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
                  <ReaderNotice>
                    Pick an issue from the list, or paste its link, to read it here before starting.
                  </ReaderNotice>
                )}
              </div>
            </ScrollArea>

            {resolvedIssue && targetProject ? (
              <div className="grid gap-2 border-border/60 border-t px-6 py-3 text-xs sm:pl-4">
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span className="w-14 shrink-0">Starts in</span>
                  {projects.length > 1 ? (
                    <Select
                      value={targetProject.id}
                      onValueChange={(next) =>
                        setOverride({
                          issueId: resolvedIssue.id,
                          projectId: String(next) as ProjectId,
                        })
                      }
                    >
                      <SelectTrigger size="xs" className="w-auto min-w-36" aria-label="Project">
                        <SelectValue>
                          <span className="truncate">{targetProject.title}</span>
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
                    <span className="font-medium text-foreground">{targetProject.title}</span>
                  )}
                </div>

                {branchIsEditable ? (
                  <div className="grid gap-1">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span className="w-14 shrink-0">Branch</span>
                      <Select
                        value={branchPrefix ?? ""}
                        onValueChange={(next) => editBranch({ prefix: String(next) })}
                      >
                        <SelectTrigger
                          size="xs"
                          className="w-auto min-w-20"
                          aria-label="Branch prefix"
                        >
                          <SelectValue>
                            <span className="truncate">{branchPrefix}</span>
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start" alignItemWithTrigger={false}>
                          {branchPrefixOptions.map((prefix) => (
                            <SelectItem hideIndicator key={prefix} value={prefix}>
                              <span className="truncate">{prefix}</span>
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <Input
                        size="sm"
                        spellCheck={false}
                        aria-label="Branch name"
                        aria-invalid={branchProblem !== null}
                        className="min-w-0 flex-1 font-mono text-xs"
                        value={branchName}
                        onChange={(event) => editBranch({ branch: event.target.value })}
                      />
                    </div>
                    {branchProblem ? (
                      <p className="pl-16 text-destructive">{branchProblem}</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span className="w-14 shrink-0">Branch</span>
                    <span className="min-w-0 truncate font-mono text-foreground">
                      {resolvedIssue.branchName}
                    </span>
                  </div>
                )}

                {movedToStateName ? (
                  <p className="text-muted-foreground">Moved to {movedToStateName}</p>
                ) : null}
                {prepareError ? <p className="text-destructive">{prepareError}</p> : null}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
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
            variant="outline"
            onClick={() => {
              void handleConfirm("local");
            }}
            disabled={!canStart}
          >
            {preparingMode === "local" ? "Preparing local..." : "Local"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm("worktree");
            }}
            disabled={!canStart}
          >
            {preparingMode === "worktree" ? "Preparing worktree..." : "Worktree"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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
    <span className="shrink-0 text-xs" style={{ color }}>
      {name}
    </span>
  );
}

function MyIssuesList({
  issues,
  isPending,
  error,
  selectedIdentifier,
  onSelect,
}: {
  readonly issues: ReadonlyArray<LinearIssueSummary> | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly selectedIdentifier: string | null;
  readonly onSelect: (identifier: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <span className="font-medium text-foreground text-xs">My issues</span>
      {issues === null && isPending ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          Loading issues...
        </div>
      ) : error !== null && issues === null ? (
        <p className="text-muted-foreground text-xs">{error}</p>
      ) : issues !== null && issues.length === 0 ? (
        <p className="text-muted-foreground text-xs">No issues are assigned to you right now.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/70 max-sm:max-h-44">
          {(issues ?? []).map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => onSelect(issue.identifier)}
                data-selected={issue.identifier === selectedIdentifier ? "true" : undefined}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 data-[selected=true]:bg-muted/60"
              >
                <IssueStateDot color={issue.state.color} className="size-2 shrink-0" />
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {issue.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
