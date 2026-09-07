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
import { CircleDotIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { parseLinearIssueReference } from "~/linearIssueReference";
import { useEnvironments } from "~/state/environments";
import { linearEnvironment } from "~/state/linear";
import { usePrepareIssueThreadAction, useLinearIssueResolution } from "~/state/linearActions";
import { useEnvironmentQuery } from "~/state/query";
import { linearBranchPrefixOptions, linearBranchProblem } from "./linearIssueThreadDialog.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
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
    referenceInputRef.current?.focus();
  }, []);

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? "Paste a Linear issue URL, or enter DEL-123."
      : parsedReference === null
        ? "Use a Linear issue URL or an identifier such as DEL-123."
        : null;
  const prepareError =
    prepareIssueThreadAction.error instanceof Error
      ? prepareIssueThreadAction.error.message
      : prepareIssueThreadAction.error
        ? "Failed to start a thread from this issue."
        : null;
  const errorMessage =
    validationMessage ??
    (resolvedIssue === null && issueResolution.error ? issueResolution.error : prepareError);

  const busy = prepareIssueThreadAction.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleDotIcon className="size-4" />
            Start thread from issue
          </DialogTitle>
          <DialogDescription>
            Resolve a Linear issue, then create the draft thread on its branch in the main repo or
            in a dedicated worktree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
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
                if (!isResolving && !busy) {
                  void handleConfirm("worktree");
                }
              }}
            />
          </label>

          {resolvedIssue ? <ResolvedIssueRow issue={resolvedIssue} /> : null}

          {resolvedIssue && targetProject ? (
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <span>Starts in</span>
              {projects.length > 1 ? (
                <Select
                  value={targetProject.id}
                  onValueChange={(next) =>
                    setOverride({ issueId: resolvedIssue.id, projectId: String(next) as ProjectId })
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
          ) : null}

          {resolvedIssue && branchIsEditable ? (
            <div className="grid gap-1.5">
              <span className="font-medium text-foreground text-xs">Branch</span>
              <div className="flex items-center gap-2">
                <Select
                  value={branchPrefix ?? ""}
                  onValueChange={(next) => editBranch({ prefix: String(next) })}
                >
                  <SelectTrigger size="sm" className="w-auto min-w-24" aria-label="Branch prefix">
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
              {branchProblem ? <p className="text-destructive text-xs">{branchProblem}</p> : null}
            </div>
          ) : resolvedIssue ? (
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <span>Branch</span>
              <span className="font-mono text-foreground">{resolvedIssue.branchName}</span>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              Resolving issue...
            </div>
          ) : null}

          {movedToStateName ? (
            <p className="text-muted-foreground text-xs">Moved to {movedToStateName}</p>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}

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
        </DialogPanel>
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
            disabled={
              !targetProject || !resolvedIssue || isResolving || busy || branchProblem !== null
            }
          >
            {preparingMode === "local" ? "Preparing local..." : "Local"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm("worktree");
            }}
            disabled={
              !targetProject || !resolvedIssue || isResolving || busy || branchProblem !== null
            }
          >
            {preparingMode === "worktree" ? "Preparing worktree..." : "Worktree"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ResolvedIssueRow({ issue }: { readonly issue: LinearIssueDetail }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">{issue.title}</p>
          <p className="truncate text-muted-foreground text-xs">
            {issue.identifier} · {issue.team.key} ·{" "}
            {issue.assignee?.displayName ?? issue.assignee?.name ?? "Unassigned"}
          </p>
        </div>
        <IssueStateLabel name={issue.state.name} color={issue.state.color} />
      </div>
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
    <div className="grid gap-1.5">
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
        <ul className="max-h-56 overflow-y-auto rounded-xl border border-border/70">
          {(issues ?? []).map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => onSelect(issue.identifier)}
                data-selected={issue.identifier === selectedIdentifier ? "true" : undefined}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 data-[selected=true]:bg-muted/60"
              >
                <span className="shrink-0 font-medium text-muted-foreground text-xs">
                  {issue.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
                <IssueStateLabel name={issue.state.name} color={issue.state.color} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
