import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  LinearIssueNotFoundError,
  LinearOperationError,
  LinearUnavailableError,
  LinearWorkflowStateType,
  TrimmedNonEmptyString,
  type LinearConnectionStatus,
  type LinearGetIssueInput,
  type LinearIssueDetail,
  type LinearIssueLabel,
  type LinearIssueRelative,
  type LinearIssueSummary,
  type LinearListIssuesInput,
  type LinearListIssuesResult,
  type LinearWorkflowState,
  type LinearWorkspaceStructure,
} from "@t3tools/contracts";

import { retryAtFromHeader } from "../sourceControl/SourceControlRateLimit.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const DEFAULT_API_BASE_URL = "https://api.linear.app/graphql";
/** Linear answers a page of issues in kilobytes; anything past this is not a response worth buffering. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_ISSUE_LIMIT = 50;
const MAX_ISSUE_LIMIT = 100;
const DEFAULT_LIST_STATE_TYPES: ReadonlyArray<LinearWorkflowStateType> = ["unstarted", "started"];
/** Details reach the UI verbatim, so a long GraphQL message is cut rather than wrapped forever. */
const MAX_DETAIL_LENGTH = 200;

/** Redirectable so tests and workspace proxies can stand in for Linear. */
const LinearApiBaseUrl = Config.string("T3CODE_LINEAR_API_BASE_URL").pipe(
  Config.withDefault(DEFAULT_API_BASE_URL),
);

const RawGraphQLError = Schema.Struct({
  message: Schema.optional(Schema.String),
  extensions: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
});

const RawGraphQLEnvelope = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.Array(RawGraphQLError)),
});

const decodeGraphQLEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(RawGraphQLEnvelope));

const RawWorkflowState = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  type: LinearWorkflowStateType,
  color: Schema.String,
  position: Schema.Number,
});

const RawUser = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
});

const RawProject = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: Schema.String,
});

const RawIssueSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  branchName: TrimmedNonEmptyString,
  priority: Schema.Number,
  updatedAt: Schema.String,
  state: RawWorkflowState,
  team: Schema.Struct({
    id: TrimmedNonEmptyString,
    key: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
  }),
  assignee: Schema.NullOr(RawUser),
  project: Schema.NullOr(RawProject),
  cycle: Schema.NullOr(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      number: Schema.Number,
      name: Schema.NullOr(Schema.String),
    }),
  ),
});

const RawIssueRelative = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  state: Schema.NullOr(Schema.Struct({ name: TrimmedNonEmptyString })),
});

const RawIssueDetail = Schema.Struct({
  ...RawIssueSummary.fields,
  description: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(RawIssueRelative),
  children: Schema.Struct({ nodes: Schema.Array(RawIssueRelative) }),
  labels: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        name: TrimmedNonEmptyString,
        color: Schema.String,
      }),
    ),
  }),
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        body: Schema.String,
        url: Schema.String,
        createdAt: Schema.String,
        user: Schema.NullOr(RawUser),
      }),
    ),
  }),
});

const ViewerResult = Schema.Struct({
  viewer: Schema.Struct({
    ...RawUser.fields,
    email: Schema.NullOr(Schema.String),
    organization: Schema.Struct({
      id: TrimmedNonEmptyString,
      name: TrimmedNonEmptyString,
      urlKey: TrimmedNonEmptyString,
    }),
  }),
});

const GetIssueResult = Schema.Struct({ issue: Schema.NullOr(RawIssueDetail) });

const ListIssuesResult = Schema.Struct({
  issues: Schema.Struct({ nodes: Schema.Array(RawIssueSummary) }),
});

const WorkspaceResult = Schema.Struct({
  teams: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        key: TrimmedNonEmptyString,
        name: TrimmedNonEmptyString,
      }),
    ),
  }),
  projects: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        ...RawProject.fields,
        teams: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString })) }),
      }),
    ),
  }),
});

