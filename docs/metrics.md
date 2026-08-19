# Lifecycle metrics

Settlement Edge keeps the version 2 JSONL ledger as its source of truth. Lifecycle telemetry is appended to the same hash chain with `schemaVersion: 1`; remote metrics never replace or rewrite that history.

## Event schema

Every telemetry record contains `event`, `runId`, `environment`, optional `marketId`, optional `opportunityId`, optional `sourceRecordHash`, and a bounded `data` object. The stable event names are:

- `run_started`
- `evidence_accepted` and `evidence_rejected`
- `decision_made` and `quote_obtained`
- `order_submitted` and `order_failed`
- `settlement_observed`
- `redemption_observed`
- `realized_pnl_observed`

The `realized_pnl_observed` event is emitted only when reconciliation has both an observed submitted cost basis and a completed redemption. Expected replay profit is never emitted as realized P&L.

Schema version 1 allows only these event-specific data fields:

| Event | Data fields |
| --- | --- |
| `run_started` | none |
| `evidence_accepted` | `sourceId` in the local ledger only |
| `evidence_rejected` | `stage`, `transactionStatus` |
| `decision_made` | `action`, `sourceCount`, `transactionStatus` |
| `quote_obtained` | `quoteCostTst`, `quoteShares` |
| `order_submitted`, `order_failed` | `transactionStatus` |
| `settlement_observed` | `settlementStatus` |
| `redemption_observed` | `redemptionStatus`, `tokensRedeemedTst` |
| `realized_pnl_observed` | `realizedPnlTst` |

Unknown telemetry events or environments fail closed during export. The exporter also reconstructs the outbound property allowlist instead of forwarding arbitrary ledger data; `sourceId` stays local.

## Project ingestion

Set `SETTLEMENT_EDGE_METRICS_ENABLED=true`, `SETTLEMENT_EDGE_POSTHOG_KEY`, and an HTTPS `SETTLEMENT_EDGE_POSTHOG_HOST` to enable server-side capture. Each event uses its ledger hash as an idempotency key. A capture failure does not block trading because the complete event stays in the ledger for retry:

```bash
npm run metrics -- --ledger artifacts/decision-receipts.jsonl
```

The default sync includes only `environment=live`. Live event names use `settlement_edge_*`; dry runs, replays, and tests use `settlement_edge_dry_run_*`, `settlement_edge_replay_*`, and `settlement_edge_test_*`. Non-live events therefore cannot enter live competition totals. The project mirror exposes their hourly counts under `posthog.events.count`, with the event name in the `event` dimension.

The remote payload excludes wallet addresses, balances, transaction hashes, source URLs, credentials, and free-form failure text. It contains only bounded lifecycle state needed to count runs and stages and to read the observed `realizedPnlTst` property.
