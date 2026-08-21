import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  marketFingerprint,
  readAndVerifySentinelReceipts,
  runMarketSentinelCycle,
} from "../src/market-sentinel.js";
import type { MarketView, TradingGateway } from "../src/types.js";

const first: MarketView = {
  id: "0xBASELINE",
  question: "Will the baseline happen?",
  outcomes: ["Yes", "No"],
  probabilities: [0.4, 0.6],
  prices: [0.4, 0.6],
  status: "open",
  resolvesAt: "2026-08-22T12:00:00.000Z",
};

const candidate: MarketView = {
  id: "0xCANDIDATE",
  question: "Will a new fact happen?",
  outcomes: ["Yes", "No"],
  probabilities: [0.25, 0.75],
  prices: [0.25, 0.75],
  status: "open",
  resolvesAt: "2026-08-23T12:00:00.000Z",
};

class MutableGateway implements TradingGateway {
  quoteCalls = 0;
  constructor(public markets: MarketView[]) {}
  async listOpenMarkets() { return this.markets; }
  async quoteBuy(_marketId: string, _outcomeIdx: number, shares: number) {
    this.quoteCalls += 1;
    return { shares, costTst: shares * 0.5 };
  }
  async buy(): Promise<{ transactionHash: string }> { throw new Error("sentinel test must never buy"); }
}

test("captures the exact initial market set as the baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-sentinel-"));
  const statePath = join(directory, "state.json");
  const receiptPath = join(directory, "receipts.jsonl");
  const gateway = new MutableGateway([first]);
  const result = await runMarketSentinelCycle(
    gateway,
    new Date("2026-08-23T23:59:00.000Z"),
    statePath,
    receiptPath,
    60_000,
    new Date("2026-08-21T15:00:00.000Z"),
  );
  assert.equal(result.baselineCreated, true);
  assert.equal(result.reviews, 0);
  assert.deepEqual(Object.keys(result.state.baseline), ["0xbaseline"]);
  assert.equal(result.state.baseline["0xbaseline"]?.fingerprint, marketFingerprint(first));
  const receipts = await readAndVerifySentinelReceipts(receiptPath);
  assert.equal(receipts[0]?.event.type, "baseline_captured");
});

test("rejects and quotes a new candidate once, then rechecks only a material change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-sentinel-"));
  const statePath = join(directory, "state.json");
  const receiptPath = join(directory, "receipts.jsonl");
  const gateway = new MutableGateway([first]);
  const cutoff = new Date("2026-08-23T23:59:00.000Z");
  await runMarketSentinelCycle(gateway, cutoff, statePath, receiptPath, 60_000, new Date("2026-08-21T15:00:00.000Z"));

  gateway.markets = [first, candidate];
  const discovered = await runMarketSentinelCycle(gateway, cutoff, statePath, receiptPath, 60_000, new Date("2026-08-21T15:01:00.000Z"));
  assert.equal(discovered.reviews, 1);
  assert.equal(gateway.quoteCalls, 2);
  const suppressed = await runMarketSentinelCycle(gateway, cutoff, statePath, receiptPath, 60_000, new Date("2026-08-21T15:02:00.000Z"));
  assert.equal(suppressed.reviews, 0);
  assert.equal(gateway.quoteCalls, 2);

  gateway.markets = [first, { ...candidate, resolvesAt: "2026-08-23T13:00:00.000Z" }];
  const changed = await runMarketSentinelCycle(gateway, cutoff, statePath, receiptPath, 60_000, new Date("2026-08-21T15:03:00.000Z"));
  assert.equal(changed.reviews, 1);
  assert.equal(gateway.quoteCalls, 4);

  const reviews = (await readAndVerifySentinelReceipts(receiptPath))
    .map((receipt) => receipt.event)
    .filter((event) => event.type === "candidate_review");
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0]?.verdict, "reject");
  assert.equal(reviews[0]?.transaction.status, "not_submitted");
  assert.equal(reviews[1]?.change, "material_market_change");
});

test("fails closed when the receipt chain is modified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-sentinel-"));
  const statePath = join(directory, "state.json");
  const receiptPath = join(directory, "receipts.jsonl");
  await runMarketSentinelCycle(
    new MutableGateway([first]),
    new Date("2026-08-23T23:59:00.000Z"),
    statePath,
    receiptPath,
    60_000,
    new Date("2026-08-21T15:00:00.000Z"),
  );
  const content = await readFile(receiptPath, "utf8");
  await writeFile(receiptPath, content.replace("baseline_captured", "poll_failed"), "utf8");
  await assert.rejects(readAndVerifySentinelReceipts(receiptPath), /hash does not match/);
});
