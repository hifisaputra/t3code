import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, CircleDashedIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  assistantTeamThread,
  type AssistantThreadRole,
  type EnvironmentId,
  type ProjectIconOverride,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { useAssistantThreadAsksYou } from "../assistant/AssistantThreadTag";
import { THREAD_KIND, ThreadKindIcon } from "../assistant/threadKinds";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  animateSidebarLayoutChanges,
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  useSidebarRowSubscriptionLease,
  type SidebarSection,
} from "../Sidebar.logic";
import {
  IssueStatusChip,
  issueStatusIndicator,
  useLinkedThreadIssue,
  useOpenIssueLink,
} from "../ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * One developer-assistant team — an issue's lead, worker, code review and
 * e2e threads — under a single sidebar row. Four rows per issue made the flat
 * Active list unreadable with more than one issue in flight, and nothing said
 * which rows belonged together; the group header carries the issue and the
 * team's worst-blocked status, and the member rows stay one click away.
 *
 * The row registers with dnd-kit so it translates around the gap a dragged
 * thread opens, but it can never be picked up itself: a team is a landing
 * slot ("before/after the whole team"), not a draggable item.
 */

// The stored array holds the teams whose collapse state the person flipped
// AWAY from their section's default — expanded in Active (work in flight is
// worth seeing), collapsed in Settled (finished issues stay tidy). One array
// can only express one thing, and "what did the user change" is the thing
// that has to survive a reload.
const COLLAPSED_TEAMS_KEY = "sidebar.collapsedTeams";
const TeamKeysSchema = Schema.Array(Schema.String);
const NO_TEAM_KEYS: readonly string[] = [];

const ROLE_ORDER: readonly AssistantThreadRole[] = ["lead", "implement", "review", "e2e"];

// Placeholder for a role the team has no thread for. The hook is still called
// (the hook count must not vary with the team's shape) but with live: false,
// so it subscribes to nothing and answers false.
const NO_THREAD_ID = "assistant-lead-none" as ThreadId;

// Same hue convention as the thread rows (amber approval, indigo input, sky
// working, emerald done): a thread must read the same colour wherever it shows
// up. Lower rank wins when the header folds four members into one label.
const APPROVAL_RANK = 0;
const INPUT_RANK = 1;
const WORKING_RANK = 3;

type MemberStatus = {
  readonly label: string;
  readonly className: string;
  readonly rank: number;
  readonly working: boolean;
};

function memberStatus(
  thread: EnvironmentThreadShell,
  asksYou: boolean,
  isUnread: boolean,
): MemberStatus | null {
  const threadStatus = resolveSidebarThreadStatus(thread);
  // An assistant thread's question to you waits on its board, not in the
  // thread, so a Ready row can still be blocked on you.
  const question = asksYou && (threadStatus === "ready" || threadStatus === "failed");
  const status = question ? "input" : threadStatus;
  switch (status) {
    case "approval":
      return {
        label: "Approval",
        className: "text-amber-700 dark:text-amber-300",
        rank: APPROVAL_RANK,
        working: false,
      };
    case "input":
      return {
        label: question ? "Question" : "Input",
        className: "text-indigo-600 dark:text-indigo-300",
        rank: INPUT_RANK,
        working: false,
      };
    case "failed":
      return {
        label: "Failed",
        className: "text-red-700 dark:text-red-300",
        rank: 2,
        working: false,
      };
    case "working":
      return {
        label: "Working",
        className: "text-sky-600 dark:text-sky-400",
        rank: WORKING_RANK,
        working: true,
      };
    case "monitoring":
      return {
        label: "Monitoring",
        className: "text-sky-600 dark:text-sky-400",
        rank: 4,
        working: false,
      };
    default:
      return isUnread
        ? {
            label: "Done",
            className: "text-emerald-700 dark:text-emerald-300",
            rank: 5,
            working: false,
          }
        : null;
  }
}

