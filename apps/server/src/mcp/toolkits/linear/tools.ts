import { LinearResource, LinearResourcePage } from "../../../linear/LinearResources.ts";
import {
  LinearIssueComment,
  LinearIssueDetail,
  LinearIssueNotFoundError,
  LinearIssueSummary,
  LinearListIssuesResult,
  LinearOperationError,
  LinearTeamRef,
  LinearUnavailableError,
  LinearWorkflowState,
  LinearWorkflowStateType,
  PositiveInt,
  PreviewAutomationUnavailableError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as LinearApi from "../../../linear/LinearApi.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import { McpApprovalBroker } from "../../McpApprovalBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  LinearApi.LinearApi,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  // The write tools ask before they mutate; both services are resolved per
  // call so the confirmation setting can change mid-session.
  ServerSettingsService,
  McpApprovalBroker,
];

/** Reading a file the agent named needs the workspace on top of the rest. */
const uploadDependencies = [
  ...dependencies,
  FileSystem.FileSystem,
  Path.Path,
  WorkspacePaths.WorkspacePaths,
];

/**
 * Everything a Linear tool can hand back. `PreviewAutomationUnavailableError`
 * is the shared MCP capability refusal: it is what the agent sees when its
 * credential was issued without Linear access.
 */
const LinearToolError = Schema.Union([
  LinearUnavailableError,
  LinearIssueNotFoundError,
  LinearOperationError,
  PreviewAutomationUnavailableError,
]);

/** Every Linear call leaves the server, and none of them can be replayed blindly. */
const linearTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

/** A Linear read: safe to repeat, and it changes nothing in the workspace. */
const readonlyLinearTool = <T extends Tool.Any>(tool: T): T =>
  linearTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

/**
 * Parameter text. `TrimmedNonEmptyString` is a decoding transformation, and a
 * description annotated onto one never reaches the JSON Schema the agent
 * reads, so tool parameters are plain checked strings and the handlers trim.
 */
const describedText = (description: string) =>
  Schema.String.check(Schema.isNonEmpty()).annotate({ description });

const IssueIdParameter = Schema.optional(
  describedText(
    "Issue identifier such as DEL-123, or a Linear issue UUID. Omit it to use the issue this thread is linked to.",
  ),
);

const IssueRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  url: Schema.String,
});

export const GetIssueTool = readonlyLinearTool(
  Tool.make("get_issue", {
    description:
      "Read one Linear issue in full: description, workflow state, team, labels, parent, sub-issues, and its most recent comments. Pass id as an identifier such as DEL-123 or a Linear UUID; omit id and the issue this thread is linked to is used.",
    parameters: Schema.Struct({ id: IssueIdParameter }),
    success: LinearIssueDetail,
    failure: LinearToolError,
    dependencies,
  }).annotate(Tool.Title, "Get Linear issue"),
);

export const ListCommentsTool = readonlyLinearTool(
  Tool.make("list_comments", {
    description:
      "List the most recent comments on a Linear issue, newest activity included, with each comment's author and URL. Pass issueId as an identifier such as DEL-123 or a Linear UUID; omit it and the issue this thread is linked to is used.",
    parameters: Schema.Struct({ issueId: IssueIdParameter }),
    success: Schema.Struct({
      issue: IssueRef,
      comments: Schema.Array(LinearIssueComment),
    }),
    failure: LinearToolError,
    dependencies,
  }).annotate(Tool.Title, "List Linear comments"),
);

export const ListIssueStatusesTool = readonlyLinearTool(
  Tool.make("list_issue_statuses", {
    description:
      "List the workflow states a team's issues can be moved to, in board order, so a status can be named exactly when saving an issue. Pass team as a team id, a key such as DEL, or a team name; omit it and the team of the issue this thread is linked to is used.",
    parameters: Schema.Struct({
      team: Schema.optional(
        describedText(
          "Team id, team key such as DEL, or team name. Omit it to use the team of the issue this thread is linked to.",
        ),
      ),
    }),
    success: Schema.Struct({
      team: LinearTeamRef,
      states: Schema.Array(LinearWorkflowState),
    }),
    failure: LinearToolError,
    dependencies,
  }).annotate(Tool.Title, "List Linear issue statuses"),
);

