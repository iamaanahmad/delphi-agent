import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import type { MarketView, ResolutionRule } from "./types.js";
import { loadResolutionRules } from "./watcher.js";
import { assessRuleTiming } from "./rule-timing.js";

export type PreflightStatus = "pass" | "fail" | "unavailable";

export interface PreflightResult {
  gate: string;
  status: PreflightStatus;
  detail: string;
  required: boolean;
}

export interface RegistrationResult {
  verified: boolean;
  detail: string;
}

export interface PreflightProbe {
  getSignerAddress(): Promise<string>;
  getEthBalance(): Promise<bigint>;
  getTstBalance(): Promise<{ balance: bigint; decimals: number }>;
  listOpenMarkets(): Promise<MarketView[]>;
  quoteBuy(marketId: string, outcomeIdx: number, shares: number): Promise<{ costTst: number }>;
  verifyWalletRegistration(address: string): Promise<RegistrationResult | undefined>;
}

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  ruleFile?: string;
  receiptPath?: string;
  probe?: PreflightProbe;
  loadRules?: (path: string) => Promise<ResolutionRule[]>;
  checkReceiptStorage?: (path: string) => Promise<void>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const COMPARATORS = new Set(["gt", "gte", "lt", "lte", "eq"]);
const PREFLIGHT_QUOTE_SHARES = 0.1;

function missingConfiguration(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!env.DELPHI_API_ACCESS_KEY) missing.push("DELPHI_API_ACCESS_KEY");
  const signerType = env.DELPHI_SIGNER_TYPE ?? "cdp_server_wallet";
  if (signerType === "private_key") {
    if (!env.WALLET_PRIVATE_KEY) missing.push("WALLET_PRIVATE_KEY");
  } else if (signerType === "cdp_server_wallet") {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "CDP_WALLET_ADDRESS"] as const) {
      if (!env[name]) missing.push(name);
    }
  } else {
    missing.push("DELPHI_SIGNER_TYPE (must be private_key or cdp_server_wallet)");
  }
  return missing;
}

function validateRules(rules: ResolutionRule[]): void {
  if (rules.length === 0) throw new Error("no reviewed rules are configured");
  for (const [index, rule] of rules.entries()) {
    const label = `rule ${index + 1}`;
    if (!ADDRESS.test(rule.marketId)) throw new Error(`${label} has an invalid market address`);
    if (!Number.isInteger(rule.outcomeIdx) || rule.outcomeIdx < 0) throw new Error(`${label} has an invalid outcome index`);
    if (!rule.sourceName.trim()) throw new Error(`${label} is missing a source name`);
    let source: URL;
    try {
      source = new URL(rule.sourceUrl);
    } catch {
      throw new Error(`${label} has an invalid source URL`);
    }
    if (source.protocol !== "https:") throw new Error(`${label} source must use HTTPS`);
    if (rule.sourceFormat !== undefined && !["json", "google-deepmind-model-cards"].includes(rule.sourceFormat)) {
      throw new Error(`${label} has an invalid source format`);
    }
    if (!COMPARATORS.has(rule.comparator)) throw new Error(`${label} has an invalid comparator`);
    if (rule.jsonPath === undefined && rule.aggregation === undefined) {
      throw new Error(`${label} needs a scalar path or aggregation`);
    }
    if (rule.jsonPath !== undefined && !rule.eventAtPath) {
      throw new Error(`${label} is missing an event timestamp path`);
    }
    if (rule.aggregation !== undefined && !rule.aggregation.eventAtPath) {
      throw new Error(`${label} is missing an aggregate event timestamp path`);
    }
    if (rule.selection !== undefined) {
      if (!rule.selection.recordsPath || !rule.selection.keyPath) {
        throw new Error(`${label} has an invalid record selection`);
      }
      if (typeof rule.selection.equals !== "number" && typeof rule.selection.equals !== "string") {
        throw new Error(`${label} has an invalid record selection value`);
      }
    }
    if (!rule.freshness || !["publication", "retrieval"].includes(rule.freshness.type)) {
      throw new Error(`${label} has an invalid freshness source`);
    }
    if (rule.freshness.type === "publication" && !rule.freshness.path) {
      throw new Error(`${label} is missing a publication timestamp path`);
    }
    if (rule.maxFreshnessAgeMinutes !== undefined && (!Number.isFinite(rule.maxFreshnessAgeMinutes) || rule.maxFreshnessAgeMinutes <= 0)) {
      throw new Error(`${label} has an invalid freshness limit`);
    }
    if (rule.earliestDecisionAt !== undefined && !Number.isFinite(Date.parse(rule.earliestDecisionAt))) {
      throw new Error(`${label} has an invalid earliest decision time`);
    }
  }
}

