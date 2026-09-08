import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinearOAuth from "./LinearOAuth.ts";

const decodeSavedRefreshToken = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ refreshToken: Schema.String })),
);

function harness() {
  const secrets = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const layer = LinearOAuth.layer.pipe(
    Layer.provide(
      ServerSettings.layerTest({
        linear: {
          delegation: {
            enabled: true,
            clientId: "app-1",
            clientSecret: "secret",
            webhookSecret: "webhook",
            publicUrl: "https://t3.example.com",
          },
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSecretStore)({
        get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
        set: (name, value) =>
          Effect.sync(() => {
            secrets.set(name, value);
          }),
        remove: (name) =>
          Effect.sync(() => {
            secrets.delete(name);
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          calls.push(request.url);
          const data = request.url.endsWith("/oauth/token")
            ? {
                access_token: `access-${calls.length}`,
                refresh_token: `refresh-${calls.length}`,
                expires_in: 86400,
              }
            : { data: { viewer: { organization: { id: "org-1" } } } };
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(data)));
        }),
      ),
    ),
  );
  return { layer, secrets, calls };
}

it.effect(
  "installs as an assignable app, validates state once, and stores tokens only in the secret store",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const oauth = yield* LinearOAuth.LinearOAuth;
      const { url } = yield* oauth.authorize;
      const params = new URL(url).searchParams;
      assert.equal(params.get("actor"), "app");
      assert.include(params.get("scope"), "app:assignable");
      assert.include(params.get("scope"), "app:mentionable");
      assert.equal(params.get("redirect_uri"), "https://t3.example.com/api/linear/oauth/callback");
      assert.equal(params.get("code_challenge_method"), "S256");
      assert.isTrue(yield* oauth.complete("wrong", "code").pipe(Effect.isFailure));
      assert.lengthOf(h.calls, 0);
      yield* oauth.complete(params.get("state")!, "code");
      assert.deepEqual(yield* oauth.status, { connected: true, organizationId: "org-1" });
      assert.isTrue(yield* oauth.complete(params.get("state")!, "code").pipe(Effect.isFailure));
      assert.equal(yield* oauth.accessToken(false), "access-1");
      const stored = yield* decodeSavedRefreshToken(
        new TextDecoder().decode(h.secrets.get("linear-app-oauth")),
      );
      assert.equal(stored.refreshToken, "refresh-1");
      yield* oauth.disconnect;
      assert.isFalse((yield* oauth.status).connected);
      assert.isFalse(h.secrets.has("linear-app-oauth"));
    }).pipe(Effect.provide(h.layer));
  },
);
it.effect("expires callbacks and serializes refresh-token rotation", () => {
  const h = harness();
  return Effect.gen(function* () {
    const oauth = yield* LinearOAuth.LinearOAuth;
    const first = new URL((yield* oauth.authorize).url);
    yield* TestClock.adjust("11 minutes");
    assert.isTrue(
      yield* oauth.complete(first.searchParams.get("state")!, "code").pipe(Effect.isFailure),
    );
    const next = new URL((yield* oauth.authorize).url);
    yield* oauth.complete(next.searchParams.get("state")!, "code");
    yield* TestClock.adjust("24 hours");
    const tokens = yield* Effect.all([oauth.accessToken(false), oauth.accessToken(false)], {
      concurrency: "unbounded",
    });
    assert.deepEqual(tokens, ["access-3", "access-3"]);
    assert.lengthOf(h.calls, 3);
  }).pipe(Effect.provide(h.layer));
});
