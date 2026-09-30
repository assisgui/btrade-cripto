import type { Logger } from 'pino';
import {
  pairKey, toNumber, portfolioMetrics, usdValuation, type BotEvent, type HodlInit, type IUsdPriceOracle, type Decision, type IBalanceSource, type IDecisionEngine, type IDexAdapter, type INotifier,
  type IRiskManager, type IStorage, type MarketSnapshot, type Pair, type Trade,
} from '@btrade/core';
import type { ChangeDetector, SnapshotBuilder } from '@btrade/market-data';
import { noActionReason } from '@btrade/risk';
import { applyBuy, applySell } from '@btrade/storage';
import { FlowTracker } from './FlowTracker.js';

export interface TradingBotDeps {
  pair: Pair;
  mode: string;
  engineName: string;
  builder: SnapshotBuilder;
  detector: ChangeDetector;
  engine: IDecisionEngine;
  risk: IRiskManager;
  dex: IDexAdapter;
  storage: IStorage;
  notifier: INotifier;
  balances: IBalanceSource;
  usdOracle?: IUsdPriceOracle | null;
  log: Logger;
}

export interface TradingBotOptions {
  pollIntervalSec: number;
  gasReserve: bigint;
  initialCostBasis?: number;
  maxTicks?: number;
  portfolioSnapshotSec?: number;
  /** native units treated as gas (not a withdrawal) when native balance drops */
  flowToleranceNative?: number;
}

export class TradingBot {
  private running = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  ticks = 0;
  /** latest mid price (QUOTE per BASE); read by the USD oracle */
  lastMid: number | null = null;
  private lastPortfolioTs = 0;
  private pnlPctVsInvested: number | null = null;
  private readonly flows: FlowTracker;

  constructor(private readonly d: TradingBotDeps, private readonly o: TradingBotOptions) {
    this.flows = new FlowTracker({
      pair: d.pair, mode: d.mode, storage: d.storage, notifier: d.notifier, balances: d.balances, log: d.log,
      nativeTolerance: o.flowToleranceNative ?? 0.5,
    });
  }

  start(): Promise<void> {
    this.running = true;
    this.loopDone = this.loop();
    return this.loopDone;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopDone;
    await this.d.notifier.notify({ type: 'stopped' });
  }

