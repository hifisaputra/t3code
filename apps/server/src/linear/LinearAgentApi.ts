import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { LinearOperationError } from "@t3tools/contracts";
import { LinearOAuth } from "./LinearOAuth.ts";

export type AgentActivityContent =
  | { readonly type: "thought" | "elicitation" | "response" | "error"; readonly body: string }
  | {
      readonly type: "action";
      readonly action: string;
      readonly parameter: string;
      readonly result?: string | undefined;
    };
/** One entry of a session plan. Linear replaces the whole plan on each update. */
export type PlanStep = {
  readonly content: string;
  readonly status: "pending" | "inProgress" | "completed" | "canceled";
};
export type ExternalLink = { readonly label: string; readonly url: string };

const MAX_BODY = 12000;
const MutationResult = Schema.Struct({
  data: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        success: Schema.Boolean,
        agentSession: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const make = Effect.gen(function* () {
  const oauth = yield* LinearOAuth;
  const http = yield* HttpClient.HttpClient;
  const request = Effect.fn("LinearAgentApi.request")(
    function* (query: string, variables: Record<string, unknown>) {
      const send = (token: string) =>
        http.execute(
          HttpClientRequest.post("https://api.linear.app/graphql").pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
            HttpClientRequest.bodyJsonUnsafe({ query, variables }),
          ),
        );
      let response = yield* send(yield* oauth.accessToken(false));
      if (response.status === 401) response = yield* send(yield* oauth.accessToken(true));
      if (response.status !== 200)
        return yield* new LinearOperationError({
          operation: "agentSession",
          detail: `Linear returned HTTP ${response.status}.`,
        });
      const result = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(MutationResult)),
      );
      if (
        result.errors?.length ||
        !result.data ||
        !Object.values(result.data).every((v) => v.success)
      )
        return yield* new LinearOperationError({
          operation: "agentSession",
          detail: "Linear rejected the agent session update.",
        });
      return result.data;
    },
    Effect.timeout("8 seconds"),
    Effect.mapError(
      () =>
        new LinearOperationError({
          operation: "agentSession",
          detail: "Could not update the Linear agent session. Check the app connection.",
        }),
    ),
  );
  /** Linear accepts `ephemeral` only on thought and action, so it is sent only when set. */
  const activity = (id: string, content: AgentActivityContent, ephemeral?: boolean) =>
    request(
      "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
      {
        input: {
          agentSessionId: id,
          content:
            content.type === "action"
              ? {
                  type: "action",
                  action: content.action,
                  parameter: content.parameter,
                  ...(content.result === undefined
                    ? {}
                    : { result: content.result.slice(0, MAX_BODY) }),
                }
              : { type: content.type, body: content.body.slice(0, MAX_BODY) },
          ...(ephemeral ? { ephemeral: true } : {}),
        },
      },
    ).pipe(Effect.asVoid);
  /** `plan` replaces the whole plan; `addedExternalUrls` keeps links already on the session. */
  const update = (
    id: string,
    input: {
      readonly plan?: ReadonlyArray<PlanStep>;
      readonly addedExternalUrls?: ReadonlyArray<ExternalLink>;
    },
  ) =>
    request(
      "mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
      {
        id,
        input: {
          ...(input.plan ? { plan: input.plan } : {}),
          ...(input.addedExternalUrls ? { addedExternalUrls: input.addedExternalUrls } : {}),
        },
      },
    ).pipe(Effect.asVoid);
  /** Starts a session proactively; Linear sends a `created` webhook for it moments later. */
  const createOnIssue = (issueId: string) =>
    request(
      "mutation($input: AgentSessionCreateOnIssue!) { agentSessionCreateOnIssue(input: $input) { success agentSession { id } } }",
      { input: { issueId } },
    ).pipe(
      Effect.flatMap((data) => {
        const id = data.agentSessionCreateOnIssue?.agentSession?.id;
        return id
          ? Effect.succeed(id)
          : Effect.fail(
              new LinearOperationError({
                operation: "agentSession",
                detail: "Linear did not return the new agent session.",
              }),
            );
      }),
    );
  return { activity, update, createOnIssue };
});
export class LinearAgentApi extends Context.Service<LinearAgentApi, Effect.Success<typeof make>>()(
  "t3/linear/LinearAgentApi",
) {}
export const layer = Layer.effect(LinearAgentApi, make);
