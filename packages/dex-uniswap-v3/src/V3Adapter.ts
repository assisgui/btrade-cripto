import { encodeFunctionData, zeroAddress } from 'viem';
import type { Address, IDexAdapter, PoolInfo, Quote, SwapParams, SwapResult, Token } from '@btrade/core';
import { erc20Abi, type EvmChainAdapter } from '@btrade/chain-evm';
import { factoryAbi, poolAbi, quoterV2Abi, swapRouter02Abi } from './abi.js';

/** Config for any Uniswap-V3-style DEX (SwapRouter02-compatible router, QuoterV2). */
export interface V3DexConfig {
  name: string;
  factory: Address;
  router: Address;
  quoter: Address;
  feeTiers: number[];
}

export const V3_FEE_TIERS = {
  'uniswap-v3': [100, 500, 3000, 10000],
  'pancakeswap-v3': [100, 500, 2500, 10000],
} as const;

export interface V3Options {
  poolCacheTtlMs?: number;
}

/** SwapRouter02's ADDRESS_THIS sentinel: "send to the router itself". */
const ROUTER_SELF: Address = '0x0000000000000000000000000000000000000002';

export class V3Adapter implements IDexAdapter {
  readonly name: string;
  private readonly ttl: number;
  private readonly poolCache = new Map<string, { info: PoolInfo; at: number }>();

  constructor(
    private readonly chain: EvmChainAdapter,
    private readonly addrs: V3DexConfig,
    opts: V3Options = {},
  ) {
    this.name = addrs.name;
    this.ttl = opts.poolCacheTtlMs ?? 10 * 60_000;
  }

  private get pc() {
    return this.chain.publicClient;
  }

  async getPoolInfo(tokenA: Token, tokenB: Token): Promise<PoolInfo> {
    const key = [tokenA.address, tokenB.address].map((a) => a.toLowerCase()).sort().join(':');
    const hit = this.poolCache.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.info;

    const candidates = await Promise.all(
      this.addrs.feeTiers.map(async (fee) => {
        const pool = await this.pc.readContract({
          address: this.addrs.factory, abi: factoryAbi, functionName: 'getPool', args: [tokenA.address, tokenB.address, fee],
        });
        if (pool === zeroAddress) return null;
        const liquidity = await this.pc.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' });
        return { pool, fee, liquidity };
      }),
    );
    const best = candidates.filter((c): c is NonNullable<typeof c> => c !== null).sort((a, b) => (a.liquidity < b.liquidity ? 1 : -1))[0];
    if (!best) throw new Error(`No ${this.name} pool for ${tokenA.symbol}/${tokenB.symbol}`);

    const [token0, token1, slot0] = await Promise.all([
      this.pc.readContract({ address: best.pool, abi: poolAbi, functionName: 'token0' }),
      this.pc.readContract({ address: best.pool, abi: poolAbi, functionName: 'token1' }),
      this.pc.readContract({ address: best.pool, abi: poolAbi, functionName: 'slot0' }),
    ]);
    const info: PoolInfo = {
      address: best.pool, fee: best.fee, liquidity: best.liquidity, token0, token1, sqrtPriceX96: slot0[0], tick: slot0[1],
    };
    this.poolCache.set(key, { info, at: Date.now() });
    return info;
  }

  async quote(tokenIn: Token, tokenOut: Token, amountIn: bigint): Promise<Quote> {
    const pool = await this.getPoolInfo(tokenIn, tokenOut);
    const { result } = await this.pc.simulateContract({
      address: this.addrs.quoter,
      abi: quoterV2Abi,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }],
    });
    const [amountOut, sqrtAfter, , gasEstimate] = result;
    // price ∝ sqrtPrice^2; use ratio of before/after (spot, excludes fee) for impact.
    const ratio = Number(sqrtAfter) / Number(pool.sqrtPriceX96);
    const priceImpactBps = Math.abs(ratio * ratio - 1) * 10_000;
    return {
      amountIn,
      amountOut,
      priceImpactBps,
      fee: pool.fee,
      route: [{ pool: pool.address, fee: pool.fee, tokenIn: tokenIn.address, tokenOut: tokenOut.address }],
      gasEstimate,
    };
  }

  async swap(p: SwapParams): Promise<SwapResult> {
    const wallet = this.chain.walletClient;
    const me = this.chain.address;
    if (!wallet || !me) throw new Error('V3Adapter.swap requires a wallet (PRIVATE_KEY)');
    const pool = await this.getPoolInfo(p.tokenIn, p.tokenOut);
    const recipient = p.recipient ?? me;

    // ERC20 in: make sure the router may pull amountIn (exact approval).
    if (!p.tokenIn.native) {
      const allowance = await this.pc.readContract({
        address: p.tokenIn.address, abi: erc20Abi, functionName: 'allowance', args: [me, this.addrs.router],
      });
      if (allowance < p.amountIn) {
        const h = await wallet.writeContract({
          account: wallet.account!, chain: this.chain.chain,
          address: p.tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [this.addrs.router, p.amountIn],
        });
        await this.pc.waitForTransactionReceipt({ hash: h });
      }
    }

    const outNative = p.tokenOut.native;
    const single = {
      tokenIn: p.tokenIn.address, tokenOut: p.tokenOut.address, fee: pool.fee,
      recipient: outNative ? ROUTER_SELF : recipient,
      amountIn: p.amountIn, amountOutMinimum: outNative ? 0n : p.amountOutMin, sqrtPriceLimitX96: 0n,
    };
    const value = p.tokenIn.native ? p.amountIn : 0n;

    const balBefore = await this.chain.getTokenBalance(p.tokenOut, me);
    let hash: `0x${string}`;
    if (outNative) {
      const data = [
        encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [single] }),
        encodeFunctionData({ abi: swapRouter02Abi, functionName: 'unwrapWETH9', args: [p.amountOutMin, recipient] }),
      ];
      const { request } = await this.pc.simulateContract({
        account: wallet.account!, address: this.addrs.router, abi: swapRouter02Abi, functionName: 'multicall', args: [data], value,
      });
      hash = await wallet.writeContract(request);
    } else {
      const { request } = await this.pc.simulateContract({
        account: wallet.account!, address: this.addrs.router, abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [single], value,
      });
      hash = await wallet.writeContract(request);
    }
    const receipt = await this.pc.waitForTransactionReceipt({ hash });
    const success = receipt.status === 'success';
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    const balAfter = await this.chain.getTokenBalance(p.tokenOut, me);
    // native gas is paid from the native balance: add it back when tokenOut (or tokenIn) is native.
    const amountOut = success ? balAfter - balBefore + (outNative ? gasCost : 0n) : 0n;
    return { success, txHash: hash, amountIn: p.amountIn, amountOut, paper: false, gasUsed: receipt.gasUsed };
  }
}
