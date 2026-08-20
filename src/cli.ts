import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadRiskPolicy, liveTradingEnabled } from "./config.js";
import { evaluateMarket } from "./engine.js";
import { fetchEvidence } from "./evidence.js";
import { DelphiGateway, ReplayGateway } from "./gateway.js";
import { reconcileMarket } from "./reconciliation.js";
import { syncLedgerTelemetry } from "./metrics.js";
import { DEFAULT_LEDGER_PATH, DEFAULT_REPLAY_LEDGER_PATH, TELEMETRY_ENVIRONMENTS } from "./receipt.js";
import { settlePortfolio } from "./settlement.js";
import { assessRuleTiming } from "./rule-timing.js";
import { appendTelemetry, type TelemetryContext } from "./telemetry.js";
import type { EvidenceSignal, MarketView, ResolutionRule } from "./types.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  failedStage,
  loadResolutionRules,
  recordOpportunityFailure,
  runWatcher,
  type WatcherStatus,
} from "./watcher.js";

interface ReplayFixture { market: MarketView; outcomeIdx: number; evidence: EvidenceSignal[] }

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function printDecision(decision: Awaited<ReturnType<typeof evaluateMarket>>, mode?: "simulated-replay") {
  console.log("\nSETTLEMENT EDGE DECISION RECEIPT");
  console.log("────────────────────────────────");
  if (mode === "simulated-replay") console.log("Mode:        SIMULATED REPLAY (no live order or realized P&L)");
  console.log(`Market:      ${decision.market.question}`);
  console.log(`Evidence:    ${decision.evidence.map((item) => `${item.source}: ${item.detail}`).join(" | ")}`);
  if (decision.estimate) console.log(`Our view:    ${pct(decision.estimate.probability)} (${pct(decision.estimate.confidence)} confidence)`);
  if (decision.plan) {
    console.log(`Market view: ${pct(decision.plan.marketProbability)}`);
    console.log(`Edge:        +${pct(decision.plan.edge)}`);
    console.log(`Quote:       ${decision.plan.shares} shares for ${decision.plan.costTst.toFixed(4)} TST`);
    console.log(`Impact:      ${pct(decision.plan.priceImpact)}`);
    console.log(`Expected P&L:${decision.plan.expectedProfitTst.toFixed(4)} TST (not realized)`);
  }
  console.log(`Action:      ${decision.action.toUpperCase()} (${decision.reason})`);
  if (decision.transactionHash) console.log(`Transaction: ${decision.transactionHash}`);
}

async function replay(file: string) {
  const fixture = JSON.parse(await readFile(file, "utf8")) as ReplayFixture;
  fixture.evidence = fixture.evidence.map((item) => ({
    ...item,
    eventTime: item.eventTime === "NOW" ? new Date().toISOString() : item.eventTime,
    freshnessTime: item.freshnessTime === "NOW" ? new Date().toISOString() : item.freshnessTime,
    publicationTime: item.publicationTime === "NOW" ? new Date().toISOString() : item.publicationTime,
  }));
  const gateway = new ReplayGateway([fixture.market]);
  const receiptPath = process.env.SETTLEMENT_EDGE_REPLAY_RECEIPT_PATH ?? DEFAULT_REPLAY_LEDGER_PATH;
  const telemetry: TelemetryContext = { runId: randomUUID(), environment: "replay" };
  await appendTelemetry({ ...telemetry, event: "run_started", data: {} }, receiptPath);
  printDecision(await evaluateMarket(gateway, fixture.market, fixture.outcomeIdx, fixture.evidence, loadRiskPolicy(), false, {
    receiptPath,
    telemetry,
  }), "simulated-replay");
}

async function scan() {
  const gateway = new DelphiGateway();
  const markets = await gateway.listOpenMarkets();
  console.log(`Found ${markets.length} open competition market(s).`);
  for (const market of markets) {
    console.log(`\n${market.question}`);
    market.outcomes.forEach((outcome, index) => console.log(`  [${index}] ${outcome}: ${pct(market.probabilities[index] ?? 0)}`));
    if (market.marketUrl) console.log(`  ${market.marketUrl}`);
  }
  console.log("\nNo orders were placed. Attach verified evidence before evaluating a market.");
}

