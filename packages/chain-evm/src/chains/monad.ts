import type { ChainConfig } from '@btrade/core';

export const monadMainnet: ChainConfig = {
  name: 'monad',
  network: 'mainnet',
  chainId: 143,
  rpcUrl: 'https://rpc.monad.xyz',
  nativeSymbol: 'MON',
  nativeDecimals: 18,
  explorerUrl: 'https://monadvision.com',
  wrappedNative: { symbol: 'WMON', address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', decimals: 18 },
  tokens: {
    WMON: { address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', decimals: 18 },
    WBTC: { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8 },
    cbBTC: { address: '0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b', decimals: 8 },
    USDC: { address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6 },
  },
  dexes: {
    'uniswap-v3': {
      factory: '0x204faca1764b154221e35c0d20abb3c525710498',
      swapRouter: '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900',
      quoter: '0x661e93cca42afacb172121ef892830ca3b70f08d',
    },
    'pancakeswap-v3': {
      factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
      swapRouter: '0x21114915Ac6d5A2e156931e20B20b038dEd0Be7C',
      quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    },
  },
  geckoNetwork: 'monad',
};

/**
 * UNVERIFIED: testnet token / DEX addresses are not filled in. Provide them via env
 * (WRAPPED_NATIVE_ADDRESS, TOKEN_ADDRESSES, DEX_ADDRESSES) or edit this file.
 */
export const monadTestnet: ChainConfig = {
  name: 'monad',
  network: 'testnet',
  chainId: 10143,
  rpcUrl: 'https://testnet-rpc.monad.xyz',
  nativeSymbol: 'MON',
  nativeDecimals: 18,
  explorerUrl: 'https://testnet.monadexplorer.com',
  tokens: {},
  dexes: {},
};
