import type { MarketSnapshot } from '@btrade/core';

export interface ChangeDetectorOptions {
  thresholdBps: number;
  heartbeatSec: number;
  now?: () => number;
}

export interface ChangeResult {
  send: boolean;
  reason: 'first' | 'price' | 'balances' | 'heartbeat' | 'unchanged';
}

/** Only forward to the decision engine when data is meaningfully new. */
export class ChangeDetector {
  private last: { price: number; base: bigint; quote: bigint; native: bigint; at: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly o: ChangeDetectorOptions) {
    this.now = o.now ?? Date.now;
  }

  check(s: MarketSnapshot): ChangeResult {
    const l = this.last;
    if (!l) return { send: true, reason: 'first' };
    const moveBps = Math.abs(s.price / l.price - 1) * 10_000;
    if (moveBps > this.o.thresholdBps) return { send: true, reason: 'price' };
    if (s.balances.base !== l.base || s.balances.quote !== l.quote || s.balances.native !== l.native) {
      return { send: true, reason: 'balances' };
    }
    if (this.now() - l.at >= this.o.heartbeatSec * 1000) return { send: true, reason: 'heartbeat' };
    return { send: false, reason: 'unchanged' };
  }

  markSent(s: MarketSnapshot): void {
    this.last = { price: s.price, base: s.balances.base, quote: s.balances.quote, native: s.balances.native, at: this.now() };
  }
}
