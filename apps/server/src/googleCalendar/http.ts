import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { GoogleCalendar } from "./GoogleCalendar.ts";

// The browser may be on another device. Google returns to the configured public
// server URL; the one-use state authorizes only the pending connection exchange.
export const googleCalendarCallbackLayer = Layer.unwrap(
  Effect.gen(function* () {
    const calendar = yield* GoogleCalendar;
    return HttpRouter.add(
      "GET",
      "/oauth/google-calendar/callback",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const result = yield* calendar
          .complete(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "")
          .pipe(
            Effect.as(
              "Google Calendar connected. Return to T3 and refresh the connection in Settings.",
            ),
            Effect.catch(() =>
              Effect.succeed(
                "Google Calendar could not connect. Return to T3 Settings and start the connection again.",
              ),
            ),
          );
        return HttpServerResponse.text(result, {
          headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
        });
      }),
    );
  }),
);
