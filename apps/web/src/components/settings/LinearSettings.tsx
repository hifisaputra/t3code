import { LinearDelegationSettingsSection } from "./LinearDelegationSettings";
/**
 * The Linear connection.
 *
 * The API key belongs to the server this client is anchored to: it is sent
 * once and lives in that server's secret store, and every later read hands the
 * client `SERVER_SECRET_REDACTED_MARKER` instead. So the key row never has a
 * value to render — it reads the marker as "a key is saved" and offers to
 * replace or remove it. Everything the rows say about Linear itself comes from
 * `linear.status`, which the server answers with the key it holds.
 *
 * @module LinearSettings
 */
import {
  LINEAR_DEFAULT_BRANCH_PREFIXES,
  normalizeLinearBranchPrefix,
  SERVER_SECRET_REDACTED_MARKER,
  type EnvironmentId,
  type LinearBranchNaming,
  type LinearConnectionStatus,
  type LinearLabelBranchPrefix,
  type LinearRepositoryMapping,
  type ProjectId,
} from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { linearEnvironment } from "~/state/linear";
import { useEnvironmentQuery } from "~/state/query";

import { linearBranchPrefixOptions } from "../linearIssueThreadDialog.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  decodeLinearPickerValue,
  encodeLinearPickerValue,
  formatLinearBranchPrefixes,
  linearConnectionSentence,
  linearPickerLabel,
  linearPickerOptions,
  nextLinearLabelRuleLabel,
  nextLinearPickerTarget,
  parseLinearBranchPrefixes,
} from "./LinearSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LinearSettingsSection() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const storedKey = usePrimarySettings((settings) => settings.linear.apiKey);
  const status = useEnvironmentQuery(
    environmentId === null ? null : linearEnvironment.status({ environmentId, input: {} }),
  );

  // Saving a key is a round trip; re-checking on the click would ask about the
  // key the server had a moment ago. The stored value changing is the server
  // saying it has the new one, which is the moment the answer can differ.
  const refreshStatus = status.refresh;
  const checkedKey = useRef(storedKey);
  useEffect(() => {
    if (checkedKey.current === storedKey) return;
    checkedKey.current = storedKey;
    refreshStatus();
  }, [refreshStatus, storedKey]);

  return (
    <SettingsSection id="linear" title="Linear">
      <LinearApiKeySetting storedKey={storedKey} />
      <LinearConnectionSetting
        hasEnvironment={environmentId !== null}
        data={status.data}
        error={status.error}
        isPending={status.isPending}
        onCheckAgain={refreshStatus}
      />
      {environmentId !== null && status.data?.status === "connected" ? (
        <LinearRepositoriesSetting environmentId={environmentId} />
      ) : null}
      <LinearBranchNamingSetting />
      <LinearMoveToStartedSetting />
      <LinearAgentAccessSetting />
      <LinearConfirmWritesSetting />
      <LinearDelegationSettingsSection />
    </SettingsSection>
  );
}

function LinearApiKeySetting({ storedKey }: { readonly storedKey: string }) {
  const updateSettings = useUpdatePrimarySettings();
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);

  const keySaved = storedKey === SERVER_SECRET_REDACTED_MARKER;
  const editing = !keySaved || replacing;
  const trimmedDraft = draft.trim();

  const patchKey = (apiKey: string) => {
    updateSettings({ linear: { apiKey } });
    setDraft("");
    setReplacing(false);
  };

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linear-api-key")}
      description="Make one in Linear under Settings → Security & access → Personal API keys. It is kept on this server and never sent back to a client."
      control={
        editing ? (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="lin_api_…"
              className="w-full sm:w-56"
              aria-label="Linear API key"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && trimmedDraft.length > 0) {
                  event.preventDefault();
                  patchKey(trimmedDraft);
                }
              }}
            />
            <Button
              size="sm"
              disabled={trimmedDraft.length === 0}
              onClick={() => patchKey(trimmedDraft)}
            >
              Save
            </Button>
            {keySaved ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft("");
                  setReplacing(false);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
            <span className="text-sm text-muted-foreground">Key saved</span>
            <Button size="sm" variant="outline" onClick={() => setReplacing(true)}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" onClick={() => patchKey("")}>
              Remove
            </Button>
          </div>
        )
      }
    />
  );
}

