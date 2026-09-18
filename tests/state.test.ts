import assert from "node:assert/strict";
import { test } from "node:test";
import { type Guard, transition } from "../packages/contract-sdk/src/index.ts";

test("sdk.state: missing/denying/asynchronous guards cannot approve grants", () => {
  for (const guards of [
    {},
    { execution_grant_valid: () => false },
    { execution_grant_valid: (async () => true) as unknown as Guard },
  ]) {
    assert.throws(() =>
      transition("ExecutionGrant", "REQUESTED", "approve", new Set(["P0"]), guards, {}),
    );
  }
});

test("sdk.state: denied grants are terminal and disabled phases cannot transition", () => {
  const decision = transition("ExecutionGrant", "REQUESTED", "deny", new Set(["P0"]), {}, {});
  assert.equal(decision.target, "DENIED");
  assert.throws(() => transition("ExecutionGrant", "DENIED", "approve", new Set(["P0"]), {}, {}));
  assert.throws(() => transition("ExecutionGrant", "REQUESTED", "deny", new Set(), {}, {}));
  assert.throws(() =>
    transition("ExecutionGrant", "REQUESTED", "invented", new Set(["P0"]), {}, {}),
  );
});
