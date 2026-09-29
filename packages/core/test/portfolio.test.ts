import { describe, expect, it } from 'vitest';
import { deriveQuoteUsd, portfolioMetrics, usdValuation } from '../src/index.js';

describe('portfolio math', () => {
  it('derives cbBTC/USD from MON/USD and mid price', () => {
    // 1 MON = 0.03 USD = 3e-7 cbBTC  => cbBTC = 100000 USD
    expect(deriveQuoteUsd(0.03, 3e-7)).toBeCloseTo(100000);
    expect(deriveQuoteUsd(0.03, 0)).toBeNull();
    expect(deriveQuoteUsd(0, 1)).toBeNull();
  });
  it('usd valuation', () => {
    expect(usdValuation(1000, 0.001, 0.03, 100000).portfolioUsd).toBeCloseTo(130);
  });
  it('hodl + pnl', () => {
    const init = { ts: 0, base: 1000, quote: 0.001, price: 3e-7, baseUsd: 0.03, quoteUsd: 100000 };
    // price +10%, bot swapped 500 MON -> cbBTC at start price (no fees)
    const m = portfolioMetrics(init, 500, 0.001 + 500 * 3e-7, 3.3e-7, 0.033, 100000);
    expect(m.startValueQuote).toBeCloseTo(0.0013);
    expect(m.hodlValueQuote).toBeCloseTo(1000 * 3.3e-7 + 0.001);
    expect(m.valueQuote).toBeCloseTo(500 * 3.3e-7 + 0.00115);
    expect(m.vsHodlQuotePct).toBeCloseTo((m.valueQuote / m.hodlValueQuote - 1) * 100);
    expect(m.pnlQuotePct).toBeCloseTo((m.valueQuote / 0.0013 - 1) * 100);
    expect(m.pnlUsdPct).not.toBeNull();
    expect(portfolioMetrics(init, 1, 1, 1, null, null).pnlUsdPct).toBeNull();
  });
});
