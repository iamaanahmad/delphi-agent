import { createHash } from "node:crypto";
import {
  appendLedgerRecord,
  available,
  unavailable,
  walletChange,
  type Availability,
  type TransactionLedgerState,
} from "./receipt.js";
import { estimateProbability, sizeTrade } from "./strategy.js";
import type { Decision, EvidenceSignal, MarketView, RiskPolicy, TradingGateway, WalletBalanceSnapshot } from "./types.js";

export interface EvaluationContext {
  receiptPath?: string;
  opportunityId?: string;
}

function opportunityId(market: MarketView, outcomeIdx: number, evidence: EvidenceSignal[]): string {
  const content = JSON.stringify({
    marketId: market.id.toLowerCase(),
    outcomeIdx,
    evidence: evidence.map((item) => ({
      id: item.id,
      eventTime: item.eventTime,
      publicationTime: item.publicationTime,
    })),
  });
  return createHash("sha256").update(content).digest("hex");
}

async function walletSnapshot(gateway: TradingGateway): Promise<Availability<WalletBalanceSnapshot>> {
  if (!gateway.getWalletSnapshot) return unavailable("gateway does not expose wallet balances");
  try {
    return available(await gateway.getWalletSnapshot());
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

async function record(
  decision: Decision,
  outcomeIdx: number,
  policy: RiskPolicy,
  gateway: TradingGateway,
  context: EvaluationContext,
  transaction: TransactionLedgerState = { status: "not_submitted" },
  before: Availability<WalletBalanceSnapshot> = unavailable("no order was submitted"),
  after: Availability<WalletBalanceSnapshot> = unavailable("no order was submitted"),
): Promise<Decision> {
  const marketProbability = decision.market.probabilities[outcomeIdx];
  await appendLedgerRecord({
    type: "decision",
    opportunityId: context.opportunityId ?? opportunityId(decision.market, outcomeIdx, decision.evidence),
    terminal: true,
    market: decision.market,
    outcomeIdx,
    sources: decision.evidence.map((item) => ({
      id: item.id,
      name: item.source,
      url: item.sourceUrl,
      publicationTime: item.publicationTime ? available(item.publicationTime) : unavailable("source publication time was not provided"),
      fetchTime: item.fetchedAt ? available(item.fetchedAt) : unavailable("source fetch time was not captured"),
      probability: item.probability,
      confidence: item.confidence,
      detail: item.detail,
    })),
    marketProbability: marketProbability === undefined ? unavailable("market probability is unavailable") : available(marketProbability),
    estimate: decision.estimate ? available(decision.estimate) : unavailable("estimation did not run"),
    quote: decision.plan ? available({ shares: decision.plan.shares, costTst: decision.plan.costTst, averagePrice: decision.plan.averagePrice }) : unavailable("no executable quote passed risk limits"),
    impact: decision.plan ? available(decision.plan.priceImpact) : unavailable("no executable quote passed risk limits"),
    riskDecision: { action: decision.action, reason: decision.reason, policy },
    transaction,
    wallet: { before, after, changeTst: walletChange(before, after) },
  }, context.receiptPath);
  return decision;
}

export async function evaluateMarket(
  gateway: TradingGateway,
  market: MarketView,
  outcomeIdx: number,
  evidence: EvidenceSignal[],
  policy: RiskPolicy,
  execute = false,
  context: EvaluationContext = {},
): Promise<Decision> {
  if (market.status !== "open") return record({ action: "skip", reason: "market is not open", market, evidence }, outcomeIdx, policy, gateway, context);
  const marketProbability = market.probabilities[outcomeIdx];
  if (marketProbability === undefined) return record({ action: "skip", reason: "market probability is unavailable", market, evidence }, outcomeIdx, policy, gateway, context);
  const now = Date.now();
  const freshEvidence = evidence.filter((signal) => {
    const ageMinutes = (now - new Date(signal.freshnessTime).getTime()) / 60_000;
    return ageMinutes >= 0 && ageMinutes <= policy.maxSourceAgeMinutes && signal.confidence > 0;
  });
  if (freshEvidence.length === 0) return record({ action: "skip", reason: "no fresh evidence", market, evidence }, outcomeIdx, policy, gateway, context);
  const estimate = estimateProbability(freshEvidence, marketProbability);
  if (estimate.disagreement > 0.2) return record({ action: "skip", reason: "sources disagree", market, evidence, estimate }, outcomeIdx, policy, gateway, context);
  const plan = await sizeTrade(gateway, market, outcomeIdx, estimate.probability, estimate.confidence, policy);
  if (!plan) return record({ action: "skip", reason: "edge does not survive quote and risk limits", market, evidence, estimate }, outcomeIdx, policy, gateway, context);
  const decision: Decision = { action: "buy", reason: execute ? "risk gates passed; order submitted" : "risk gates passed; dry-run only", market, evidence, estimate, plan };
  if (!execute) return record(decision, outcomeIdx, policy, gateway, context);

  const before = await walletSnapshot(gateway);
  try {
    decision.transactionHash = (await gateway.buy(plan)).transactionHash;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const after = await walletSnapshot(gateway);
    await record(
      { ...decision, reason: "risk gates passed; order result ambiguous" },
      outcomeIdx,
      policy,
      gateway,
      context,
      { status: "ambiguous", error: failure.message },
      before,
      after,
    );
    throw failure;
  }
  const after = await walletSnapshot(gateway);
  return record(
    decision,
    outcomeIdx,
    policy,
    gateway,
    context,
    { status: "submitted", transactionHash: decision.transactionHash },
    before,
    after,
  );
}
