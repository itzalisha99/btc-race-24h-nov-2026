// BTC race bot for make.fun btc-race-24h-20261123-0511 (agent-fun/bars-replay/v1).
//
// Strategy — "buy at bar 24 + 1% crash guard + confirmed-bounce washout sniper":
//   1. Trend entry: at the first tradable batch with seq >= max(24, warmupBars) and
//      RSI(14) < 75, buy 100% of cash. If RSI is >= 75, wait for RSI < 75, or buy at
//      seq 120 at the latest. This guarantees at least 1 trade (the dev gate needs
//      net PnL > $0, and a bot that never trades makes exactly $0 and fails it).
//   2. Crash guard: while holding the trend position, if the close falls to the
//      entry fill price x 0.99, sell everything. The last BTC race (Nov 18) showed
//      why: the winners made exactly 2 trades — one washout buy, one sell — then sat
//      out a falling day; our 3-trade dip-buying bot lost $21.50. A 1% guard is the
//      best balance found in backtests (1.5% -> -$18.04, 2% -> -$24.78 on the old
//      falling window; 1% -> -$13.27 there, +$34.94 on the new dev window).
//   3. Washout sniper (flat only): RSI(14) <= 20 AND the 60-bar return <= -0.8% AND
//      a bounce is confirmed (this bar's close > open x 1.002, or RSI rose >= 2 over
//      the last 5 bars) -> buy 100%. Exits: take-profit +1.2%, trailing stop 1% from
//      the peak, RSI >= 60, hold 240 bars, or stop-loss -1.5%. At most 2 washout
//      round trips. A washout-only sniper is NOT robust on its own (it catches a
//      falling knife: +$1.72 new window, -$13.19 old window), so it only runs as a
//      backup for a falling race day after a guard exit.
//   4. At most 4 round trips total, no entries after seq 1380, 20-bar cooldown
//      after every exit (180 bars after a guard exit), no re-entry into a trend
//      position after a guard exit; after a guard exit the sniper needs a
//      deeper washout (RSI <= 15, 60-bar return <= -1.5%) before it may fire.
//   5. Post-guard re-entry, tightened further: after the guard sells, the bot
//      waits 3 hours (180 bars) instead of 1, then demands a confirmed turn
//      before it may buy again — a firm green bar (close >= 0.3% above its
//      open) that also closes above the previous bar, with RSI turning up at
//      least 2 points over 5 bars, all three at once. And it gets only one
//      such shot: if that sniper trade exits, win or lose, the bot sits out
//      the rest of the day. Why: a guard exit means the bought trend broke,
//      and the old falling window showed a single green bar or a small RSI
//      tick inside a downtrend is noise — re-entering on it catches a falling
//      knife. The bar for coming back in is deliberately high, so the bot
//      would rather miss a bounce than churn through a falling day.
//
// Backtested (Python model of the kit's fill rules: fill at next open + 2 bps
// slippage + constant-product impact + 4 bps fee) on the kit's frozen dev window
// and on the Nov-18 falling window:
//   new dev window  +$34.94 (2 trades, max drawdown 1.98%) — passes the dev gate
//   old falling win -$13.27 (buy-and-hold -$23.87 there)
//   block-shuffled new window, median +$30.80
// The sniper never fired in either final backtest; the trend buy carried the dev
// window. Dev profit does NOT predict the race window — the rules are simple and
// un-fitted on purpose, so they survive an unseen day.
//
// Fully deterministic: no clock, no Math.random, no environment. Every decision is
// a pure function of the bars seen so far. Two runs on the same data give the same
// orders, byte for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 1000;
const FIRST_TRADE_BAR = 24;
const LATEST_TREND_BAR = 120;
const LAST_ENTRY_BAR = 1380;
const MAX_ROUNDTRIPS = 4;
const MAX_WASHOUT_RTS = 2;
const GUARD_PCT = 0.01;
const WASH_RSI = 20;
const WASH_DROP = -0.008;
const WASH_TP = 0.012;
const WASH_SL = -0.015;
const WASH_TRAIL = 0.01;
const WASH_RSI_EXIT = 60;
const WASH_MAX_HOLD = 240;
const COOLDOWN_BARS = 20;
const POST_GUARD_WASH_RSI = 15;
const POST_GUARD_WASH_DROP = -0.015;
// After a guard exit the bought trend has broken, so the bot waits three
// hours (180 bars = three full 60-bar drop windows) for the tape to base,
// instead of one hour. A broken trend needs time to form a base; an hour
// still catches the same falling tape.
const POST_GUARD_COOLDOWN_BARS = 180;
// A post-guard re-entry must show a confirmed turn, not a flicker: a firm
// green bar, a close above the previous bar's close, and RSI turning up —
// all three at once.
const POST_GUARD_TURN_GREEN = 0.003;
const POST_GUARD_RSI_RISE = 2;
const RSI_PERIOD = 14;
const TREND_RSI_MAX = 75;

