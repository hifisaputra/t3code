import type { LinearConnectionStatus, LinearWorkspaceTeam } from "@t3tools/contracts";

import { linearBranchPrefixOptions } from "../linearIssueThreadDialog.logic";

/**
 * The one line Settings prints under "Connection". Every branch says something
 * a user can act on, so the row never falls back to a bare "error".
 */
export function linearConnectionSentence(
  status: LinearConnectionStatus,
  nowMs: number = Date.now(),
): string {
  switch (status.status) {
    case "connected":
      return `Connected as ${status.viewer.displayName} in ${status.workspace.name}`;
    case "unconfigured":
      return "Not connected";
    case "unauthenticated":
      return "Linear rejected the API key";
    case "failed": {
      const retry = status.retryAt === undefined ? null : formatRetryDelay(status.retryAt - nowMs);
      return retry === null ? status.detail : `${endSentence(status.detail)} Retry after ${retry}.`;
    }
  }
}

function endSentence(detail: string): string {
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

/** Rounded up, so the label never invites a retry Linear will still refuse. */
function formatRetryDelay(remainingMs: number): string | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

/**
 * The repository mapping picker.
 *
 * A row names either a Linear team or one project inside it, and the select
 * holds a single string, so the two kinds share one option list with a
 * prefixed value. `team:`/`project:` is the only thing that distinguishes
 * them once the value is in the DOM.
 */
export interface LinearPickerOption {
  readonly value: string;
  readonly label: string;
  readonly kind: "team" | "project";
}

/** Just the halves of `LinearRepositoryMapping` the picker owns. */
export interface LinearPickerTarget {
  readonly teamKey: string | null;
  readonly linearProjectId: string | null;
}

const TEAM_VALUE_PREFIX = "team:";
const PROJECT_VALUE_PREFIX = "project:";

export function encodeLinearPickerValue(target: LinearPickerTarget): string {
  if (target.linearProjectId !== null) return `${PROJECT_VALUE_PREFIX}${target.linearProjectId}`;
  if (target.teamKey !== null) return `${TEAM_VALUE_PREFIX}${target.teamKey}`;
  return "";
}

/** Null for anything the select could not have produced, so a bad value never saves. */
export function decodeLinearPickerValue(value: string): LinearPickerTarget | null {
  if (value.startsWith(PROJECT_VALUE_PREFIX)) {
    const linearProjectId = value.slice(PROJECT_VALUE_PREFIX.length);
    return linearProjectId.length > 0 ? { teamKey: null, linearProjectId } : null;
  }
  if (value.startsWith(TEAM_VALUE_PREFIX)) {
    const teamKey = value.slice(TEAM_VALUE_PREFIX.length);
    return teamKey.length > 0 ? { teamKey, linearProjectId: null } : null;
  }
  return null;
}

/**
 * Every team, each followed by its own projects. Linear lets a project span
 * teams, so the same project can arrive twice; the first team that lists it
 * names it.
 */
export function linearPickerOptions(
  teams: ReadonlyArray<LinearWorkspaceTeam>,
): ReadonlyArray<LinearPickerOption> {
  const options: Array<LinearPickerOption> = [];
  const seen = new Set<string>();
  const push = (option: LinearPickerOption) => {
    if (seen.has(option.value)) return;
    seen.add(option.value);
    options.push(option);
  };
  for (const team of teams) {
    push({
      value: encodeLinearPickerValue({ teamKey: team.key, linearProjectId: null }),
      label: `${team.key} · ${team.name}`,
      kind: "team",
    });
    for (const project of team.projects) {
      push({
        value: encodeLinearPickerValue({ teamKey: null, linearProjectId: project.id }),
        label: `${team.key} / ${project.name}`,
        kind: "project",
      });
    }
  }
  return options;
}

/**
 * What a saved row reads as. The workspace answer can be missing or stale
 * while a row still points at something, so a row never renders as blank.
 */
export function linearPickerLabel(
  options: ReadonlyArray<LinearPickerOption>,
  target: LinearPickerTarget,
): string {
  const value = encodeLinearPickerValue(target);
  const option = options.find((candidate) => candidate.value === value);
  if (option) return option.label;
  if (target.linearProjectId !== null) return `Project ${target.linearProjectId}`;
  if (target.teamKey !== null) return target.teamKey;
  return "Choose a team or project";
}

/**
 * What "Add repository" starts a row on: the first team or project nothing
 * maps yet, so adding twice does not produce two rows for the same thing.
 */
export function nextLinearPickerTarget(
  options: ReadonlyArray<LinearPickerOption>,
  existing: ReadonlyArray<LinearPickerTarget>,
): LinearPickerTarget | null {
  const used = new Set(existing.map(encodeLinearPickerValue));
  const option = options.find((candidate) => !used.has(candidate.value)) ?? options[0];
  return option ? decodeLinearPickerValue(option.value) : null;
}

/**
 * The branch-prefix list, as one comma-separated line.
 *
 * A convention reads as `feat, fix, bug, chore` rather than as a table, so the
 * setting is a single box. Parsing borrows the dialog's option builder, which
 * settles what counts as the same prefix, so the box and the select the dialog
 * renders from it can never disagree.
 */
export function parseLinearBranchPrefixes(value: string): ReadonlyArray<string> {
  return linearBranchPrefixOptions(value.split(","));
}

export function formatLinearBranchPrefixes(prefixes: ReadonlyArray<string>): string {
  return prefixes.join(", ");
}

/**
 * The label a fresh rule starts on. A label is a rule's identity and cannot be
 * empty, so a second unnamed rule would shadow the first; numbering keeps both
 * of them editable until they are named.
 */
export function nextLinearLabelRuleLabel(
  existing: ReadonlyArray<{ readonly label: string }>,
): string {
  const used = new Set(existing.map((rule) => rule.label.trim().toLowerCase()));
  const base = "New label";
  // At most `used.size` names can be taken, so one of these is always free.
  for (let suffix = 1; suffix <= used.size + 1; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base} ${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
