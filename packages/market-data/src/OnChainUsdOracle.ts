import { deriveQuoteUsd, toNumber, toUnits, type IDexAdapter, type IUsdPriceOracle, type Token } from '@btrade/core';

export interface OnChainUsdOracleOptions {
  /** DEX with deep BASE(wrapped)/USD pools (e.g. uniswap-v3 preset on Monad) */
  dex: IDexAdapter;
  /** wrapped form of BASE (WMON) */
  baseToken: Token;
  usdToken: Token;
  /** whole BASE units quoted as the probe */
  probeAmount: number;
  /** latest mid price (QUOTE per BASE) from the trading snapshot */
  midPrice: () => number | null;
  onWarn?: (msg: string, err?: unknown) => void;
}

/** BASE/USD from a probe quote BASE->USDC; QUOTE/USD derived as baseUsd / mid. Never throws; null on failure. */
export class OnChainUsdOracle implements IUsdPriceOracle {
  constructor(private readonly o: OnChainUsdOracleOptions) {}

  async getUsdPrices(): Promise<{ baseUsd: number; quoteUsd: number } | null> {
    try {
      const { baseToken, usdToken, dex, probeAmount } = this.o;
      const amountIn = toUnits(probeAmount, baseToken.decimals);
      const q = await dex.quote(baseToken, usdToken, amountIn);
      // quote is net of the pool fee (hundredths of a bip, e.g. 3000 = 0.3%); gross it up to get the mid price
      const feeFrac = (q.fee ?? 0) / 1_000_000;
      const baseUsd = toNumber(q.amountOut, usdToken.decimals) / probeAmount / (1 - feeFrac);
      const quoteUsd = deriveQuoteUsd(baseUsd, this.o.midPrice() ?? 0);
      if (!(baseUsd > 0) || quoteUsd === null) return null;
      return { baseUsd, quoteUsd };
    } catch (e) {
      this.o.onWarn?.('usd oracle failed; continuing without USD values', e);
      return null;
    }
  }
}
