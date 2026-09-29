import type { Address, Candle, IMarketDataProvider, Timeframe } from '@btrade/core';

export interface GeckoOptions {
  network: string;
  /** pool address (lazy: may need on-chain discovery) */
  pool: () => Promise<string | undefined>;
  /** priced token (our BASE); response prices are BASE in QUOTE terms */
  baseTokenAddress: Address;
  refreshSec: number;
  minRequestIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const BASE_URL = 'https://api.geckoterminal.com/api/v2';

export class GeckoTerminalProvider implements IMarketDataProvider {
  private readonly cache = new Map<string, { at: number; candles: Candle[] }>();
  private lastRequestAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly o: GeckoOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
  }

  async getCandles(timeframe: Timeframe, aggregate: number, limit: number): Promise<Candle[]> {
    const key = `${timeframe}:${aggregate}:${limit}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.o.refreshSec * 1000) return hit.candles;
    try {
      const candles = await this.fetchCandles(timeframe, aggregate, limit);
      this.cache.set(key, { at: this.now(), candles });
      return candles;
    } catch (e) {
      // back off: keep serving stale data (or rethrow if none) and don't hammer the API
      if (hit) {
        this.cache.set(key, { at: this.now(), candles: hit.candles });
        return hit.candles;
      }
      throw e;
    }
  }

  private async fetchCandles(timeframe: Timeframe, aggregate: number, limit: number): Promise<Candle[]> {
    const pool = await this.o.pool();
    if (!pool) throw new Error('GeckoTerminal pool address unknown');
    // simple spacing to stay under ~30 req/min
    const wait = (this.o.minRequestIntervalMs ?? 2100) - (this.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = this.now();
    const url =
      `${BASE_URL}/networks/${this.o.network}/pools/${pool}/ohlcv/${timeframe}` +
      `?aggregate=${aggregate}&limit=${limit}&currency=token&token=${this.o.baseTokenAddress}`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json;version=20230302' } });
    if (!res.ok) throw new Error(`GeckoTerminal ${res.status} for ${timeframe}/${aggregate}`);
    const json = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const list = json.data?.attributes?.ohlcv_list ?? [];
    return list
      .map(([ts, open, high, low, close, volume]) => ({
        ts: ts as number, open: open as number, high: high as number, low: low as number, close: close as number, volume: volume as number,
      }))
      .sort((a, b) => a.ts - b.ts);
  }
}
