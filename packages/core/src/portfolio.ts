import type { UsdValuation } from './types.js';

export interface HodlInit {
  ts: number;
  /** whole units */
  base: number;
  quote: number;
  /** QUOTE per BASE at start */
  price: number;
  baseUsd: number | null;
  quoteUsd: number | null;
}

export interface PortfolioMetrics {
  valueQuote: number;
  valueUsd: number | null;
  hodlValueQuote: number;
  hodlValueUsd: number | null;
  startValueQuote: number;
  startValueUsd: number | null;
  pnlQuotePct: number;
  pnlUsdPct: number | null;
  vsHodlQuotePct: number;
}

const pct = (a: number, b: number): number => (b > 0 ? (a / b - 1) * 100 : 0);

/** cbBTC/USD derived from BASE/USD and the mid price (QUOTE per BASE). */
export const deriveQuoteUsd = (baseUsd: number, midPrice: number): number | null =>
  baseUsd > 0 && midPrice > 0 ? baseUsd / midPrice : null;

export const valueInQuote = (base: number, quote: number, price: number): number => base * price + quote;

export function usdValuation(base: number, quote: number, baseUsd: number, quoteUsd: number): UsdValuation {
  return { monUsd: baseUsd, cbBtcUsd: quoteUsd, portfolioUsd: base * baseUsd + quote * quoteUsd };
}

/** Portfolio value and performance vs start and vs a buy-and-hold of the initial balances. */
export function portfolioMetrics(init: HodlInit, base: number, quote: number, price: number, baseUsd: number | null, quoteUsd: number | null): PortfolioMetrics {
  const valueQuote = valueInQuote(base, quote, price);
  const hasUsd = baseUsd !== null && quoteUsd !== null;
  const valueUsd = hasUsd ? base * baseUsd + quote * quoteUsd : null;
  const hodlValueQuote = valueInQuote(init.base, init.quote, price);
  const hodlValueUsd = hasUsd ? init.base * baseUsd + init.quote * quoteUsd : null;
  const startValueQuote = valueInQuote(init.base, init.quote, init.price);
  const startValueUsd = init.baseUsd !== null && init.quoteUsd !== null ? init.base * init.baseUsd + init.quote * init.quoteUsd : null;
  return {
    valueQuote, valueUsd, hodlValueQuote, hodlValueUsd, startValueQuote, startValueUsd,
    pnlQuotePct: pct(valueQuote, startValueQuote),
    pnlUsdPct: valueUsd !== null && startValueUsd !== null ? pct(valueUsd, startValueUsd) : null,
    vsHodlQuotePct: pct(valueQuote, hodlValueQuote),
  };
}
