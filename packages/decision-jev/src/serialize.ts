import type { MarketSnapshot } from '@btrade/core';
import { toNumber } from '@btrade/core';
import type { JsonValue } from '@typesafe-ai/sdk';
import type { RiskConstraintsForModel } from './constraints.js';

const r = (n: number | null, d = 6): number | null => (n === null || !Number.isFinite(n) ? null : Number(n.toPrecision(d)));

/** Compact, model-friendly state: snapshot + the constraints the risk layer will enforce. */
export function serializeState(s: MarketSnapshot, c: RiskConstraintsForModel): Record<string, JsonValue> {
  const { base, quote } = s.pair;
  const i = s.indicators;
  return {
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
      return5mPct: i.return5m === null ? null : r(i.return5m * 100, 4),
      return1hPct: i.return1h === null ? null : r(i.return1h * 100, 4),
      return24hPct: i.return24h === null ? null : r(i.return24h * 100, 4),
      volatilityPerCandle: r(i.volatility, 4),
      emaShort: r(i.emaShort, 8),
      emaLong: r(i.emaLong, 8),
      rsi14: r(i.rsi14, 4),
    },
    constraints: {
      minProfitPctToSell: c.minProfitPct,
      stopLossPct: c.stopLossPct,
      gasReserveNative: c.gasReserveNative,
      minConfidence: c.minConfidence,
      tradeSizePctOfAvailable: c.sizePct,
      note: 'Sells below the profit threshold (except stop-loss) will be vetoed. Native gas reserve is untouchable.',
    },
  };
}
