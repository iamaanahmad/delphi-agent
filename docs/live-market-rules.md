# Reviewed live-market rules

These rules were checked against the open Delphi competition markets and their public settlement wording on 2026-08-18. They are committed in `config/resolution-rules.json`; loading that file does not enable trading.

## Chess Wikipedia pageviews

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
- Market page: https://competition.delphi.fyi/markets/0x360274d153c58566943cb21088dd95e45638bda3

## Sporting Kansas City versus St. Louis CITY SC

- Market: `0xbf1ce7c9d751b92bfac4acefe0e87d82b1d30163`, outcome 0 (`Yes`).
- Settlement: Sporting Kansas City wins after regulation in the MLS match scheduled for 2026-08-19 local time. A draw or St. Louis win resolves `No`.
- Source: the public JSON feed used by MLSsoccer.com, match `MLS-MAT-0009J5`.
- Mapping: require `match_information.match_status eq finalWhistle`, then compare `home_team_goals gt away_team_goals`; the event timestamp is `match_information.kickoff_time`.
- Market page: https://competition.delphi.fyi/markets/0xbf1ce7c9d751b92bfac4acefe0e87d82b1d30163

## Safety boundary

The reviewed pack identifies settlement facts; it does not claim a profitable timing edge. Each rule treats the source event time separately from the locally observed HTTPS retrieval time. The strict 15-minute source freshness check remains active, and `.env.example` keeps `ALLOW_LIVE_TRADING=false` and `SETTLEMENT_EDGE_EXECUTE=false`.
