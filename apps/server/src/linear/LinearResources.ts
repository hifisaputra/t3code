import * as Schema from "effect/Schema";

const Ref = Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) });
export const LinearResource = Schema.Struct({
  ...Ref.fields,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Boolean),
  number: Schema.optional(Schema.Number),
  startsAt: Schema.optional(Schema.String),
  endsAt: Schema.optional(Schema.String),
  startDate: Schema.optional(Schema.NullOr(Schema.String)),
  targetDate: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.String),
  project: Schema.optional(Schema.NullOr(Ref)),
  team: Schema.optional(Schema.NullOr(Ref)),
  teams: Schema.optional(Schema.Struct({ nodes: Schema.Array(Ref) })),
});
export type LinearResource = typeof LinearResource.Type;
export const LinearResourcePage = Schema.Struct({
  nodes: Schema.Array(LinearResource),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
});
export type LinearResourcePage = typeof LinearResourcePage.Type;

export const resourceDefinitions = {
  project: {
    plural: "projects",
    entity: "project",
    type: "Project",
    fields: "id name description url startDate targetDate teams { nodes { id name } }",
    writable: ["name", "description", "teamIds", "startDate", "targetDate"],
  },
  milestone: {
    plural: "projectMilestones",
    entity: "projectMilestone",
    type: "ProjectMilestone",
    fields: "id name description targetDate project { id name }",
    writable: ["name", "description", "projectId", "targetDate"],
  },
  cycle: {
    plural: "cycles",
    entity: "cycle",
    type: "Cycle",
    fields: "id name description number startsAt endsAt team { id name }",
    writable: ["name", "description", "startsAt", "endsAt"],
  },
  label: {
    plural: "issueLabels",
    entity: "issueLabel",
    type: "IssueLabel",
    fields: "id name description color team { id name }",
    writable: ["name", "description", "color"],
  },
  user: {
    plural: "users",
    entity: "user",
    type: "User",
    fields: "id name displayName email active",
    writable: [],
  },
  team: {
    plural: "teams",
    entity: "team",
    type: "Team",
    fields: "id name key description",
    writable: [],
  },
} as const;
export type LinearResourceKind = keyof typeof resourceDefinitions;
export type LinearResourceListInput = {
  kind: LinearResourceKind;
  query?: string | undefined;
  exact?: string | undefined;
  teamId?: string | undefined;
  projectId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};
export type LinearResourceSaveInput = {
  kind: "project" | "milestone" | "cycle" | "label";
  id?: string | undefined;
  name?: string | undefined;
  description?: string | null;
  teamIds?: ReadonlyArray<string>;
  teamId?: string | undefined;
  projectId?: string | undefined;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  startDate?: string | null;
  targetDate?: string | null;
  color?: string | undefined;
};
