import type { BucketValues, MarketSnapshot, NowState, SellReason, SizeBucket, Token, Trade } from '@btrade/core';
import { toNumber, toUnits } from '@btrade/core';

export interface RiskConfig {
  minConfidence: number;
  /** native wei never to be spent */
  gasReserveNative: bigint;
  sizePct: Record<SizeBucket, number>;
  minProfitPct: number;
  /** 0 disables */
  stopLossPct: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  /** minimum trade value in QUOTE units */
  minTradeValue: number;
  /** hard cap per trade in QUOTE units; amount is clamped down to it. 0 disables */
  maxTradeValue: number;
  maxGasCostPct: number;
  tradeCooldownSec: number;
  maxTradesPerDay: number;
  maxDailyLossPct: number;
  /** a same-side trade needs the price to move this % beyond the last one (sell: above, buy: below). 0 disables */
  sameSideStepPct: number;
}

const BUCKETS: SizeBucket[] = ['small', 'medium', 'large'];

/** Balance minus the untouchable native gas reserve. */
export function availableAfterReserve(bal: bigint, token: Token, reserve: bigint): bigint {
  return token.native ? (bal > reserve ? bal - reserve : 0n) : bal;
}

/** Raw amountIn for a bucket, after the MAX_TRADE_VALUE clamp (sell cap converted to BASE via spot price). */
export function bucketAmountIn(cfg: RiskConfig, s: MarketSnapshot, isBuy: boolean, bucket: SizeBucket): bigint {
  const { base, quote } = s.pair;
  const tokenIn = isBuy ? quote : base;
  const avail = availableAfterReserve(isBuy ? s.balances.quote : s.balances.base, tokenIn, cfg.gasReserveNative);
  const bps = BigInt(Math.round(cfg.sizePct[bucket] * 100));
  let amountIn = (avail * bps) / 10_000n;
  if (amountIn > 0n && cfg.maxTradeValue > 0) {
    const cap = isBuy
      ? toUnits(cfg.maxTradeValue, quote.decimals)
      : s.price > 0 ? toUnits(cfg.maxTradeValue / s.price, base.decimals) : amountIn;
    if (amountIn > cap) amountIn = cap;
  }
  return amountIn;
}

/** Seconds of cooldown left (0 when none). */
export function cooldownSecLeft(cfg: RiskConfig, lastTradeTs: number | null, nowSec: number): number {
  return lastTradeTs !== null && nowSec - lastTradeTs < cfg.tradeCooldownSec ? Math.ceil(cfg.tradeCooldownSec - (nowSec - lastTradeTs)) : 0;
}

/** Rolling-24h realized loss vs portfolio value (QUOTE). */
export function dailyLoss(cfg: RiskConfig, recent: Trade[], s: MarketSnapshot): { lossPct: number; hit: boolean } {
  const { base, quote } = s.pair;
  const realizedLoss = -recent.reduce((a, t) => a + Math.min(0, t.realizedPnlQuote), 0);
  const portfolio = toNumber(s.balances.quote, quote.decimals) + toNumber(s.balances.base, base.decimals) * s.price;
  const lossPct = portfolio > 0 ? (realizedLoss / portfolio) * 100 : 0;
  return { lossPct, hit: cfg.maxDailyLossPct > 0 && lossPct >= cfg.maxDailyLossPct };
}

/** Gas of one swap in QUOTE (only computable if native is base or quote). */
export function gasInQuote(s: MarketSnapshot): number | null {
  const gasNative = toNumber(s.estGasCostNative, 18);
  return s.pair.base.native ? gasNative * s.price : s.pair.quote.native ? gasNative : null;
}

export interface SellRule {
  stopPrice: number | null;
  /** minimum sell price (entry*(1+minProfit) + gas/unit) */
  required: number;
  stopLoss: boolean;
  targetReached: boolean;
}

/**
 * The sell rule. sellPrice comes from a quote already net of the pool fee; buy-side fee is in avgEntry.
 * A sell is allowed when targetReached or stopLoss.
 */
export function sellRule(cfg: RiskConfig, entry: number, sellPrice: number, gasQuote: number | null, baseAmount: number): SellRule {
  const stopPrice = cfg.stopLossPct > 0 ? entry * (1 - cfg.stopLossPct / 100) : null;
  const gasPerUnit = gasQuote !== null && baseAmount > 0 ? gasQuote / baseAmount : 0;
  const required = entry * (1 + cfg.minProfitPct / 100) + gasPerUnit;
  return { stopPrice, required, stopLoss: stopPrice !== null && sellPrice <= stopPrice, targetReached: sellPrice >= required };
}

const round = (n: number, d: number) => Number(n.toFixed(d));

export interface StepRule { ok: boolean; next: number | null }

/**
 * Ladder between same-side trades: after a sell, the next sell needs price >= last*(1+step)
 * (or, with stop-loss active, <= last*(1-step)); after a buy, the next buy needs price <= last*(1-step).
 * An opposite-side last trade (or none) imposes nothing. `next` is the price that unlocks the step.
 */
