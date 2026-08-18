# 90-second demo

## 0:00 to 0:15: the contest problem

Open the competition leaderboard and say: “This contest is judged by final P&L. The opportunity is not more trades. It is recognizing an objective result before the market fully prices it.”

## 0:15 to 0:35: the evidence

Open `fixtures/wikipedia-threshold.json`. Point to the Wikimedia source shape, the simulated 102,431 fixture value, the 100,000 threshold, and the simulated 61% market probability. Do not present the fixture as a live observation.

## 0:35 to 1:05: the decision

Run:

```bash
npm run demo
```

Walk down the receipt in order: source fact, conservative 98.7% estimate, 37.7-point edge, simulated shallow-curve quote, 2% impact, 1.4292 TST simulated expected profit, and dry-run buy. Say plainly that 2.5200 TST is not a real spend and 1.4292 TST is not realized competition profit.

Then change the evidence timestamp to 2020 and rerun. The agent should skip with `no fresh evidence`. Restore the fixture afterward.

## 1:05 to 1:20: the safety model

Show `.env.example`. Explain that the live SDK gateway is present, but an order needs two explicit execution switches, a registered competition wallet, and secrets that never enter git.

## 1:20 to 1:30: the memorable close

Open `artifacts/decision-receipts.jsonl` and say: “Every evaluation leaves a hash-linked receipt. Settlement Edge does not ask you to trust its instinct. It shows the fact, the price, the risk, and the decision.”

## Replay fallback

The demo is fully deterministic and does not depend on Wi-Fi, API availability, wallet gas, or an open market. Use `npm run scan` separately when live connectivity is available.
