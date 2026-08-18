import type { EvidenceSignal, MarketView, Quote, RiskPolicy, TradePlan, TradingGateway } from "./types.js";

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function estimateProbability(signals: EvidenceSignal[], marketProbability: number) {
  if (signals.length === 0) return { probability: marketProbability, confidence: 0, disagreement: 1 };
  const totalWeight = signals.reduce((sum, signal) => sum + clamp(signal.confidence), 0);
  if (totalWeight === 0) return { probability: marketProbability, confidence: 0, disagreement: 1 };
  const evidenceProbability = signals.reduce(
    (sum, signal) => sum + clamp(signal.probability) * clamp(signal.confidence),
    0,
  ) / totalWeight;
  const variance = signals.reduce(
    (sum, signal) => sum + clamp(signal.confidence) * (signal.probability - evidenceProbability) ** 2,
    0,
  ) / totalWeight;
  const disagreement = Math.sqrt(variance);
  const sourceConfidence = totalWeight / signals.length;
  const confidence = clamp(sourceConfidence * Math.exp(-4 * disagreement));
  const probability = clamp(marketProbability + (evidenceProbability - marketProbability) * confidence, 0.005, 0.995);
  return { probability, confidence, disagreement };
}

export async function sizeTrade(
  gateway: TradingGateway,
  market: MarketView,
  outcomeIdx: number,
  probability: number,
  confidence: number,
  policy: RiskPolicy,
): Promise<TradePlan | undefined> {
  const marketProbability = market.probabilities[outcomeIdx];
  const spotPrice = market.prices[outcomeIdx];
  const outcome = market.outcomes[outcomeIdx];
  if (marketProbability === undefined || spotPrice === undefined || outcome === undefined) return undefined;
  const edge = probability - marketProbability;
  if (edge < policy.minEdge || confidence < policy.minConfidence) return undefined;
  const spendCap = Math.min(policy.maxTradeTst, policy.bankrollTst * policy.maxBankrollPct);
  let best: TradePlan | undefined;
  for (const shares of policy.candidateShares) {
    let quote: Quote;
    try {
      quote = await gateway.quoteBuy(market.id, outcomeIdx, shares);
    } catch {
      continue;
    }
    if (quote.costTst > spendCap) continue;
    const averagePrice = quote.costTst / shares;
    const priceImpact = averagePrice - spotPrice;
    const expectedProfitTst = (probability - averagePrice) * shares;
    if (priceImpact > policy.maxPriceImpact || expectedProfitTst <= 0) continue;
    const tokensIn = BigInt(Math.ceil(quote.costTst * 1_000_000));
    const slippageBps = BigInt(Math.ceil(policy.slippagePct * 100));
    const maxTokensIn = tokensIn * (10_000n + slippageBps) / 10_000n;
    const candidate: TradePlan = {
      marketId: market.id,
      outcomeIdx,
      outcome,
      probability,
      confidence,
      marketProbability,
      edge,
      shares,
      costTst: quote.costTst,
      averagePrice,
      priceImpact,
      expectedProfitTst,
      maxTokensIn,
    };
    if (!best || candidate.expectedProfitTst > best.expectedProfitTst) best = candidate;
  }
  return best;
}
