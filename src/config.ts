import type { RiskPolicy } from "./types.js";

const numeric = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

export function parseCandidateShares(value = "0.05,0.1,0.25,0.5,1,2,4,8"): number[] {
  const candidates = [...new Set(value.split(",").map((item) => Number(item.trim())))].sort((a, b) => a - b);
  if (candidates.length === 0 || candidates.some((item) => !Number.isFinite(item) || item <= 0)) {
    throw new Error("SETTLEMENT_EDGE_CANDIDATE_SHARES must be a comma-separated list of positive numbers");
  }
  return candidates;
}

export function loadRiskPolicy(): RiskPolicy {
  return {
    bankrollTst: numeric("SETTLEMENT_EDGE_BANKROLL_TST", 100),
    minEdge: numeric("SETTLEMENT_EDGE_MIN_EDGE", 0.08),
    minConfidence: numeric("SETTLEMENT_EDGE_MIN_CONFIDENCE", 0.75),
    maxTradeTst: numeric("SETTLEMENT_EDGE_MAX_TRADE_TST", 10),
    maxBankrollPct: numeric("SETTLEMENT_EDGE_MAX_BANKROLL_PCT", 0.1),
    maxPriceImpact: numeric("SETTLEMENT_EDGE_MAX_PRICE_IMPACT", 0.03),
    maxSourceAgeMinutes: numeric("SETTLEMENT_EDGE_MAX_SOURCE_AGE_MINUTES", 15),
    slippagePct: numeric("SETTLEMENT_EDGE_SLIPPAGE_PCT", 2),
    candidateShares: parseCandidateShares(process.env.SETTLEMENT_EDGE_CANDIDATE_SHARES),
  };
}

export function liveTradingEnabled(): boolean {
  return process.env.ALLOW_LIVE_TRADING === "true" && process.env.SETTLEMENT_EDGE_EXECUTE === "true";
}