  private async loop(): Promise<void> {
    const { log, pair } = this.d;
    await this.d.notifier.notify({ type: 'started', mode: this.d.mode, pair: pairKey(pair), engine: this.d.engineName });
    this.d.storage.state.set('pair_info', JSON.stringify({ baseDecimals: pair.base.decimals, quoteDecimals: pair.quote.decimals }));
    while (this.running) {
      await this.tick();
      this.ticks++;
      if (this.o.maxTicks && this.ticks >= this.o.maxTicks) {
        log.info({ ticks: this.ticks }, 'max ticks reached');
        this.running = false;
        break;
      }
      await this.sleep(this.o.pollIntervalSec * 1000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(t);
        resolve();
      }
    });
  }

  /** One isolated iteration: never throws. */
  async tick(): Promise<void> {
    const { log } = this.d;
    try {
      if (this.d.storage.state.isPaused()) {
        log.info('paused; skipping tick');
        return;
      }
      const snap = await this.d.builder.build();
      this.ensureCostBasis(snap);
      this.lastMid = snap.price > 0 ? snap.price : null;
      await this.attachUsd(snap);
      await this.flows.check(snap);
      this.reportPortfolio(snap);
      log.info(
        {
          price: snap.price, buy: snap.priceBuy, sell: snap.priceSell, impactBps: snap.priceImpactBps,
          balances: this.fmtBalances(snap), pnlPct: snap.unrealizedPnlPct, indicators: snap.indicators,
        },
        'snapshot',
      );
      const change = this.d.detector.check(snap);
      if (!change.send) {
        log.debug({ reason: change.reason }, 'no meaningful change; skipping decision');
        return;
      }
      const now = this.d.risk.assess(snap);
      const skip = noActionReason(now);
      if (skip) {
        // nothing could be approved: don't spend an engine call; not marking sent re-triggers once the block clears
        log.debug({ trigger: change.reason, skip }, 'no trade possible; skipping decision');
        return;
      }
      const decision = await this.d.engine.decide(snap, { now, pnlPctVsInvested: this.pnlPctVsInvested });
      this.d.detector.markSent(snap);
      this.d.storage.state.set('lastDecision', JSON.stringify({ action: decision.action, confidence: decision.confidence, at: snap.timestamp }));
      log.info({ trigger: change.reason, action: decision.action, size: decision.sizeBucket, confidence: decision.confidence, p: decision.probabilities }, 'decision');
      await this.d.notifier.notify({ type: 'decision', decision, price: snap.price });

      const verdict = await this.d.risk.evaluate(decision, snap, (a, b, n) => this.d.dex.quote(a, b, n));
      if (decision.action === 'hold' || !verdict.approved) {
        const outcome = decision.action === 'hold' ? 'hold' : `vetoed: ${verdict.reasons.join('; ')}`;
        if (decision.action !== 'hold') {
          log.warn({ reasons: verdict.reasons }, 'trade vetoed by risk');
          await this.d.notifier.notify({ type: 'vetoed', decision, reasons: verdict.reasons });
        }
        this.d.storage.decisions.log({ ts: snap.timestamp, snapshot: snap, decision, outcome });
        return;
      }
      await this.execute(decision, snap, verdict.amountIn, verdict.amountOutMin);
    } catch (e) {
      log.error({ err: e }, 'tick failed (isolated)');
      await this.d.notifier.notify({ type: 'error', message: (e as Error).message }).catch(() => {});
    }
  }

  private async execute(decision: Decision, snap: MarketSnapshot, amountIn: bigint, amountOutMin: bigint): Promise<void> {
    const { base, quote } = this.d.pair;
    const isBuy = decision.action === 'buy';
    const tokenIn = isBuy ? quote : base;
    const tokenOut = isBuy ? base : quote;
    const res = await this.d.dex.swap({ tokenIn, tokenOut, amountIn, amountOutMin });
    if (!res.success) {
      this.d.log.warn({ res }, 'swap failed / not filled');
      this.d.storage.decisions.log({ ts: snap.timestamp, snapshot: snap, decision, outcome: 'swap failed' });
      return;
    }
    const baseAmt = isBuy ? res.amountOut : res.amountIn;
    const quoteAmt = isBuy ? res.amountIn : res.amountOut;
    const price = toNumber(quoteAmt, quote.decimals) / toNumber(baseAmt, base.decimals);
    const key = pairKey(this.d.pair);
    const now = Date.now();
    let realized = 0;
    const pos = this.d.storage.positions.get(key);
    if (isBuy) {
      this.d.storage.positions.save(key, applyBuy(pos, baseAmt, price, base.decimals, now));
    } else if (pos) {
      const r = applySell(pos, baseAmt, price, base.decimals, now);
      realized = r.realizedPnlQuote;
      this.d.storage.positions.save(key, r.position);
    }
    const qUsd = snap.usd?.quoteUsd ?? null;
    const gasNative = toNumber(res.gasUsed ? res.gasUsed * snap.gasPrice : snap.estGasCostNative, 18);
    const trade: Trade = {
      ts: now / 1000, side: isBuy ? 'buy' : 'sell', mode: this.d.mode, tokenIn: tokenIn.address, tokenOut: tokenOut.address,
      amountIn: res.amountIn, amountOut: res.amountOut, price, realizedPnlQuote: realized, txHash: res.txHash, paper: res.paper,
      valueUsd: qUsd === null ? null : toNumber(quoteAmt, quote.decimals) * qUsd,
      gasUsd: snap.usd ? gasNative * snap.usd.monUsd : null,
      realizedPnlUsd: qUsd === null ? null : realized * qUsd,
    };
    this.d.storage.trades.insert(trade);
    this.d.detector.acknowledgeOwnTrade();
    this.d.storage.decisions.log({ ts: snap.timestamp, snapshot: snap, decision, outcome: `executed ${trade.side} @ ${price}` });
    this.d.log.info({ side: trade.side, price, realizedPnlQuote: realized, txHash: res.txHash, paper: res.paper }, 'trade executed');
    await this.d.notifier.notify({ type: 'trade', trade });
  }

  private async attachUsd(snap: MarketSnapshot): Promise<void> {
    if (!this.d.usdOracle) return;
    const p = await this.d.usdOracle.getUsdPrices().catch(() => null);
    if (!p) return;
    const { base, quote } = this.d.pair;
    snap.usd = usdValuation(toNumber(snap.balances.base, base.decimals), toNumber(snap.balances.quote, quote.decimals), p.baseUsd, p.quoteUsd);
  }

  /** HODL benchmark init (once per DB/mode), per-tick `portfolio` log line, throttled DB snapshot. */
  private reportPortfolio(snap: MarketSnapshot): void {
    if (!(snap.price > 0)) return;
    const { base, quote } = this.d.pair;
    const b = toNumber(snap.balances.base, base.decimals);
    const q = toNumber(snap.balances.quote, quote.decimals);
    const st = this.d.storage.state;
    const key = `hodl_init:${this.d.mode}`;
    const raw = st.get(key);
    let init: HodlInit;
    if (raw) {
      init = JSON.parse(raw) as HodlInit;
      if (init.baseUsd === null && snap.usd) { // USD was unavailable on the first run: backfill once
        init = { ...init, baseUsd: snap.usd.monUsd, quoteUsd: snap.usd.quoteUsd };
        st.set(key, JSON.stringify(init));
      }
    } else {
      init = { ts: snap.timestamp, base: b, quote: q, price: snap.price, baseUsd: snap.usd?.monUsd ?? null, quoteUsd: snap.usd?.quoteUsd ?? null };
      st.set(key, JSON.stringify(init));
    }
    const m = portfolioMetrics(init, b, q, snap.price, snap.usd?.monUsd ?? null, snap.usd?.quoteUsd ?? null, this.d.storage.flows.all());
    this.pnlPctVsInvested = m.pnlQuotePct;
    const f = (n: number | null, d = 2) => (n === null ? null : Number(n.toFixed(d)));
    this.d.log.info(
      {
        valueQuote: Number(m.valueQuote.toFixed(8)), valueUsd: f(m.valueUsd), monUsd: f(snap.usd?.monUsd ?? null, 5), quoteUsd: f(snap.usd?.quoteUsd ?? null, 0),
        investedQuote: Number(m.investedQuote.toFixed(8)), investedUsd: f(m.investedUsd), pnlQuotePct: f(m.pnlQuotePct, 3), pnlUsdPct: f(m.pnlUsdPct, 3), vsHodlQuotePct: f(m.vsHodlQuotePct, 3),
      },
      'portfolio',
    );
    const every = (this.o.portfolioSnapshotSec ?? 300) * 1000;
    if (snap.timestamp - this.lastPortfolioTs >= every) {
      this.lastPortfolioTs = snap.timestamp;
      this.d.storage.portfolio.insert({
        ts: snap.timestamp / 1000, balanceBase: b, balanceQuote: q, valueQuote: m.valueQuote, valueUsd: m.valueUsd,
        hodlValueQuote: m.hodlValueQuote, hodlValueUsd: m.hodlValueUsd,
      });
    }
  }

  /** If no cost basis exists, initialise from INITIAL_COST_BASIS env or the current price. */
  private ensureCostBasis(snap: MarketSnapshot): void {
    const key = pairKey(this.d.pair);
    if (this.d.storage.positions.get(key) || !(snap.price > 0)) return;
    const b = this.d.pair.base;
    const bal = b.native ? (snap.balances.base > this.o.gasReserve ? snap.balances.base - this.o.gasReserve : 0n) : snap.balances.base;
    const avg = this.o.initialCostBasis ?? snap.price;
    this.d.storage.positions.save(key, { size: bal, avgEntryPrice: avg, realizedPnlQuote: 0, updatedAt: Date.now() });
    this.d.log.info({ avgEntryPrice: avg, source: this.o.initialCostBasis ? 'INITIAL_COST_BASIS' : 'current price' }, 'initialised cost basis');
    snap.position = this.d.storage.positions.get(key);
    snap.unrealizedPnlPct = snap.position ? (snap.price / avg - 1) * 100 : null;
  }

  private fmtBalances(s: MarketSnapshot) {
    return {
      [s.pair.base.symbol]: toNumber(s.balances.base, s.pair.base.decimals),
      [s.pair.quote.symbol]: toNumber(s.balances.quote, s.pair.quote.decimals),
    };
  }
}
export type { BotEvent };