/**
 * What the server's key is worth right now. A first check says it is checking
 * rather than guessing at "Not connected", and a re-check keeps the previous
 * answer on screen while the button spins, so the line is never a claim
 * nobody has verified.
 */
function LinearConnectionSetting({
  hasEnvironment,
  data,
  error,
  isPending,
  onCheckAgain,
}: {
  readonly hasEnvironment: boolean;
  readonly data: LinearConnectionStatus | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onCheckAgain: () => void;
}) {
  const sentence = !hasEnvironment
    ? "No server is connected."
    : data !== null
      ? linearConnectionSentence(data)
      : error !== null
        ? error
        : isPending
          ? "Checking…"
          : "Not checked yet";
  const problem =
    data !== null ? data.status === "unauthenticated" || data.status === "failed" : error !== null;

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linear-connection-status")}
      description={<span className={problem ? "text-destructive" : undefined}>{sentence}</span>}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!hasEnvironment || isPending}
          onClick={onCheckAgain}
        >
          <RefreshIcon className="size-3.5" refreshing={isPending} />
          Check again
        </Button>
      }
    />
  );
}

function LinearMoveToStartedSetting() {
  const moveToStarted = usePrimarySettings(
    (settings) => settings.linear.moveToStartedOnThreadStart,
  );
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linear-move-to-started")}
      description="When you start a thread from a Linear issue, move that issue to the team's first In Progress state."
      control={
        <Switch
          checked={moveToStarted}
          onCheckedChange={(checked) =>
            updateSettings({ linear: { moveToStartedOnThreadStart: Boolean(checked) } })
          }
          aria-label="Move issue to In Progress when a thread starts"
        />
      }
    />
  );
}

function LinearAgentAccessSetting() {
  const agentAccess = usePrimarySettings((settings) => settings.linear.agentAccess);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linear-agent-access")}
      description="Agents in a thread linked to an issue get server-side tools to read the issue, list your issues, add comments, edit the title, description, state, and labels, and file follow-up issues. They cannot change who an issue is assigned to. Takes effect on the next turn."
      control={
        <Switch
          checked={agentAccess}
          onCheckedChange={(checked) =>
            updateSettings({ linear: { agentAccess: Boolean(checked) } })
          }
          aria-label="Let agents read and update Linear issues"
        />
      }
    />
  );
}

/**
 * Stays visible while agent access is off: the row is how someone finds out
 * writes can be gated at all, and its description says when it applies.
 */
function LinearConfirmWritesSetting() {
  const confirmAgentWrites = usePrimarySettings((settings) => settings.linear.confirmAgentWrites);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linear-confirm-agent-writes")}
      description="Each comment, edit, or new issue an agent wants to make in Linear shows up as an approval in the thread first. Reads never ask. Only matters while agents can update Linear issues."
      control={
        <Switch
          checked={confirmAgentWrites}
          onCheckedChange={(checked) =>
            updateSettings({ linear: { confirmAgentWrites: Boolean(checked) } })
          }
          aria-label="Ask before agents write to Linear"
        />
      }
    />
  );
}

/**
 * Which checkout an issue's work lands in.
 *
 * The rows are the whole setting, so every committed edit writes the whole
 * list back: `linear.repositories` is patched as one value, and a row that
 * never reached a valid team, project and checkout would not decode.
 */