function compactTimeLabel(thread: EnvironmentThreadShell): string {
  const label = formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The worker thread is titled `DEL-123: Issue title`; every other member is
    titled `DEL-123 · <role>`, which carries no title of its own. */
function resolveTeamIssueTitle(
  identifier: string,
  members: ReadonlyArray<{ readonly role: AssistantThreadRole; readonly title: string }>,
): string {
  const prefix = new RegExp(`^${escapeForRegExp(identifier)}\\s*:\\s*`);
  const worker = members.find((member) => member.role === "implement");
  if (worker) {
    const stripped = worker.title.replace(prefix, "").trim();
    if (stripped.length > 0 && stripped !== identifier) return stripped;
  }
  for (const member of members) {
    const stripped = member.title
      .replace(/\s+·\s+[^·]*$/, "")
      .replace(prefix, "")
      .trim();
    if (stripped.length > 0 && stripped !== identifier) return stripped;
  }
  return identifier;
}

// Same pill the thread rows float at their right edge while the jump modifier
// is held (Sidebar.tsx's JumpHintBadge): an overlay, so it displaces neither
// the status label nor any layout when it appears.
function JumpHintBadge({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
    >
      {label}
    </span>
  );
}

function StatusLabel({ status, dim }: { status: MemberStatus; dim: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums",
        status.className,
        dim && "opacity-75",
      )}
    >
      {status.working ? <CircleDashedIcon aria-hidden className="size-3.5 shrink-0" /> : null}
      <span role="status">{status.label}</span>
    </span>
  );
}

type TeamMember = {
  readonly role: AssistantThreadRole;
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
};

