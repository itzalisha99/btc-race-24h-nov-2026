[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/itzalisha99/btc-race-24h-nov-2026/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/itzalisha99/btc-race-24h-nov-2026/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

# BTC Race Bot — "Buy at Bar 24 + 1% Crash Guard + Washout Sniper"

A trading bot for the make.fun bounty **"Race a BTC trading bot live for 24 hours"**
(`btc-race-24h-20261123-0511`, harness `bars-replay/v1`). It trades Coinbase
Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars with $1,000 of paper
money. Simulation only — nothing is traded for real.

## How it works

1. **Trend entry:** at the first tradable batch with seq ≥ max(24, warmupBars) and
   RSI(14) < 75, it buys 100% of cash. If RSI is ≥ 75 it waits for RSI < 75, or
   buys at seq 120 at the latest — so it always makes at least 1 trade.
2. **Crash guard:** while holding the trend position, if the close falls to the
   entry fill price × 0.99, it sells everything and never re-enters a trend
   position. A falling day is where dip-buyers bleed out.
3. **Washout sniper (flat only):** RSI(14) ≤ 20 AND the 60-bar return ≤ −0.8%
   AND a bounce is confirmed (close > open × 1.002, or RSI rose ≥ 2 over the
   last 5 bars) → buy 100%. Exits: take-profit +1.2%, trailing stop 1% from the
   peak, RSI ≥ 60, hold 240 bars, or stop-loss −1.5%. At most 2 washout round
   trips, 4 round trips total, no entries after seq 1380, 20-bar cooldown after
   every exit.

## Why this shape

The last BTC race (Nov 18) taught the lesson: 8 of the top 10 winners made
exactly 2 trades — one extreme-oversold washout buy, one sell — then sat out a
falling day. Our 3-trade dip-buying bot lost $21.50. A washout-only sniper is
not robust on its own either (it catches a falling knife). So the bot buys once
early, guards the downside hard, and only snipes a washout with a confirmed
bounce as a backup for a falling race day.

## Backtest results

Modelled on the kit's fill rules (fill at next open + 2 bps slippage +
constant-product impact + 4 bps fee):

| Window | Net PnL | Trades | Max drawdown |
| --- | --- | --- | --- |
| New dev window (kit) | **+$34.94** | 2 | 1.98% |
| Old Nov-18 falling window | −$13.27 | 2 | 1.95% |
| Block-shuffled new window (median) | +$30.80 | — | — |

Buy-and-hold for comparison: +$32.17 on the new window, −$23.87 on the old
one. The bot passes the dev gate (net PnL > $0) with a wide margin. Dev profit
does not predict the race window — the rules are deliberately simple and
un-fitted so they survive an unseen day.

## Run it

Node 22, standard library only. The kit's SDK shim is vendored verbatim at
`vendor/makefun-bars.ts`.

```sh
node main.ts   # speaks agent-fun/bars-replay/v1 on stdin/stdout
```

Fully deterministic: no clock, no randomness, no environment. Two runs on the
same data produce the same orders, byte for byte.

## License

MIT — see [LICENSE](LICENSE).
