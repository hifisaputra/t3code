import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { LinearOperationError } from "@t3tools/contracts";
import { LinearOAuth } from "./LinearOAuth.ts";

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
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              data: Schema.optional(
                Schema.Record(Schema.String, Schema.Struct({ success: Schema.Boolean })),
              ),
              errors: Schema.optional(Schema.Array(Schema.Unknown)),
            }),
          ),
        ),
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
    },
    Effect.asVoid,
    Effect.timeout("8 seconds"),
    Effect.mapError(
      () =>
        new LinearOperationError({
          operation: "agentSession",
          detail: "Could not update the Linear agent session. Check the app connection.",
        }),
    ),
  );
  const activity = (
    id: string,
    type: "thought" | "elicitation" | "response" | "error",
    body: string,
  ) =>
    request(
      "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
      { input: { agentSessionId: id, content: { type, body: body.slice(0, 12000) } } },
    );
  const links = (id: string, externalUrls: ReadonlyArray<{ label: string; url: string }>) =>
    request(
      "mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
      { id, input: { addedExternalUrls: externalUrls } },
    );
  return { activity, links };
});
export class LinearAgentApi extends Context.Service<LinearAgentApi, Effect.Success<typeof make>>()(
  "t3/linear/LinearAgentApi",
) {}
export const layer = Layer.effect(LinearAgentApi, make);
