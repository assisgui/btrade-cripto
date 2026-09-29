import type { ChainConfig } from '@btrade/core';
import { monadMainnet, monadTestnet } from './chains/monad.js';

/** Add a new chain: create chains/<name>.ts and register it here. */
const CHAINS: ChainConfig[] = [monadMainnet, monadTestnet];

export function getChainConfig(name: string, network: 'mainnet' | 'testnet'): ChainConfig {
  const c = CHAINS.find((x) => x.name === name && x.network === network);
  if (!c) throw new Error(`Unknown chain "${name}" (${network}). Known: ${CHAINS.map((x) => `${x.name}/${x.network}`).join(', ')}`);
  return structuredClone(c);
}
