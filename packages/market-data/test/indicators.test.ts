import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@btrade/core';
import { ChangeDetector, ema, returnOver, rsi, volatility } from '../src/index.js';

describe('indicators', () => {
  it('ema of constant series is constant', () => {
    expect(ema([5, 5, 5, 5, 5], 3)).toBeCloseTo(5);
    expect(ema([1, 2], 3)).toBeNull();
  });
  it('ema follows trend', () => {
    const v = Array.from({ length: 30 }, (_, i) => i);
    expect(ema(v, 5)!).toBeGreaterThan(ema(v, 20)!);
  });
  it('rsi extremes', () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => i + 1))).toBe(100);
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 - i))).toBe(0);
    expect(rsi([1, 2, 3])).toBeNull();
  });
  it('rsi known value (Wilder example)', () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(rsi(closes, 14)!).toBeCloseTo(70.46, 0);
  });
  it('volatility', () => {
    expect(volatility([1, 1, 1, 1])).toBe(0);
    expect(volatility([1, 1.1, 1, 1.1])!).toBeGreaterThan(0);
    expect(volatility([1, 2])).toBeNull();
  });
  it('returnOver picks candle near window start', () => {
    const c = Array.from({ length: 20 }, (_, i) => ({ ts: 1000 + i * 300, open: 100 + i, high: 0, low: 0, close: 0, volume: 0 }));
    const now = 1000 + 19 * 300 + 300;
    expect(returnOver(c, 130, now, 3600)!).toBeCloseTo(130 / 108 - 1); // candle at now-3600 -> i=8
    expect(returnOver(c, 130, now, 86400)).toBeNull(); // history too short
  });
});

describe('ChangeDetector', () => {
  const snap = (price: number, base = 1n): MarketSnapshot =>
    ({ price, balances: { native: 1n, base, quote: 1n } }) as unknown as MarketSnapshot;
  it('sends first, then only on change/heartbeat', () => {
    let t = 0;
    const d = new ChangeDetector({ thresholdBps: 15, heartbeatSec: 100, now: () => t });
    expect(d.check(snap(100)).reason).toBe('first');
    d.markSent(snap(100));
    expect(d.check(snap(100.1)).send).toBe(false);
    expect(d.check(snap(100.2)).reason).toBe('price');
    expect(d.check(snap(100, 2n)).reason).toBe('balances');
    t = 100_000;
    expect(d.check(snap(100)).reason).toBe('heartbeat');
  });
});