export const ListMyIssuesTool = readonlyLinearTool(
  Tool.make("list_my_issues", {
    description:
      "List the Linear issues assigned to the connected user, most recently updated first, filtered by team, workflow state type, or project. Useful for finding the identifier of an issue before reading or saving it.",
    parameters: Schema.Struct({
      teamKey: Schema.optional(
        describedText("Only issues on this team key, such as DEL. Omit for every team."),
      ),
      stateTypes: Schema.optional(
        Schema.Array(LinearWorkflowStateType).annotate({
          description:
            "Workflow state types to include: triage, backlog, unstarted, started, completed, canceled, or duplicate. Defaults to unstarted and started.",
        }),
      ),
      projectId: Schema.optional(
        describedText("Only issues in this Linear project id. Omit for every project."),
      ),
      limit: Schema.optional(
        PositiveInt.annotate({
          description: "How many issues to return. Defaults to 50, and the server caps it at 100.",
        }),
      ),
    }),
    success: LinearListIssuesResult,
    failure: LinearToolError,
    dependencies,
  }).annotate(Tool.Title, "List my Linear issues"),
);

export const SaveCommentTool = linearTool(
  Tool.make("save_comment", {
    description:
      "Create or edit a Linear comment as the connected identity. Pass id from list_comments to replace an existing comment body; omit id to create a comment. For creation, issueId defaults to the issue this thread is linked to. For editing, the comment identifies its issue; an optional issueId must match. Linear enforces permission to edit the comment.",
    parameters: Schema.Struct({
      id: Schema.optional(
        describedText("Existing comment UUID to edit. Omit to create a new comment."),
      ),
      body: describedText(
        'The comment body, in markdown, written for whoever reads the issue next. Post it unsigned: no closing "Written by ..." line, and no mention of the agent, the model, or T3 Code.',
      ),
      issueId: IssueIdParameter,
    }),
    success: Schema.Struct({
      id: TrimmedNonEmptyString,
      url: Schema.String,
    }),
    failure: LinearToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Comment on Linear issue")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false),
);

export const UploadImageTool = linearTool(
  Tool.make("upload_image", {
    description:
      "Upload an image from this thread's workspace to Linear and get back a URL to embed. Use it for screenshots and other visual evidence of the work: save the image in the workspace, upload it here, then put the returned markdown in a save_comment body or a save_issue description. The URL belongs to the Linear workspace, so one upload can be embedded in as many comments and issues as you like.",
    parameters: Schema.Struct({
      path: describedText(
        "Path to the image file, relative to this thread's workspace root. PNG, JPEG, GIF, WebP, AVIF, BMP, TIFF, HEIC, ICO, and SVG are accepted, up to 20 MB.",
      ),
      alt: Schema.optional(
        describedText(
          "Alt text describing what the image shows, for the markdown. Defaults to the file name.",
        ),
      ),
    }),
    success: Schema.Struct({
      /** The workspace asset URL, permanent and usable in any Linear markdown. */
      url: Schema.String,
      name: TrimmedNonEmptyString,
      /** Ready to paste into a comment or description, so the agent need not build it. */
      markdown: TrimmedNonEmptyString,
    }),
    failure: LinearToolError,
    dependencies: uploadDependencies,
  })
    .annotate(Tool.Title, "Upload image to Linear")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false),
);

const IssuePlanningFields = {
  assignee: Schema.optional(
    Schema.NullOr(
      describedText(
        "Assignee user ID, exact name, or email. Pass null to unassign; omit to leave assignment unchanged. Assignment does not delegate the issue to an agent.",
      ),
    ),
  ),
  project: Schema.optional(
    Schema.NullOr(
      describedText(
        "Project ID or exact name. Null removes the project and its milestone; omit to keep it.",
      ),
    ),
  ),
  milestone: Schema.optional(
    Schema.NullOr(
      describedText(
        "Milestone ID or exact name within the issue's project (or the project supplied here). Null clears it.",
      ),
    ),
  ),
  cycle: Schema.optional(
    Schema.NullOr(
      describedText(
        "Cycle ID, number, exact name, or current/next/previous within the issue's team. Null clears it.",
      ),
    ),
  ),
  estimate: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
      description:
        "Numeric estimate in the team's estimation scale. Null clears it; omit to keep it. Linear validates the team's allowed values.",
    }),
  ),
  priority: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })).annotate({
      description: "Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. Omit to keep it.",
    }),
  ),
  dueDate: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "Due date in YYYY-MM-DD format. Null clears it; omit to keep it.",
    }),
  ),
};

