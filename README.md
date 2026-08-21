# Settlement Edge

Settlement Edge is an autonomous trading agent for the [Gensyn Delphi Agent Arena](https://dorahacks.io/hackathon/delphi-agent-competition/detail). It turns verifiable facts from reviewed primary data sources into quote-aware dry-run decisions and, after every live gate passes, competition-testnet trades. Each evaluation is preserved as a tamper-evident receipt.

**[Visit the Settlement Edge website](https://iamaanahmad.github.io/delphi-agent/)**

> Fresh fact → conservative probability → LMSR quote → risk gate → decision receipt

## Observed status

**Observed on August 21, 2026:** 0 live orders, 0 TST realized competition P&L, 1,000 TST available in the registered wallet, and 70 passing tests. No settlement or redemption has been observed. The 1.4292 TST expected P&L shown in the deterministic replay is simulated supporting evidence, not competition performance.

## Tagline

Trade the fact before the market prices it.

## Problem

The competition ranks agents by final P&L. Most agents can form an opinion; the hard part is finding an opinion the market has not priced yet and converting it into profit without saturating a shallow LMSR curve.

Settlement Edge currently monitors a reviewed Gemini model-release mapping and retains retired Wikimedia, NOAA, and MLS mappings as regression fixtures. It waits for high-confidence evidence, subtracts disagreement and staleness, requests an execution quote when Delphi API access is configured, and permits a buy only when the edge survives price impact and portfolio limits.

## Solution

Settlement Edge maps each reviewed market to its exact primary source and settlement threshold. The agent converts validated observations into conservative probabilities, tests several tiny sizes against quotes, and either records a dry-run plan or, when every live gate passes, submits the best risk-adjusted trade.

## Innovation

The agent is built around settlement evidence, not free-form prediction. Its strategy targets the short window between an official source publishing the resolving fact and the LMSR market absorbing it. Whether that window creates a live edge is not yet proven. A reviewed resolution rule prevents the agent from silently changing the source, threshold, or outcome.

## Sponsor technology

The official `@gensyn-ai/gensyn-delphi-sdk` is the execution backbone. The wired gateway discovers competition markets, reads implied probabilities, obtains LMSR buy quotes, manages gateway approval, and can submit TST trades on `competition-testnet`. Competition access and read-only quotes have been observed from the configured registered wallet; no live order has been submitted.

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

- Primary-source JSON extraction plus a narrow Google DeepMind model-card adapter, with exact settlement comparators, separate event and freshness timestamps, and bounded maximum-over-window rules.
- Conservative probability estimates that penalize stale or conflicting evidence.
- Quote-aware size search designed for shallow competition LMSR curves.
- Two-switch execution authorization and dry-run defaults.
- A hash-linked lifecycle ledger that can record trades, refusals, failures, wallet changes, settlement, redemption, and realized P&L. The full lifecycle is proven with fixtures, not a live order.
- Optional server-side lifecycle metrics derived from the verified ledger, with separate live, dry-run, replay, and test namespaces. Expected replay P&L is never counted as realized profit.
- Persistent duplicate and ambiguous-order protection across watcher restarts.
- Read-only reconciliation that reports unsupported or unavailable SDK fields explicitly.
- Dry-run-first portfolio settlement that routes settled markets to redemption and expired or failed markets to liquidation.
- Deterministic replay with no API, wallet, gas, or network dependency.

## Setup instructions

Requirements: Node.js 20+.

Before adding wallet credentials or enabling live execution, read the [Terms of use](TERMS.md) and [Privacy notice](PRIVACY.md). Settlement Edge has no hosted accounts, cookies, or advertising tracking. Live commands can store the operator's public wallet address and transaction history in the local ledger and send wallet queries or transactions to the configured Delphi, RPC, and signing providers. Optional server-side lifecycle metrics are disabled by default and exclude wallet addresses, transaction hashes, source URLs and identifiers, credentials, and free-form failure text.

```bash
npm install
npm run check
npm run demo
```

The deterministic demo needs no credentials and prints the complete decision trace. **Its 2.5200 TST cost and 1.4292 TST expected P&L are simulated. No order is submitted, and neither number is realized competition profit.** Replay receipts use `artifacts/replay-receipts.jsonl` by default, keeping fixtures outside the live decision ledger.

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

To preserve a read-only baseline and record only newly opened markets through the competition cutoff:

```bash
npm run sentinel -- --cutoff 2026-08-23T23:59:00Z --interval-ms 60000
```

The sentinel records the initial open market IDs, then writes one hash-linked review receipt for each new market or material change to its wording, outcomes, or close time. Each receipt includes read-only 0.1-share quote probes. An unreviewed candidate is rejected without changing rules or submitting an order; unchanged rejections are suppressed. The sentinel refuses to start if either live switch is enabled.

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

The active rule file contains one timing-eligible mapping for an official Gemini Pro model release. It accepts only exact Google DeepMind model-card rows for Gemini Pro version 3.5 or later, and it cannot infer a `No` outcome or trade from an absent or ambiguous row. The retired NOAA, MLS, and settled Wikimedia mappings remain in fixtures and [live-market-rules.md](docs/live-market-rules.md) for regression coverage and the audit trail. Reviewed means the source mapping was checked; it does not mean the market is profitable or that qualifying evidence currently exists.

For continuous monitoring, run the watcher. It reloads the rule file, open markets, and evidence every 60 seconds by default:

```bash
npm run watch -- config/resolution-rules.json
# Faster local verification:
npm run watch -- config/resolution-rules.json --interval-ms 5000
```

`SETTLEMENT_EDGE_POLL_INTERVAL_MS` can also set the polling interval. Transient failures use exponential retry backoff, `SIGINT` and `SIGTERM` stop cleanly, and unchanged evidence plus market state cannot produce the same order twice. Dry-run remains the default; live orders still require both `ALLOW_LIVE_TRADING=true` and `SETTLEMENT_EDGE_EXECUTE=true`.

For any unattended or live watch, use the cutoff-aware supervisor instead of launching `watch` directly:

```bash
npm run supervise -- config/resolution-rules.json --cutoff 2026-08-23T23:59:00Z
```

The supervisor writes and monitors a heartbeat, restarts a failed or unresponsive watcher, and stops at the configured cutoff or the first submitted or ambiguous configured-market order. It also holds a single-writer lease for the active ledger. A second supervisor, reconciliation command, or other process cannot append to that ledger while the lease is active. An abandoned lease is recovered only after its heartbeat is stale and its owner PID is no longer alive. Start the supervisor itself with the host's durable service manager; the repository can recover its watcher child, but no process can restart itself after the host kills the supervisor.

In a workspace without a running systemd or cron manager, build once and launch the repository-owned outer service as a detached session. Keep both execution switches explicitly disabled for verification, and do not start it until the rule file contains only reviewed markets that pass preflight:

```bash
npm run build
ALLOW_LIVE_TRADING=false SETTLEMENT_EDGE_EXECUTE=false \
  setsid nohup node dist/src/service-cli.js config/resolution-rules.json \
  --cutoff 2026-08-23T23:59:00Z \
  > artifacts/supervisor-service.log 2>&1 < /dev/null &
```

The outer service restarts only an abnormally exited supervisor. Before recovery it stops the previous supervisor's orphaned watcher process group, then reuses the same stale-dead-only writer-lease path. A clean supervisor exit after a configured-market order, an operator signal, or the cutoff is not restarted. The outer service has its own cutoff timer and never starts a replacement at or after August 23, 2026 at 23:59 UTC. Restart the service whenever the configured market IDs change so the supervisor's order guard matches the reviewed rule set.

Watcher state is stored atomically in `artifacts/watcher-state.json`. Successful opportunities retain their transaction hash, while an order whose response was lost is persisted as ambiguous and blocked after restart.

After a trade settles, append a read-only wallet and market reconciliation:

```bash
npm run reconcile -- 0xMARKET_ADDRESS
```

The command reads the signer balance, on-chain market status, indexed winner, and wallet positions through the official SDK. It computes realized P&L only when the ledger contains observed before-and-after trade balances and the SDK reports a completed redemption. Missing history and unsupported fields are recorded as unavailable rather than replaced with estimates. The command never redeems, liquidates, approves, or trades.

To sweep eligible positions, quote every exit first, and append the result to the same ledger:

```bash
npm run settle
```

The sweep is dry-run by default. It redeems settled markets and liquidates expired or failed markets only when both `ALLOW_LIVE_TRADING=true` and `SETTLEMENT_EDGE_EXECUTE=true`. Open markets are skipped, quote failures fail closed, and an ambiguous transaction blocks an automatic retry until the ledger is inspected. Submitted exits are immediately reconciled so realized P&L is recorded only from observed wallet state.

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
- [x] Heartbeat-monitored supervisor with child recovery, cutoff stop, and active-ledger single-writer lease
- [x] Detached outer service with supervisor recovery, orphan-watcher cleanup, and an independent cutoff
- [x] One timing-eligible live mapping plus retired post-close mappings with offline boundary fixtures
- [x] Stale-data, disagreement, low-edge, and quote-failure stops
- [x] Hash-linked decision receipts
- [x] Restart-safe duplicate and ambiguous-order state
- [x] Read-only settlement, redemption, wallet, and realized-P&L reconciliation in code and fixtures
- [x] Dry-run-first redemption and failed-market liquidation with hash-linked receipts
- [x] Type checking, unit tests, and GitHub Actions
- [x] Registered signer, testnet Delphi API access, and 1,000 TST confirmed by read-only preflight
- [ ] Confirm any numeric minimum activity requirement the organizer publishes
- [ ] Run one tiny order only after the live preflight passes

The build intentionally optimizes one contest-winning loop instead of presenting a broad trading dashboard. The next live milestone is one tiny, verified order from the registered wallet, but only after qualifying official evidence and every live risk gate pass.

## Competition cutoffs

The exact DoraHacks event timestamp closes wallet registration and competition trading on **August 23, 2026 at 23:59 UTC**. The generic event card calls this a submission deadline, but the competition requires only the registered trading wallet. No repository, video, or BUIDL submission is required.

Final judging has no published UTC cutoff. It happens after all competition markets settle and Gensyn reviews final P&L and eligibility. See [competition-cutoffs.md](docs/competition-cutoffs.md) for the source reconciliation and the remaining unknowns.

## Technical challenges

Regular Delphi uses dynamic parimutuel pricing, while this competition uses LMSR with a fixed 1 TST winning payout. The agent keeps that math isolated, quotes before every proposed trade, and avoids carrying regular Delphi spot-price assumptions into competition sizing.

Shallow liquidity can make even modest orders move the curve or revert. Rather than calculate an ideal size from spot price alone, the optimizer asks the SDK for several small executable quotes and chooses the highest expected profit inside its impact and spend caps.

## Future roadmap

1. Watch the official Gemini model-card table through the eligible market cutoff.
2. Reconcile the guarded watch outcome, including a no-trade result if no qualifying row appears.
3. Exercise guarded redemption after the first eligible live position settles.
4. Confirm and encode any numeric trade or market activity thresholds the organizer publishes.

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
src/metrics.ts    Verified ledger-to-project-metrics ingestion
src/reconciliation.ts Read-only settlement and realized-P&L reconciliation
src/settlement.ts Guarded redemption and failed-market liquidation
fixtures/         Credential-free judge replay
tests/            Risk, evidence, strategy, and engine checks
docs/             Architecture, demo, and submission plan
```

## Sources

- [Gensyn Delphi competition reference](https://github.com/gensyn-ai/gensyn-delphi-skills/blob/main/reference/competition.md)
- [Gensyn Delphi SDK skills](https://github.com/gensyn-ai/gensyn-delphi-skills)
- [DoraHacks competition page](https://dorahacks.io/hackathon/delphi-agent-competition/detail)
- [Gensyn testnet documentation](https://docs.gensyn.ai/testnet)
