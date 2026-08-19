import type { MarketView, ResolutionRule } from "./types.js";

export interface RuleTimingAssessment {
  feasible: boolean;
  reason: string;
  earliestDecisionAt?: string;
  marketClosesAt?: string;
}

const timestamp = (label: string, value: string | undefined): number => {
  if (!value) throw new Error(`${label} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
};

export function assessRuleTiming(rule: ResolutionRule, market: MarketView): RuleTimingAssessment {
  const earliestDecisionAt = rule.aggregation?.windowStart ?? rule.earliestDecisionAt;
  let earliest: number;
  let close: number;
  try {
    earliest = timestamp("earliest decision time", earliestDecisionAt);
    close = timestamp("market close time", market.resolvesAt);
  } catch (error) {
    return { feasible: false, reason: error instanceof Error ? error.message : String(error), earliestDecisionAt, marketClosesAt: market.resolvesAt };
  }
  if (earliest >= close) {
    return {
      feasible: false,
      reason: `earliest decisive evidence ${earliestDecisionAt} is not before market close ${market.resolvesAt}`,
      earliestDecisionAt,
      marketClosesAt: market.resolvesAt,
    };
  }
  return {
    feasible: true,
    reason: `earliest decisive evidence precedes market close by ${Math.floor((close - earliest) / 60_000)} minute(s)`,
    earliestDecisionAt,
    marketClosesAt: market.resolvesAt,
  };
}