/**
 * A team's state list is read leniently: a state type this build does not know
 * is dropped from the list rather than failing the whole read, so a new Linear
 * state type never blocks moving an issue to In Progress.
 */
const RawTeamWorkflowState = Schema.Struct({
  ...RawWorkflowState.fields,
  type: Schema.String,
});

const TeamStatesResult = Schema.Struct({
  team: Schema.NullOr(
    Schema.Struct({ states: Schema.Struct({ nodes: Schema.Array(RawTeamWorkflowState) }) }),
  ),
});

const isKnownWorkflowStateType = Schema.is(LinearWorkflowStateType);

const IssueUpdateResult = Schema.Struct({
  issueUpdate: Schema.Struct({ success: Schema.Boolean }),
});

const CommentCreateResult = Schema.Struct({
  commentCreate: Schema.Struct({
    success: Schema.Boolean,
    comment: Schema.NullOr(Schema.Struct({ id: TrimmedNonEmptyString, url: Schema.String })),
  }),
});

const CommentUpdateResult = Schema.Struct({
  commentUpdate: CommentCreateResult.fields.commentCreate,
});
const CommentResult = Schema.Struct({
  comment: Schema.NullOr(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      body: Schema.String,
      url: Schema.String,
      issue: Schema.NullOr(Schema.Struct({ id: TrimmedNonEmptyString })),
    }),
  ),
});

const IssueCreateResult = Schema.Struct({
  issueCreate: Schema.Struct({
    success: Schema.Boolean,
    issue: Schema.NullOr(RawIssueSummary),
  }),
});

const RawIssueLabel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  color: Schema.String,
});

const LabelsResult = Schema.Struct({
  issueLabels: Schema.Struct({ nodes: Schema.Array(RawIssueLabel) }),
});

const decodeViewerResult = Schema.decodeUnknownEffect(ViewerResult);
const decodeGetIssueResult = Schema.decodeUnknownEffect(GetIssueResult);
const decodeListIssuesResult = Schema.decodeUnknownEffect(ListIssuesResult);
const decodeWorkspaceResult = Schema.decodeUnknownEffect(WorkspaceResult);
const decodeTeamStatesResult = Schema.decodeUnknownEffect(TeamStatesResult);
const decodeIssueUpdateResult = Schema.decodeUnknownEffect(IssueUpdateResult);
const decodeCommentCreateResult = Schema.decodeUnknownEffect(CommentCreateResult);
const decodeIssueCreateResult = Schema.decodeUnknownEffect(IssueCreateResult);
const decodeLabelsResult = Schema.decodeUnknownEffect(LabelsResult);

const ISSUE_SUMMARY_FIELDS = `
  id
  identifier
  title
  url
  branchName
  priority
  updatedAt
  state { id name type color position }
  team { id key name }
  assignee { id name displayName }
  project { id name url }
  cycle { id number name }
`;

const ISSUE_DETAIL_FIELDS = `
  ${ISSUE_SUMMARY_FIELDS}
  description
  parent { id identifier title url state { name } }
  children { nodes { id identifier title url state { name } } }
  labels { nodes { id name color } }
  comments(first: 50) { nodes { id body url createdAt user { id name displayName } } }
`;

const VIEWER_QUERY = `
  query T3CodeViewer {
    viewer { id name displayName email organization { id name urlKey } }
  }
`;

const GET_ISSUE_QUERY = `
  query T3CodeIssue($id: String!) {
    issue(id: $id) { ${ISSUE_DETAIL_FIELDS} }
  }
`;

const LIST_ISSUES_QUERY = `
  query T3CodeIssues($filter: IssueFilter!, $first: Int!) {
    issues(filter: $filter, orderBy: updatedAt, first: $first) {
      nodes { ${ISSUE_SUMMARY_FIELDS} }
    }
  }
`;