export function stepRule(cfg: RiskConfig, side: 'buy' | 'sell', price: number, last: Pick<Trade, 'side' | 'price'> | null, stopLossActive = false): StepRule {
  const step = cfg.sameSideStepPct / 100;
  if (step <= 0 || !last || last.side !== side || !(last.price > 0)) return { ok: true, next: null };
  if (side === 'sell') {
    const up = last.price * (1 + step);
    return { ok: price >= up || (stopLossActive && price <= last.price * (1 - step)), next: up };
  }
  const down = last.price * (1 - step);
  return { ok: price <= down, next: down };
}

/** What is possible right now. Pure; RiskManager.assess feeds it the stored trades. */
export function computeNow(
  cfg: RiskConfig, s: MarketSnapshot, ctx: { recentTrades: Trade[]; lastTradeTs: number | null; nowSec: number; lastTrade?: Pick<Trade, 'side' | 'price'> | null },
): NowState {
  const { base, quote } = s.pair;
  const valuesFor = (isBuy: boolean): BucketValues => {
    const sellPx = s.priceSell ?? s.price;
    const out = {} as BucketValues;
    for (const b of BUCKETS) {
      const amt = bucketAmountIn(cfg, s, isBuy, b);
      const value = isBuy ? toNumber(amt, quote.decimals) : toNumber(amt, base.decimals) * sellPx;
      out[b] = { value: Number(value.toPrecision(6)), belowMin: value < cfg.minTradeValue };
    }
    return out;
  };
  const buy = valuesFor(true);
  const sell = valuesFor(false);

  const quoteAvail = availableAfterReserve(s.balances.quote, quote, cfg.gasReserveNative);
  const last = ctx.lastTrade ?? null;
  const buyPx = s.priceBuy ?? s.price;
  const buyStep = stepRule(cfg, 'buy', buyPx, last);
  let buyReason: NowState['buyReason'] = quoteAvail <= 0n ? 'no_quote_balance' : BUCKETS.every((b) => buy[b].belowMin) ? 'below_min_trade_value' : 'ok';
  if (buyReason === 'ok' && !buyStep.ok) buyReason = 'waiting_price_step';

  // sell rule evaluated at the probe (medium) size, like the snapshot's executable sell price
  const sellPx = s.priceSell ?? s.price;
  const medIn = bucketAmountIn(cfg, s, false, 'medium');
  const entry = s.position?.avgEntryPrice;
  let sellReason: SellReason;
  let pctToProfitTarget: number | null = null;
  let pctToStopLoss: number | null = null;
  if (medIn <= 0n) sellReason = 'no_base_available';
  else sellReason = 'below_profit_target';
  if (entry && entry > 0 && sellPx > 0) {
    const r = sellRule(cfg, entry, sellPx, gasInQuote(s), toNumber(medIn, base.decimals));
    pctToProfitTarget = round((r.required / sellPx - 1) * 100, 3);
    pctToStopLoss = r.stopPrice === null ? null : round((r.stopPrice / sellPx - 1) * 100, 3);
    if (medIn > 0n) sellReason = r.targetReached ? 'profit_target_reached' : r.stopLoss ? 'stop_loss_active' : 'below_profit_target';
  }
  const sellStep = stepRule(cfg, 'sell', sellPx, last, sellReason === 'stop_loss_active');
  if ((sellReason === 'profit_target_reached' || sellReason === 'stop_loss_active') && !sellStep.ok) sellReason = 'waiting_price_step';
  const pctTo = (target: number | null, px: number) => (target === null || !(px > 0) ? null : round((target / px - 1) * 100, 3));

  return {
    sellAllowedNow: sellReason === 'profit_target_reached' || sellReason === 'stop_loss_active',
    sellReason,
    buyAllowedNow: buyReason === 'ok',
    buyReason,
    pctToProfitTarget,
    pctToStopLoss,
    blocked: {
      cooldownSecLeft: cooldownSecLeft(cfg, ctx.lastTradeTs, ctx.nowSec),
      dailyTradesLeft: Math.max(0, cfg.maxTradesPerDay - ctx.recentTrades.length),
      dailyLossLimitHit: dailyLoss(cfg, ctx.recentTrades, s).hit,
    },
    priceStep: {
      stepPct: cfg.sameSideStepPct, lastSide: last?.side ?? null, lastPrice: last?.price ?? null,
      pctToNextSell: pctTo(sellStep.next, sellPx), pctToNextBuy: pctTo(buyStep.next, buyPx),
    },
    tradeValueByBucket: { buy, sell },
  };
}

export type NoActionReason = 'cooldown' | 'max_trades_per_day' | 'daily_loss_limit' | 'no_trade_allowed';

/** Why no trade could be approved right now regardless of the decision (null = asking the engine is worthwhile). */
export function noActionReason(now: NowState): NoActionReason | null {
  if (now.blocked.cooldownSecLeft > 0) return 'cooldown';
  if (now.blocked.dailyTradesLeft <= 0) return 'max_trades_per_day';
  if (now.blocked.dailyLossLimitHit && now.sellReason !== 'stop_loss_active') return 'daily_loss_limit';
  if (!now.sellAllowedNow && !now.buyAllowedNow) return 'no_trade_allowed';
  return null;
}
