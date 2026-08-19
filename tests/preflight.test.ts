import assert from "node:assert/strict";
import test from "node:test";
import { formatPreflight, preflightPassed, runPreflight, type PreflightProbe } from "../src/preflight.js";
import type { MarketView, ResolutionRule } from "../src/types.js";

const market: MarketView = {
  id: "0x1111111111111111111111111111111111111111",
  question: "Ready?",
  outcomes: ["Yes", "No"],
  probabilities: [0.5, 0.5],
  prices: [0.5, 0.5],
  status: "open",
};

const rule: ResolutionRule = {
  marketId: market.id,
  outcomeIdx: 0,
  sourceName: "Official source",
  sourceUrl: "https://example.test/data.json",
  jsonPath: "value",
  comparator: "gte",
  threshold: 1,
  eventAtPath: "event_at",
  freshness: { type: "retrieval" },
};

const readyEnv: NodeJS.ProcessEnv = {
  DELPHI_API_ACCESS_KEY: "api-secret-that-must-not-print",
  DELPHI_SIGNER_TYPE: "private_key",
  WALLET_PRIVATE_KEY: "wallet-secret-that-must-not-print",
  DELPHI_REGISTERED_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
  ALLOW_LIVE_TRADING: "true",
  SETTLEMENT_EDGE_EXECUTE: "true",
  SETTLEMENT_EDGE_MAX_TRADE_TST: "10",
};

class FixtureProbe implements PreflightProbe {
  buyCalls = 0;
  signerAddress = readyEnv.DELPHI_REGISTERED_WALLET_ADDRESS!;
  ethBalance = 1_000_000_000_000_000n;
  tstBalance = 20_000_000n;
  registration: { verified: boolean; detail: string } | undefined = { verified: true, detail: "Registered wallet confirmed." };
  async getSignerAddress() { return this.signerAddress; }
  async getEthBalance() { return this.ethBalance; }
  async getTstBalance() { return { balance: this.tstBalance, decimals: 6 }; }
  async listOpenMarkets() { return [market]; }
  async quoteBuy() { return { costTst: 0.005 }; }
  async verifyWalletRegistration() { return this.registration; }
}

const run = (probe: FixtureProbe, overrides: Parameters<typeof runPreflight>[0] = {}) => runPreflight({
  env: readyEnv,
  probe,
  loadRules: async () => [rule],
  checkReceiptStorage: async () => undefined,
  ...overrides,
});

test("reports every gate and passes a fully mocked read-only path", async () => {
  const probe = new FixtureProbe();
  const results = await run(probe);
  assert.deepEqual(results.map((result) => result.gate), [
    "Configuration",
    "Signer identity",
    "Wallet registration",
    "ETH funds",
    "TST funds",
    "Reviewed rules",
    "Execution switches",
    "Quote availability",
    "Receipt storage",
  ]);
  assert.ok(results.every((result) => result.status === "pass"));
  assert.equal(preflightPassed(results), true);
  assert.equal(probe.buyCalls, 0);
  const output = formatPreflight(results);
  assert.doesNotMatch(output, /api-secret|wallet-secret/);
  assert.match(output, /No transactions were submitted/);
});

test("fails clearly when required configuration is missing", async () => {
  const results = await run(new FixtureProbe(), { env: {} });
  const configuration = results.find((result) => result.gate === "Configuration");
  assert.equal(configuration?.status, "fail");
  assert.match(configuration?.detail ?? "", /DELPHI_API_ACCESS_KEY/);
  assert.equal(preflightPassed(results), false);
});

test("fails when the derived signer differs from the registered wallet", async () => {
  const probe = new FixtureProbe();
  probe.signerAddress = "0x3333333333333333333333333333333333333333";
  const results = await run(probe);
  assert.equal(results.find((result) => result.gate === "Signer identity")?.status, "fail");
  assert.equal(preflightPassed(results), false);
});

test("fails when ETH or TST funds are unavailable", async () => {
  const probe = new FixtureProbe();
  probe.ethBalance = 0n;
  probe.tstBalance = 0n;
  const results = await run(probe);
  assert.equal(results.find((result) => result.gate === "ETH funds")?.status, "fail");
  assert.equal(results.find((result) => result.gate === "TST funds")?.status, "fail");
  assert.equal(preflightPassed(results), false);
});

test("fails closed on invalid reviewed rules", async () => {
  const invalid = { ...rule, marketId: "not-an-address" };
  const results = await run(new FixtureProbe(), { loadRules: async () => [invalid] });
  assert.equal(results.find((result) => result.gate === "Reviewed rules")?.status, "fail");
  assert.equal(results.find((result) => result.gate === "Quote availability")?.status, "fail");
  assert.equal(preflightPassed(results), false);
});

test("fails closed when a reviewed rule has no freshness source", async () => {
  const invalid = { ...rule, freshness: undefined } as unknown as ResolutionRule;
  const results = await run(new FixtureProbe(), { loadRules: async () => [invalid] });
  assert.equal(results.find((result) => result.gate === "Reviewed rules")?.status, "fail");
  assert.equal(preflightPassed(results), false);
});

test("fails closed when a reviewed rule has an incomplete record selection", async () => {
  const invalid = { ...rule, selection: { recordsPath: "schedule", keyPath: "", equals: "match" } };
  const results = await run(new FixtureProbe(), { loadRules: async () => [invalid] });
  assert.equal(results.find((result) => result.gate === "Reviewed rules")?.status, "fail");
  assert.equal(preflightPassed(results), false);
});

test("keeps registration unavailable when no reliable source exists", async () => {
  const probe = new FixtureProbe();
  probe.registration = undefined;
  const results = await run(probe);
  const registration = results.find((result) => result.gate === "Wallet registration");
  assert.equal(registration?.status, "unavailable");
  assert.equal(registration?.required, false);
  assert.equal(preflightPassed(results), true);
});