async function run(ruleFile: string) {
  const rules = await loadResolutionRules(ruleFile);
  const gateway = new DelphiGateway();
  const markets = await gateway.listOpenMarkets();
  const groups = new Map<string, ResolutionRule[]>();
  for (const rule of rules) {
    const key = `${rule.marketId}:${rule.outcomeIdx}`;
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  const execute = liveTradingEnabled();
  const receiptPath = process.env.SETTLEMENT_EDGE_RECEIPT_PATH ?? DEFAULT_LEDGER_PATH;
  const telemetry: TelemetryContext = { runId: randomUUID(), environment: execute ? "live" : "dry_run" };
  await appendTelemetry({ ...telemetry, event: "run_started", data: {} }, receiptPath);
  console.log(execute ? "LIVE EXECUTION ENABLED" : "DRY-RUN: no orders can be submitted");
  for (const groupedRules of groups.values()) {
    const first = groupedRules[0];
    if (!first) continue;
    const market = markets.find((candidate) => candidate.id.toLowerCase() === first.marketId.toLowerCase());
    if (!market) {
      console.error(`Skipping ${first.marketId}: open competition market not found`);
      await recordOpportunityFailure(undefined, groupedRules, createHash("sha256").update(JSON.stringify(groupedRules)).digest("hex"), "open competition market not found", "market", receiptPath, { status: "not_submitted" }, telemetry);
      continue;
    }
    const timing = assessRuleTiming(first, market);
    if (!timing.feasible) {
      const reason = `rule timing is not tradable: ${timing.reason}`;
      console.error(`Skipping ${first.marketId}: ${reason}`);
      await recordOpportunityFailure(market, groupedRules, createHash("sha256").update(JSON.stringify({ groupedRules, resolvesAt: market.resolvesAt })).digest("hex"), reason, "market", receiptPath, { status: "not_submitted" }, telemetry);
      continue;
    }
    let evidence: EvidenceSignal[];
    try {
      evidence = await Promise.all(groupedRules.map((rule) => fetchEvidence(rule)));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const id = createHash("sha256").update(JSON.stringify({ marketId: market.id, groupedRules })).digest("hex");
      await recordOpportunityFailure(market, groupedRules, id, failure.message, failedStage(failure), receiptPath, { status: "not_submitted" }, telemetry);
      console.error(`Skipping ${first.marketId}: ${failure.message}`);
      continue;
    }
    const id = createHash("sha256").update(JSON.stringify({ market, groupedRules, evidence })).digest("hex");
    printDecision(await evaluateMarket(gateway, market, first.outcomeIdx, evidence, loadRiskPolicy(), execute, { opportunityId: id, receiptPath, telemetry }));
  }
}

async function reconcile(marketId: string, args: string[]) {
  const ledgerPath = option(args, "--ledger") ?? process.env.SETTLEMENT_EDGE_RECEIPT_PATH ?? DEFAULT_LEDGER_PATH;
  const telemetry: TelemetryContext = { runId: randomUUID(), environment: "live" };
  await appendTelemetry({ ...telemetry, event: "run_started", marketId, data: {} }, ledgerPath);
  const result = await reconcileMarket(new DelphiGateway(), marketId, ledgerPath, telemetry);
  console.log("SETTLEMENT EDGE RECONCILIATION");
  console.log(JSON.stringify(result, null, 2));
}

async function settle(args: string[]) {
  const ledgerPath = option(args, "--ledger") ?? process.env.SETTLEMENT_EDGE_RECEIPT_PATH ?? DEFAULT_LEDGER_PATH;
  const execute = liveTradingEnabled();
  const telemetry: TelemetryContext = { runId: randomUUID(), environment: execute ? "live" : "dry_run" };
  await appendTelemetry({ ...telemetry, event: "run_started", data: {} }, ledgerPath);
  const gateway = new DelphiGateway();
  console.log(execute ? "LIVE POSITION SETTLEMENT ENABLED" : "DRY-RUN: no redemption or liquidation transactions can be submitted");
  const results = await settlePortfolio(gateway, execute, ledgerPath);
  if (results.length === 0) {
    console.log("No unredeemed wallet positions found.");
    return;
  }
  console.log("SETTLEMENT EDGE POSITION SWEEP");
  for (const result of results) {
    const expected = result.expectedTokensTst === undefined ? "unavailable" : `${result.expectedTokensTst.toFixed(6)} TST`;
    const transaction = result.transaction.transactionHash ?? result.transaction.status;
    console.log(`\nMarket:      ${result.marketId}`);
    console.log(`Status:      ${result.status}`);
    console.log(`Action:      ${result.action}`);
    console.log(`Expected:    ${expected}`);
    console.log(`Transaction: ${transaction}`);
    console.log(`Reason:      ${result.reason ?? "none"}`);
    if (execute && result.transaction.status === "submitted") {
      await reconcileMarket(gateway, result.marketId, ledgerPath, telemetry);
    }
  }
  if (results.some((result) => result.transaction.status === "ambiguous")) {
    throw new Error("one or more settlement transactions are ambiguous; inspect the ledger before retrying");
  }
}

async function syncMetrics(args: string[]) {
  const ledgerPath = option(args, "--ledger") ?? process.env.SETTLEMENT_EDGE_RECEIPT_PATH ?? DEFAULT_LEDGER_PATH;
  const environment = option(args, "--environment") ?? "live";
  if (!TELEMETRY_ENVIRONMENTS.includes(environment as TelemetryContext["environment"])) {
    throw new Error("metrics environment must be live, dry_run, replay, or test");
  }
  const count = await syncLedgerTelemetry(ledgerPath, [environment as TelemetryContext["environment"]]);
  console.log(`Synced ${count} ${environment} telemetry event(s) from the verified ledger.`);
}

const positiveOption = (name: string, value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printWatcherStatus(status: WatcherStatus) {
  if (status.type === "cycle") console.log(`Polling ${status.marketCount} open market(s) against ${status.ruleGroupCount} configured outcome(s).`);
  if (status.type === "duplicate") console.log(`Unchanged ${status.key}; duplicate evaluation suppressed.`);
  if (status.type === "missing-market") console.error(`Skipping ${status.marketId}: open competition market not found`);
  if (status.type === "infeasible-rule") console.error(`Skipping ${status.marketId}: ${status.reason}`);
  if (status.type === "retry") console.error(`Watcher cycle failed: ${status.error.message}. Retrying in ${status.delayMs}ms.`);
  if (status.type === "ambiguous-order") console.error(`Order result for ${status.key} is ambiguous. Duplicate execution is blocked until market or evidence changes.`);
  if (status.type === "stopped") console.log("Watcher stopped cleanly.");
}

async function watch(ruleFile: string, args: string[]) {
  const intervalMs = positiveOption(
    "poll interval",
    option(args, "--interval-ms") ?? process.env.SETTLEMENT_EDGE_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const retryBaseMs = positiveOption("retry base", process.env.SETTLEMENT_EDGE_RETRY_BASE_MS, 1_000);
  const retryMaxMs = positiveOption("retry maximum", process.env.SETTLEMENT_EDGE_RETRY_MAX_MS, 30_000);
  const execute = liveTradingEnabled();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(execute ? "LIVE EXECUTION ENABLED" : "DRY-RUN: no orders can be submitted");
  console.log(`Watching ${ruleFile} every ${intervalMs}ms. Press Ctrl+C to stop.`);
  try {
    await runWatcher({
      gateway: new DelphiGateway(),
      ruleFile,
      policy: loadRiskPolicy(),
      execute,
      intervalMs,
      retryBaseMs,
      retryMaxMs,
      stateFile: process.env.SETTLEMENT_EDGE_WATCHER_STATE_PATH,
      receiptPath: process.env.SETTLEMENT_EDGE_RECEIPT_PATH ?? DEFAULT_LEDGER_PATH,
      telemetryEnvironment: execute ? "live" : "dry_run",
      signal: controller.signal,
      onDecision: printDecision,
      onStatus: printWatcherStatus,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function main() {
  const [command = "help", ...commandArgs] = process.argv.slice(2);
  const argument = commandArgs[0]?.startsWith("--") ? undefined : commandArgs[0];
  const args = argument ? commandArgs.slice(1) : commandArgs;
  if (command === "replay") {
    await replay(argument ?? "fixtures/wikipedia-threshold.json");
  } else if (command === "scan") {
    if (liveTradingEnabled()) console.log("Live switches are enabled, but scan is read-only by design.");
    await scan();
  } else if (command === "run") {
    await run(argument ?? "config/resolution-rules.json");
  } else if (command === "watch") {
    await watch(argument ?? "config/resolution-rules.json", args);
  } else if (command === "reconcile") {
    if (!argument) throw new Error("reconcile requires a market address");
    await reconcile(argument, args);
  } else if (command === "settle") {
    await settle(commandArgs);
  } else if (command === "metrics") {
    await syncMetrics(commandArgs);
  } else {
    console.log("Settlement Edge\n\n  npm run demo                                      Deterministic proof with no credentials\n  npm run scan                                      Read live competition markets without trading\n  npm run agent -- <rules>                          Evaluate declared sources once; dry-run by default\n  npm run watch -- <rules> --interval-ms N          Poll declared sources continuously; defaults to 60000ms\n  npm run reconcile -- <market> [--ledger <path>]   Append read-only settlement and wallet reconciliation\n  npm run settle -- [--ledger <path>]               Quote or execute eligible redemption/liquidation\n  npm run metrics -- [--ledger <path>]              Sync verified live telemetry to project metrics");
  }
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Settlement Edge stopped: ${detail}`);
  process.exitCode = 1;
}