export const SidebarTeamRow = memo(function SidebarTeamRow(props: {
  /** Sortable id, `team:<environmentId>:<taskId>`. */
  teamKey: string;
  section: SidebarSection;
  /** Members in list order; looked up through `threadByKey` so the row does
      not take a fresh array identity on every parent render. */
  threadKeys: readonly string[];
  threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  environmentId: EnvironmentId;
  routeThreadKey: string | null;
  /** Null while the jump modifier is not held. */
  jumpLabelByKey: ReadonlyMap<string, string> | null;
  currentEnvironmentId: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  projectIcon: ProjectIconOverride | null;
  projectTitle: string | null;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
}) {
  const {
    environmentId,
    jumpLabelByKey,
    onContextMenu,
    onThreadActivate,
    onThreadClick,
    routeThreadKey,
    section,
    teamKey,
    threadByKey,
    threadKeys,
  } = props;

  const members = useMemo(() => {
    const list: TeamMember[] = [];
    for (const key of threadKeys) {
      const thread = threadByKey.get(key);
      if (thread === undefined) continue;
      const team = assistantTeamThread(thread.id);
      if (team === null) continue;
      list.push({ role: team.role, key, thread });
    }
    // Fixed reading order: who decided, who wrote it, who checked it, who
    // tested it — not whatever order the list happened to sort them into.
    return list.toSorted(
      (left, right) => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role),
    );
  }, [threadByKey, threadKeys]);

  const byRole = useMemo(() => {
    const mapping = new Map<AssistantThreadRole, TeamMember>();
    for (const member of members) mapping.set(member.role, member);
    return mapping;
  }, [members]);

  const hasRouteMember = members.some((member) => member.key === routeThreadKey);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(hasRouteMember);

  // One call per role, never per member: the hook count has to stay constant
  // across renders, and every call shares the same board subscription.
  const asksYouByRole: Record<AssistantThreadRole, boolean> = {
    lead: useAssistantThreadAsksYou({
      environmentId,
      threadId: (byRole.get("lead") ?? members[0])?.thread.id ?? NO_THREAD_ID,
      live: leaseLiveStatus && byRole.has("lead"),
    }),
    implement: useAssistantThreadAsksYou({
      environmentId,
      threadId: (byRole.get("implement") ?? members[0])?.thread.id ?? NO_THREAD_ID,
      live: leaseLiveStatus && byRole.has("implement"),
    }),
    review: useAssistantThreadAsksYou({
      environmentId,
      threadId: (byRole.get("review") ?? members[0])?.thread.id ?? NO_THREAD_ID,
      live: leaseLiveStatus && byRole.has("review"),
    }),
    e2e: useAssistantThreadAsksYou({
      environmentId,
      threadId: (byRole.get("e2e") ?? members[0])?.thread.id ?? NO_THREAD_ID,
      live: leaseLiveStatus && byRole.has("e2e"),
    }),
  };

  const lastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const selectedThreadKeys = useThreadSelectionStore((state) => state.selectedThreadKeys);

  const linkedIssue = members.find((member) => member.thread.linkedIssue != null)?.thread
    .linkedIssue;
  const issue = useLinkedThreadIssue(environmentId, linkedIssue, leaseLiveStatus);
  const issueStatus = issueStatusIndicator(issue);
  const identifier = linkedIssue?.identifier ?? issue?.identifier ?? "";
  const issueTitle = useMemo(
    () =>
      resolveTeamIssueTitle(
        identifier,
        members.map((member) => ({ role: member.role, title: member.thread.title })),
      ),
    [identifier, members],
  );
  const headerLabel = identifier === "" ? issueTitle : identifier;
  const threadCountLabel = `${members.length} ${members.length === 1 ? "thread" : "threads"}`;

  const entries = members.map((member) => ({
    member,
    status: memberStatus(
      member.thread,
      asksYouByRole[member.role],
      hasUnseenCompletion({
        ...member.thread,
        lastVisitedAt: lastVisitedAtByKey[member.key],
      }),
    ),
  }));
  // The header speaks for the worst-blocked member: the team is one unit of
  // work, and "which of the four" is what expanding answers.
  const teamStatus = entries.reduce<MemberStatus | null>(
    (worst, entry) =>
      entry.status !== null && (worst === null || entry.status.rank < worst.rank)
        ? entry.status
        : worst,
    null,
  );
  // Whoever the team is waiting on, else whoever is doing the work, else the
  // lead — the thread you would have opened yourself.
  const representative =
    entries.find((entry) => entry.status !== null && entry.status.rank <= INPUT_RANK)?.member ??
    entries.find((entry) => entry.status?.rank === WORKING_RANK)?.member ??
    byRole.get("lead") ??
    members[0];

  const [collapseOverrides, setCollapseOverrides] = useLocalStorage(
    COLLAPSED_TEAMS_KEY,
    NO_TEAM_KEYS,
    TeamKeysSchema,
  );
  const defaultExpanded = section !== "settled";
  const flipped = collapseOverrides.includes(teamKey);
  // The open thread is never hidden behind a collapsed group, same exception
  // the settled tail and the snoozed shelf make for the route row.
  const expanded = hasRouteMember || (flipped ? !defaultExpanded : defaultExpanded);
  const handleToggle = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setCollapseOverrides((current) =>
        current.includes(teamKey)
          ? current.filter((key) => key !== teamKey)
          : [...current, teamKey],
      );
    },
    [setCollapseOverrides, teamKey],
  );

  const openIssueLink = useOpenIssueLink();
  const handleOpenIssue = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (issueStatus === null) return;
      openIssueLink(event, issueStatus.url);
    },
    [issueStatus, openIssueLink],
  );

  // Plain functions: `representative` is derived from a per-render array, so
  // a useCallback here only makes the React Compiler give up on the whole
  // component. Let the compiler memoize them.
  const handleHeaderClick = (event: ReactMouseEvent) => {
    if (representative === undefined) return;
    // The chevron (and the issue chip) own their clicks.
    if ((event.target as HTMLElement | null)?.closest("button") !== null) return;
    onThreadClick(
      event,
      scopeThreadRef(representative.thread.environmentId, representative.thread.id),
    );
  };
  const handleHeaderKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (representative === undefined) return;
    event.preventDefault();
    onThreadActivate(scopeThreadRef(representative.thread.environmentId, representative.thread.id));
  };

  // Registered but never draggable: the row has to translate with its
  // neighbours so a gap can open above or below the whole team.
  const { setNodeRef, transform, transition } = useSortable({
    id: teamKey,
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });

  if (members.length === 0) return null;

  const latestActivity = members.reduce<string | null>((latest, member) => {
    const candidate = member.thread.latestUserMessageAt ?? member.thread.updatedAt;
    return latest === null || candidate > latest ? candidate : latest;
  }, null);
  const isRemote =
    props.currentEnvironmentId !== null && environmentId !== props.currentEnvironmentId;

  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid="sidebar-team-row"
      className="list-none"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      <div
        role="group"
        aria-label={[identifier, issueTitle, threadCountLabel]
          .filter((part, index, parts) => part !== "" && parts.indexOf(part) === index)
          .join(" · ")}
        className="rounded-md"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                role="button"
                tabIndex={0}
                data-testid="sidebar-team-header"
                onClick={handleHeaderClick}
                onKeyDown={handleHeaderKeyDown}
                // The open member's own row carries the route tint; a second
                // solid fill here would read as one undifferentiated block.
                className="group/sidebar-row relative flex h-9 w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md bg-transparent px-1.5 text-left text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover"
              />
            }
          >
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? `Collapse ${headerLabel}` : `Expand ${headerLabel}`}
              onClick={handleToggle}
              className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")}
              />
            </button>
            <ProjectFavicon
              environmentId={environmentId}
              cwd={props.projectCwd ?? ""}
              projectName={props.projectTitle ?? ""}
              faviconPath={props.projectFaviconPath}
              projectIcon={props.projectIcon}
              className="size-4 shrink-0"
            />
            {issueStatus !== null ? (
              <IssueStatusChip status={issueStatus} onOpen={handleOpenIssue} />
            ) : identifier !== "" ? (
              <span className="shrink-0 rounded-sm bg-sidebar-row-hover px-1 font-mono text-[10px] font-medium text-sidebar-muted-foreground">
                {identifier}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{issueTitle}</span>
            {teamStatus !== null ? (
              <StatusLabel status={teamStatus} dim={!hasRouteMember && teamStatus.working} />
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="right">
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{issueTitle}</span>
              <span className="text-xs opacity-80">
                {identifier === "" ? "Assistant team" : identifier} · {threadCountLabel}
              </span>
              {latestActivity !== null ? (
                <span className="text-xs opacity-80">
                  Last activity {formatShortTimestamp(latestActivity, props.timestampFormat)}
                </span>
              ) : null}
              {isRemote ? <span className="text-xs opacity-80">On another machine</span> : null}
            </span>
          </TooltipPopup>
        </Tooltip>
        {expanded ? (
          <ul role="list" className="flex flex-col">
            {entries.map(({ member, status }) => (
              <SidebarTeamMemberRow
                key={member.key}
                member={member}
                status={status}
                isActive={routeThreadKey === member.key}
                isSelected={selectedThreadKeys.has(member.key)}
                jumpLabel={jumpLabelByKey?.get(member.key) ?? null}
                onThreadClick={onThreadClick}
                onThreadActivate={onThreadActivate}
                onContextMenu={onContextMenu}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
});

const SidebarTeamMemberRow = memo(function SidebarTeamMemberRow(props: {
  member: TeamMember;
  status: MemberStatus | null;
  isActive: boolean;
  isSelected: boolean;
  jumpLabel: string | null;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
}) {
  const { member, onContextMenu, onThreadActivate, onThreadClick } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(member.thread.environmentId, member.thread.id),
    [member.thread.environmentId, member.thread.id],
  );
  const handleClick = useCallback(
    (event: ReactMouseEvent) => onThreadClick(event, threadRef),
    [onThreadClick, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  return (
    <li className="list-none">
      <div
        data-thread-item
        data-testid="sidebar-team-member"
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        className={cn(
          // A left rule ties the members to the header they belong to; the
          // indent leaves the header's chevron and favicon column clear.
          "group/sidebar-row relative ml-3.5 flex h-8 cursor-pointer items-center gap-2 overflow-hidden rounded-md border-l border-sidebar-border/60 pl-3 pr-2 text-left outline-none select-none",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : props.isSelected
              ? "bg-sidebar-row-selected text-sidebar-foreground"
              : "text-sidebar-muted-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <ThreadKindIcon kind={member.role} />
        <span className="min-w-0 flex-1 truncate text-xs">{THREAD_KIND[member.role].label}</span>
        {props.status !== null ? (
          <StatusLabel status={props.status} dim={!props.isActive && props.status.working} />
        ) : (
          <span className="shrink-0 text-xs tabular-nums text-secondary-label">
            {compactTimeLabel(member.thread)}
          </span>
        )}
        {props.jumpLabel !== null ? <JumpHintBadge label={props.jumpLabel} /> : null}
      </div>
    </li>
  );
});
