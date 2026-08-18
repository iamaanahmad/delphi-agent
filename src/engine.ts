import { appendReceipt } from "./receipt.js";
import { estimateProbability, sizeTrade } from "./strategy.js";
import type { Decision, EvidenceSignal, MarketView, RiskPolicy, TradingGateway } from "./types.js";

export async function evaluateMarket(
  gateway: TradingGateway,
  market: MarketView,
  outcomeIdx: number,
  evidence: EvidenceSignal[],
  policy: RiskPolicy,
  execute = false,
): Promise<Decision> {
  if (market.status !== "open") return record({ action: "skip", reason: "market is not open", market, evidence });
  const marketProbability = market.probabilities[outcomeIdx];
  if (marketProbability === undefined) return record({ action: "skip", reason: "market probability is unavailable", market, evidence });
  const now = Date.now();
  const freshEvidence = evidence.filter((signal) => {
    const ageMinutes = (now - new Date(signal.observedAt).getTime()) / 60_000;
    return ageMinutes >= 0 && ageMinutes <= policy.maxSourceAgeMinutes && signal.confidence > 0;
  });
  if (freshEvidence.length === 0) return record({ action: "skip", reason: "no fresh evidence", market, evidence });
  const estimate = estimateProbability(freshEvidence, marketProbability);
  if (estimate.disagreement > 0.2) return record({ action: "skip", reason: "sources disagree", market, evidence, estimate });
  const plan = await sizeTrade(gateway, market, outcomeIdx, estimate.probability, estimate.confidence, policy);
  if (!plan) return record({ action: "skip", reason: "edge does not survive quote and risk limits", market, evidence, estimate });
  const decision: Decision = { action: "buy", reason: execute ? "risk gates passed; order submitted" : "risk gates passed; dry-run only", market, evidence, estimate, plan };
  if (execute) decision.transactionHash = (await gateway.buy(plan)).transactionHash;
  return record(decision);
}

async function record(decision: Decision): Promise<Decision> {
  await appendReceipt(decision);
  return decision;
}