type Kind = 'trend' | 'wash';

interface OpenPosition {
  kind: Kind;
  /** Entry fill price in USDC (from the buy fill's price field). */
  entry: number;
  /** Decision bar (seq index into the closes array) of the buy. */
  bar: number;
  /** Highest close seen while holding. */
  peak: number;
  qty: bigint;
}

interface PendingBuy {
  kind: Kind;
  bar: number;
}

interface PendingSell {
  reason: 'GUARD' | 'WASH';
  bar: number;
}

// Closes and opens in USDC (raw / 1e5), one entry per CBBTC bar seen, in order.
const closes: number[] = [];
const opens: number[] = [];

let pos: OpenPosition | null = null;
let pendingBuy: PendingBuy | null = null;
let pendingSell: PendingSell | null = null;
let crashed = false;
// Whether the one sniper shot allowed after a guard exit has been used.
// After the guard fires the bot gets exactly one washout attempt; if that
// trade also fails, the day is confirmed falling and the bot sits out.
let guardWashUsed = false;
let roundtrips = 0;
let washRoundtrips = 0;
let coolUntil = -1;
let trendDone = false;

/**
 * RSI(14) at index `idx`, exactly as the backtester's Wilder-smoothed RSI:
 * initial average over the first 14 deltas, then smoothing from index 15 on.
 * Null before index 14.
 */
function rsiAt(idx: number): number | null {
  if (idx < RSI_PERIOD) return null;
  let ag = 0;
  let al = 0;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const d = closes[i] - closes[i - 1];
    ag += Math.max(d, 0);
    al += Math.max(-d, 0);
  }
  ag /= RSI_PERIOD;
  al /= RSI_PERIOD;
  let rsi = 100 - 100 / (1 + (al > 0 ? ag / al : 100));
  for (let i = RSI_PERIOD + 1; i <= idx; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (RSI_PERIOD - 1) + Math.max(d, 0)) / RSI_PERIOD;
    al = (al * (RSI_PERIOD - 1) + Math.max(-d, 0)) / RSI_PERIOD;
    rsi = 100 - 100 / (1 + (al > 0 ? ag / al : 100));
  }
  return rsi;
}

runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);

    // Fold this batch's fills into our own bookkeeping first: a buy fill sets
    // the position (entry price from the fill's price field); a sell fill
    // closes it and counts the round trip. A rejected order clears its pending
    // slot so the same decision can be retried on the next bar.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.client_id.startsWith('_')) continue;
      if (fill.side === 'buy' && fill.status === 'filled' && pendingBuy !== null) {
        const entry = Number(fill.price) / 1e5;
        pos = { kind: pendingBuy.kind, entry, bar: pendingBuy.bar, peak: entry, qty: BigInt(fill.qty) };
        if (pendingBuy.kind === 'trend') trendDone = true;
        // A washout buy taken after a guard exit spends the single shot the
        // bot allows itself there — win or lose, there is no second attempt.
        if (pendingBuy.kind === 'wash' && crashed) guardWashUsed = true;
        pendingBuy = null;
      } else if (fill.side === 'buy' && fill.status === 'rejected') {
        pendingBuy = null;
      } else if (fill.side === 'sell' && fill.status === 'filled' && pendingSell !== null) {
        roundtrips += 1;
        if (pendingSell.reason === 'GUARD') crashed = true;
        if (pos !== null && pos.kind === 'wash') washRoundtrips += 1;
        pos = null;
        coolUntil =
          pendingSell.bar +
          (pendingSell.reason === 'GUARD' ? POST_GUARD_COOLDOWN_BARS : COOLDOWN_BARS);
        pendingSell = null;
      } else if (fill.side === 'sell' && fill.status === 'rejected') {
        pendingSell = null;
      }
    }

    if (bar === undefined) return [];

    // Fresh bar: extend the history (Number, raw / 1e5).
    opens.push(Number(bar.o) / 1e5);
    closes.push(Number(bar.c) / 1e5);
    const idx = closes.length - 1;
    const close = closes[idx];

    // Safety net: if the account holds a position our fill bookkeeping missed,
    // rebuild it from the latest close instead of trading blind.
    if (pos === null && pendingBuy === null) {
      const held = state.positions.get(SYMBOL);
      if (held !== undefined && held.qty > 0n) {
        pos = { kind: 'trend', entry: close, bar: idx, peak: close, qty: held.qty };
        trendDone = true;
      }
    }

    // Warm-up batches cannot trade (orders on them are rejected).
    if (state.warmingUp) return [];

    // --- exits ---
    if (pos !== null) {
      const ret = close / pos.entry - 1;
      if (close > pos.peak) pos.peak = close;
      if (pos.kind === 'wash') {
        const rsi = rsiAt(idx);
        if (
          ret >= WASH_TP ||
          (rsi !== null && rsi >= WASH_RSI_EXIT) ||
          idx - pos.bar >= WASH_MAX_HOLD ||
          ret <= -WASH_SL ||
          close < pos.peak * (1 - WASH_TRAIL)
        ) {
          pendingSell = { reason: 'WASH', bar: idx };
          return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      } else if (ret <= -GUARD_PCT) {
        pendingSell = { reason: 'GUARD', bar: idx };
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- entries ---
    if (pendingBuy !== null || pendingSell !== null) return [];
    const firstTrade = Math.max(FIRST_TRADE_BAR, state.warmupBars);
    if (idx < firstTrade || idx > LAST_ENTRY_BAR) return [];
    if (roundtrips >= MAX_ROUNDTRIPS || idx <= coolUntil) return [];
    if (state.cash < 1000000n) return [];

    const rsi = rsiAt(idx);
    const r60 = idx >= 60 ? closes[idx] / closes[idx - 60] - 1 : 0;
    const rsi5 = idx >= 5 ? rsiAt(idx - 5) : null;
    const bounce =
      close > opens[idx] * 1.002 || (rsi !== null && rsi5 !== null && rsi > rsi5 + 2);
    // After a guard exit the market has just confirmed a >=1% fall from
    // entry, so a sniper re-entry must demand a genuinely exhausted selloff
    // (deeper RSI, bigger 60-bar drop) instead of the first bounce in a
    // downtrend — re-entering after a guard exit churned in backtests.
    // My extra bar: a single green bar or a small RSI tick is noise inside a
    // downtrend, so after a guard exit the turn must show up three ways at
    // once — a firm green bar, a close above the previous bar's close, and
    // RSI turning up — and the bot spends its one allowed shot on it.
    const turnConfirmed =
      idx >= 1 &&
      close > opens[idx] * (1 + POST_GUARD_TURN_GREEN) &&
      close > closes[idx - 1] &&
      rsi !== null &&
      rsi5 !== null &&
      rsi > rsi5 + POST_GUARD_RSI_RISE;
    const washRsi = crashed ? POST_GUARD_WASH_RSI : WASH_RSI;
    const washDrop = crashed ? POST_GUARD_WASH_DROP : WASH_DROP;
    const wash =
      washRoundtrips < MAX_WASHOUT_RTS &&
      (!crashed || !guardWashUsed) &&
      rsi !== null &&
      rsi <= washRsi &&
      r60 <= washDrop &&
      (crashed ? turnConfirmed : bounce);
    const trend =
      !crashed &&
      !trendDone &&
      idx >= firstTrade &&
      ((rsi !== null && rsi < TREND_RSI_MAX) || idx >= LATEST_TREND_BAR);

    if (wash || trend) {
      pendingBuy = { kind: wash ? 'wash' : 'trend', bar: idx };
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
