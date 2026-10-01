import type { Decision, IRiskManager, ITradeRepository, MarketSnapshot, NowState, QuoteFn, RiskVerdict, Token, Trade } from '@btrade/core';
import { toNumber } from '@btrade/core';
import { bucketAmountIn, computeNow, cooldownSecLeft, dailyLoss, gasInQuote, rebuyRule, sellRule, stepRule, type RiskConfig } from './limits.js';

export type { RiskConfig };

export class RiskManager implements IRiskManager {
  constructor(
    private readonly cfg: RiskConfig,
    private readonly trades: ITradeRepository,
    private readonly now: () => number = Date.now,
  ) {}

  assess(s: MarketSnapshot): NowState {
    const nowSec = this.now() / 1000;
    const recentTrades = this.trades.since(nowSec - 86_400);
    const last = recentTrades.length ? recentTrades[recentTrades.length - 1] : this.trades.last();
    return computeNow(this.cfg, s, { recentTrades, lastTradeTs: last?.ts ?? null, nowSec, lastTrade: last ?? null, lastSell: this.lastSell() });
  }

  private lastSell(): Trade | null {
    return this.trades.recent(500).find((t) => t.side === 'sell') ?? null;
  }

  async evaluate(decision: Decision, s: MarketSnapshot, quoteFn: QuoteFn): Promise<RiskVerdict> {
    const c = this.cfg;
    const reject = (reasons: string[], amountIn = 0n): RiskVerdict => ({ approved: false, amountIn, amountOutMin: 0n, reasons });
    if (decision.action === 'hold') return reject(['action is hold']);

    const reasons: string[] = [];
    const isBuy = decision.action === 'buy';
    const { base, quote } = s.pair;
    const tokenIn: Token = isBuy ? quote : base;
    const tokenOut: Token = isBuy ? base : quote;

    if (decision.confidence < c.minConfidence) reasons.push(`confidence ${decision.confidence.toFixed(2)} < min ${c.minConfidence}`);

    const nowSec = this.now() / 1000;
    const dayAgo = nowSec - 86_400;
    const recent = this.trades.since(dayAgo);
    const last = recent.length ? recent[recent.length - 1] : this.trades.last();
    const cd = cooldownSecLeft(c, last?.ts ?? null, nowSec);
    if (cd > 0) reasons.push(`cooldown: ${cd}s left`);
    if (recent.length >= c.maxTradesPerDay) reasons.push(`max trades/day reached (${recent.length}/${c.maxTradesPerDay})`);

    // sizing
    const amountIn = bucketAmountIn(c, s, isBuy, decision.sizeBucket);
    if (amountIn <= 0n) return reject([...reasons, `no available ${tokenIn.symbol} (after gas reserve)`]);

    // daily loss (realized, rolling 24h, vs portfolio value in QUOTE) — stop-loss exits stay allowed
    const { lossPct, hit: dailyLossHit } = dailyLoss(c, recent, s);

    let q;
    try {
      q = await quoteFn(tokenIn, tokenOut, amountIn);
    } catch (e) {
      return reject([...reasons, `quote failed: ${(e as Error).message}`], amountIn);
    }
    if (q.amountOut <= 0n) return reject([...reasons, 'quote returned zero output'], amountIn);

    if (q.priceImpactBps > c.maxPriceImpactBps) reasons.push(`price impact ${q.priceImpactBps.toFixed(1)}bps > ${c.maxPriceImpactBps}`);
    const amountOutMin = (q.amountOut * BigInt(10_000 - c.maxSlippageBps)) / 10_000n;

    const tradeValue = isBuy ? toNumber(amountIn, quote.decimals) : toNumber(q.amountOut, quote.decimals);
    if (tradeValue < c.minTradeValue) reasons.push(`trade value ${tradeValue} < min ${c.minTradeValue} ${quote.symbol}`);

    const gasQuote = gasInQuote(s);
    if (gasQuote !== null && tradeValue > 0) {
      const pct = (gasQuote / tradeValue) * 100;
      if (pct >= c.maxGasCostPct) reasons.push(`gas cost ${pct.toFixed(2)}% of trade >= max ${c.maxGasCostPct}%`);
    }

    let stopLoss = false;
    if (!isBuy) {
      const entry = s.position?.avgEntryPrice;
      const sellPrice = toNumber(q.amountOut, quote.decimals) / toNumber(amountIn, base.decimals);
      if (!entry || entry <= 0) {
        reasons.push('no cost basis: cannot verify profit rule');
      } else {
        const r = sellRule(c, entry, sellPrice, gasQuote, toNumber(amountIn, base.decimals));
        stopLoss = r.stopLoss;
        if (!stopLoss && !r.targetReached) {
          reasons.push(`sell price ${sellPrice.toPrecision(6)} < required ${r.required.toPrecision(6)} (entry ${entry.toPrecision(6)} + profit + gas/unit)`);
        }
      }
    }
    const execPrice = isBuy
      ? toNumber(amountIn, quote.decimals) / toNumber(q.amountOut, base.decimals)
      : toNumber(q.amountOut, quote.decimals) / toNumber(amountIn, base.decimals);
    const step = stepRule(c, isBuy ? 'buy' : 'sell', execPrice, last ?? null, stopLoss);
    if (!step.ok && step.next !== null) {
      reasons.push(`price step: last ${last!.side} @ ${last!.price.toPrecision(6)}, next ${isBuy ? 'buy' : 'sell'} needs ${isBuy ? '<=' : '>='} ${step.next.toPrecision(6)} (now ${execPrice.toPrecision(6)})`);
    }
    if (isBuy) {
      const rb = rebuyRule(c, execPrice, this.lastSell());
      if (!rb.ok && rb.target !== null) reasons.push(`rebuy: needs price <= ${rb.target.toPrecision(6)} (${c.rebuyDiscountPct}% below last sell), now ${execPrice.toPrecision(6)}`);
    }
    if (dailyLossHit && !stopLoss) reasons.push(`daily loss ${lossPct.toFixed(2)}% >= max ${c.maxDailyLossPct}%`);

    return { approved: reasons.length === 0, amountIn, amountOutMin, reasons };
  }
}
