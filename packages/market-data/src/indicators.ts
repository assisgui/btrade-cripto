import type { Candle, Indicators } from '@btrade/core';

export function ema(values: number[], period: number): number | null {
  if (values.length < period || period < 1) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period; // seed with SMA
  for (let i = period; i < values.length; i++) e = (values[i] as number) * k + e * (1 - k);
  return e;
}

/** Wilder's RSI. Needs period+1 values. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (values[i] as number) - (values[i - 1] as number);
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = (values[i] as number) - (values[i - 1] as number);
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Sample stdev of simple per-candle returns. */
export function volatility(closes: number[]): number | null {
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] as number) / (closes[i - 1] as number) - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v);
}

/** Return of `price` vs the open of the candle at (now - windowSec). Null if history doesn't reach back. */
export function returnOver(candles: Candle[], price: number, nowSec: number, windowSec: number): number | null {
  if (candles.length === 0) return null;
  const target = nowSec - windowSec;
  const first = candles[0] as Candle;
  if (first.ts > target + (candles[1] ? (candles[1].ts - first.ts) : 0)) return null;
  let best = first;
  for (const c of candles) if (Math.abs(c.ts - target) < Math.abs(best.ts - target)) best = c;
  return best.open > 0 ? price / best.open - 1 : null;
}

export interface IndicatorInput {
  /** ascending, short candles (e.g. 5m) */
  shortCandles: Candle[];
  /** ascending, hourly candles */
  hourCandles: Candle[];
  price: number;
  nowSec: number;
  emaShort?: number;
  emaLong?: number;
}

export function computeIndicators(i: IndicatorInput): Indicators {
  const closes = i.shortCandles.map((c) => c.close);
  const hourCloses = i.hourCandles.map((c) => c.close);
  return {
    return5m: returnOver(i.shortCandles, i.price, i.nowSec, 300),
    return1h: returnOver(i.shortCandles, i.price, i.nowSec, 3600),
    return24h: returnOver(i.hourCandles, i.price, i.nowSec, 86400),
    volatility: volatility(closes),
    emaShort: ema(closes, i.emaShort ?? 9),
    emaLong: ema(closes, i.emaLong ?? 21),
    rsi14: rsi(closes.length >= 15 ? closes : hourCloses, 14),
  };
}