const WORKSPACE_QUERY = `
  query T3CodeWorkspace {
    teams(first: 100) { nodes { id key name } }
    projects(first: 100) {
      nodes {
        id
        name
        url
        teams(first: 10) { nodes { id } }
      }
    }
  }
`;

const TEAM_STATES_QUERY = `
  query T3CodeTeamStates($teamId: String!) {
    team(id: $teamId) { states { nodes { id name type color position } } }
  }
`;

const UPDATE_ISSUE_STATE_MUTATION = `
  mutation T3CodeUpdateIssueState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }
`;

/**
 * The generic issue patch. Only the fields the caller set are put in `$input`,
 * so an unmentioned field is left alone rather than cleared. Assignment fields
 * (`assigneeId`, `delegateId`, `subscriberIds`) are deliberately unreachable:
 * an agent editing an issue must never reassign who owns it.
 */
const UPDATE_ISSUE_MUTATION = `
  mutation T3CodeUpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation T3CodeCreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { ${ISSUE_SUMMARY_FIELDS} }
    }
  }
`;

/**
 * The labels an issue on `$teamId` may carry: the team's own plus the
 * workspace-level ones, which Linear models as labels with a null team.
 */
const LABELS_QUERY = `
  query T3CodeLabels($teamId: ID!) {
    issueLabels(
      first: 250
      filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }
    ) {
      nodes { id name color }
    }
  }
`;

const GET_COMMENT_QUERY = `
  query T3CodeGetComment($id: String!) {
    comment(id: $id) { id body url issue { id } }
  }
`;
const UPDATE_COMMENT_MUTATION = `
  mutation T3CodeUpdateComment($id: String!, $body: String!) {
    commentUpdate(id: $id, input: { body: $body }) {
      success
      comment { id url }
    }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation T3CodeCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id url }
    }
  }
`;

/**
 * A failure that reached Linear, kept internal so an operation can tell a missing
 * issue from a broken request before it turns into a contract error.
 */
class LinearRequestFailure extends Schema.TaggedErrorClass<LinearRequestFailure>()(
  "LinearRequestFailure",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    /** GraphQL `extensions.code`, empty when the failure never got that far. */
    code: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const toOperationError = (failure: LinearRequestFailure) =>
  new LinearOperationError({
    operation: failure.operation,
    detail: failure.detail,
    ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
  });

const failOperation = (failure: LinearRequestFailure) => Effect.fail(toOperationError(failure));

/** Linear's own words, flattened to one line the UI can print without leaking a body dump. */
function sanitizeDetail(value: string): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= MAX_DETAIL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

function isEntityNotFound(failure: LinearRequestFailure): boolean {
  return failure.code === "ENTITY_NOT_FOUND" || /entity not found/iu.test(failure.detail);
}

/** Linear's `X-RateLimit-Requests-Reset` is epoch millis, unlike `Retry-After`. */
function retryAtFromResetHeader(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > now ? parsed : undefined;
}

function toIssueRelative(raw: typeof RawIssueRelative.Type): LinearIssueRelative {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    stateName: raw.state?.name ?? "Unknown",
  };
}

function toIssueDetail(raw: typeof RawIssueDetail.Type): LinearIssueDetail {
  const { description, comments, parent, children, labels, ...summary } = raw;
  return {
    ...summary,
    description,
    comments: comments.nodes.map((comment) => ({
      id: comment.id,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      author: comment.user,
    })),
    parent: parent === null ? null : toIssueRelative(parent),
    children: children.nodes.map(toIssueRelative),
    labels: labels.nodes,
  };
}

