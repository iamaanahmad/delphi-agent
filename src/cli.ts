import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadRiskPolicy, liveTradingEnabled } from "./config.js";
import { evaluateMarket } from "./engine.js";
import { fetchEvidence } from "./evidence.js";
import { DelphiGateway, ReplayGateway } from "./gateway.js";
import { reconcileMarket } from "./reconciliation.js";
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

function printDecision(decision: Awaited<ReturnType<typeof evaluateMarket>>) {
  console.log("\nSETTLEMENT EDGE DECISION RECEIPT");
  console.log("────────────────────────────────");
  console.log(`Market:      ${decision.market.question}`);
  console.log(`Evidence:    ${decision.evidence.map((item) => `${item.source}: ${item.detail}`).join(" | ")}`);
  if (decision.estimate) console.log(`Our view:    ${pct(decision.estimate.probability)} (${pct(decision.estimate.confidence)} confidence)`);
  if (decision.plan) {
    console.log(`Market view: ${pct(decision.plan.marketProbability)}`);
    console.log(`Edge:        +${pct(decision.plan.edge)}`);
    console.log(`Quote:       ${decision.plan.shares} shares for ${decision.plan.costTst.toFixed(4)} TST`);
    console.log(`Impact:      ${pct(decision.plan.priceImpact)}`);
    console.log(`Expected P&L:${decision.plan.expectedProfitTst.toFixed(4)} TST`);
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
  printDecision(await evaluateMarket(gateway, fixture.market, fixture.outcomeIdx, fixture.evidence, loadRiskPolicy(), false, {
    receiptPath: process.env.SETTLEMENT_EDGE_RECEIPT_PATH,
  }));
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
  const receiptPath = process.env.SETTLEMENT_EDGE_RECEIPT_PATH;
  console.log(execute ? "LIVE EXECUTION ENABLED" : "DRY-RUN: no orders can be submitted");
  for (const groupedRules of groups.values()) {
    const first = groupedRules[0];
    if (!first) continue;
    const market = markets.find((candidate) => candidate.id.toLowerCase() === first.marketId.toLowerCase());
    if (!market) {
      console.error(`Skipping ${first.marketId}: open competition market not found`);
      await recordOpportunityFailure(undefined, groupedRules, createHash("sha256").update(JSON.stringify(groupedRules)).digest("hex"), "open competition market not found", "market", receiptPath);
      continue;
    }
    let evidence: EvidenceSignal[];
    try {
      evidence = await Promise.all(groupedRules.map((rule) => fetchEvidence(rule)));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const id = createHash("sha256").update(JSON.stringify({ marketId: market.id, groupedRules })).digest("hex");
      await recordOpportunityFailure(market, groupedRules, id, failure.message, failedStage(failure), receiptPath);
      console.error(`Skipping ${first.marketId}: ${failure.message}`);
      continue;
    }
    const id = createHash("sha256").update(JSON.stringify({ market, groupedRules, evidence })).digest("hex");
    printDecision(await evaluateMarket(gateway, market, first.outcomeIdx, evidence, loadRiskPolicy(), execute, { opportunityId: id, receiptPath }));
  }
}

async function reconcile(marketId: string, args: string[]) {
  const ledgerPath = option(args, "--ledger") ?? process.env.SETTLEMENT_EDGE_RECEIPT_PATH;
  const result = await reconcileMarket(new DelphiGateway(), marketId, ledgerPath);
  console.log("SETTLEMENT EDGE RECONCILIATION");
  console.log(JSON.stringify(result, null, 2));
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
      receiptPath: process.env.SETTLEMENT_EDGE_RECEIPT_PATH,
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
  } else {
    console.log("Settlement Edge\n\n  npm run demo                                      Deterministic proof with no credentials\n  npm run scan                                      Read live competition markets without trading\n  npm run agent -- <rules>                          Evaluate declared sources once; dry-run by default\n  npm run watch -- <rules> --interval-ms N          Poll declared sources continuously; defaults to 60000ms\n  npm run reconcile -- <market> [--ledger <path>]  Append read-only settlement and wallet reconciliation");
  }
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Settlement Edge stopped: ${detail}`);
  process.exitCode = 1;
}
