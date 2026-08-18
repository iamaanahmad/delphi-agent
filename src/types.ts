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
  eventAtPath: string;
  eventAtFormat?: TimestampFormat;
  reducer: "max";
  windowStart: string;
  windowEnd: string;
}

export type RuleFreshness =
  | { type: "publication"; path: string; format?: TimestampFormat }
  | { type: "retrieval" };

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
  eventTime: string;
  freshnessTime: string;
  freshnessType: RuleFreshness["type"];
  publicationTime?: string;
  fetchedAt?: string;
  probability: number;
  confidence: number;
  detail: string;
}

export type MarketLifecycleStatus = "open" | "awaiting_settlement" | "settled" | "expired" | "failed";

export interface WalletBalanceSnapshot {
  address: string;
  ethWei: string;
  collateralAtomic: string;
  collateralDecimals: number;
}

export interface MarketSettlementSnapshot {
  status: MarketLifecycleStatus;
  winningOutcomeIdx: number | null;
}

export interface PositionSnapshot {
  outcomeIdx: number;
  sharesAtomic: string;
  redeemedOrLiquidated: boolean;
  tokensRedeemedAtomic: string;
}

export interface ResolutionRule {
  marketId: string;
  outcomeIdx: number;
  sourceName: string;
  sourceUrl: string;
  jsonPath?: string;
  comparator: Comparator;
  threshold: RuleThreshold;
  eventAtPath?: string;
  eventAtFormat?: TimestampFormat;
  freshness: RuleFreshness;
  aggregation?: RuleAggregation;
  conditions?: RuleCondition[];
  maxFreshnessAgeMinutes?: number;
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
  getWalletSnapshot?(): Promise<WalletBalanceSnapshot>;
}

export interface ReconciliationGateway {
  getWalletSnapshot?(): Promise<WalletBalanceSnapshot>;
  getMarketSettlement?(marketId: string): Promise<MarketSettlementSnapshot>;
  listWalletPositions?(marketId: string, walletAddress: string): Promise<PositionSnapshot[]>;
}
