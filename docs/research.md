# Strategy research

This document records strategy hypotheses, not observed live performance. Settlement Edge has not submitted a live order or produced realized competition P&L.

## Decision

Build an evidence-latency agent rather than a generic forecasting chatbot or high-frequency trader.

## Why this direction

- Final P&L is the competition's ranking metric.
- Competition shares have a fixed 1 TST winning payout, so a fact-backed probability gap has direct expected value.
- Shallow LMSR markets punish oversized orders, so quote-aware small sizing may reduce avoidable price impact.
- Machine-readable resolution sources may create a timing edge because the agent can monitor exact source facts consistently. That edge is not yet proven in live competition trading.
- A single receipt is enough to demonstrate the whole product without relying on a long narrative.

## Target market families

Prioritize markets whose resolution wording maps cleanly to a primary API:

1. Wikimedia pageviews and article statistics.
2. NOAA weather observations and climate summaries.
3. FRED or Treasury economic releases.
4. UK carbon-intensity observations.
5. Official public ledgers or status APIs with timestamped JSON.

Avoid subjective, model-judged, thinly sourced, or ambiguous settlement questions until the objective set is exhausted.

## Rejected directions

- A broad multi-agent research UI would look impressive but would not create a direct P&L advantage.
- A generic safety agent does not match the actual trading competition.
- High-frequency trading would pay repeated price impact without an information advantage.
- Autonomous rule inference from natural-language market text risks trading against the wrong threshold, timezone, or source.
