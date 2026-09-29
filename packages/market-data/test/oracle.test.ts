import { describe, expect, it } from 'vitest';
import type { IDexAdapter, Token } from '@btrade/core';
import { OnChainUsdOracle } from '../src/index.js';

const tok = (symbol: string, decimals: number): Token => ({ symbol, address: '0x01', decimals, native: false });
const mkDex = (out: bigint | Error, fee?: number) => ({ quote: async (_a: Token, _b: Token, amountIn: bigint) => {
  if (out instanceof Error) throw out;
  expect(amountIn).toBe(10n * 10n ** 18n);
  return { amountIn, amountOut: out, fee };
} }) as unknown as IDexAdapter;

describe('OnChainUsdOracle', () => {
  const mk = (out: bigint | Error, mid: number | null) => new OnChainUsdOracle({
    dex: mkDex(out), baseToken: tok('WMON', 18), usdToken: tok('USDC', 6), probeAmount: 10, midPrice: () => mid,
  });
  it('derives base and quote usd', async () => {
    const r = await mk(300_000n, 3e-7).getUsdPrices(); // 10 MON -> 0.3 USDC
    expect(r?.baseUsd).toBeCloseTo(0.03);
    expect(r?.quoteUsd).toBeCloseTo(100000);
  });
  it('grosses the net quote up by the pool fee', async () => {
    const o = new OnChainUsdOracle({
      dex: mkDex(299_100n, 3000), baseToken: tok('WMON', 18), usdToken: tok('USDC', 6), probeAmount: 10, midPrice: () => 0.03,
    });
    const r = await o.getUsdPrices(); // 10 MON -> 0.2991 USDC after 0.3% fee => mid 0.03
    expect(r?.baseUsd).toBeCloseTo(0.03, 8);
    expect(r?.quoteUsd).toBeCloseTo(1, 6);
  });
  it('returns null on failure or missing mid', async () => {
    expect(await mk(new Error('rpc'), 3e-7).getUsdPrices()).toBeNull();
    expect(await mk(300_000n, null).getUsdPrices()).toBeNull();
  });
});
