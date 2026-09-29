import type {
  IBalanceSource, IChainAdapter, IDexAdapter, IMarketDataProvider, IPositionRepository, ITradeRepository,
  IBotStateRepository, Indicators, MarketSnapshot, Pair, Quote,
} from '@btrade/core';
import { pairKey, toNumber } from '@btrade/core';
import { computeIndicators } from './indicators.js';

export interface SnapshotBuilderOptions {
  /** % of available balance used to probe quotes/impact (the "intended size") */
  probePct: number;
  /** native units kept untouched (wei); subtracted from available native */
  gasReserve: bigint;
  /** gas units per swap, for fee estimate */
  gasUnits: bigint;
  /** minimum BASE probe (raw) when balances are ~0 */
  fallbackProbeBase: bigint;
  now?: () => number;
  onWarn?: (msg: string, err?: unknown) => void;
}

export interface SnapshotBuilderDeps {
  pair: Pair;
  chain: IChainAdapter;
  dex: IDexAdapter;
  balances: IBalanceSource;
  market: IMarketDataProvider | null;
  positions: IPositionRepository;
  trades: ITradeRepository;
  state: IBotStateRepository;
}

export class SnapshotBuilder {
  private readonly now: () => number;

  constructor(private readonly d: SnapshotBuilderDeps, private readonly o: SnapshotBuilderOptions) {
    this.now = o.now ?? Date.now;
  }

  async build(): Promise<MarketSnapshot> {
    const { pair, dex } = this.d;
    const { base, quote } = pair;
    const [nativeBal, baseBal, quoteBal, gasPrice] = await Promise.all([
      this.d.balances.getNativeBalance(),
      this.d.balances.getBalance(base),
      this.d.balances.getBalance(quote),
      this.d.chain.getGasPrice(),
    ]);
    const reserve = this.o.gasReserve;
    const availBase = base.native ? (baseBal > reserve ? baseBal - reserve : 0n) : baseBal;
    const availQuote = quote.native ? (quoteBal > reserve ? quoteBal - reserve : 0n) : quoteBal;
    const pct = BigInt(Math.round(this.o.probePct * 100));

    // sell probe (BASE -> QUOTE)
    let sellIn = (availBase * pct) / 10_000n;
    if (sellIn < this.o.fallbackProbeBase) sellIn = this.o.fallbackProbeBase;
    const sellQ = await dex.quote(base, quote, sellIn);
    // buy probe (QUOTE -> BASE)
    let buyIn = (availQuote * pct) / 10_000n;
    if (buyIn === 0n) buyIn = sellQ.amountOut;
    const buyQ = buyIn > 0n ? await dex.quote(quote, base, buyIn) : null;

    const priceSell = px(sellQ, quote.decimals, base.decimals, 'sell');
    const priceBuy = buyQ ? px(buyQ, quote.decimals, base.decimals, 'buy') : null;
    const price = priceBuy && priceSell ? (priceBuy + priceSell) / 2 : (priceSell ?? priceBuy ?? 0);

    let liquidity: bigint | null = null;
    try {
      liquidity = (await dex.getPoolInfo(base, quote)).liquidity;
    } catch { /* ignore */ }

    const now = this.now();
    const position = this.d.positions.get(pairKey(pair));
    const last = this.d.trades.last();
    const lastDecRaw = this.d.state.get('lastDecision');
    return {
      timestamp: now,
      pair,
      price,
      priceBuy,
      priceSell,
      poolLiquidity: liquidity,
      priceImpactBps: { buy: buyQ?.priceImpactBps ?? null, sell: sellQ.priceImpactBps },
      gasPrice,
      estGasCostNative: gasPrice * this.o.gasUnits,
      balances: { native: nativeBal, base: baseBal, quote: quoteBal },
      position,
      unrealizedPnlPct: position && position.avgEntryPrice > 0 ? (price / position.avgEntryPrice - 1) * 100 : null,
      secondsSinceLastTrade: last ? Math.floor(now / 1000 - last.ts) : null,
      lastDecision: lastDecRaw ? (JSON.parse(lastDecRaw) as MarketSnapshot['lastDecision']) : null,
      indicators: await this.indicators(price, now),
      usd: null,
    };
  }

  private async indicators(price: number, nowMs: number): Promise<Indicators | null> {
    if (!this.d.market || !(price > 0)) return null;
    try {
      const [shortCandles, hourCandles] = await Promise.all([
        this.d.market.getCandles('minute', 5, 100),
        this.d.market.getCandles('hour', 1, 48),
      ]);
      return computeIndicators({ shortCandles, hourCandles, price, nowSec: nowMs / 1000 });
    } catch (e) {
      this.o.onWarn?.('indicators unavailable (market data failed); continuing without', e);
      return null;
    }
  }
}

/** QUOTE per BASE from a quote. */
function px(q: Quote, quoteDec: number, baseDec: number, dir: 'buy' | 'sell'): number | null {
  if (q.amountIn === 0n || q.amountOut === 0n) return null;
  if (dir === 'sell') return toNumber(q.amountOut, quoteDec) / toNumber(q.amountIn, baseDec);
  return toNumber(q.amountIn, quoteDec) / toNumber(q.amountOut, baseDec);
}
