import assert from "node:assert/strict";
import test from "node:test";
import { compare, readPath } from "../src/evidence.js";

test("reads nested object and array paths", () => {
  assert.equal(readPath({ data: [{ value: 42 }] }, "data.0.value"), 42);
});

test("evaluates numeric and string settlement rules", () => {
  assert.equal(compare(101, "gte", 100), true);
  assert.equal(compare("settled", "eq", "SETTLED"), true);
  assert.equal(compare(99, "gt", 100), false);
});
