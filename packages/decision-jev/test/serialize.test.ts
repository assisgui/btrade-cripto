import { describe, expect, it } from 'vitest';
import type { MarketSnapshot, NowState, Token } from '@btrade/core';
import { serializeState } from '../src/serialize.js';

const base: Token = { symbol: 'MON', address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', decimals: 18, native: true };
const quote: Token = { symbol: 'USDC', address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6, native: false };
const E18 = 10n ** 18n;

const snap: MarketSnapshot = {
  timestamp: 1_800_000_000_000, pair: { base, quote }, price: 0.02, priceBuy: 0.0201, priceSell: 0.0199, poolLiquidity: 1n, usd: { monUsd: 0.02, quoteUsd: 1, portfolioUsd: 13 },
  priceImpactBps: { buy: 2, sell: 3 }, gasPrice: 1n, estGasCostNative: 2n * E18 / 100n,
  balances: { native: 600n * E18, base: 600n * E18, quote: 7_000_000n },
  position: { size: 590n * E18, avgEntryPrice: 0.0195, realizedPnlQuote: 0, updatedAt: 0 }, unrealizedPnlPct: 2.5641, secondsSinceLastTrade: 4000,
  lastDecision: { action: 'hold', confidence: 0.7, at: 1_799_999_000_000 },
  indicators: {
    return5m: 0.001, return1h: -0.004, return24h: 0.02, volatility: 0.0021, emaShort: 0.0199, emaLong: 0.0197, rsi14: 55,
    recentCloses: [0.0196, 0.0197, 0.0198, 0.0197, 0.0199, 0.02, 0.0201, 0.02, 0.0199, 0.0198, 0.0199, 0.02],
  },
};
const now: NowState = {
  sellAllowedNow: false, sellReason: 'below_profit_target', buyAllowedNow: true, buyReason: 'ok', pctToProfitTarget: 1.234, pctToStopLoss: -12.1,
  blocked: { cooldownSecLeft: 0, dailyTradesLeft: 6, dailyLossLimitHit: false },
  rebuy: { discountPct: 0.5, lastSellPrice: 0.0201, targetPrice: 0.0199995, pctToRebuyTarget: -0.4 },
  priceStep: { stepPct: 0.5, lastSide: 'sell', lastPrice: 0.0201, pctToNextSell: 1.5, pctToNextBuy: null },
  tradeValueByBucket: {
    buy: { small: { value: 0.35, belowMin: true }, medium: { value: 0.7, belowMin: false }, large: { value: 1.4, belowMin: false } },
    sell: { small: { value: 1.2, belowMin: false }, medium: { value: 3, belowMin: false }, large: { value: 6, belowMin: false } },
  },
};
const constraints = { minProfitPct: 1, stopLossPct: 3, gasReserveNative: 10.5, minConfidence: 0.6, sizePct: { small: 5, medium: 10, large: 20 } };

describe('serializeState', () => {
  it('matches the expected structure', () => {
    expect(serializeState(snap, constraints, { now, pnlPctVsInvested: 1.5 })).toMatchSnapshot();
  });
  it('has objective, relative indicators, recentCloses, portfolio and now', () => {
    const s = serializeState(snap, constraints, { now, pnlPctVsInvested: 1.5 }) as Record<string, any>;
    expect(s.objective).toContain('Maximize total portfolio value measured in USDC');
    expect(s.indicators.priceVsEmaShortPct).toBeCloseTo(0.5025, 2);
    expect(s.indicators.volatilityPer5mCandle).toBe(0.0021);
    expect(s.recentCloses.values).toHaveLength(12);
    expect(s.portfolio.pnlPctVsInvested).toBe(1.5);
    expect(s.now.sellReason).toBe('below_profit_target');
    expect(s.constraints.note).toContain('never forces a sell');
  });
});
