import type { Flow, Trade, UsdValuation } from './types.js';
import { toNumber } from './math.js';

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
  /** start value + net external flows (QUOTE) */
  investedQuote: number;
  investedUsd: number | null;
}

const pct = (a: number, b: number): number => (b > 0 ? (a / b - 1) * 100 : 0);

/** QUOTE/USD derived from BASE/USD and the mid price (QUOTE per BASE). */
export const deriveQuoteUsd = (baseUsd: number, midPrice: number): number | null =>
  baseUsd > 0 && midPrice > 0 ? baseUsd / midPrice : null;

export const valueInQuote = (base: number, quote: number, price: number): number => base * price + quote;

export function usdValuation(base: number, quote: number, baseUsd: number, quoteUsd: number): UsdValuation {
  return { monUsd: baseUsd, quoteUsd: quoteUsd, portfolioUsd: base * baseUsd + quote * quoteUsd };
}

/** HODL balances including external deposits/withdrawals from their arrival. */
export function hodlBalances(init: HodlInit, flows: Flow[] = []): { base: number; quote: number } {
  let base = init.base;
  let quote = init.quote;
  for (const f of flows) {
    if (f.asset === 'base') base += f.amount;
    else quote += f.amount;
  }
  return { base, quote };
}

/** Invested capital in QUOTE: start value (at hodl_init price) + net flows. */
export function investedQuote(init: HodlInit, flows: Flow[] = []): number {
  return valueInQuote(init.base, init.quote, init.price) + flows.reduce((a, f) => a + f.valueQuote, 0);
}

/** Invested capital in USD (flow USD value, else valueQuote * quoteUsd); null when anything is unknown. */
export function investedUsd(init: HodlInit, flows: Flow[] = [], quoteUsd: number | null = null): number | null {
  if (init.baseUsd === null || init.quoteUsd === null) return null;
  let total = init.base * init.baseUsd + init.quote * init.quoteUsd;
  for (const f of flows) {
    const v = f.valueUsd ?? (quoteUsd !== null ? f.valueQuote * quoteUsd : null);
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** (current - invested) / invested, in %. */
export const pnlVsInvestedPct = (current: number, invested: number): number => pct(current, invested);

/** Portfolio value and performance vs invested capital and vs a buy-and-hold of initial balances (+ flows). */
export function portfolioMetrics(
  init: HodlInit, base: number, quote: number, price: number, baseUsd: number | null, quoteUsd: number | null, flows: Flow[] = [],
): PortfolioMetrics {
  const valueQuote = valueInQuote(base, quote, price);
  const hasUsd = baseUsd !== null && quoteUsd !== null;
  const valueUsd = hasUsd ? base * baseUsd + quote * quoteUsd : null;
  const h = hodlBalances(init, flows);
  const hodlValueQuote = valueInQuote(h.base, h.quote, price);
  const hodlValueUsd = hasUsd ? h.base * baseUsd + h.quote * quoteUsd : null;
  const startValueQuote = valueInQuote(init.base, init.quote, init.price);
  const startValueUsd = init.baseUsd !== null && init.quoteUsd !== null ? init.base * init.baseUsd + init.quote * init.quoteUsd : null;
  const invQ = investedQuote(init, flows);
  const invUsd = investedUsd(init, flows, quoteUsd);
  return {
    valueQuote, valueUsd, hodlValueQuote, hodlValueUsd, startValueQuote, startValueUsd,
    pnlQuotePct: pct(valueQuote, invQ),
    pnlUsdPct: valueUsd !== null && invUsd !== null ? pct(valueUsd, invUsd) : null,
    vsHodlQuotePct: pct(valueQuote, hodlValueQuote),
    investedQuote: invQ,
    investedUsd: invUsd,
  };
}

// ---- external flow detection (pure) ----

export interface Balances { base: number; quote: number }
export interface FlowDelta { asset: 'base' | 'quote'; amount: number }

export const QUOTE_DUST = 1e-6;

/**
 * Deltas that are external flows. A negative delta on a native asset down to -nativeTolerance is gas
 * spend (ignored); tiny quote deltas are ignored.
 */
export function detectFlowDeltas(
  last: Balances, current: Balances, opts: { baseNative: boolean; quoteNative: boolean; nativeTolerance: number; extraNativeTolerance?: number },
): FlowDelta[] {
  const tol = opts.nativeTolerance + (opts.extraNativeTolerance ?? 0);
  const out: FlowDelta[] = [];
  const check = (asset: 'base' | 'quote', d: number, native: boolean) => {
    if (Math.abs(d) < QUOTE_DUST) return;
    if (native && d < 0 && d >= -tol) return;
    out.push({ asset, amount: d });
  };
  check('base', current.base - last.base, opts.baseNative);
  check('quote', current.quote - last.quote, opts.quoteNative);
  return out;
}

/** Expected balances = start balances + net effect of trades (raw amounts converted by decimals). */
export function expectedBalances(
  init: { base: number; quote: number }, trades: Pick<Trade, 'side' | 'amountIn' | 'amountOut'>[], baseDecimals: number, quoteDecimals: number,
): Balances {
  let base = init.base;
  let quote = init.quote;
  for (const t of trades) {
    if (t.side === 'buy') {
      quote -= toNumber(t.amountIn, quoteDecimals);
      base += toNumber(t.amountOut, baseDecimals);
    } else {
      base -= toNumber(t.amountIn, baseDecimals);
      quote += toNumber(t.amountOut, quoteDecimals);
    }
  }
  return { base, quote };
}

/** Build a Flow record at the given price/USD quotes. */
export function makeFlow(d: FlowDelta, ts: number, price: number, baseUsd: number | null, quoteUsd: number | null): Flow {
  const valueQuote = d.asset === 'base' ? d.amount * price : d.amount;
  const usd = d.asset === 'base' ? baseUsd : quoteUsd;
  return { ts, asset: d.asset, amount: d.amount, price, valueQuote, valueUsd: usd === null ? null : d.amount * usd };
}