export const SaveIssueTool = linearTool(
  Tool.make("save_issue", {
    description:
      "Update a Linear issue's title, description, workflow state, labels, assignee, project, milestone, estimate, cycle, priority, or due date, leaving every field you omit untouched. Pass id as an identifier such as DEL-123 or a Linear UUID; omit id and the issue this thread is linked to is saved.",
    parameters: Schema.Struct({
      id: IssueIdParameter,
      ...IssuePlanningFields,
      title: Schema.optional(
        describedText("Replacement issue title. Omit to leave the title alone."),
      ),
      description: Schema.optional(
        Schema.String.annotate({
          description:
            "Replacement issue description, in markdown. Replaces the whole description, so send the full text. Omit to leave it alone.",
        }),
      ),
      state: Schema.optional(
        describedText(
          "Workflow state name such as In Progress, or a state id. Use list_issue_statuses to see the team's states.",
        ),
      ),
      labels: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description:
            "The issue's complete label set, by name or id. This replaces the existing labels, so include the ones to keep.",
        }),
      ),
    }),
    success: LinearIssueDetail,
    failure: LinearToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Save Linear issue")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
);

export const CreateIssueTool = linearTool(
  Tool.make("create_issue", {
    description:
      "Create a Linear issue. By default it lands on the team of the issue this thread is linked to, as a sub-issue of it; pass team to file it elsewhere, and parentId null to create a standalone issue instead.",
    parameters: Schema.Struct({
      ...IssuePlanningFields,
      title: describedText("The issue title, written so someone outside the work can read it."),
      description: Schema.optional(
        Schema.String.annotate({
          description: "The issue description, in markdown.",
        }),
      ),
      team: Schema.optional(
        describedText(
          "Team id, team key such as DEL, or team name. Omit it to use the team of the issue this thread is linked to.",
        ),
      ),
      parentId: Schema.optional(
        Schema.NullOr(Schema.String).annotate({
          description:
            "Parent issue, as an identifier such as DEL-123 or a Linear UUID. Omit it to file the new issue under the issue this thread is linked to, or pass null for a standalone issue.",
        }),
      ),
      state: Schema.optional(
        describedText(
          "Workflow state name such as Todo, or a state id. Omit it to use the team's default state.",
        ),
      ),
      labels: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description: "Labels to put on the new issue, by name or id.",
        }),
      ),
    }),
    success: LinearIssueSummary,
    failure: LinearToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Create Linear issue")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false),
);

