# Terms of use

These terms cover use of Settlement Edge, the open-source command-line software in this repository.

## Competition software

Settlement Edge is built for the Gensyn Delphi Agent Arena on `competition-testnet`. It uses play-money TST and is not a mainnet trading system or financial advice. The software does not guarantee a profitable trade, a market result, competition eligibility, uninterrupted access, or a leaderboard position.

## Operator responsibilities

You are responsible for reviewing each market and resolution rule, protecting credentials, registering and funding the correct competition wallet, checking the live-trading preflight, and deciding whether to enable both execution switches. You are also responsible for following the competition rules and the terms of connected services.

Live execution can approve tokens and submit public blockchain transactions. Blockchain transactions can be irreversible even when the asset is a test token. Dry-run is the default, but you should inspect the configuration and code before enabling execution.

## Third-party services and data

Settlement Edge depends on the Gensyn Delphi SDK, competition APIs and contracts, a configured RPC provider, optional Coinbase Developer Platform signing, and the primary JSON sources declared in each rule. Those services can change, fail, return stale or incorrect data, or apply separate terms.

How the agent handles operator and wallet data is described in the [Privacy notice](PRIVACY.md).

## Availability and liability

The software is provided under the repository's [MIT License](LICENSE), including its warranty and liability limitations. Nothing in these terms expands the warranties or liability stated in that license.

## Changes and contact

These terms may be updated in this repository as the software changes. Questions can be sent to [dorahacks@mail.tin.computer](mailto:dorahacks@mail.tin.computer).
