# Architecture

## Design goal

Settlement Edge must fail closed. A missing source, stale timestamp, malformed value, conflicting signal, bad quote, excessive price impact, or missing live-trade switch produces a visible skip instead of a speculative order.

## Components

1. `rule-timing.ts` rejects mappings whose decisive source fact cannot arrive strictly before market close. `evidence.ts` then reads a declared scalar from an HTTPS JSON response or the narrowly parsed Google DeepMind model-card table, records the event time separately from publication or retrieval freshness, and evaluates the exact settlement comparator.
2. `strategy.ts` combines one or more probability signals. It penalizes disagreement and shrinks the result back toward the market's probability.
3. `gateway.ts` isolates the official SDK. The live implementation speaks to `competition-testnet`; the replay implementation models shallow price impact deterministically.
4. `engine.ts` filters stale evidence, rejects disagreement, sizes a trade, and optionally executes it.
5. `receipt.ts` appends backward-compatible decision, failure, transaction, and reconciliation records with the previous record hash.
6. `watcher.ts` atomically persists processed and ambiguous opportunities so a restart cannot silently replay the same order.
7. `reconciliation.ts` joins read-only SDK wallet, settlement, and position state to observed trade balances. It reports unavailable fields explicitly and computes realized P&L only after redemption is observed.
8. `settlement.ts` quotes every eligible portfolio exit and routes settled markets to redemption or expired and failed markets to liquidation. Transactions remain behind both live switches.

The live `run` command groups resolution rules by market outcome, fetches all declared sources, and sends the combined evidence through this same pipeline. Rules are reviewed configuration rather than model-generated guesses.

## Competition-specific math

The competition uses an LMSR market maker, unlike regular Delphi's dynamic parimutuel markets. Outcome prices sum to one, the spot price is the implied probability, and a winning share redeems for exactly 1 TST.

The agent therefore treats `probability - price` as edge. It still sizes against a fresh quote because the average purchase price rises along the LMSR curve. A trade is allowed only if expected profit remains positive at the quoted average price.

## Trust boundaries

- Primary-source payloads are untrusted until their HTTP status, extraction path, scalar type, event timestamp, explicit freshness signal, and comparator pass.
- Freshness is declared per rule as either a source publication timestamp or the locally observed HTTPS retrieval time. Missing or malformed publication metadata and future freshness timestamps fail closed.
- Market metadata is untrusted until the question, outcomes, probabilities, and prices are present.
- Quotes are authoritative for cost, but a slippage ceiling limits the submitted transaction.
- Credentials stay in `.env`; the agent never reads or prints secret values itself.
- The replay gateway cannot submit orders by construction.
- The reconciliation command is read-only. The separate settlement command is dry-run by default and requires both live switches before redemption or liquidation.

## Lifecycle ledger

Version 2 records preserve source publication and fetch times, the market probability, conservative estimate, executable quote, price impact, risk decision, transaction result, wallet balances, settlement status, positions, redemption, and realized P&L. Older version 1 decision receipts remain valid chain predecessors and are never rewritten.

Version 2 also carries schema-versioned lifecycle telemetry for runs, evidence, decisions, quotes, orders, settlement, redemption, and realized P&L. The ledger remains authoritative. Optional project metrics verify the complete hash chain before export, use ledger hashes as idempotency keys, and keep live, dry-run, replay, and test environments separate. See [metrics.md](metrics.md).

Source and schema failures are terminal records, so a failed fetch does not disappear before audit. Transaction responses that fail after a buy attempt are recorded as ambiguous and persisted in watcher state. Reconciliation uses observed wallet deltas for trade cost basis rather than treating the pre-trade quote as realized spend.

## Known limits

- Each real market needs a reviewed resolution rule matching its exact settlement wording. Automatically guessing JSON paths or thresholds is deliberately out of scope.
- A reviewed source mapping is not necessarily tradable. Every live rule must declare or derive its earliest decisive evidence time, and that time must be strictly before the SDK market close.
- The agent can redeem or liquidate eligible positions through a guarded portfolio sweep. It does not rebalance or sell open positions.
- The competition page says entrants must meet published minimum activity requirements, but no numeric trade or distinct-market threshold is visible. Confirm any numeric requirement the organizer publishes.
- Source adapters default to JSON. The only HTML adapter accepts exact Gemini Pro rows from Google DeepMind's model-card table; generic HTML, document-novelty, CSV, and signed-document extraction remain out of scope.
