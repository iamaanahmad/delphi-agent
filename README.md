# Settlement Edge

Settlement Edge is an autonomous trading agent for the [Gensyn Delphi Agent Arena](https://dorahacks.io/hackathon/delphi-agent-competition/detail). It turns verifiable facts from reviewed primary data sources into quote-aware dry-run decisions and, after every live gate passes, competition-testnet trades. Each evaluation is preserved as a tamper-evident receipt.

> Fresh fact → conservative probability → LMSR quote → risk gate → decision receipt

## Observed status

The credential-free decision journey is proven locally. **No live order, settlement, redemption, or realized competition P&L has been observed for Settlement Edge yet.** The replay below is simulation, not leaderboard performance.

## Tagline

Trade the fact before the market prices it.

## Problem

The competition ranks agents by final P&L. Most agents can form an opinion; the hard part is finding an opinion the market has not priced yet and converting it into profit without saturating a shallow LMSR curve.

Settlement Edge currently has reviewed mappings for Wikimedia pageviews, NOAA water levels, and an MLS match feed. It waits for high-confidence evidence, subtracts disagreement and staleness, requests an execution quote when Delphi API access is configured, and permits a buy only when the edge survives price impact and portfolio limits.

## Solution

Settlement Edge maps each reviewed market to its exact primary source and settlement threshold. The agent converts validated observations into conservative probabilities, tests several tiny sizes against quotes, and either records a dry-run plan or, when every live gate passes, submits the best risk-adjusted trade.

## Innovation

The agent is built around settlement evidence, not free-form prediction. Its strategy targets the short window between an official source publishing the resolving fact and the LMSR market absorbing it. Whether that window creates a live edge is not yet proven. A reviewed resolution rule prevents the agent from silently changing the source, threshold, or outcome.

## Sponsor technology

The official `@gensyn-ai/gensyn-delphi-sdk` is the execution backbone. The wired gateway discovers competition markets, reads implied probabilities, obtains LMSR buy quotes, manages gateway approval, and can submit TST trades on `competition-testnet`. Market access and order submission remain credential-gated and have not been observed live for Settlement Edge.

## Architecture

```text
Official source APIs
        │
        ▼
Resolution-rule evaluator ── rejects stale or malformed facts
        │
        ▼
Conservative estimator ───── shrinks confidence when sources disagree
        │
        ▼
Delphi competition market ── reads live price and implied probability
        │
        ▼
Quote-aware optimizer ────── searches small sizes on the LMSR curve
        │
        ▼
Risk policy ──────────────── edge, spend, impact, bankroll, slippage
        │
        ├── SKIP + reason
        └── BUY + hash-linked decision receipt
```

The live gateway uses `@gensyn-ai/gensyn-delphi-sdk@^2.1.0` on `competition-testnet`. Winning shares pay exactly 1 TST, so the core expected-value calculation is transparent:

```text
expected profit = (our conservative probability - quoted average price) × shares
```

See [architecture.md](docs/architecture.md) for boundaries and failure handling.

## Architecture diagram

The diagram above shows the complete trust path. Only a fresh scalar from a declared primary source can enter estimation, and only an SDK quote inside every risk cap can reach execution.

## Safety

Dry-run is the default. A live order requires both `ALLOW_LIVE_TRADING=true` and `SETTLEMENT_EDGE_EXECUTE=true`; the read-only `scan` command never trades regardless of those switches.

The agent also enforces:

- source freshness and scalar schema checks;
- confidence shrinkage when independent signals disagree;
- a minimum probability edge after uncertainty;
- live quotes before every proposed order;
- maximum TST spend, bankroll percentage, price impact, and slippage;
- tiny candidate sizes for shallow competition markets;
- no secret logging and no committed credentials;
- hash-linked JSONL ledger records for decisions, source failures, ambiguous orders, and read-only settlement reconciliation;
- restart-safe opportunity state that blocks unchanged and ambiguous order replays across process restarts.

This is competition testnet software using play-money TST, not financial advice or a mainnet trading system.

## Key features

- Primary-source JSON extraction with exact settlement comparators, separate event and freshness timestamps, and bounded maximum-over-window rules.
- Conservative probability estimates that penalize stale or conflicting evidence.
- Quote-aware size search designed for shallow competition LMSR curves.
- Two-switch execution authorization and dry-run defaults.
- A hash-linked lifecycle ledger that can record trades, refusals, failures, wallet changes, settlement, redemption, and realized P&L. The full lifecycle is proven with fixtures, not a live order.
- Persistent duplicate and ambiguous-order protection across watcher restarts.
- Read-only reconciliation that reports unsupported or unavailable SDK fields explicitly.
- Deterministic replay with no API, wallet, gas, or network dependency.

## Setup instructions

Requirements: Node.js 20+.

Before adding wallet credentials or enabling live execution, read the [Terms of use](TERMS.md) and [Privacy notice](PRIVACY.md). Settlement Edge has no hosted accounts, cookies, or analytics. Live commands can store the operator's public wallet address and transaction history in the local ledger and send wallet queries or transactions to the configured Delphi, RPC, and signing providers.

```bash
npm install
npm run check
npm run demo
```

The deterministic demo needs no credentials and prints the complete decision trace. **Its 2.5200 TST cost and 1.4292 TST expected P&L are simulated. No order is submitted, and neither number is realized competition profit.**

```text
SETTLEMENT EDGE DECISION RECEIPT
────────────────────────────────
Mode:        SIMULATED REPLAY (no live order or realized P&L)
Market:      Will the featured Wikipedia article exceed 100,000 views by settlement?
Evidence:    Wikimedia Pageviews API: fixture value: 102,431 views; simulated threshold crossed
Our view:    98.7% (98.0% confidence)
Market view: 61.0%
Edge:        +37.7%
Quote:       4 shares for 2.5200 TST
Impact:      2.0%
Expected P&L:1.4292 TST (not realized)
Action:      BUY (risk gates passed; dry-run only)
```

To inspect live competition markets without trading:

```bash
cp .env.example .env
# Add a testnet DELPHI_API_ACCESS_KEY.
npm run scan
```

Before enabling the watcher, run the live-trading preflight:

```bash
npm run preflight
```

It checks configuration, signer identity, wallet-registration visibility, ETH and TST balances, reviewed rules, both execution switches, live quotes, and receipt storage. Every check is read-only and reported separately. The command exits non-zero when a required automated gate fails, never prints credential values, and never submits an approval or order. DoraHacks does not expose a reliable registration endpoint, so that check is reported as unavailable and must be confirmed on the competition page.

To evaluate a real market, copy `config/resolution-rules.example.json`, replace the market address and settlement rule with the exact competition wording, then run:

```bash
npm run agent -- config/resolution-rules.json
```

That command fetches the declared primary source, evaluates freshness, joins the open market, requests quotes, and prints a dry-run decision. It submits only when both live switches in `.env` are set to `true`.

The repository includes two active reviewed competition mappings for NOAA and MLS in `config/resolution-rules.json`. The settled Wikimedia mapping remains in [live-market-rules.md](docs/live-market-rules.md) as historical documentation. Reviewed means the source mapping was checked; it does not mean a trade will have positive expected value.

For continuous monitoring, run the watcher. It reloads the rule file, open markets, and evidence every 60 seconds by default:

```bash
npm run watch -- config/resolution-rules.json
# Faster local verification:
npm run watch -- config/resolution-rules.json --interval-ms 5000
```

`SETTLEMENT_EDGE_POLL_INTERVAL_MS` can also set the polling interval. Transient failures use exponential retry backoff, `SIGINT` and `SIGTERM` stop cleanly, and unchanged evidence plus market state cannot produce the same order twice. Dry-run remains the default; live orders still require both `ALLOW_LIVE_TRADING=true` and `SETTLEMENT_EDGE_EXECUTE=true`.

Watcher state is stored atomically in `artifacts/watcher-state.json`. Successful opportunities retain their transaction hash, while an order whose response was lost is persisted as ambiguous and blocked after restart.

After a trade settles, append a read-only wallet and market reconciliation:

```bash
npm run reconcile -- 0xMARKET_ADDRESS
```

The command reads the signer balance, on-chain market status, indexed winner, and wallet positions through the official SDK. It computes realized P&L only when the ledger contains observed before-and-after trade balances and the SDK reports a completed redemption. Missing history and unsupported fields are recorded as unavailable rather than replaced with estimates. The command never redeems, liquidates, approves, or trades.

See [demo-script.md](docs/demo-script.md) for the 90-second judge walkthrough.

## Demo instructions

Run `npm run demo`. The fixture supplies a 61% market and a simulated Wikimedia value above a 100,000-view threshold. The agent shows a conservative 98.7% view, searches the simulated shallow curve, and returns a four-share dry-run plan. The 2.5200 TST cost and 1.4292 TST expected P&L are simulated, not realized competition results.

## Screenshots

![Settlement Edge deterministic decision receipt](docs/settlement-edge-demo.svg)

## Competition readiness

- [x] Official Delphi competition SDK integration
- [x] Correct LMSR probability and 1 TST payout model
- [x] Read-only market discovery
- [x] Quote-aware sizing for shallow liquidity
- [x] Explicit two-switch live-order gate
- [x] Deterministic credential-free replay
- [x] Continuous 60-second watcher with retry, shutdown, and duplicate-order protection
- [x] Two open reviewed live-market mappings with offline source fixtures and one retired historical mapping
- [x] Stale-data, disagreement, low-edge, and quote-failure stops
- [x] Hash-linked decision receipts
- [x] Restart-safe duplicate and ambiguous-order state
- [x] Read-only settlement, redemption, wallet, and realized-P&L reconciliation in code and fixtures
- [x] Type checking, unit tests, and GitHub Actions
- [ ] Register the trading wallet on DoraHacks
- [ ] Add the testnet Delphi API key and signer only to local `.env`
- [ ] Confirm any numeric minimum activity requirement the organizer publishes
- [ ] Run one tiny order only after the live preflight passes

The build intentionally optimizes one contest-winning loop instead of presenting a broad trading dashboard. The next live milestone is a registered wallet completing one tiny, verified order and appearing on the [competition leaderboard](https://competition.delphi.fyi/).

## Technical challenges

Regular Delphi uses dynamic parimutuel pricing, while this competition uses LMSR with a fixed 1 TST winning payout. The agent keeps that math isolated, quotes before every proposed trade, and avoids carrying regular Delphi spot-price assumptions into competition sizing.

Shallow liquidity can make even modest orders move the curve or revert. Rather than calculate an ideal size from spot price alone, the optimizer asks the SDK for several small executable quotes and chooses the highest expected profit inside its impact and spend caps.

## Future roadmap

1. Register the exact signer wallet and verify leaderboard inclusion with a tiny trade.
2. Expand reviewed rule coverage as new objective JSON-backed markets open.
3. Add explicitly authorized redemption and failed-market liquidation after the first read-only reconciliation is observed.
4. Confirm and encode the organizer's unpublished trade and market activity thresholds.

## Impact

The same evidence-to-action design can make autonomous agents more accountable beyond this contest. Every decision shows what fact was observed, how uncertain it was, what execution would cost, which policy allowed it, and how the record links to the prior decision.

## Team information

Built by [iamaanahmad](https://github.com/iamaanahmad) for the Delphi Agent Arena Competition.

Project contact: [dorahacks@mail.tin.computer](mailto:dorahacks@mail.tin.computer)

[Terms of use](TERMS.md) | [Privacy notice](PRIVACY.md)

## Repository map

```text
src/evidence.ts   Primary-source extraction, freshness, threshold rules
src/strategy.ts   Conservative probability and quote-aware sizing
src/engine.ts     Decision pipeline and safety stops
src/gateway.ts    Official Delphi SDK and deterministic replay gateways
src/receipt.ts    Backward-compatible hash-linked lifecycle ledger
src/reconciliation.ts Read-only settlement and realized-P&L reconciliation
fixtures/         Credential-free judge replay
tests/            Risk, evidence, strategy, and engine checks
docs/             Architecture, demo, and submission plan
```

## Sources

- [Gensyn Delphi competition reference](https://github.com/gensyn-ai/gensyn-delphi-skills/blob/main/reference/competition.md)
- [Gensyn Delphi SDK skills](https://github.com/gensyn-ai/gensyn-delphi-skills)
- [DoraHacks competition page](https://dorahacks.io/hackathon/delphi-agent-competition/detail)
- [Gensyn testnet documentation](https://docs.gensyn.ai/testnet)
