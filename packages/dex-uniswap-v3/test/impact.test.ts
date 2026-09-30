import { describe, expect, it } from 'vitest';
import type { Token } from '@btrade/core';
import { V3Adapter } from '../src/index.js';

const A: Token = { symbol: 'WMON', address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', decimals: 18, native: false };
const B: Token = { symbol: 'USDC', address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6, native: false };
const POOL = '0x00000000000000000000000000000000000000aa';

describe('V3Adapter.quote price impact', () => {
  it('uses a fresh slot0, so a market move after the pool was cached is not reported as impact', async () => {
    let spot = 1_000_000n; // sqrtPriceX96 (arbitrary units)
    const publicClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getPool') return POOL;
        if (functionName === 'liquidity') return 10n ** 18n;
        if (functionName === 'token0') return A.address;
        if (functionName === 'token1') return B.address;
        if (functionName === 'slot0') return [spot, 0, 0, 0, 0, 0, true];
        throw new Error(functionName);
      },
      // a tiny trade moves the price by 0.0001% from the *current* spot
      simulateContract: async () => ({ result: [1n, (spot * 1_000_001n) / 1_000_000n, 0, 100_000n] }),
    };
    const dex = new V3Adapter({ publicClient } as never, { name: 'pancakeswap-v3', factory: '0x01', router: '0x02', quoter: '0x03', feeTiers: [500] } as never);
    expect((await dex.quote(A, B, 1n)).priceImpactBps).toBeLessThan(0.1);
    spot = 1_006_000n; // market moved ~1.2% while the pool info stays cached
    expect((await dex.quote(A, B, 1n)).priceImpactBps).toBeLessThan(0.1);
  });
});