export class LinearApi extends Context.Service<
  LinearApi,
  {
    /** Settings reads this on every open; a missing or rejected key is a status, not a failure. */
    readonly status: Effect.Effect<LinearConnectionStatus>;
    readonly getIssue: (
      input: LinearGetIssueInput,
    ) => Effect.Effect<
      LinearIssueDetail,
      LinearUnavailableError | LinearIssueNotFoundError | LinearOperationError
    >;
    readonly listIssues: (
      input: LinearListIssuesInput,
    ) => Effect.Effect<LinearListIssuesResult, LinearUnavailableError | LinearOperationError>;
    /** Teams and their projects, sorted so the mapping picker does not reshuffle. */
    readonly workspace: Effect.Effect<
      LinearWorkspaceStructure,
      LinearUnavailableError | LinearOperationError
    >;
    readonly workflowStates: (
      teamId: string,
    ) => Effect.Effect<
      ReadonlyArray<LinearWorkflowState>,
      LinearUnavailableError | LinearOperationError
    >;
    readonly updateIssueState: (input: {
      readonly issueId: string;
      readonly stateId: string;
    }) => Effect.Effect<void, LinearUnavailableError | LinearOperationError>;
    /**
     * Patch an issue. Only the fields present are sent, so anything the caller
     * leaves out keeps its current value. There is deliberately no way to
     * change the assignee, the delegate, or the subscribers.
     */
    readonly updateIssue: (input: {
      readonly issueId: string;
      readonly title?: string;
      readonly description?: string;
      readonly stateId?: string;
      readonly labelIds?: ReadonlyArray<string>;
    }) => Effect.Effect<void, LinearUnavailableError | LinearOperationError>;
    readonly createIssue: (input: {
      readonly teamId: string;
      readonly title: string;
      readonly description?: string;
      readonly parentId?: string;
      readonly stateId?: string;
      readonly labelIds?: ReadonlyArray<string>;
    }) => Effect.Effect<LinearIssueSummary, LinearUnavailableError | LinearOperationError>;
    /** Labels an issue on this team may carry, team-owned plus workspace-wide, sorted by name. */
    readonly labels: (
      teamId: string,
    ) => Effect.Effect<
      ReadonlyArray<LinearIssueLabel>,
      LinearUnavailableError | LinearOperationError
    >;
    readonly getComment: (
      id: string,
    ) => Effect.Effect<
      NonNullable<typeof CommentResult.Type.comment>,
      LinearUnavailableError | LinearOperationError
    >;
    readonly updateComment: (input: {
      readonly id: string;
      readonly body: string;
    }) => Effect.Effect<
      { readonly id: string; readonly url: string },
      LinearUnavailableError | LinearOperationError
    >;
    readonly createComment: (input: {
      readonly issueId: string;
      readonly body: string;
    }) => Effect.Effect<
      { readonly id: string; readonly url: string },
      LinearUnavailableError | LinearOperationError
    >;
  }
>()("t3/linear/LinearApi") {}

/** Delegated runs authenticate as the app; interactive requests keep the personal key. */
export class LinearAppCredential extends Context.Reference<
  Effect.Effect<string, LinearOperationError> | undefined
>("t3/linear/LinearAppCredential", {
  defaultValue: () => undefined as Effect.Effect<string, LinearOperationError> | undefined,
}) {}

