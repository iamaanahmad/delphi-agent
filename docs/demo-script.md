# 90-second demo

## 0:00 to 0:15: the contest problem

Open the competition leaderboard and say: “This contest is judged by final P&L. The opportunity is not more trades. It is recognizing an objective result before the market fully prices it.”

## 0:15 to 0:35: the evidence

Open `fixtures/wikipedia-threshold.json`. Point to the official Wikimedia source, the verified 102,431 view count, the 100,000 settlement threshold, and the 61% market probability.

## 0:35 to 1:05: the decision

Run:

```bash
npm run demo
```

Walk down the receipt in order: source fact, conservative 98.7% estimate, 37.7-point edge, live-style shallow-curve quote, 2% impact, 1.4272 TST expected profit, and dry-run buy.

Then change the evidence timestamp to 2020 and rerun. The agent should skip with `no fresh evidence`. Restore the fixture afterward.

## 1:05 to 1:20: the safety model

Show `.env.example`. Explain that the live SDK gateway is present, but an order needs two explicit execution switches, a registered competition wallet, and secrets that never enter git.

## 1:20 to 1:30: the memorable close

Open `artifacts/decision-receipts.jsonl` and say: “Every trade and every refusal leaves a hash-linked receipt. Settlement Edge does not ask you to trust its instinct. It shows the fact, the price, the risk, and the decision.”

## Replay fallback

The demo is fully deterministic and does not depend on Wi-Fi, API availability, wallet gas, or an open market. Use `npm run scan` separately when live connectivity is available.