const ResourceListFields = {
  query: Schema.optional(
    describedText("Filter names by text; omit to list all accessible records."),
  ),
  cursor: Schema.optional(
    describedText("endCursor from a previous response to fetch the next page."),
  ),
  limit: Schema.optional(
    PositiveInt.annotate({ description: "Page size, defaults to 50 and is capped at 100." }),
  ),
};
const ResourceId = describedText(
  "Record ID or exact name. Use the corresponding list tool to find it; ambiguous names require an ID.",
);
const OptionalTeam = Schema.optional(
  describedText("Team ID, key, or exact name. Omit to use the linked issue's team where required."),
);
const ResourceWriteFields = {
  id: Schema.optional(ResourceId),
  name: Schema.optional(
    describedText("Name of the record. Required when creating a project, milestone, or label."),
  ),
  description: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "Replacement description. Omit to keep it; null clears it.",
    }),
  ),
};
const TargetDate = Schema.optional(
  Schema.NullOr(Schema.String).annotate({
    description: "Target date in YYYY-MM-DD format. Omit to keep it; null clears it.",
  }),
);
const StartDate = Schema.optional(
  Schema.NullOr(Schema.String).annotate({
    description: "Start date in YYYY-MM-DD format. Omit to keep it; null clears it.",
  }),
);

