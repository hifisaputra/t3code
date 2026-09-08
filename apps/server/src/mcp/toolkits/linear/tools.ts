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
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as LinearApi from "../../../linear/LinearApi.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
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
            "Workflow state types to include: triage, backlog, unstarted, started, completed, or canceled. Defaults to unstarted and started.",
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
      "Post a comment on a Linear issue as the connected user. The body is Linear-flavoured markdown. Pass issueId as an identifier such as DEL-123 or a Linear UUID; omit it and the issue this thread is linked to is commented on.",
    parameters: Schema.Struct({
      body: describedText(
        "The comment body, in markdown, written for whoever reads the issue next.",
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

export const SaveIssueTool = linearTool(
  Tool.make("save_issue", {
    description:
      "Update a Linear issue's title, description, workflow state, or labels, leaving every field you omit untouched. Pass id as an identifier such as DEL-123 or a Linear UUID; omit id and the issue this thread is linked to is saved. This tool cannot change who an issue is assigned to.",
    parameters: Schema.Struct({
      id: IssueIdParameter,
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

export const LinearToolkit = Toolkit.make(
  GetIssueTool,
  ListCommentsTool,
  ListIssueStatusesTool,
  ListMyIssuesTool,
  SaveCommentTool,
  SaveIssueTool,
  CreateIssueTool,
);
