import test from "node:test";
import assert from "node:assert/strict";
import { makeEgoError } from "./errors.js";

test("makeEgoError attaches error_code", () => {
  const err = makeEgoError("EGO_BROWSER_UNAVAILABLE", "chrome missing");
  assert.equal(err.message, "chrome missing");
  assert.equal(err.error_code, "EGO_BROWSER_UNAVAILABLE");
  assert.ok(err instanceof Error);
});
