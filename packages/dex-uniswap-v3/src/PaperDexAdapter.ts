import type { IDexAdapter, IPaperBalanceRepository, PoolInfo, Quote, SwapParams, SwapResult, Token } from '@btrade/core';
import { balanceKey } from '@btrade/core';

export interface PaperDexOptions {
  /** simulated gas cost per swap (native wei) deducted from paper native balance */
  simulatedGasCost?: () => Promise<bigint>;
}

/** Decorator: real quotes from the wrapped adapter, fills simulated against paper balances. Never sends txs. */
export class PaperDexAdapter implements IDexAdapter {
  readonly name: string;

  constructor(
    private readonly inner: IDexAdapter,
    private readonly balances: IPaperBalanceRepository,
    private readonly opts: PaperDexOptions = {},
  ) {
    this.name = `paper(${inner.name})`;
  }

  quote(tokenIn: Token, tokenOut: Token, amountIn: bigint): Promise<Quote> {
    return this.inner.quote(tokenIn, tokenOut, amountIn);
  }

  getPoolInfo(a: Token, b: Token): Promise<PoolInfo> {
    return this.inner.getPoolInfo(a, b);
  }

  async swap(p: SwapParams): Promise<SwapResult> {
    const kIn = balanceKey(p.tokenIn);
    const kOut = balanceKey(p.tokenOut);
    const gas = (await this.opts.simulatedGasCost?.()) ?? 0n;
    const haveIn = this.balances.get(kIn) ?? 0n;
    const fail = (): SwapResult => ({ success: false, txHash: null, amountIn: p.amountIn, amountOut: 0n, paper: true });
    if (haveIn < p.amountIn) return fail();
    const q = await this.inner.quote(p.tokenIn, p.tokenOut, p.amountIn);
    if (q.amountOut < p.amountOutMin) return fail();

    this.balances.set(kIn, haveIn - p.amountIn);
    this.balances.set(kOut, (this.balances.get(kOut) ?? 0n) + q.amountOut);
    if (gas > 0n) {
      const nat = this.balances.get('native') ?? 0n;
      this.balances.set('native', nat > gas ? nat - gas : 0n);
    }
    return { success: true, txHash: null, amountIn: p.amountIn, amountOut: q.amountOut, paper: true };
  }
}
