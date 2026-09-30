import { describe, expect, it } from 'vitest';
import type { BotEvent, MarketSnapshot, Token } from '@btrade/core';
import { toUnits } from '@btrade/core';
import { SqliteStorage } from '@btrade/storage';
import { FlowTracker } from '../src/FlowTracker.js';

const base: Token = { symbol: 'MON', address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', decimals: 18, native: true };
const quote: Token = { symbol: 'USDC', address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6, native: false };
const price = 0.02;
const snap = (b: number, q: number, ts = 1_800_000_000_000): MarketSnapshot => ({
  timestamp: ts, pair: { base, quote }, price, priceBuy: price, priceSell: price, poolLiquidity: 1n, usd: { monUsd: 0.02, quoteUsd: 1, portfolioUsd: 0 },
  priceImpactBps: { buy: 1, sell: 1 }, gasPrice: 1n, estGasCostNative: 1n,
  balances: { native: toUnits(b, 18), base: toUnits(b, 18), quote: toUnits(q, 6) },
  position: null, unrealizedPnlPct: null, secondsSinceLastTrade: null, lastDecision: null, indicators: null,
});
const mk = () => {
  const storage = new SqliteStorage(':memory:');
  const events: BotEvent[] = [];
  const t = new FlowTracker({
    pair: { base, quote }, mode: 'live', storage, notifier: { notify: async (e) => { events.push(e); } },
    balances: { getBalance: async () => 0n, getNativeBalance: async () => 0n }, log: { info() {}, warn() {} } as never, nativeTolerance: 0.5,
  });
  return { storage, events, t };
};

describe('FlowTracker', () => {
  it('records a quote deposit, notifies, and does not repeat it', async () => {
    const { storage, events, t } = mk();
    await t.check(snap(100, 0)); // no hodl_init, no last -> baseline only
    expect((await t.check(snap(100, 7))).length).toBe(1);
    expect(storage.flows.all()[0]).toMatchObject({ asset: 'quote', amount: 7, valueQuote: 7, valueUsd: 7 });
    expect(events.map((e) => e.type)).toEqual(['flow']);
    expect(await t.check(snap(100, 7))).toEqual([]);
  });
  it('records a withdrawal and a base deposit updates cost basis', async () => {
    const { storage, t } = mk();
    await t.check(snap(100, 10));
    await t.check(snap(100, 4));
    expect(storage.flows.all()[0]?.amount).toBeCloseTo(-6);
    storage.positions.save('MON/USDC', { size: toUnits(100, 18), avgEntryPrice: 0.01, realizedPnlQuote: 0, updatedAt: 0 });
    await t.check(snap(200, 4));
    const p = storage.positions.get('MON/USDC')!;
    expect(p.avgEntryPrice).toBeCloseTo(0.015);
    expect(p.size).toBe(toUnits(200, 18));
  });
  it('ignores gas-sized native drop', async () => {
    const { storage, t } = mk();
    await t.check(snap(100, 1));
    await t.check(snap(99.8, 1));
    expect(storage.flows.count()).toBe(0);
  });
  it('a trade recorded between ticks is not a flow, but a deposit alongside it is', async () => {
    const { storage, t } = mk();
    const t0 = 1_800_000_000_000;
    await t.check(snap(100, 0, t0));
    // sell 40 MON for 0.8 USDC right after the tick (trade ts in seconds, after the snapshot)
    storage.trades.insert({
      ts: t0 / 1000 + 5, side: 'sell', mode: 'live', tokenIn: base.address, tokenOut: quote.address, amountIn: toUnits(40, 18), amountOut: toUnits(0.8, 6),
      price: 0.02, realizedPnlQuote: 0, txHash: null, paper: false,
    });
    expect(await t.check(snap(59.95, 0.8, t0 + 10_000))).toEqual([]); // 0.05 MON gas
    // next tick: user deposits 3 USDC; the old trade is before last.ts and is not counted again
    const f = await t.check(snap(59.95, 3.8, t0 + 20_000));
    expect(f).toHaveLength(1);
    expect(f[0]?.amount).toBeCloseTo(3, 6);
  });
  it('retroactive bootstrap reproduces the real case (one USDC deposit, no MON flow)', async () => {
    const { storage, t } = mk();
    storage.state.set('hodl_init:live', JSON.stringify({ ts: 1, base: 605.63429, quote: 0, price, baseUsd: 0.02, quoteUsd: 1 }));
    const f = await t.check(snap(605.63429, 6.9993));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ asset: 'quote' });
    expect(f[0]?.amount).toBeCloseTo(6.9993, 6);
    // rerun does nothing
    expect(await t.check(snap(605.63429, 6.9993))).toEqual([]);
    expect(storage.flows.count()).toBe(1);
  });
  it('bootstrap accounts for trades and gas tolerance', async () => {
    const { storage, t } = mk();
    storage.state.set('hodl_init:live', JSON.stringify({ ts: 1, base: 100, quote: 0, price, baseUsd: null, quoteUsd: null }));
    storage.trades.insert({
      ts: 1, side: 'sell', mode: 'live', tokenIn: base.address, tokenOut: quote.address, amountIn: toUnits(40, 18), amountOut: toUnits(0.8, 6),
      price: 0.02, realizedPnlQuote: 0, txHash: null, paper: false,
    });
    expect(await t.check(snap(59.95, 0.8))).toEqual([]); // 0.05 MON gas
  });
});
