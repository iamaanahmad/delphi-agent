# Privacy notice

Settlement Edge is a command-line competition agent with a public project website. It has no hosted account system, cookies, advertising profiles, or project-operated database. Optional agent lifecycle metrics are disabled by default and require explicit local configuration.

## Data the agent handles

The credential-free replay uses only the checked-in fixture. Live commands can handle the following operator data:

- wallet addresses, balances, positions, transaction hashes, market actions, and timestamps;
- API keys, private keys, or Coinbase Developer Platform wallet credentials supplied through a local `.env` file;
- local configuration, including market addresses, source URLs, risk limits, and file destinations; and
- terminal output, decision receipts, reconciliation records, and watcher state created while the agent runs.

When optional lifecycle metrics are enabled, Settlement Edge sends bounded run, market, decision, settlement, redemption, and realized-P&L state to the configured PostHog ingestion host. The metrics payload does not include wallet addresses, balances, transaction hashes, source URLs, source identifiers, credentials, or free-form failure text. Dry-run, replay, and test events use separate event names and remain outside live competition totals.

The public website uses PostHog to measure page and guide engagement, coarse error or empty states, and rage clicks. It is configured for session replay; replay input masking stays on when the managed project enables recording. After a visitor engages with the demo or reads most of a guide, the site may ask one feedback question; only the page route and the visitor's deliberate answer, limited to 280 characters, are sent. The site does not identify visitors, create advertising profiles, or send URL query strings, wallet identifiers, credentials, or typed feedback into session recordings.

Secrets are read by the official Delphi SDK from the local environment. Settlement Edge does not add secrets to receipts or print their values. A public wallet address and its on-chain activity are not secret.

## Where data goes

Settlement Edge does not send data to a project-operated server. Depending on the command and signer configuration, it connects directly from the operator's machine to:

- the Gensyn Delphi API for competition markets and wallet-position queries;
- the configured Gensyn RPC provider for wallet balance reads, quotes, approvals, and transactions;
- Coinbase Developer Platform when the operator selects its server-wallet signer; and
- the reviewed JSON evidence source named in each rule, currently Wikimedia, NOAA, or the MLS match feed.
- the configured PostHog ingestion host when optional agent lifecycle metrics are enabled, and from the public website for privacy-limited visitor analytics and deliberate feedback.

The wallet-position query includes the public wallet address. RPC reads and submitted transactions also use the public wallet address. Evidence requests include the source URL and the `settlement-edge/1.0` user-agent, but Settlement Edge does not add wallet credentials to those requests. Optional metrics use a fixed CLI identifier rather than a wallet or person identifier. These third-party services operate under their own terms and privacy notices.

## Local storage and deletion

By default, credentials stay in the gitignored `.env` file. Decision and reconciliation history is stored in `artifacts/decision-receipts.jsonl`, and restart protection can be stored in `artifacts/watcher-state.json`. Operators can choose other local paths with the documented environment variables.

To remove local agent data, stop the agent and delete the applicable `.env`, receipt, and watcher-state files. Revoke or rotate provider credentials through the provider that issued them. Disable agent metrics by removing the metrics variables or setting `SETTLEMENT_EDGE_METRICS_ENABLED=false`. Website analytics use browser local storage rather than cookies; clearing this site's local storage removes the browser-side identifier and feedback-prompt state. Public blockchain transactions and wallet activity cannot be deleted by Settlement Edge. Metrics already sent to a configured provider must be removed under that provider's deletion process.

The project does not set a retention period for files it does not control. Local files remain until the operator removes them, and third-party services apply their own retention practices.

## Contact

Questions about this notice can be sent to [dorahacks@mail.tin.computer](mailto:dorahacks@mail.tin.computer).
