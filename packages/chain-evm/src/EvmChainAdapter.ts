import {
  createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, ChainConfig, IChainAdapter, Token } from '@btrade/core';
import { erc20Abi } from './abi.js';

export interface EvmChainAdapterOptions {
  privateKey?: `0x${string}`;
}

export class EvmChainAdapter implements IChainAdapter {
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | undefined;
  readonly address: Address | undefined;

  constructor(readonly config: ChainConfig, opts: EvmChainAdapterOptions = {}) {
    this.chain = defineChain({
      id: config.chainId,
      name: `${config.name}-${config.network}`,
      nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: config.nativeDecimals },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(config.rpcUrl) });
    if (opts.privateKey) {
      const account = privateKeyToAccount(opts.privateKey);
      this.address = account.address;
      this.walletClient = createWalletClient({ account, chain: this.chain, transport: http(config.rpcUrl) });
    }
  }

  private requireAddress(address?: Address): Address {
    const a = address ?? this.address;
    if (!a) throw new Error('No wallet address available (PRIVATE_KEY not set)');
    return a;
  }

  getNativeBalance(address?: Address): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.requireAddress(address) });
  }

  getTokenBalance(token: Token, address?: Address): Promise<bigint> {
    if (token.native) return this.getNativeBalance(address);
    return this.publicClient.readContract({
      address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [this.requireAddress(address)],
    });
  }

  getGasPrice(): Promise<bigint> {
    return this.publicClient.getGasPrice();
  }

  async estimateFee(gasUnits: bigint): Promise<bigint> {
    return gasUnits * (await this.getGasPrice());
  }

  async getTokenInfo(address: Address): Promise<Token> {
    const [decimals, symbol] = await Promise.all([
      this.publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
      this.publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    ]);
    return { address, decimals, symbol, native: false };
  }
}