const ListProjectsTool = readonlyLinearTool(
  Tool.make("list_projects", {
    description:
      "Find accessible Linear projects by name, optionally restricted to a team. Returns IDs and pagination for assigning issues or editing projects.",
    parameters: Schema.Struct({ ...ResourceListFields, team: OptionalTeam }),
    success: LinearResourcePage,
    failure: LinearToolError,
    dependencies,
  }),
);
const ListIssuesTool = readonlyLinearTool(
  Tool.make("list_issues", {
    description:
      "Search Linear issues across assignees by title, team, project, assignee, or workflow state type. Defaults to open issues; pass stateTypes for completed or canceled work. Supports pagination.",
    parameters: Schema.Struct({
      ...ResourceListFields,
      team: OptionalTeam,
      project: Schema.optional(ResourceId),
      assignee: IssuePlanningFields.assignee,
      stateTypes: Schema.optional(
        Schema.Array(LinearWorkflowStateType).annotate({
          description: "Workflow state types to include; defaults to unstarted and started.",
        }),
      ),
    }),
    success: LinearListIssuesResult,
    failure: LinearToolError,
    dependencies,
  }),
);
const GetProjectTool = readonlyLinearTool(
  Tool.make("get_project", {
    description:
      "Read one Linear project by ID or exact name, including its description, dates, and associated teams.",
    parameters: Schema.Struct({ query: ResourceId }),
    success: LinearResource,
    failure: LinearToolError,
    dependencies,
  }),
);
const SaveProjectTool = linearTool(
  Tool.make("save_project", {
    description:
      "Create or update a Linear project. Omit id to create; pass id to update only the fields provided. Creating requires a name and teams (defaults to the linked issue's team).",
    parameters: Schema.Struct({
      ...ResourceWriteFields,
      teams: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description:
            "Complete set of team IDs, keys, or names for this project. On update, omit to keep its teams.",
        }),
      ),
      startDate: StartDate,
      targetDate: TargetDate,
    }),
    success: LinearResource,
    failure: LinearToolError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false),
);
const ListMilestonesTool = readonlyLinearTool(
  Tool.make("list_milestones", {
    description:
      "List milestones for a Linear project, including their IDs, descriptions, and target dates. Omit project to use the linked issue's project.",
    parameters: Schema.Struct({ ...ResourceListFields, project: Schema.optional(ResourceId) }),
    success: LinearResourcePage,
    failure: LinearToolError,
    dependencies,
  }),
);
const GetMilestoneTool = readonlyLinearTool(
  Tool.make("get_milestone", {
    description:
      "Read a Linear project milestone by ID or exact name. Supply its project when matching by name.",
    parameters: Schema.Struct({ query: ResourceId, project: Schema.optional(ResourceId) }),
    success: LinearResource,
    failure: LinearToolError,
    dependencies,
  }),
);
const SaveMilestoneTool = linearTool(
  Tool.make("save_milestone", {
    description:
      "Create or update a project milestone. Omit id to create. New milestones require a name and project, defaulting to the linked issue's project.",
    parameters: Schema.Struct({
      ...ResourceWriteFields,
      project: Schema.optional(ResourceId),
      targetDate: TargetDate,
    }),
    success: LinearResource,
    failure: LinearToolError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false),
);
const ListCyclesTool = readonlyLinearTool(
  Tool.make("list_cycles", {
    description:
      "List cycles for a Linear team with cycle IDs, numbers, dates, and names. Omit team to use the linked issue's team.",
    parameters: Schema.Struct({ ...ResourceListFields, team: OptionalTeam }),
    success: LinearResourcePage,
    failure: LinearToolError,
    dependencies,
  }),
);
const UpdateCycleTool = linearTool(
  Tool.make("update_cycle", {
    description:
      "Update an existing Linear cycle's name, description, or dates. Linear schedules new cycles automatically; this tool edits an existing cycle only.",
    parameters: Schema.Struct({
      ...ResourceWriteFields,
      id: ResourceId,
      team: OptionalTeam,
      startsAt: Schema.optional(describedText("Cycle start as an ISO 8601 timestamp.")),
      endsAt: Schema.optional(describedText("Cycle end as an ISO 8601 timestamp.")),
    }),
    success: LinearResource,
    failure: LinearToolError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
);
const ListIssueLabelsTool = readonlyLinearTool(
  Tool.make("list_issue_labels", {
    description:
      "Find Linear issue labels by name. When team is supplied, includes that team's labels and workspace-wide labels.",
    parameters: Schema.Struct({ ...ResourceListFields, team: OptionalTeam }),
    success: LinearResourcePage,
    failure: LinearToolError,
    dependencies,
  }),
);
const SaveIssueLabelTool = linearTool(
  Tool.make("save_issue_label", {
    description:
      "Create or update a Linear issue label. New labels require a name. Omit team for a workspace label; an existing label's team is unchanged.",
    parameters: Schema.Struct({
      ...ResourceWriteFields,
      team: OptionalTeam,
      color: Schema.optional(
        describedText("Label color as a hexadecimal color string such as #5e6ad2."),
      ),
    }),
    success: LinearResource,
    failure: LinearToolError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false),
);
const ListUsersTool = readonlyLinearTool(
  Tool.make("list_users", {
    description:
      "Find Linear workspace users, returning IDs, names, email addresses, and active status for assigning work.",
    parameters: Schema.Struct(ResourceListFields),
    success: LinearResourcePage,
    failure: LinearToolError,
    dependencies,
  }),
);
const GetUserTool = readonlyLinearTool(
  Tool.make("get_user", {
    description:
      "Look up a Linear user by user ID, exact name, display name, or email address. Ambiguous names require an email or ID.",
    parameters: Schema.Struct({ query: ResourceId }),
    success: LinearResource,
    failure: LinearToolError,
    dependencies,
  }),
);
const ListTeamsTool = readonlyLinearTool(
  Tool.make("list_teams", {
    description:
      "List accessible Linear teams and their IDs and keys for filtering work or creating projects and issues.",
    parameters: Schema.Struct(ResourceListFields),
    success: LinearResourcePage,
    failure: LinearToolError,
    dependencies,
  }),
);
const GetTeamTool = readonlyLinearTool(
  Tool.make("get_team", {
    description:
      "Read a Linear team by ID, key, or name to find its identifier and description before organizing work.",
    parameters: Schema.Struct({ query: ResourceId }),
    success: LinearResource,
    failure: LinearToolError,
    dependencies,
  }),
);

export const LinearToolkit = Toolkit.make(
  GetIssueTool,
  ListCommentsTool,
  ListIssueStatusesTool,
  ListMyIssuesTool,
  SaveCommentTool,
  UploadImageTool,
  SaveIssueTool,
  CreateIssueTool,
  ListIssuesTool,
  ListProjectsTool,
  GetProjectTool,
  SaveProjectTool,
  ListMilestonesTool,
  GetMilestoneTool,
  SaveMilestoneTool,
  ListCyclesTool,
  UpdateCycleTool,
  ListIssueLabelsTool,
  SaveIssueLabelTool,
  ListUsersTool,
  GetUserTool,
  ListTeamsTool,
  GetTeamTool,
);
