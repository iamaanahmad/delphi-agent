import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import type {
  MarketSettlementSnapshot,
  MarketView,
  PositionSnapshot,
  Quote,
  TradePlan,
  TradingGateway,
  WalletBalanceSnapshot,
} from "./types.js";

const sharesToBigint = (shares: number) => BigInt(Math.round(shares * 1e18));

export class DelphiGateway implements TradingGateway {
  private readonly client = new DelphiClient({ network: "competition-testnet" });

  async listOpenMarkets(): Promise<MarketView[]> {
    const competitionId = process.env.DELPHI_COMPETITION_ID || undefined;
    const scope = competitionId ? { competitionId } : {};
    const { markets } = await this.client.listMarkets({
      status: "open",
      limit: 100,
      pricesAndImpliedProbabilities: true,
      ...scope,
    });
    return (markets ?? []).flatMap((market) => {
      const question = market.metadata?.question;
      const outcomes = market.metadata?.outcomes;
      const probabilities = market.spotImpliedProbabilities;
      const prices = market.spotPrices;
      if (!question || !outcomes || !probabilities || !prices) return [];
      return [{
        id: market.id,
        question,
        outcomes,
        probabilities,
        prices,
        status: market.status,
        resolvesAt: market.resolvesAt ?? undefined,
        marketUrl: market.marketUrl,
      }];
    });
  }

  async quoteBuy(marketId: string, outcomeIdx: number, shares: number): Promise<Quote> {
    const { tokensIn } = await this.client.quoteBuy({
      marketAddress: marketId as `0x${string}`,
      outcomeIdx,
      sharesOut: sharesToBigint(shares),
    });
    return { shares, costTst: Number(tokensIn) / 1e6 };
  }

  async buy(plan: TradePlan): Promise<{ transactionHash: string }> {
    await this.client.ensureTokenApproval({ marketAddress: plan.marketId as `0x${string}`, minimumAmount: plan.maxTokensIn });
    return this.client.buyShares({
      marketAddress: plan.marketId as `0x${string}`,
      outcomeIdx: plan.outcomeIdx,
      sharesOut: sharesToBigint(plan.shares),
      maxTokensIn: plan.maxTokensIn,
    });
  }

  async getWalletSnapshot(): Promise<WalletBalanceSnapshot> {
    const signer = await this.client.getSigner();
    const [ethWei, collateral] = await Promise.all([
      this.client.getEthBalance(),
      this.client.getErc20BalanceWithDecimals(),
    ]);
    return {
      address: signer.address,
      ethWei: ethWei.toString(),
      collateralAtomic: collateral.balance.toString(),
      collateralDecimals: collateral.decimals,
    };
  }

  async getMarketSettlement(marketId: string): Promise<MarketSettlementSnapshot> {
    const [status, market] = await Promise.all([
      this.client.getMarketStatus(marketId as `0x${string}`),
      this.client.getMarket({ id: marketId }),
    ]);
    const parsedWinner = market.winningOutcomeIdx === null ? null : Number(market.winningOutcomeIdx);
    return {
      status,
      winningOutcomeIdx: parsedWinner !== null && Number.isInteger(parsedWinner) ? parsedWinner : null,
    };
  }

  async listWalletPositions(marketId: string, walletAddress: string): Promise<PositionSnapshot[]> {
    const { positions } = await this.client.listPositions({ wallet: walletAddress, limit: 100 });
    return (positions ?? [])
      .filter((position) => position.marketProxy.toLowerCase() === marketId.toLowerCase())
      .map((position) => ({
        outcomeIdx: Number(position.outcomeIdx),
        sharesAtomic: position.shares,
        redeemedOrLiquidated: position.redeemedOrLiquidated,
        tokensRedeemedAtomic: position.tokensRedeemed,
      }));
  }
}

export class ReplayGateway implements TradingGateway {
  constructor(private readonly markets: MarketView[], private readonly impactPerShare = 0.01) {}
  async listOpenMarkets() { return this.markets; }
  async quoteBuy(marketId: string, outcomeIdx: number, shares: number) {
    const market = this.markets.find((candidate) => candidate.id === marketId);
    const spot = market?.prices[outcomeIdx];
    if (spot === undefined) throw new Error("Market not found");
    if (shares > 4) throw new Error("LMSR curve saturated");
    return { shares, costTst: shares * (spot + this.impactPerShare * shares / 2) };
  }
  async buy(): Promise<{ transactionHash: string }> { throw new Error("Replay gateway cannot execute trades"); }
}
