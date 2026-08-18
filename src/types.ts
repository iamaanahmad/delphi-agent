export type Comparator = "gt" | "gte" | "lt" | "lte" | "eq";
export type TimestampFormat = "iso" | "wikimedia-hour" | "noaa-gmt-minute";

export type RuleThreshold = number | string | { jsonPath: string };

export interface RuleCondition {
  jsonPath: string;
  comparator: Comparator;
  threshold: number | string;
}

export interface RuleAggregation {
  recordsPath: string;
  valuePath: string;
  observedAtPath: string;
  observedAtFormat?: TimestampFormat;
  reducer: "max";
  windowStart: string;
  windowEnd: string;
}

export interface MarketView {
  id: string;
  question: string;
  outcomes: string[];
  probabilities: number[];
  prices: number[];
  status: string;
  resolvesAt?: string;
  marketUrl?: string;
}

export interface EvidenceSignal {
  id: string;
  source: string;
  sourceUrl: string;
  observedAt: string;
  probability: number;
  confidence: number;
  detail: string;
}

export interface ResolutionRule {
  marketId: string;
  outcomeIdx: number;
  sourceName: string;
  sourceUrl: string;
  jsonPath?: string;
  comparator: Comparator;
  threshold: RuleThreshold;
  observedAtPath?: string;
  observedAtFormat?: TimestampFormat;
  aggregation?: RuleAggregation;
  conditions?: RuleCondition[];
  maxAgeMinutes?: number;
}

export interface RiskPolicy {
  bankrollTst: number;
  minEdge: number;
  minConfidence: number;
  maxTradeTst: number;
  maxBankrollPct: number;
  maxPriceImpact: number;
  maxSourceAgeMinutes: number;
  slippagePct: number;
  candidateShares: number[];
}

export interface Quote {
  shares: number;
  costTst: number;
}

export interface TradePlan {
  marketId: string;
  outcomeIdx: number;
  outcome: string;
  probability: number;
  confidence: number;
  marketProbability: number;
  edge: number;
  shares: number;
  costTst: number;
  averagePrice: number;
  priceImpact: number;
  expectedProfitTst: number;
  maxTokensIn: bigint;
}

export interface Decision {
  action: "buy" | "skip";
  reason: string;
  market: MarketView;
  evidence: EvidenceSignal[];
  estimate?: { probability: number; confidence: number; disagreement: number };
  plan?: TradePlan;
  transactionHash?: string;
}

export interface TradingGateway {
  listOpenMarkets(): Promise<MarketView[]>;
  quoteBuy(marketId: string, outcomeIdx: number, shares: number): Promise<Quote>;
  buy(plan: TradePlan): Promise<{ transactionHash: string }>;
}
