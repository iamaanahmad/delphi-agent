# Architecture

## Design goal

Settlement Edge must fail closed. A missing source, stale timestamp, malformed value, conflicting signal, bad quote, excessive price impact, or missing live-trade switch produces a visible skip instead of a speculative order.

## Components

1. `evidence.ts` reads a declared scalar from an HTTPS JSON response, validates its timestamp, and evaluates the exact settlement comparator.
2. `strategy.ts` combines one or more probability signals. It penalizes disagreement and shrinks the result back toward the market's probability.
3. `gateway.ts` isolates the official SDK. The live implementation speaks to `competition-testnet`; the replay implementation models shallow price impact deterministically.
4. `engine.ts` filters stale evidence, rejects disagreement, sizes a trade, and optionally executes it.
5. `receipt.ts` writes each decision with the previous receipt hash, creating an auditable chain.

The live `run` command groups resolution rules by market outcome, fetches all declared sources, and sends the combined evidence through this same pipeline. Rules are reviewed configuration rather than model-generated guesses.

## Competition-specific math

The competition uses an LMSR market maker, unlike regular Delphi's dynamic parimutuel markets. Outcome prices sum to one, the spot price is the implied probability, and a winning share redeems for exactly 1 TST.

The agent therefore treats `probability - price` as edge. It still sizes against a fresh quote because the average purchase price rises along the LMSR curve. A trade is allowed only if expected profit remains positive at the quoted average price.

## Trust boundaries

- Primary-source payloads are untrusted until their HTTP status, extraction path, scalar type, timestamp, and comparator pass.
- Market metadata is untrusted until the question, outcomes, probabilities, and prices are present.
- Quotes are authoritative for cost, but a slippage ceiling limits the submitted transaction.
- Credentials stay in `.env`; the agent never reads or prints secret values itself.
- The replay gateway cannot submit orders by construction.

## Known limits

- Each real market needs a reviewed resolution rule matching its exact settlement wording. Automatically guessing JSON paths or thresholds is deliberately out of scope.
- The starter build buys evidence-backed outcomes but does not yet rebalance or redeem a portfolio.
- The public minimum number of trades and distinct markets for leaderboard eligibility is unpublished and must be confirmed with organizers.
- Source adapters currently expect JSON. CSV and signed-document adapters are natural extensions after a live market requires them.
