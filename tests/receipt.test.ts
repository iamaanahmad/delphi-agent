import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendLedgerRecord, appendReceipt } from "../src/receipt.js";
import type { Decision } from "../src/types.js";

const decision: Decision = {
  action: "skip",
  reason: "fixture",
  market: { id: "0x1", question: "Fixture?", outcomes: ["Yes", "No"], probabilities: [0.5, 0.5], prices: [0.5, 0.5], status: "open" },
  evidence: [],
};

test("links each receipt to the hash before it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-"));
  const path = join(directory, "receipts.jsonl");
  const firstHash = await appendReceipt(decision, path);
  await appendReceipt({ ...decision, reason: "second fixture" }, path);
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { previousHash: string });
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.previousHash, "GENESIS");
  assert.equal(lines[1]?.previousHash, firstHash);
});

test("continues the hash chain when a version 2 record follows version 1 history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-"));
  const path = join(directory, "receipts.jsonl");
  const firstHash = await appendReceipt(decision, path);
  await appendLedgerRecord({
    type: "failure",
    opportunityId: "fixture",
    terminal: true,
    stage: "source",
    marketId: decision.market.id,
    outcomeIdx: 0,
    rules: [],
    reason: "fixture failure",
    marketProbability: { available: true, value: 0.5 },
    riskDecision: { action: "skip", reason: "fixture failure" },
    transaction: { status: "not_submitted" },
  }, path);
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { version: number; previousHash: string });
  assert.equal(lines[1]?.version, 2);
  assert.equal(lines[1]?.previousHash, firstHash);
});
