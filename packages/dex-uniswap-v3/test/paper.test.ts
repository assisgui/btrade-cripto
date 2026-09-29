import { describe, expect, it } from 'vitest';
import type { IDexAdapter, Token } from '@btrade/core';
import { PaperDexAdapter } from '../src/index.js';

const a: Token = { symbol: 'A', address: '0x00000000000000000000000000000000000000a1', decimals: 18, native: false };
const b: Token = { symbol: 'B', address: '0x00000000000000000000000000000000000000b2', decimals: 6, native: false };
const inner: IDexAdapter = {
  name: 'fake',
  quote: async (_i, _o, n) => ({ amountIn: n, amountOut: n / 1000n, priceImpactBps: 0, fee: 3000, route: [] }),
  swap: async () => { throw new Error('must not be called'); },
  getPoolInfo: async () => { throw new Error('n/a'); },
};
const mem = () => { const m = new Map<string, bigint>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: bigint) => void m.set(k, v) }; };

describe('PaperDexAdapter', () => {
  it('moves paper balances, never calls inner.swap', async () => {
    const bal = mem();
    bal.set(a.address.toLowerCase(), 5000n);
    const dex = new PaperDexAdapter(inner, bal);
    const r = await dex.swap({ tokenIn: a, tokenOut: b, amountIn: 2000n, amountOutMin: 1n });
    expect(r).toMatchObject({ success: true, paper: true, amountOut: 2n, txHash: null });
    expect(bal.get(a.address.toLowerCase())).toBe(3000n);
    expect(bal.get(b.address.toLowerCase())).toBe(2n);
  });
  it('fails on insufficient balance or slippage', async () => {
    const bal = mem();
    bal.set(a.address.toLowerCase(), 100n);
    const dex = new PaperDexAdapter(inner, bal);
    expect((await dex.swap({ tokenIn: a, tokenOut: b, amountIn: 2000n, amountOutMin: 1n })).success).toBe(false);
    bal.set(a.address.toLowerCase(), 5000n);
    expect((await dex.swap({ tokenIn: a, tokenOut: b, amountIn: 2000n, amountOutMin: 999n })).success).toBe(false);
  });
});
