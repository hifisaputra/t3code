import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { LinearOperationError } from "@t3tools/contracts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const SECRET = "linear-app-oauth";
const Tokens = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  clientId: Schema.String,
  organizationId: Schema.String,
});
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
});
const decodeTokens = Schema.decodeUnknownEffect(Schema.fromJsonString(Tokens));
const encodeTokens = Schema.encodeEffect(Schema.fromJsonString(Tokens));
const failure = (detail: string) => new LinearOperationError({ operation: "delegation", detail });
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const settings = yield* ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const lock = yield* Semaphore.make(1);
  let pending: {
    state: string;
    verifier: string;
    expiresAt: number;
    clientId: string;
    redirectUri: string;
  } | null = null;
  const config = settings.getSettings.pipe(
    Effect.map((s) => s.linear.delegation),
    Effect.mapError(() => failure("Could not read delegation settings.")),
  );
  const read = Effect.fn("LinearOAuth.read")(function* () {
    const stored = yield* secrets
      .get(SECRET)
      .pipe(Effect.mapError(() => failure("Could not read the Linear app connection.")));
    if (Option.isNone(stored)) return null;
    return yield* decodeTokens(new TextDecoder().decode(stored.value)).pipe(
      Effect.mapError(() => failure("Reconnect the Linear app.")),
    );
  });
  const save = Effect.fn("LinearOAuth.save")(
    function* (tokens: typeof Tokens.Type) {
      const encoded = yield* encodeTokens(tokens);
      yield* secrets.set(SECRET, new TextEncoder().encode(encoded));
    },
    Effect.mapError(() => failure("Could not save the Linear app connection.")),
  );
  const exchange = Effect.fn("LinearOAuth.exchange")(function* (
    parameters: Record<string, string>,
  ) {
    const c = yield* config;
    const response = yield* http
      .execute(
        HttpClientRequest.post("https://api.linear.app/oauth/token").pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: c.clientId,
            client_secret: c.clientSecret,
            ...parameters,
          }),
        ),
      )
      .pipe(
        Effect.timeout("8 seconds"),
        Effect.mapError(() => failure("Could not reach Linear authorization.")),
      );
    if (response.status !== 200)
      return yield* failure("Linear authorization expired or was denied. Reconnect the app.");
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
      Effect.mapError(() => failure("Linear returned an invalid token response.")),
    );
  });
  const authorize = Effect.gen(function* () {
    const c = yield* config;
    let origin: URL;
    try {
      origin = new URL(c.publicUrl);
    } catch {
      return yield* failure("Set the public HTTPS URL of this T3 environment.");
    }
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      return yield* failure("Use a public HTTPS origin without a path, query, or credentials.");
    if (!c.clientId || !c.clientSecret || !c.webhookSecret)
      return yield* failure(
        "Save the Linear app client ID, client secret, and webhook secret first.",
      );
    const state = NodeCrypto.randomBytes(32).toString("base64url");
    const verifier = NodeCrypto.randomBytes(32).toString("base64url");
    const redirectUri = `${origin.origin}/api/linear/oauth/callback`;
    pending = {
      state,
      verifier,
      clientId: c.clientId,
      redirectUri,
      expiresAt: (yield* Clock.currentTimeMillis) + 600_000,
    };
    const url = new URL("https://linear.app/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      actor: "app",
      prompt: "consent",
      scope: "read,write,issues:create,comments:create,app:assignable,app:mentionable",
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString() };
  });
  const complete = Effect.fn("LinearOAuth.complete")(function* (state: string, code: string) {
    const p = pending;
    if (!p || !state || p.state !== state || p.expiresAt < (yield* Clock.currentTimeMillis))
      return yield* failure("Authorization request expired. Connect again from Settings.");
    pending = null;
    const c = yield* config;
    if (p.clientId !== c.clientId || !code)
      return yield* failure("Authorization settings changed. Connect again.");
    const tokens = yield* exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    });
    const response = yield* http
      .execute(
        HttpClientRequest.post("https://api.linear.app/graphql").pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${tokens.access_token}`),
          HttpClientRequest.bodyJsonUnsafe({ query: "query { viewer { organization { id } } }" }),
        ),
      )
      .pipe(
        Effect.timeout("8 seconds"),
        Effect.mapError(() => failure("Could not identify the Linear workspace.")),
      );
    const identity = yield* response.json.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              viewer: Schema.Struct({ organization: Schema.Struct({ id: Schema.String }) }),
            }),
          }),
        ),
      ),
      Effect.mapError(() => failure("Could not identify the Linear workspace.")),
    );
    yield* save({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000,
      clientId: c.clientId,
      organizationId: identity.data.viewer.organization.id,
    });
  }, lock.withPermits(1));
  const accessToken = Effect.fn("LinearOAuth.accessToken")(function* (force: boolean) {
    let tokens = yield* read();
    const c = yield* config;
    if (!tokens || tokens.clientId !== c.clientId)
      return yield* failure("Connect the Linear app in Settings first.");
    if (force || tokens.expiresAt < (yield* Clock.currentTimeMillis) + 3_600_000) {
      const next = yield* exchange({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      });
      tokens = {
        ...tokens,
        accessToken: next.access_token,
        refreshToken: next.refresh_token,
        expiresAt: (yield* Clock.currentTimeMillis) + next.expires_in * 1000,
      };
      yield* save(tokens);
    }
    return tokens.accessToken;
  }, lock.withPermits(1));
  const status = Effect.gen(function* () {
    const c = yield* config;
    const tokens = yield* read();
    return {
      connected: tokens !== null && tokens.clientId === c.clientId,
      organizationId: tokens?.organizationId ?? null,
    };
  });
  const disconnect = Effect.gen(function* () {
    pending = null;
    yield* settings
      .updateSettings({ linear: { delegation: { enabled: false } } })
      .pipe(Effect.mapError(() => failure("Could not disable delegation.")));
    yield* secrets
      .remove(SECRET)
      .pipe(Effect.mapError(() => failure("Could not remove the Linear app connection.")));
  }).pipe(lock.withPermits(1));
  return { authorize, complete, accessToken, status, disconnect };
});
export class LinearOAuth extends Context.Service<LinearOAuth, Effect.Success<typeof make>>()(
  "t3/linear/LinearOAuth",
) {}
export const layer = Layer.effect(LinearOAuth, make);
