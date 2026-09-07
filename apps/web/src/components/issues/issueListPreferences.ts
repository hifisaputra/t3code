import * as Schema from "effect/Schema";

import { EnvironmentId, type LinearWorkflowStateType } from "@t3tools/contracts";

/**
 * Which of my issues the page lists. "open" is everything that is not done:
 * backlog, todo and in progress. The other three narrow to one workflow type.
 */
export const IssueListStateFilter = Schema.Literals(["open", "active", "todo", "backlog"]);
export type IssueListStateFilter = typeof IssueListStateFilter.Type;

/** The Linear workflow state types a filter value asks the server for. */
export function issueListStateTypes(
  state: IssueListStateFilter,
): ReadonlyArray<LinearWorkflowStateType> {
  switch (state) {
    case "active":
      return ["started"];
    case "todo":
      return ["unstarted"];
    case "backlog":
      return ["backlog"];
    case "open":
      return ["backlog", "unstarted", "started"];
  }
}

/**
 * The list controls the sidebar link restores. Team, project and cycle are
 * Linear ids from the loaded issues themselves, never names, so a rename in
 * Linear does not silently empty the page. The selected row is a URL concern
 * and is deliberately absent.
 */
export interface IssueListPreferences {
  readonly state: IssueListStateFilter;
  readonly environmentId?: EnvironmentId;
  /** Team key, e.g. `DEL`. */
  readonly team?: string;
  /** Linear project id. */
  readonly project?: string;
  /** Linear cycle id. */
  readonly cycle?: string;
  readonly q?: string;
}

export type IssueListPreferencePatch = {
  [Key in keyof IssueListPreferences]?: IssueListPreferences[Key] | undefined;
};

export const DEFAULT_ISSUE_LIST_PREFERENCES = {
  state: "open",
} as const satisfies IssueListPreferences;

const BoundedPreference = Schema.String.check(Schema.isMaxLength(200));
const IssueListPreferencesSchema = Schema.Struct({
  state: IssueListStateFilter,
  environmentId: Schema.optional(EnvironmentId),
  team: Schema.optional(BoundedPreference),
  project: Schema.optional(BoundedPreference),
  cycle: Schema.optional(BoundedPreference),
  q: Schema.optional(BoundedPreference),
});

const decodeIssueListPreferences = Schema.decodeUnknownOption(IssueListPreferencesSchema);
const ISSUE_LIST_PREFERENCES_STORAGE_KEY = "t3.issues.preferences";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function resolvePreferenceStorage(
  storage: PreferenceStorage | undefined,
): PreferenceStorage | undefined {
  return storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
}

/** Drops empty fields so a cleared control leaves the URL and storage rather than lingering. */
export function issueListPreferences(
  search: IssueListPreferences | Schema.Schema.Type<typeof IssueListPreferencesSchema>,
): IssueListPreferences {
  return {
    state: search.state,
    ...(search.environmentId ? { environmentId: search.environmentId } : {}),
    ...(search.team ? { team: search.team } : {}),
    ...(search.project ? { project: search.project } : {}),
    ...(search.cycle ? { cycle: search.cycle } : {}),
    ...(search.q ? { q: search.q } : {}),
  };
}

export function readIssueListPreferences(storage?: PreferenceStorage): IssueListPreferences {
  try {
    const raw = resolvePreferenceStorage(storage)?.getItem(ISSUE_LIST_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_ISSUE_LIST_PREFERENCES;
    const decoded = decodeIssueListPreferences(JSON.parse(raw));
    return decoded._tag === "Some"
      ? issueListPreferences(decoded.value)
      : DEFAULT_ISSUE_LIST_PREFERENCES;
  } catch {
    return DEFAULT_ISSUE_LIST_PREFERENCES;
  }
}

export function writeIssueListPreferences(
  preferences: IssueListPreferences,
  storage?: PreferenceStorage,
): void {
  try {
    resolvePreferenceStorage(storage)?.setItem(
      ISSUE_LIST_PREFERENCES_STORAGE_KEY,
      JSON.stringify(issueListPreferences(preferences)),
    );
  } catch {
    // Storage can be full or denied; the URL remains the source of truth for this visit.
  }
}
