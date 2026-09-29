import { formatUnits, parseEther } from 'viem';
import { toUnits, type Token } from '@btrade/core';
import { EvmChainAdapter, getChainConfig } from '@btrade/chain-evm';
import { V3Adapter, V3_FEE_TIERS } from '@btrade/dex-uniswap-v3';
import { botKey, forkRpc } from './forkCommon.js';

const dexName = (process.env.DEX ?? 'pancakeswap-v3') as keyof typeof V3_FEE_TIERS;
const cfg = getChainConfig('monad', 'mainnet');
cfg.rpcUrl = forkRpc();
const chain = new EvmChainAdapter(cfg, { privateKey: botKey() });
const me = chain.address!;
const a = cfg.dexes[dexName];
if (!a) throw new Error(`unknown DEX ${dexName}`);
const dex = new V3Adapter(chain, { name: dexName, factory: a.factory!, router: a.swapRouter!, quoter: a.quoter!, feeTiers: [...V3_FEE_TIERS[dexName]] });

const mon: Token = { symbol: 'MON', address: cfg.wrappedNative!.address, decimals: 18, native: true };
const t = cfg.tokens.cbBTC!;
const btc: Token = { symbol: 'cbBTC', address: t.address, decimals: t.decimals, native: false };
const bal = async (label: string) => {
  const [m, b] = await Promise.all([chain.getNativeBalance(), chain.getTokenBalance(btc)]);
  console.log(`${label}: ${formatUnits(m, 18)} MON | ${formatUnits(b, 8)} cbBTC`);
  return b;
};
const slip = (x: bigint) => (x * 9900n) / 10_000n; // 1% for the test

try {
  if ((await chain.publicClient.getChainId()) !== 143) throw new Error('not chain 143');
  await bal('before');
  const inMon = parseEther(process.env.E2E_MON ?? '50');
  const q1 = await dex.quote(mon, btc, inMon);
  console.log(`quote ${formatUnits(inMon, 18)} MON -> ${formatUnits(q1.amountOut, 8)} cbBTC (impact ${q1.priceImpactBps.toFixed(2)}bps)`);
  const s1 = await dex.swap({ tokenIn: mon, tokenOut: btc, amountIn: inMon, amountOutMin: slip(q1.amountOut) });
  console.log(`buy: success=${s1.success} tx=${s1.txHash} out=${formatUnits(s1.amountOut, 8)} cbBTC`);
  if (!s1.success || s1.amountOut <= 0n) throw new Error('buy failed');
  const got = await bal('after buy');

  const inBtc = s1.amountOut / 2n;
  const q2 = await dex.quote(btc, mon, inBtc);
  console.log(`quote ${formatUnits(inBtc, 8)} cbBTC -> ${formatUnits(q2.amountOut, 18)} MON`);
  const s2 = await dex.swap({ tokenIn: btc, tokenOut: mon, amountIn: inBtc, amountOutMin: slip(q2.amountOut) });
  console.log(`sell: success=${s2.success} tx=${s2.txHash} out=${formatUnits(s2.amountOut, 18)} MON`);
  if (!s2.success || s2.amountOut <= 0n) throw new Error('sell failed');
  const after = await bal('after sell');
  if (after >= got) throw new Error('cbBTC balance did not decrease after sell');
  console.log('E2E OK');
} catch (e) {
  console.error('E2E FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
}
