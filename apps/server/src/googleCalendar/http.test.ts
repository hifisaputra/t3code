import { GoogleCalendarError } from "@t3tools/contracts";
import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import { GoogleCalendar } from "./GoogleCalendar.ts";
import { googleCalendarCallbackLayer } from "./http.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

it("rejects an unsolicited OAuth callback without exposing request details", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    googleCalendarCallbackLayer.pipe(
      Layer.provide(
        Layer.mock(GoogleCalendar)({
          complete: () =>
            Effect.fail(new GoogleCalendarError({ message: "This connection request expired." })),
        }),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const response = await handler(
    new Request("http://localhost/oauth/google-calendar/callback?state=invalid&code=secret-code"),
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const text = await response.text();
  assert.include(text, "could not connect");
  assert.notInclude(text, "secret-code");
});
