import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { LinearOAuth } from "./LinearOAuth.ts";
import { LinearDelegation } from "./LinearDelegation.ts";

export const linearRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const oauth = yield* LinearOAuth;
    const delegation = yield* LinearDelegation;
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/api/linear/oauth/callback",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://localhost");
          const result = yield* oauth
            .complete(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "")
            .pipe(
              Effect.as({
                status: 200,
                text: "T3 Code connected to Linear. Return to T3 Settings and refresh the connection.",
              }),
              Effect.catch(() =>
                Effect.succeed({
                  status: 400,
                  text: "Could not connect to Linear. Return to T3 Settings and start again.",
                }),
              ),
            );
          return HttpServerResponse.text(result.text, {
            status: result.status,
            headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
          });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/api/webhooks/linear",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          let receivedBytes = 0;
          const body = yield* collectUint8StreamText({
            stream: request.stream.pipe(
              Stream.takeUntil((chunk) => {
                receivedBytes += chunk.byteLength;
                return receivedBytes > 1_048_576;
              }),
            ),
            maxBytes: 1_048_576,
          }).pipe(Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(1_048_576)));
          if (body.invalidUtf8) return HttpServerResponse.empty({ status: 400 });
          if (body.truncated) return HttpServerResponse.empty({ status: 413 });
          return yield* delegation
            .receive(
              new TextEncoder().encode(body.text),
              request.headers["linear-signature"] ?? "",
              request.headers["linear-delivery"] ?? "",
            )
            .pipe(
              Effect.as(HttpServerResponse.empty({ status: 200 })),
              Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
            );
        }),
      ),
    );
  }),
);
