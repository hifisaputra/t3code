import { LinearOperationError } from "@t3tools/contracts";
import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import { LinearDelegation } from "./LinearDelegation.ts";
import { linearRoutes } from "./http.ts";
import { LinearOAuth } from "./LinearOAuth.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const routes = () => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    linearRoutes.pipe(
      Layer.provide(
        Layer.mock(LinearOAuth)({
          complete: () =>
            Effect.fail(
              new LinearOperationError({ operation: "delegation", detail: "Invalid OAuth state." }),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(LinearDelegation)({
          receive: () =>
            Effect.fail(
              new LinearOperationError({ operation: "delegation", detail: "Invalid signature." }),
            ),
        }),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return handler;
};

it("rejects an unsolicited OAuth callback without echoing its code", async () => {
  const response = await routes()(
    new Request("http://localhost/api/linear/oauth/callback?state=invalid&code=secret-code"),
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.notInclude(await response.text(), "secret-code");
});

it("rejects an unsigned webhook", async () => {
  const response = await routes()(
    new Request("http://localhost/api/webhooks/linear", { method: "POST", body: "{}" }),
  );
  assert.equal(response.status, 400);
});