function LinearRepositoriesSetting({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const repositories = usePrimarySettings((settings) => settings.linear.repositories);
  const updateSettings = useUpdatePrimarySettings();
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const workspace = useEnvironmentQuery(linearEnvironment.workspace({ environmentId, input: {} }));
  const options = useMemo(() => linearPickerOptions(workspace.data?.teams ?? []), [workspace.data]);

  const save = (next: ReadonlyArray<LinearRepositoryMapping>) =>
    updateSettings({ linear: { repositories: next } });
  const replaceRow = (index: number, patch: Partial<LinearRepositoryMapping>) =>
    save(repositories.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const addable = projects[0] ?? null;
  const nextTarget = nextLinearPickerTarget(options, repositories);

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linear-repositories")}
      description="Point a Linear team or project at the checkout its issues belong to. A project row wins over a team row for the same team."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={addable === null || nextTarget === null}
          onClick={() => {
            if (addable === null || nextTarget === null) return;
            save([...repositories, { ...nextTarget, projectId: addable.id, baseBranch: null }]);
          }}
        >
          Add repository
        </Button>
      }
    >
      {repositories.length === 0 ? (
        <p className="pb-3 text-[13px] text-muted-foreground/80">
          {workspace.error !== null && workspace.data === null
            ? workspace.error
            : projects.length === 0
              ? "Add a project on this server first."
              : "No mapping yet. Issues start in the project you are already in."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2 pb-3">
          {repositories.map((row, index) => (
            // Rows are only ever appended, edited in place, or removed, and a
            // persisted row carries no id, so the position is the only stable
            // identity it has.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index} className="flex flex-wrap items-center gap-2">
              <Select
                value={encodeLinearPickerValue(row)}
                onValueChange={(next) => {
                  const target = decodeLinearPickerValue(String(next));
                  if (target) replaceRow(index, target);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full min-w-44 sm:w-56"
                  aria-label="Linear team or project"
                >
                  <SelectValue>
                    <span className="truncate">{linearPickerLabel(options, row)}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {options.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      <span className={option.kind === "project" ? "truncate ps-3" : "truncate"}>
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                value={row.projectId}
                onValueChange={(next) =>
                  replaceRow(index, { projectId: String(next) as ProjectId })
                }
              >
                <SelectTrigger size="sm" className="w-full min-w-40 sm:w-52" aria-label="Project">
                  <SelectValue>
                    <span className="truncate">
                      {projects.find((project) => project.id === row.projectId)?.title ??
                        "Unknown project"}
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
              <BaseBranchInput
                value={row.baseBranch}
                onCommit={(baseBranch) => replaceRow(index, { baseBranch })}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Remove repository mapping"
                onClick={() => save(repositories.filter((_, at) => at !== index))}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}

/** Held locally while it is being typed; committed on blur or Enter like the key row. */
function BaseBranchInput({
  value,
  onCommit,
}: {
  readonly value: string | null;
  readonly onCommit: (value: string | null) => void;
}) {
  // Rows are keyed by position, so a removal slides a different row's value
  // into this instance; resyncing on the prop keeps the box showing that row.
  const [draft, setDraft] = useState(value ?? "");
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(value ?? "");
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === (value ?? "")) return;
    onCommit(trimmed.length > 0 ? trimmed : null);
  };

  return (
    <Input
      size="sm"
      spellCheck={false}
      placeholder="default branch"
      aria-label="Base branch"
      className="w-full min-w-32 sm:w-40"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commit();
      }}
    />
  );
}

/**
 * How a thread started from an issue names its branch.
 *
 * Linear's own format needs nothing else, so the two rows below it only exist
 * under the repository convention: the prefixes a person is offered, and the
 * label rules that pick one of them without being asked.
 */
function LinearBranchNamingSetting() {
  const branchNaming = usePrimarySettings((settings) => settings.linear.branchNaming);
  const updateSettings = useUpdatePrimarySettings();

  const patchNaming = (patch: Partial<LinearBranchNaming>) =>
    updateSettings({ linear: { branchNaming: patch } });

  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("linear-branch-naming")}
        description="Linear's format uses the branch Linear suggests, such as tomo/del-177-fix-login. The repository convention uses feat/del-177-fix-login instead, with the prefix chosen per issue."
        control={
          <Select
            value={branchNaming.style}
            onValueChange={(next) =>
              patchNaming({ style: next === "prefixed" ? "prefixed" : "linear" })
            }
          >
            <SelectTrigger size="sm" className="w-full min-w-52 sm:w-64" aria-label="Branch names">
              <SelectValue>
                <span className="truncate">{BRANCH_STYLE_LABELS[branchNaming.style]}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="linear">
                <span className="truncate">{BRANCH_STYLE_LABELS.linear}</span>
              </SelectItem>
              <SelectItem hideIndicator value="prefixed">
                <span className="truncate">{BRANCH_STYLE_LABELS.prefixed}</span>
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {branchNaming.style === "prefixed" ? (
        <>
          <LinearBranchPrefixesSetting
            prefixes={branchNaming.prefixes}
            onSave={(prefixes) => patchNaming({ prefixes })}
          />
          <LinearLabelPrefixesSetting
            prefixes={branchNaming.prefixes}
            labelPrefixes={branchNaming.labelPrefixes}
            onSave={(labelPrefixes) => patchNaming({ labelPrefixes })}
          />
        </>
      ) : null}
    </>
  );
}

const BRANCH_STYLE_LABELS: Readonly<Record<LinearBranchNaming["style"], string>> = {
  linear: "Linear's branch format",
  prefixed: "Repository convention (prefix/…)",
};

/** The list as one line, committed on blur or Enter like the base-branch box. */
function LinearBranchPrefixesSetting({
  prefixes,
  onSave,
}: {
  readonly prefixes: ReadonlyArray<string>;
  readonly onSave: (prefixes: ReadonlyArray<string>) => void;
}) {
  const saved = formatLinearBranchPrefixes(prefixes);
  const [draft, setDraft] = useState(saved);
  const [syncedValue, setSyncedValue] = useState(saved);
  if (syncedValue !== saved) {
    setSyncedValue(saved);
    setDraft(saved);
  }

  const commit = () => {
    const parsed = parseLinearBranchPrefixes(draft);
    // An empty list would leave the dialog with no prefix to offer and no
    // default to fall back on, so clearing the box reads as "back to ours".
    const next = parsed.length > 0 ? parsed : LINEAR_DEFAULT_BRANCH_PREFIXES;
    const line = formatLinearBranchPrefixes(next);
    setDraft(line);
    if (line === saved) return;
    onSave(next);
  };

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linear-branch-prefixes")}
      description="Offered when starting a thread. The first is the default."
      control={
        <Input
          size="sm"
          spellCheck={false}
          placeholder="feat, fix, bug, chore"
          aria-label="Branch prefixes"
          className="w-full sm:w-64"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit();
          }}
        />
      }
    />
  );
}

/**
 * Which prefix a label picks.
 *
 * Like the repository rows, the whole list is written back on every edit, and
 * a row's position is its only identity. A rule whose prefix has since left
 * the prefixes list still offers its own, so editing the list never silently
 * rewrites a rule.
 */
function LinearLabelPrefixesSetting({
  prefixes,
  labelPrefixes,
  onSave,
}: {
  readonly prefixes: ReadonlyArray<string>;
  readonly labelPrefixes: ReadonlyArray<LinearLabelBranchPrefix>;
  readonly onSave: (labelPrefixes: ReadonlyArray<LinearLabelBranchPrefix>) => void;
}) {
  const replaceRow = (index: number, patch: Partial<LinearLabelBranchPrefix>) =>
    onSave(labelPrefixes.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linear-branch-label-prefixes")}
      description="An issue carrying the label gets the prefix. Otherwise the first prefix is used."
      control={
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onSave([
              ...labelPrefixes,
              {
                label: nextLinearLabelRuleLabel(labelPrefixes),
                prefix: prefixes[0] ?? LINEAR_DEFAULT_BRANCH_PREFIXES[0] ?? "feat",
              },
            ])
          }
        >
          Add label rule
        </Button>
      }
    >
      {labelPrefixes.length === 0 ? (
        <p className="pb-3 text-[13px] text-muted-foreground/80">
          No label rules. Every issue starts on the first prefix.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 pb-3">
          {labelPrefixes.map((row, index) => {
            const prefix = normalizeLinearBranchPrefix(row.prefix);
            return (
              // Rows carry no id, so the position is the only stable identity
              // they have, exactly as in the repository list above.
              // oxlint-disable-next-line react/no-array-index-key
              <li key={index} className="flex flex-wrap items-center gap-2">
                <LabelNameInput
                  value={row.label}
                  onCommit={(label) => replaceRow(index, { label })}
                />
                <Select
                  value={prefix}
                  onValueChange={(next) => replaceRow(index, { prefix: String(next) })}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full min-w-32 sm:w-40"
                    aria-label="Branch prefix"
                  >
                    <SelectValue>
                      <span className="truncate">{prefix}</span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {linearBranchPrefixOptions(prefixes, prefix).map((option) => (
                      <SelectItem hideIndicator key={option} value={option}>
                        <span className="truncate">{option}</span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove label rule"
                  onClick={() => onSave(labelPrefixes.filter((_, at) => at !== index))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsRow>
  );
}

/** Like `BaseBranchInput`, but a rule with no label matches nothing, so an emptied box snaps back. */
function LabelNameInput({
  value,
  onCommit,
}: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(value);
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setDraft(value);
      return;
    }
    if (trimmed === value) return;
    onCommit(trimmed);
  };

  return (
    <Input
      size="sm"
      spellCheck={false}
      placeholder="Linear label"
      aria-label="Linear label"
      className="w-full min-w-32 sm:w-44"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commit();
      }}
    />
  );
}
