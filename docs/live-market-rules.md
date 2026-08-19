# Reviewed live-market rules

All eight open Delphi competition markets were rechecked against their exact close times and official settlement sources on 2026-08-19. One Gemini release rule is timing-eligible and active in `config/resolution-rules.json`. The other seven markets cannot produce safely validated decisive evidence before close with the current extractor and remain unconfigured.

Loading the rule file does not enable trading. The active source currently contains no qualifying Gemini Pro release, so evaluation fails closed without proposing an order.

## Open-market screening

| Market | Close (UTC) | Earliest decisive official evidence | Verdict |
|---|---:|---|---|
| WTI front-month below $65 on August 21 | 2026-08-21 18:30 | CME's settlement window ends at 18:30 UTC; public settlement files publish later | Reject: not strictly pre-close |
| Gemini 3.5 Pro or later by August 21 | 2026-08-21 03:59 | An official Google DeepMind model-card row can appear before close | Accept for `Yes` only |
| The Battery maximum water level above 5.18 feet | 2026-08-20 17:00 | NOAA observation window begins at 18:00 UTC | Reject: source begins 60 minutes after close |
| 10-year Treasury yield above 4.68% | 2026-08-20 13:00 | Treasury's official daily rate uses market quotations around 19:30 UTC | Reject: official rate is determined after close |
| Rayo Vallecano versus Alavés ends in a draw | 2026-08-20 19:00 | Scheduled kickoff is 19:00 UTC | Reject: result cannot exist before close |
| Sporting Kansas City beats St. Louis CITY SC | 2026-08-20 00:00 | Scheduled kickoff is 00:00 UTC | Reject: result cannot exist before close |
| Botafogo versus Cienciano has at least four goals | 2026-08-21 00:30 | Scheduled kickoff is 00:30 UTC | Reject: result cannot exist before close |
| AARO or ODNI publishes previously unreleased UAP records | 2026-08-21 14:00 | A qualifying publication could appear before close | Reject: requires historical document-novelty validation; AARO also blocks the CLI source request |

## Gemini 3.5 Pro or later

- Market: `0x2e0d3ee960783033bb70e5b5577a04a1d19f7dcf`, outcome 0 (`Yes`).
- Settlement: Google officially releases a Gemini Pro-family model numbered 3.5 or later by the market cutoff.
- Source: Google DeepMind's official model-card table at https://deepmind.google/models/model-cards/.
- Mapping: accept only an exact row named `Gemini <version> Pro`, optionally suffixed `Preview` or `Experimental`; require version `gte 3.5` and an `Updated` date from 2026-08-10 through 2026-08-20.
- Timing boundary: the source exposes a calendar date rather than a release time. An August 21 row is therefore excluded because its publication cannot be proven earlier than the 03:59 UTC close.
- Current source check: the official table is reachable but contains no qualifying Gemini Pro 3.5-or-later row. Missing, malformed, non-Pro, `Pro Image`, date-ambiguous, and post-cutoff rows cannot carry confidence.

## Retired reviewed mappings

The former NOAA and MLS mappings remain as offline regression fixtures. They still prove exact source semantics, including strict water-level comparison, match identity, and final-whistle conditions, but they are excluded from active monitoring because their decisive facts occur after close. The settled Wikimedia Chess mapping remains documented for the same audit purpose.

## Safety boundary

The screening identifies settlement facts; it does not claim a profitable timing edge. Preflight and live evaluation reject any rule whose earliest decisive fact is missing or is not strictly before the market close. Source timestamps remain separate from local HTTPS retrieval time, the 15-minute freshness check remains active, and `.env.example` keeps `ALLOW_LIVE_TRADING=false` and `SETTLEMENT_EDGE_EXECUTE=false`.
