import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";

const listingWith = (hasCredential: boolean) =>
  Effect.gen(function* () {
    let called = false;
    const provider = yield* BitbucketSourceControlProvider.make.pipe(
      Effect.provide(
        Layer.mock(BitbucketApi.BitbucketApi)({
          hasCredential: Effect.succeed(hasCredential),
          listPullRequests: () =>
            Effect.sync(() => {
              called = true;
              return [];
            }),
        }),
      ),
    );
    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
    });
    return { called, changeRequests };
  });

it.effect("lists no change requests without a credential, leaving the API untouched", () =>
  Effect.gen(function* () {
    const result = yield* listingWith(false);
    assert.deepStrictEqual(result.changeRequests, []);
    assert.isFalse(result.called);
  }),
);

it.effect("lists change requests through the API once a credential is configured", () =>
  Effect.gen(function* () {
    const result = yield* listingWith(true);
    assert.isTrue(result.called);
  }),
);