async function checkWritableWithoutWriting(path: string): Promise<void> {
  const absolute = resolve(path);
  try {
    const metadata = await stat(absolute);
    await access(metadata.isDirectory() ? absolute : dirname(absolute), constants.W_OK);
    if (!metadata.isDirectory()) await access(absolute, constants.W_OK);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let current = dirname(absolute);
  while (true) {
    try {
      const metadata = await stat(current);
      if (!metadata.isDirectory()) throw new Error("receipt parent is not a directory");
      await access(current, constants.W_OK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("no writable receipt directory exists");
      current = parent;
    }
  }
}

class DelphiPreflightProbe implements PreflightProbe {
  private readonly client = new DelphiClient({ network: "competition-testnet" });

  async getSignerAddress() {
    return (await this.client.getSigner()).address;
  }

  getEthBalance() {
    return this.client.getEthBalance();
  }

  getTstBalance() {
    return this.client.getErc20BalanceWithDecimals();
  }

  async listOpenMarkets(): Promise<MarketView[]> {
    const competitionId = process.env.DELPHI_COMPETITION_ID || undefined;
    const { markets } = await this.client.listMarkets({
      status: "open",
      limit: 100,
      pricesAndImpliedProbabilities: true,
      ...(competitionId ? { competitionId } : {}),
    });
    return (markets ?? []).flatMap((market) => {
      const question = market.metadata?.question;
      const outcomes = market.metadata?.outcomes;
      const probabilities = market.spotImpliedProbabilities;
      const prices = market.spotPrices;
      if (!question || !outcomes || !probabilities || !prices) return [];
      return [{
        id: market.id,
        question,
        outcomes,
        probabilities,
        prices,
        status: market.status,
        resolvesAt: market.resolvesAt ?? undefined,
        marketUrl: market.marketUrl,
      }];
    });
  }

  async quoteBuy(marketId: string, outcomeIdx: number, shares: number) {
    const { tokensIn } = await this.client.quoteBuy({
      marketAddress: marketId as `0x${string}`,
      outcomeIdx,
      sharesOut: BigInt(Math.round(shares * 1e18)),
    });
    return { costTst: Number(tokensIn) / 1e6 };
  }

  async verifyWalletRegistration(): Promise<undefined> {
    // Neither the Delphi SDK nor the competition API exposes registration state.
    // Do not infer registration from a configured address or an empty trade history.
    return undefined;
  }
}

function decimalUnits(value: bigint, decimals: number): number {
  return Number(value) / (10 ** decimals);
}

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult[]> {
  const env = options.env ?? process.env;
  const ruleFile = options.ruleFile ?? "config/resolution-rules.json";
  const receiptPath = options.receiptPath ?? env.SETTLEMENT_EDGE_RECEIPT_PATH ?? "artifacts/decision-receipts.jsonl";
  const probe = options.probe ?? new DelphiPreflightProbe();
  const loadRules = options.loadRules ?? loadResolutionRules;
  const checkReceiptStorage = options.checkReceiptStorage ?? checkWritableWithoutWriting;
  const results: PreflightResult[] = [];
  let signerAddress: string | undefined;
  let rules: ResolutionRule[] | undefined;

  const missing = missingConfiguration(env);
  results.push(missing.length === 0
    ? { gate: "Configuration", status: "pass", detail: "Required API and signer settings are present.", required: true }
    : { gate: "Configuration", status: "fail", detail: `Missing or invalid: ${missing.join(", ")}.`, required: true });

  try {
    signerAddress = await probe.getSignerAddress();
    if (!ADDRESS.test(signerAddress)) throw new Error("invalid signer address");
    const expected = env.DELPHI_REGISTERED_WALLET_ADDRESS;
    if (expected && signerAddress.toLowerCase() !== expected.toLowerCase()) {
      results.push({ gate: "Signer identity", status: "fail", detail: "Derived signer does not match DELPHI_REGISTERED_WALLET_ADDRESS.", required: true });
    } else {
      results.push({
        gate: "Signer identity",
        status: "pass",
        detail: expected ? "Derived signer matches the configured registered wallet." : `Derived signer ${signerAddress}. No registered-wallet comparison is configured.`,
        required: true,
      });
    }
  } catch {
    results.push({ gate: "Signer identity", status: "fail", detail: "Signer could not be derived from the configured signing method.", required: true });
  }

  if (!signerAddress) {
    results.push({ gate: "Wallet registration", status: "unavailable", detail: "Registration cannot be checked until a signer address is available.", required: false });
  } else {
    try {
      const registration = await probe.verifyWalletRegistration(signerAddress);
      if (!registration) {
        results.push({ gate: "Wallet registration", status: "unavailable", detail: "No reliable registration endpoint is exposed; confirm this gate on DoraHacks.", required: false });
      } else {
        results.push({ gate: "Wallet registration", status: registration.verified ? "pass" : "fail", detail: registration.detail, required: true });
      }
    } catch {
      results.push({ gate: "Wallet registration", status: "unavailable", detail: "The reliable registration source could not be reached.", required: false });
    }
  }

  try {
    const minimum = Number(env.SETTLEMENT_EDGE_MIN_ETH_BALANCE ?? 0.0001);
    if (!Number.isFinite(minimum) || minimum <= 0) throw new Error("invalid minimum");
    const balance = decimalUnits(await probe.getEthBalance(), 18);
    results.push(balance >= minimum
      ? { gate: "ETH funds", status: "pass", detail: `Balance ${balance.toFixed(6)} ETH meets the ${minimum} ETH minimum.`, required: true }
      : { gate: "ETH funds", status: "fail", detail: `Balance ${balance.toFixed(6)} ETH is below the ${minimum} ETH minimum.`, required: true });
  } catch {
    results.push({ gate: "ETH funds", status: "fail", detail: "ETH balance could not be read.", required: true });
  }

  try {
    const minimum = Number(env.SETTLEMENT_EDGE_MIN_TST_BALANCE ?? env.SETTLEMENT_EDGE_MAX_TRADE_TST ?? 10);
    if (!Number.isFinite(minimum) || minimum <= 0) throw new Error("invalid minimum");
    const { balance: rawBalance, decimals } = await probe.getTstBalance();
    const balance = decimalUnits(rawBalance, decimals);
    results.push(balance >= minimum
      ? { gate: "TST funds", status: "pass", detail: `Balance ${balance.toFixed(4)} TST meets the ${minimum} TST minimum.`, required: true }
      : { gate: "TST funds", status: "fail", detail: `Balance ${balance.toFixed(4)} TST is below the ${minimum} TST minimum.`, required: true });
  } catch {
    results.push({ gate: "TST funds", status: "fail", detail: "TST balance could not be read.", required: true });
  }

  try {
    rules = await loadRules(ruleFile);
    validateRules(rules);
    results.push({ gate: "Reviewed rules", status: "pass", detail: `${rules.length} structurally valid reviewed rule(s) loaded from ${ruleFile}.`, required: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "rules could not be loaded";
    results.push({ gate: "Reviewed rules", status: "fail", detail: `Rules are not ready: ${reason}.`, required: true });
  }

  const switches = env.ALLOW_LIVE_TRADING === "true" && env.SETTLEMENT_EDGE_EXECUTE === "true";
  results.push(switches
    ? { gate: "Execution switches", status: "pass", detail: "Both live-execution switches are enabled; preflight remains read-only.", required: true }
    : { gate: "Execution switches", status: "fail", detail: "ALLOW_LIVE_TRADING and SETTLEMENT_EDGE_EXECUTE must both equal true.", required: true });

  if (!rules) {
    results.push({ gate: "Rule timing", status: "fail", detail: "Timing cannot be checked until reviewed rules load.", required: true });
    results.push({ gate: "Quote availability", status: "fail", detail: "Quotes cannot be checked until reviewed rules load.", required: true });
  } else {
    try {
      const markets = await probe.listOpenMarkets();
      const uniqueRules = [...new Map(rules.map((rule) => [`${rule.marketId.toLowerCase()}:${rule.outcomeIdx}`, rule])).values()];
      const timingFailures: string[] = [];
      for (const rule of uniqueRules) {
        const market = markets.find((item) => item.id.toLowerCase() === rule.marketId.toLowerCase());
        if (!market) throw new Error("a configured market is not open");
        const timing = assessRuleTiming(rule, market);
        if (!timing.feasible) timingFailures.push(`${market.question}: ${timing.reason}`);
      }
      results.push(timingFailures.length === 0
        ? { gate: "Rule timing", status: "pass", detail: `${uniqueRules.length} rule(s) can produce decisive evidence before market close.`, required: true }
        : { gate: "Rule timing", status: "fail", detail: timingFailures.join(" | "), required: true });
      for (const rule of uniqueRules) {
        const quote = await probe.quoteBuy(rule.marketId, rule.outcomeIdx, PREFLIGHT_QUOTE_SHARES);
        if (!Number.isFinite(quote.costTst) || quote.costTst <= 0) throw new Error("an invalid quote was returned");
      }
      results.push({ gate: "Quote availability", status: "pass", detail: `Read-only quotes succeeded for ${uniqueRules.length} configured outcome(s).`, required: true });
    } catch {
      if (!results.some((result) => result.gate === "Rule timing")) {
        results.push({ gate: "Rule timing", status: "fail", detail: "Timing could not be checked for every configured open market.", required: true });
      }
      results.push({ gate: "Quote availability", status: "fail", detail: "A live quote could not be read for every configured open market.", required: true });
    }
  }

  try {
    await checkReceiptStorage(receiptPath);
    results.push({ gate: "Receipt storage", status: "pass", detail: `Receipt destination ${receiptPath} is writable. No file was created.`, required: true });
  } catch {
    results.push({ gate: "Receipt storage", status: "fail", detail: `Receipt destination ${receiptPath} is not writable.`, required: true });
  }

  return results;
}

export function formatPreflight(results: PreflightResult[]): string {
  const lines = ["SETTLEMENT EDGE LIVE-TRADING PREFLIGHT", "──────────────────────────────────────"];
  for (const result of results) lines.push(`${result.status.toUpperCase().padEnd(11)} ${result.gate}: ${result.detail}`);
  const failed = results.filter((result) => result.required && result.status !== "pass");
  const unavailable = results.filter((result) => result.status === "unavailable");
  lines.push("");
  lines.push(failed.length === 0
    ? `READY: all automated gates passed${unavailable.length ? `; ${unavailable.length} manual check remains unavailable` : ""}. No transactions were submitted.`
    : `NOT READY: ${failed.length} required gate(s) did not pass. No transactions were submitted.`);
  return lines.join("\n");
}

export function preflightPassed(results: PreflightResult[]): boolean {
  return results.every((result) => !result.required || result.status === "pass");
}
