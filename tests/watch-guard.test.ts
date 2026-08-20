import assert from "node:assert/strict";
import test from "node:test";
import { guardedTransactionStatus } from "../src/watch-guard.js";

const configured = new Set(["0xgemini"]);

test("guard ignores ambiguous fixture transactions for unconfigured markets", () => {
  const line = JSON.stringify({ record: { type: "failure", marketId: "0x1", transaction: { status: "ambiguous" } } });
  assert.equal(guardedTransactionStatus(line, configured), undefined);
});

test("guard stops on a submitted or ambiguous configured-market transaction", () => {
  const submitted = JSON.stringify({ record: { type: "decision", market: { id: "0xGemini" }, transaction: { status: "submitted" } } });
  const ambiguous = JSON.stringify({ record: { type: "failure", marketId: "0xGEMINI", transaction: { status: "ambiguous" } } });
  assert.equal(guardedTransactionStatus(submitted, configured), "submitted");
  assert.equal(guardedTransactionStatus(ambiguous, configured), "ambiguous");
});

test("guard ignores telemetry transaction summaries", () => {
  const line = JSON.stringify({ record: { type: "telemetry", marketId: "0xgemini", transaction: { status: "ambiguous" } } });
  assert.equal(guardedTransactionStatus(line, configured), undefined);
});
