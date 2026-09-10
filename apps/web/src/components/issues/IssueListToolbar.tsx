import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  FolderGit2Icon,
  LayersIcon,
  ListFilterIcon,
  SearchIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import type { ElementType, ReactNode } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { IssueListFacets } from "./issueList.logic";
import type { IssueListPreferencePatch, IssueListStateFilter } from "./issueListPreferences";

/** A radio group carries a string value, so "no filter" needs one of its own. */
const ALL = "__all__";

const STATE_TABS = [
  { value: "open", label: "Open", Icon: LayersIcon },
  { value: "active", label: "Active", Icon: CircleDotIcon },
  { value: "todo", label: "Todo", Icon: CircleIcon },
  { value: "backlog", label: "Backlog", Icon: CircleDashedIcon },
] as const satisfies ReadonlyArray<{
  value: IssueListStateFilter;
  label: string;
  Icon: ElementType<{ className?: string }>;
}>;

const SCOPE_OPTIONS = [
  { value: "mine", label: "Assigned to me", Icon: UserRoundIcon },
  { value: "all", label: "Everyone", Icon: UsersIcon },
] as const;

interface IssueFilterOption {
  readonly value: string;
  readonly label: string;
  readonly Icon?: ElementType<{ className?: string }>;
}

/**
 * One narrowing group in the filters menu. The "all" entry leads, so clearing a
 * group is the first thing under the cursor rather than the last.
 */
function IssueFilterRadioGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<IssueFilterOption>;
  onChange: (value: string) => void;
}) {
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(String(next));
      }}
    >
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {options.map((option) => (
        <MenuRadioItem key={option.value} value={option.value}>
          <span className="flex min-w-0 items-center gap-2">
            {option.Icon ? <option.Icon aria-hidden className="size-3.5" /> : null}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/**
 * The one row of controls above the list: what to search, which states to list,
 * and everything else behind a filters menu whose trigger counts what is on.
 * The row's right end is the caller's, which is where the list says how many
 * rows it has and whether it is refreshing.
 */
export function IssueListToolbar({
  state,
  scope,
  query,
  onQueryChange,
  facets,
  team,
  project,
  cycle,
  environments,
  environmentId,
  projects,
  projectId,
  showRepositoryPicker,
  onPickProject,
  onChange,
  children,
}: {
  state: IssueListStateFilter;
  scope: "mine" | "all";
  /** Controlled: the rows narrow as it is typed, the URL catches up after. */
  query: string;
  onQueryChange: (query: string) => void;
  facets: IssueListFacets;
  team: string | undefined;
  project: string | undefined;
  cycle: string | undefined;
  /** The Linear-capable servers; a lone one has nothing to switch between. */
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  projectId: ProjectId | null;
  /** Only while some issue on screen has no repository mapping of its own. */
  showRepositoryPicker: boolean;
  onPickProject: (projectId: ProjectId) => void;
  onChange: (patch: IssueListPreferencePatch) => void;
  children?: ReactNode;
}) {
  const showServers = environments.length > 1;
  const serverFiltered = showServers && environmentId !== environments[0]?.environmentId;
  const filterCount = [scope === "all", team, project, cycle, serverFiltered].filter(
    Boolean,
  ).length;
  const clearFilters = () => {
    onQueryChange("");
    onChange({
      scope: undefined,
      team: undefined,
      project: undefined,
      cycle: undefined,
      q: undefined,
    });
  };

  return (
    <div className="flex items-center gap-2 border-border/60 border-b px-3 py-2 sm:px-5">
      <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search issues"
          aria-label="Search issues"
        />
      </InputGroup>

      <ToggleGroup
        aria-label="Issue state"
        className="shrink-0"
        variant="segmented"
        value={[state]}
        onValueChange={(next) => {
          const value = next[0];
          if (value && value !== state) onChange({ state: value as IssueListStateFilter });
        }}
      >
        {STATE_TABS.map((tab) => (
          <Toggle key={tab.value} value={tab.value} aria-label={tab.label}>
            <tab.Icon aria-hidden />
            <span className="sr-only lg:not-sr-only">{tab.label}</span>
          </Toggle>
        ))}
      </ToggleGroup>

      <Menu>
        <MenuTrigger render={<Button size="sm" variant="outline" />}>
          <ListFilterIcon aria-hidden />
          <span className="sr-only sm:not-sr-only">Filters</span>
          {filterCount > 0 ? (
            <Badge size="sm" variant="secondary" className="tabular-nums">
              {filterCount}
            </Badge>
          ) : null}
        </MenuTrigger>
        <MenuPopup align="end" className="w-56">
          <IssueFilterRadioGroup
            label="Assigned"
            value={scope}
            options={SCOPE_OPTIONS}
            onChange={(next) => onChange({ scope: next === "all" ? "all" : undefined })}
          />
          {facets.teams.length > 1 ? (
            <>
              <MenuSeparator />
              <IssueFilterRadioGroup
                label="Team"
                value={team ?? ALL}
                options={[
                  { value: ALL, label: "All teams", Icon: LayersIcon },
                  ...facets.teams.map((entry) => ({ value: entry.key, label: entry.name })),
                ]}
                onChange={(next) => onChange({ team: next === ALL ? undefined : next })}
              />
            </>
          ) : null}
          {facets.projects.length > 1 ? (
            <>
              <MenuSeparator />
              <IssueFilterRadioGroup
                label="Project"
                value={project ?? ALL}
                options={[
                  { value: ALL, label: "All projects", Icon: LayersIcon },
                  ...facets.projects.map((entry) => ({ value: entry.id, label: entry.name })),
                ]}
                onChange={(next) => onChange({ project: next === ALL ? undefined : next })}
              />
            </>
          ) : null}
          {facets.cycles.length > 1 ? (
            <>
              <MenuSeparator />
              <IssueFilterRadioGroup
                label="Cycle"
                value={cycle ?? ALL}
                options={[
                  { value: ALL, label: "All cycles", Icon: LayersIcon },
                  ...facets.cycles.map((entry) => ({ value: entry.id, label: entry.label })),
                ]}
                onChange={(next) => onChange({ cycle: next === ALL ? undefined : next })}
              />
            </>
          ) : null}
          {showServers ? (
            <>
              <MenuSeparator />
              <IssueFilterRadioGroup
                label="Server"
                value={environmentId ?? ALL}
                options={environments.map((environment) => ({
                  value: environment.environmentId,
                  label: environment.label,
                }))}
                onChange={(next) => onChange({ environmentId: next as EnvironmentId })}
              />
            </>
          ) : null}
          {showRepositoryPicker && projects.length > 1 ? (
            <>
              <MenuSeparator />
              {/* Where an issue with no mapping of its own is checked out. It
                  is a filter's neighbour rather than a filter: nothing narrows
                  by it, and nothing stores it. */}
              <IssueFilterRadioGroup
                label="Default repository"
                value={projectId ?? ALL}
                options={projects.map((entry) => ({
                  value: entry.id,
                  label: entry.title,
                  Icon: FolderGit2Icon,
                }))}
                onChange={(next) => onPickProject(next as ProjectId)}
              />
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem
            disabled={filterCount === 0 && query.trim().length === 0}
            onClick={clearFilters}
          >
            Clear filters
          </MenuItem>
        </MenuPopup>
      </Menu>

      {children}
    </div>
  );
}
