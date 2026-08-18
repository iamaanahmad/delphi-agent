import "dotenv/config";
import { readFile } from "node:fs/promises";
import { loadRiskPolicy, liveTradingEnabled } from "./config.js";
import { evaluateMarket } from "./engine.js";
import { fetchEvidence } from "./evidence.js";
import { DelphiGateway, ReplayGateway } from "./gateway.js";
import type { EvidenceSignal, MarketView, ResolutionRule } from "./types.js";

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
    observedAt: item.observedAt === "NOW" ? new Date().toISOString() : item.observedAt,
  }));
  const gateway = new ReplayGateway([fixture.market]);
  printDecision(await evaluateMarket(gateway, fixture.market, fixture.outcomeIdx, fixture.evidence, loadRiskPolicy(), false));
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
  const rules = JSON.parse(await readFile(ruleFile, "utf8")) as ResolutionRule[];
  if (!Array.isArray(rules) || rules.length === 0) throw new Error("Rule file must contain at least one resolution rule");
  const gateway = new DelphiGateway();
  const markets = await gateway.listOpenMarkets();
  const groups = new Map<string, ResolutionRule[]>();
  for (const rule of rules) {
    const key = `${rule.marketId}:${rule.outcomeIdx}`;
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  const execute = liveTradingEnabled();
  console.log(execute ? "LIVE EXECUTION ENABLED" : "DRY-RUN: no orders can be submitted");
  for (const groupedRules of groups.values()) {
    const first = groupedRules[0];
    if (!first) continue;
    const market = markets.find((candidate) => candidate.id.toLowerCase() === first.marketId.toLowerCase());
    if (!market) {
      console.error(`Skipping ${first.marketId}: open competition market not found`);
      continue;
    }
    const evidence = await Promise.all(groupedRules.map((rule) => fetchEvidence(rule)));
    printDecision(await evaluateMarket(gateway, market, first.outcomeIdx, evidence, loadRiskPolicy(), execute));
  }
}

const [, , command = "help", argument] = process.argv;
if (command === "replay") {
  await replay(argument ?? "fixtures/wikipedia-threshold.json");
} else if (command === "scan") {
  if (liveTradingEnabled()) console.log("Live switches are enabled, but scan is read-only by design.");
  await scan();
} else if (command === "run") {
  await run(argument ?? "config/resolution-rules.json");
} else {
  console.log("Settlement Edge\n\n  npm run demo                 Deterministic proof with no credentials\n  npm run scan                 Read live competition markets without trading\n  npm run agent -- <rules>     Evaluate declared sources; dry-run by default");
}
