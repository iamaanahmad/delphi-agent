# Reviewed live-market rules

The two configured rules were rechecked against the open Delphi competition markets and their public settlement wording on 2026-08-19. They are committed in `config/resolution-rules.json`; loading that file does not enable trading. Neither is eligible for live evaluation because its decisive source fact cannot arrive before market close. The settled Wikimedia rule remains below as historical documentation only.

## Chess Wikipedia pageviews (settled, retired)

This rule settled on 2026-08-18 and was removed from active monitoring on 2026-08-19. Its reviewed mapping remains here for the audit trail.

- Market: `0x7fb6eb62585de2fde740bfe4b4bae0c279919021`, outcome 0 (`Yes`).
- Settlement: the English Wikipedia article `Chess` receives more than 2,250 pageviews on 2026-08-18 UTC. Exactly 2,250 resolves `No`.
- Source: Wikimedia Pageviews API, project `en.wikipedia`, access `all-access`, agent `user`, daily granularity, article `Chess`.
- Mapping: `items.0.views gt 2250`; event timestamp `items.0.timestamp` in `yyyyMMddHH` UTC format.
- Market page: https://competition.delphi.fyi/markets/0x7fb6eb62585de2fde740bfe4b4bae0c279919021

## The Battery maximum water level

- Market: `0x360274d153c58566943cb21088dd95e45638bda3`, outcome 0 (`Yes`).
- Settlement: the maximum NOAA observation is greater than 5.18 feet MLLW from 18:00 through 23:54 UTC on 2026-08-20. Exactly 5.18 resolves `No`.
- Source: NOAA CO-OPS station `8518750`, product `water_level`, datum `MLLW`, GMT, English units, JSON format.
- Mapping: select `data` records inside the exact UTC window, parse `v`, and apply `max gt 5.18`; each record carries its event timestamp at `t`.
- Source check: the endpoint and station returned the expected `metadata` plus six-minute `data` records for 2026-08-18. The exact 2026-08-20 request currently returns NOAA's no-data response because the observation window has not started; the rule fails closed until observations exist.
- Timing status: ineligible. The market closes at `2026-08-20T17:00:00Z`, but the required observation window starts at `2026-08-20T18:00:00Z`.
- Market page: https://competition.delphi.fyi/markets/0x360274d153c58566943cb21088dd95e45638bda3

## Sporting Kansas City versus St. Louis CITY SC

- Market: `0xbf1ce7c9d751b92bfac4acefe0e87d82b1d30163`, outcome 0 (`Yes`).
- Settlement: Sporting Kansas City wins after regulation in the MLS match scheduled for 2026-08-19 local time. A draw or St. Louis win resolves `No`.
- Source: the public schedule JSON feed used by MLSsoccer.com, selecting match `MLS-MAT-0009J5` from season `MLS-SEA-0001KA`.
- Mapping: require exactly one record whose `match_id` is `MLS-MAT-0009J5`, then require `match_status eq finalWhistle` and compare `home_team_goals gt away_team_goals`; the event timestamp is `planned_kickoff_time`.
- Source check: the feed returned one exact scheduled record with Sporting Kansas City at home, St. Louis CITY SC away, and kickoff at `2026-08-20T00:00:00Z`. Zero or multiple matching records fail closed.
- Timing status: ineligible. The match is scheduled to start exactly when the market closes at `2026-08-20T00:00:00Z`, so the final result cannot be known before close.
- Market page: https://competition.delphi.fyi/markets/0xbf1ce7c9d751b92bfac4acefe0e87d82b1d30163

## Safety boundary

The reviewed pack identifies settlement facts; it does not claim a profitable timing edge. Preflight and live evaluation reject any rule whose earliest decisive fact is missing or is not strictly before the market close. Each rule treats the source event time separately from the locally observed HTTPS retrieval time. The strict 15-minute source freshness check remains active, and `.env.example` keeps `ALLOW_LIVE_TRADING=false` and `SETTLEMENT_EDGE_EXECUTE=false`.
