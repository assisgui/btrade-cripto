import type { DecisionContext, MarketSnapshot } from '@btrade/core';
import { toNumber } from '@btrade/core';
import type { JsonValue } from '@typesafe-ai/sdk';
import type { RiskConstraintsForModel } from './constraints.js';

const r = (n: number | null, d = 6): number | null => (n === null || !Number.isFinite(n) ? null : Number(n.toPrecision(d)));

/** Compact, model-friendly state: snapshot + the constraints the risk layer will enforce. */
const relPct = (a: number | null | undefined, b: number, d = 3): number | null =>
  a === null || a === undefined || !(a > 0) || !(b > 0) ? null : r((a / b - 1) * 100, d);

export function serializeState(s: MarketSnapshot, c: RiskConstraintsForModel, ctx: DecisionContext = {}): Record<string, JsonValue> {
  const { base, quote } = s.pair;
  const i = s.indicators;
  const baseBal = toNumber(s.balances.base, base.decimals);
  const quoteBal = toNumber(s.balances.quote, quote.decimals);
  const total = baseBal * s.price + quoteBal;
  return {
    objective: `Grow total portfolio value measured in ${quote.symbol} by buying ${base.symbol} low and selling ${base.symbol} high. Both buy and sell are equally valid; ${quote.symbol} is idle capital that should be redeployed into ${base.symbol} when ${base.symbol} is cheap.`,
    task: `Trading ${base.symbol} (base) against ${quote.symbol} (quote). buy = spend ${quote.symbol} to acquire ${base.symbol}; sell = sell ${base.symbol} for ${quote.symbol}. Price is ${quote.symbol} per ${base.symbol}.`,
    price: r(s.price, 8),
    buyPrice: r(s.priceBuy, 8),
    sellPrice: r(s.priceSell, 8),
    priceImpactBps: { buy: r(s.priceImpactBps.buy, 3), sell: r(s.priceImpactBps.sell, 3) },
    gasCostNative: r(toNumber(s.estGasCostNative, 18), 4),
    balances: {
      [base.symbol]: r(toNumber(s.balances.base, base.decimals), 8),
      [quote.symbol]: r(toNumber(s.balances.quote, quote.decimals), 8),
    },
    portfolio: {
      [`${base.symbol}PctOfValue`]: total > 0 ? r((baseBal * s.price / total) * 100, 4) : null,
      [`${quote.symbol}PctOfValue`]: total > 0 ? r((quoteBal / total) * 100, 4) : null,
      pnlPctVsInvested: r(ctx.pnlPctVsInvested ?? null, 4),
    },
    position: s.position
      ? {
          avgEntryPrice: r(s.position.avgEntryPrice, 8),
          unrealizedPnlPct: r(s.unrealizedPnlPct, 4),
        }
      : null,
    usd: s.usd ? { [`${base.symbol}Usd`]: r(s.usd.monUsd, 6), [`${quote.symbol}Usd`]: r(s.usd.quoteUsd, 6) } : null,
    secondsSinceLastTrade: s.secondsSinceLastTrade,
    lastDecision: s.lastDecision,
    indicators: i && {
      timeframe: 'EMA(9/21), RSI(14) and volatility use 5-minute candles',
      return5mPct: i.return5m === null ? null : r(i.return5m * 100, 4),
      return1hPct: i.return1h === null ? null : r(i.return1h * 100, 4),
      return24hPct: i.return24h === null ? null : r(i.return24h * 100, 4),
      volatilityPer5mCandle: r(i.volatility, 4),
      priceVsEmaShortPct: relPct(s.price, i.emaShort ?? 0),
      priceVsEmaLongPct: relPct(s.price, i.emaLong ?? 0),
      emaShortVsLongPct: relPct(i.emaShort, i.emaLong ?? 0),
      rsi14: r(i.rsi14, 4),
    },
    recentCloses: i?.recentCloses?.length && s.price > 0
      ? { unit: '% change of each past 5m close vs current price, oldest first', values: i.recentCloses.map((x) => r((x / s.price - 1) * 100, 2)) }
      : null,
    now: ctx.now ? (ctx.now as unknown as JsonValue) : null,
    buyOpportunity: (() => {
      const buyPx = s.priceBuy ?? s.price;
      const ls = ctx.now?.rebuy.lastSellPrice ?? null;
      return {
        lastSellPrice: r(ls, 8),
        pctBelowLastSell: ls && buyPx > 0 ? r((buyPx / ls - 1) * 100, 3) : null,
        rebuyTargetPrice: r(ctx.now?.rebuy.targetPrice ?? null, 8),
        pctToRebuyTarget: ctx.now?.rebuy.pctToRebuyTarget ?? null,
        buyAllowedNow: ctx.now?.buyAllowedNow ?? null,
        buyReason: ctx.now?.buyReason ?? null,
        quoteBalanceIdlePct: total > 0 ? r((quoteBal / total) * 100, 4) : null,
        meaning: `pctBelowLastSell < 0 means ${base.symbol} is now cheaper than where it was last sold; buying back there increases the ${base.symbol} held.`,
      } as unknown as JsonValue;
    })(),
    recentTrades: ctx.recentTrades?.length && s.price > 0
      ? ctx.recentTrades.map((t) => ({ side: t.side, price: r(t.price, 8), pctVsNow: r((t.price / s.price - 1) * 100, 3), minutesAgo: Math.round((Date.now() / 1000 - t.ts) / 60) }))
      : null,
    constraints: {
      minProfitPctToSell: c.minProfitPct,
      stopLossPct: c.stopLossPct,
      gasReserveNative: c.gasReserveNative,
      minConfidence: c.minConfidence,
      tradeSizePctOfAvailable: c.sizePct,
      note: 'A sell executes only at/above the profit target (or at/below the stop-loss). A buy executes only below the rebuy target (see buyOpportunity) and not into an overheated run-up. Native gas reserve is untouchable. See `now` for what is possible right now.',
    },
  };
}