export const make = Effect.gen(function* () {
  const baseUrl = yield* LinearApiBaseUrl;
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettingsService;

  // Read per call: the key can change in Settings while the server runs, and
  // `getSettings` is the path that materializes it out of the secret store.
  const readApiKey = (operation: string) =>
    serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new LinearRequestFailure({
            operation,
            detail: "The server could not read its Linear settings.",
            code: "",
            cause,
          }),
      ),
      Effect.map((settings) => settings.linear.apiKey.trim()),
    );

  const request = <A>(input: {
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
    /** Built at module scope so a compiled decoder is reused across calls. */
    readonly decode: (data: unknown) => Effect.Effect<A, Schema.SchemaError>;
  }): Effect.Effect<A, LinearUnavailableError | LinearRequestFailure> =>
    Effect.gen(function* () {
      const operation = input.operation;
      const appCredential = yield* LinearAppCredential;
      const apiKey = appCredential
        ? `Bearer ${yield* appCredential.pipe(Effect.mapError(() => new LinearRequestFailure({ operation, detail: "Reconnect the Linear app.", code: "" })))}`
        : yield* readApiKey(operation);
      if (apiKey.length === 0) {
        return yield* new LinearUnavailableError({ reason: "unconfigured" });
      }

      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(baseUrl).pipe(
            // Linear personal keys are sent raw; a `Bearer` prefix is only for OAuth tokens.
            HttpClientRequest.setHeader("authorization", apiKey),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({ query: input.query, variables: input.variables }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new LinearRequestFailure({
                operation,
                detail: "Could not reach Linear.",
                code: "",
                cause,
              }),
          ),
        );

      const now = yield* Clock.currentTimeMillis;
      const retryAt =
        retryAtFromHeader(response.headers["retry-after"], now) ??
        retryAtFromResetHeader(response.headers["x-ratelimit-requests-reset"], now);

      const collected = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: MAX_RESPONSE_BYTES,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LinearRequestFailure({
              operation,
              detail: "Could not read Linear's response.",
              code: "",
              cause,
            }),
        ),
      );
      if (collected.truncated) {
        return yield* new LinearRequestFailure({
          operation,
          detail: "Linear's response was too large to read.",
          code: "",
        });
      }

      // A body Linear did not write as GraphQL JSON still has a status worth reporting.
      const envelope = yield* decodeGraphQLEnvelope(collected.text).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const graphQLError = envelope?.errors?.[0];
      const code = graphQLError?.extensions?.code ?? "";

      if (response.status === 401 || code === "AUTHENTICATION_ERROR") {
        return yield* new LinearUnavailableError({ reason: "unauthenticated" });
      }
      if (response.status === 429 || code === "RATELIMITED") {
        return yield* new LinearUnavailableError({
          reason: "rate-limited",
          ...(retryAt !== undefined ? { retryAt } : {}),
        });
      }
      if (graphQLError !== undefined) {
        const detail = sanitizeDetail(graphQLError.message ?? "");
        return yield* new LinearRequestFailure({
          operation,
          code,
          detail:
            detail.length > 0
              ? `Linear rejected the request: ${detail}`
              : "Linear rejected the request.",
        });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new LinearRequestFailure({
          operation,
          code,
          detail: `Linear returned HTTP ${response.status}.`,
        });
      }
      if (envelope?.data === undefined || envelope.data === null) {
        return yield* new LinearRequestFailure({
          operation,
          code,
          detail: "Linear returned a response this server could not read.",
        });
      }

      return yield* input.decode(envelope.data).pipe(
        Effect.mapError(
          (cause) =>
            new LinearRequestFailure({
              operation,
              detail: "Linear returned an unexpected response shape.",
              code: "",
              cause,
            }),
        ),
      );
    });

  const status: Effect.Effect<LinearConnectionStatus> = request({
    operation: "status",
    query: VIEWER_QUERY,
    variables: {},
    decode: decodeViewerResult,
  }).pipe(
    Effect.map(({ viewer }): LinearConnectionStatus => {
      const email = viewer.email?.trim() ?? "";
      return {
        status: "connected",
        viewer: {
          id: viewer.id,
          name: viewer.name,
          displayName: viewer.displayName,
          ...(email.length > 0 ? { email } : {}),
        },
        workspace: viewer.organization,
      };
    }),
    Effect.catchTags({
      LinearUnavailableError: (error) => {
        if (error.reason === "unconfigured") {
          return Effect.succeed<LinearConnectionStatus>({ status: "unconfigured" });
        }
        if (error.reason === "unauthenticated") {
          return Effect.succeed<LinearConnectionStatus>({ status: "unauthenticated" });
        }
        return Effect.succeed<LinearConnectionStatus>({
          status: "failed",
          detail: error.message,
          ...(error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
        });
      },
      LinearRequestFailure: (failure) =>
        Effect.succeed<LinearConnectionStatus>({ status: "failed", detail: failure.detail }),
    }),
  );

  const getIssue = Effect.fn("LinearApi.getIssue")(function* (input: LinearGetIssueInput) {
    const result = yield* request({
      operation: "getIssue",
      query: GET_ISSUE_QUERY,
      // Linear's `issue(id:)` takes an identifier such as `DEL-123` as well as a UUID.
      variables: { id: input.reference },
      decode: decodeGetIssueResult,
    }).pipe(
      Effect.catchTag(
        "LinearRequestFailure",
        (failure): Effect.Effect<never, LinearIssueNotFoundError | LinearOperationError> =>
          isEntityNotFound(failure)
            ? Effect.fail(new LinearIssueNotFoundError({ reference: input.reference }))
            : failOperation(failure),
      ),
    );
    if (result.issue === null) {
      return yield* new LinearIssueNotFoundError({ reference: input.reference });
    }
    return toIssueDetail(result.issue);
  });

  const listIssues = Effect.fn("LinearApi.listIssues")(function* (input: LinearListIssuesInput) {
    const stateTypes =
      input.stateTypes !== undefined && input.stateTypes.length > 0
        ? input.stateTypes
        : DEFAULT_LIST_STATE_TYPES;
    const result = yield* request({
      operation: "listIssues",
      query: LIST_ISSUES_QUERY,
      variables: {
        filter: {
          ...(input.assignedToMe !== false ? { assignee: { isMe: { eq: true } } } : {}),
          state: { type: { in: stateTypes } },
          ...(input.teamKey !== undefined ? { team: { key: { eq: input.teamKey } } } : {}),
          ...(input.projectId !== undefined ? { project: { id: { eq: input.projectId } } } : {}),
        },
        first: Math.min(input.limit ?? DEFAULT_ISSUE_LIMIT, MAX_ISSUE_LIMIT),
      },
      decode: decodeListIssuesResult,
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    return { issues: result.issues.nodes } satisfies LinearListIssuesResult;
  });

  const workspace: Effect.Effect<
    LinearWorkspaceStructure,
    LinearUnavailableError | LinearOperationError
  > = request({
    operation: "workspace",
    query: WORKSPACE_QUERY,
    variables: {},
    decode: decodeWorkspaceResult,
  }).pipe(
    Effect.catchTag("LinearRequestFailure", failOperation),
    Effect.map((result) => ({
      teams: result.teams.nodes
        .map((team) => ({
          id: team.id,
          key: team.key,
          name: team.name,
          projects: result.projects.nodes
            .filter((project) => project.teams.nodes.some((owner) => owner.id === team.id))
            .map(({ id, name, url }) => ({ id, name, url }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    })),
  );

  const workflowStates = Effect.fn("LinearApi.workflowStates")(function* (teamId: string) {
    const result = yield* request({
      operation: "workflowStates",
      query: TEAM_STATES_QUERY,
      variables: { teamId },
      decode: decodeTeamStatesResult,
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    if (result.team === null) {
      return yield* new LinearOperationError({
        operation: "workflowStates",
        detail: "Linear has no team with that id, or it is not visible to the connected user.",
      });
    }
    return result.team.states.nodes.flatMap((state): LinearWorkflowState[] =>
      isKnownWorkflowStateType(state.type) ? [{ ...state, type: state.type }] : [],
    );
  });

  const updateIssueState = Effect.fn("LinearApi.updateIssueState")(function* (input: {
    readonly issueId: string;
    readonly stateId: string;
  }) {
    const result = yield* request({
      operation: "updateIssueState",
      query: UPDATE_ISSUE_STATE_MUTATION,
      variables: { id: input.issueId, stateId: input.stateId },
      decode: decodeIssueUpdateResult,
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    if (!result.issueUpdate.success) {
      return yield* new LinearOperationError({
        operation: "updateIssueState",
        detail: "Linear refused to move the issue to that state.",
      });
    }
  });

  const updateIssue = Effect.fn("LinearApi.updateIssue")(function* (input: {
    readonly issueId: string;
    readonly title?: string;
    readonly description?: string;
    readonly stateId?: string;
    readonly labelIds?: ReadonlyArray<string>;
  }) {
    const result = yield* request({
      operation: "updateIssue",
      query: UPDATE_ISSUE_MUTATION,
      variables: {
        id: input.issueId,
        input: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.stateId !== undefined ? { stateId: input.stateId } : {}),
          ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
        },
      },
      decode: decodeIssueUpdateResult,
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    if (!result.issueUpdate.success) {
      return yield* new LinearOperationError({
        operation: "updateIssue",
        detail: "Linear refused to save the issue.",
      });
    }
  });

  const createIssue = Effect.fn("LinearApi.createIssue")(function* (input: {
    readonly teamId: string;
    readonly title: string;
    readonly description?: string;
    readonly parentId?: string;
    readonly stateId?: string;
    readonly labelIds?: ReadonlyArray<string>;
  }) {
    const result = yield* request({
      operation: "createIssue",
      query: CREATE_ISSUE_MUTATION,
      variables: {
        input: {
          teamId: input.teamId,
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.stateId !== undefined ? { stateId: input.stateId } : {}),
          ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
        },
      },
      decode: decodeIssueCreateResult,
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    if (!result.issueCreate.success || result.issueCreate.issue === null) {
      return yield* new LinearOperationError({
        operation: "createIssue",
        detail: "Linear refused to create the issue.",
      });
    }
    return result.issueCreate.issue satisfies LinearIssueSummary;
  });

  const labels = Effect.fn("LinearApi.labels")(function* (teamId: string) {
    const result = yield* request({
      operation: "labels",
      query: LABELS_QUERY,
      variables: { teamId },
      decode: decodeLabelsResult,
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    return [...result.issueLabels.nodes].sort((left, right) =>
      left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase()),
    );
  });

  const createComment = Effect.fn("LinearApi.createComment")(function* (input: {
    readonly issueId: string;
    readonly body: string;
  }) {
    const result = yield* request({
      operation: "createComment",
      query: CREATE_COMMENT_MUTATION,
      variables: { issueId: input.issueId, body: input.body },
      decode: decodeCommentCreateResult,
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    if (!result.commentCreate.success || result.commentCreate.comment === null) {
      return yield* new LinearOperationError({
        operation: "createComment",
        detail: "Linear refused to add the comment.",
      });
    }
    return result.commentCreate.comment;
  });

  const getComment = Effect.fn("LinearApi.getComment")(function* (id: string) {
    const result = yield* request({
      operation: "getComment",
      query: GET_COMMENT_QUERY,
      variables: { id },
      decode: Schema.decodeUnknownEffect(CommentResult),
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    if (result.comment === null) {
      return yield* new LinearOperationError({
        operation: "getComment",
        detail: "Comment not found or inaccessible.",
      });
    }
    return result.comment;
  });

  const updateComment = Effect.fn("LinearApi.updateComment")(function* (input: {
    readonly id: string;
    readonly body: string;
  }) {
    const result = yield* request({
      operation: "updateComment",
      query: UPDATE_COMMENT_MUTATION,
      variables: { id: input.id, body: input.body },
      decode: Schema.decodeUnknownEffect(CommentUpdateResult),
    }).pipe(Effect.catchTag("LinearRequestFailure", failOperation));
    if (!result.commentUpdate.success || result.commentUpdate.comment === null) {
      return yield* new LinearOperationError({
        operation: "updateComment",
        detail: "Linear refused to edit the comment.",
      });
    }
    return result.commentUpdate.comment;
  });

  return LinearApi.of({
    getComment,
    updateComment,
    status,
    getIssue,
    listIssues,
    workspace,
    workflowStates,
    updateIssueState,
    updateIssue,
    createIssue,
    labels,
    createComment,
  });
});

export const layer = Layer.effect(LinearApi, make);
