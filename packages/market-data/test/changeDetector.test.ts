import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@btrade/core';
import { ChangeDetector } from '../src/index.js';

const snap = (price: number, base: bigint, quote: bigint) => ({ price, balances: { base, quote, native: base } }) as unknown as MarketSnapshot;

describe('ChangeDetector', () => {
  it("does not re-trigger on the bot's own trade, but still on external balance changes", () => {
    const d = new ChangeDetector({ thresholdBps: 50, heartbeatSec: 3600, now: () => 0 });
    const s0 = snap(1, 100n, 0n);
    expect(d.check(s0).reason).toBe('first');
    d.markSent(s0);
    d.acknowledgeOwnTrade();
    expect(d.check(snap(1, 90n, 10n))).toEqual({ send: false, reason: 'unchanged' }); // own sell
    expect(d.check(snap(1, 90n, 17n))).toEqual({ send: true, reason: 'balances' }); // deposit afterwards
  });
});
