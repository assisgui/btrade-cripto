import type { Logger } from 'pino';
import {
  detectFlowDeltas, expectedBalances, makeFlow, toNumber, toUnits, pairKey,
  type Balances, type Flow, type FlowDelta, type HodlInit, type IBalanceSource, type INotifier, type IStorage, type MarketSnapshot, type Pair,
} from '@btrade/core';
import { applyBuy, applyWithdrawal } from '@btrade/storage';

export interface FlowTrackerDeps {
  pair: Pair;
  mode: string;
  storage: IStorage;
  notifier: INotifier;
  balances: IBalanceSource;
  log: Pick<Logger, 'info' | 'warn'>;
  /** native units: negative native deltas down to this are gas, not withdrawals */
  nativeTolerance: number;
}

interface StoredBalances extends Balances { ts: number }

/** Detects external deposits/withdrawals by diffing wallet balances against the last known ones. */
export class FlowTracker {
  constructor(private readonly d: FlowTrackerDeps) {}

  private get key(): string {
    return `last_balances:${this.d.mode}`;
  }

  private whole(raw: { base: bigint; quote: bigint }): Balances {
    const { base, quote } = this.d.pair;
    return { base: toNumber(raw.base, base.decimals), quote: toNumber(raw.quote, quote.decimals) };
  }

  private opts(extra = 0) {
    const { base, quote } = this.d.pair;
    return { baseNative: base.native, quoteNative: quote.native, nativeTolerance: this.d.nativeTolerance, extraNativeTolerance: extra };
  }

  /** Persist balances (whole units) as the new reference. */
  save(raw: { base: bigint; quote: bigint }, ts = Date.now()): void {
    const b = this.whole(raw);
    this.d.storage.state.set(this.key, JSON.stringify({ base: b.base, quote: b.quote, ts } satisfies StoredBalances));
  }

  /** Detect (and record) flows for the current snapshot, then set last_balances to current. */
  async check(snap: MarketSnapshot): Promise<Flow[]> {
    const st = this.d.storage.state;
    const cur = this.whole(snap.balances);
    const raw = st.get(this.key);
    let deltas: FlowDelta[] = [];
    if (raw) {
      // expected = last known balances + bot trades recorded since then (trade ts is in seconds, last.ts in ms),
      // so a trade is never mistaken for a flow even if an RPC read lags behind.
      const last = JSON.parse(raw) as StoredBalances;
      const { base, quote } = this.d.pair;
      const since = this.d.storage.trades.since(last.ts / 1000).filter((t) => t.mode === this.d.mode);
      const exp = expectedBalances(last, since, base.decimals, quote.decimals);
      deltas = detectFlowDeltas(exp, cur, this.opts(0.1 * since.length));
    } else {
      const initRaw = st.get(`hodl_init:${this.d.mode}`);
      if (initRaw) deltas = this.bootstrap(JSON.parse(initRaw) as HodlInit, cur);
    }
    const flows: Flow[] = [];
    for (const dl of deltas) {
      const f = makeFlow(dl, snap.timestamp / 1000, snap.price, snap.usd?.monUsd ?? null, snap.usd?.quoteUsd ?? null);
      this.d.storage.flows.insert(f);
      this.applyToPosition(f, snap);
      this.d.log.info({ asset: f.asset, amount: f.amount, price: f.price, valueQuote: f.valueQuote, valueUsd: f.valueUsd }, 'flow detected');
      await this.d.notifier.notify({ type: 'flow', flow: f }).catch(() => {});
      flows.push(f);
    }
    this.save(snap.balances, snap.timestamp);
    return flows;
  }

  /** Retroactive: expected = hodl_init + net trades; any excess/shortfall beyond tolerance is a flow. */
  private bootstrap(init: HodlInit, cur: Balances): FlowDelta[] {
    const { base, quote } = this.d.pair;
    const trades = this.d.storage.trades.recent(1_000_000).filter((t) => t.mode === this.d.mode);
    const exp = expectedBalances(init, trades, base.decimals, quote.decimals);
    return detectFlowDeltas(exp, cur, this.opts(0.1 * trades.length));
  }

  /** BASE deposit = buy at the flow price; BASE withdrawal reduces size with no realized PnL. QUOTE flows: nothing. */
  private applyToPosition(f: Flow, snap: MarketSnapshot): void {
    if (f.asset !== 'base') return;
    const { base } = this.d.pair;
    const key = pairKey(this.d.pair);
    const pos = this.d.storage.positions.get(key);
    const raw = toUnits(Math.abs(f.amount), base.decimals);
    const now = Date.now();
    if (f.amount > 0) this.d.storage.positions.save(key, applyBuy(pos, raw, f.price, base.decimals, now));
    else if (pos) this.d.storage.positions.save(key, applyWithdrawal(pos, raw, now));
    snap.position = this.d.storage.positions.get(key);
    snap.unrealizedPnlPct = snap.position && snap.position.avgEntryPrice > 0 ? (snap.price / snap.position.avgEntryPrice - 1) * 100 : null;
  }
}
