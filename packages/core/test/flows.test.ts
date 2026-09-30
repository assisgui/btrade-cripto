import { describe, expect, it } from 'vitest';
import { detectFlowDeltas, expectedBalances, investedQuote, investedUsd, makeFlow, portfolioMetrics, type Flow, type HodlInit } from '../src/index.js';

const opts = { baseNative: true, quoteNative: false, nativeTolerance: 0.5 };
const init: HodlInit = { ts: 0, base: 605.63429, quote: 0, price: 0.02, baseUsd: 0.02, quoteUsd: 1 };

describe('flow detection', () => {
  it('detects quote deposit and withdrawal', () => {
    expect(detectFlowDeltas({ base: 10, quote: 0 }, { base: 10, quote: 7 }, opts)).toEqual([{ asset: 'quote', amount: 7 }]);
    expect(detectFlowDeltas({ base: 10, quote: 7 }, { base: 10, quote: 2 }, opts)).toEqual([{ asset: 'quote', amount: -5 }]);
  });
  it('ignores native gas spend within tolerance, flags larger drops and any rise', () => {
    expect(detectFlowDeltas({ base: 10, quote: 1 }, { base: 9.7, quote: 1 }, opts)).toEqual([]);
    expect(detectFlowDeltas({ base: 10, quote: 1 }, { base: 5, quote: 1 }, opts)).toEqual([{ asset: 'base', amount: -5 }]);
    expect(detectFlowDeltas({ base: 10, quote: 1 }, { base: 12, quote: 1 }, opts)).toEqual([{ asset: 'base', amount: 2 }]);
    expect(detectFlowDeltas({ base: 10, quote: 1 }, { base: 10, quote: 1 + 1e-7 }, opts)).toEqual([]);
  });
  it('trade-adjusted expected balances', () => {
    const e = expectedBalances({ base: 100, quote: 0 }, [
      { side: 'sell', amountIn: 10n * 10n ** 18n, amountOut: 5_000_000n },
      { side: 'buy', amountIn: 2_000_000n, amountOut: 4n * 10n ** 18n },
    ], 18, 6);
    expect(e.base).toBeCloseTo(94);
    expect(e.quote).toBeCloseTo(3);
  });
});

describe('metrics with flows', () => {
  it('a deposit is not profit; HODL includes it', () => {
    const f: Flow = makeFlow({ asset: 'quote', amount: 7 }, 1, 0.02, 0.02, 1);
    const price = 0.02;
    const m = portfolioMetrics(init, 605.63429, 7, price, 0.02, 1, [f]);
    expect(m.pnlQuotePct).toBeCloseTo(0, 6);
    expect(m.investedQuote).toBeCloseTo(605.63429 * 0.02 + 7);
    expect(m.hodlValueQuote).toBeCloseTo(m.valueQuote);
    expect(m.vsHodlQuotePct).toBeCloseTo(0, 6);
    expect(m.investedUsd).toBeCloseTo(605.63429 * 0.02 + 7);
    expect(m.pnlUsdPct).toBeCloseTo(0, 6);
    // without flows the deposit shows as profit
    expect(portfolioMetrics(init, 605.63429, 7, price, 0.02, 1).pnlQuotePct).toBeGreaterThan(50);
  });
  it('usd fallback via quoteUsd and null when unknown', () => {
    const f: Flow = { ts: 1, asset: 'quote', amount: 5, price: 0.02, valueQuote: 5, valueUsd: null };
    expect(investedUsd(init, [f], 1)).toBeCloseTo(605.63429 * 0.02 + 5);
    expect(investedUsd(init, [f], null)).toBeNull();
    expect(investedQuote(init, [f])).toBeCloseTo(605.63429 * 0.02 + 5);
  });
  it('base withdrawal reduces invested', () => {
    const f = makeFlow({ asset: 'base', amount: -100 }, 1, 0.02, 0.02, 1);
    expect(f.valueQuote).toBeCloseTo(-2);
    expect(f.valueUsd).toBeCloseTo(-2);
  });
});
