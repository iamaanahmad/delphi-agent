import assert from "node:assert/strict";
import test from "node:test";
import { parseCandidateShares } from "../src/config.js";

test("accepts configurable quote sizes while sorting and deduplicating them", () => {
  assert.deepEqual(parseCandidateShares("16,1,4,16,8"), [1, 4, 8, 16]);
});

test("rejects unsafe candidate-share configuration", () => {
  assert.throws(() => parseCandidateShares("1,0,4"), /positive numbers/);
  assert.throws(() => parseCandidateShares("1,not-a-number"), /positive numbers/);
});
