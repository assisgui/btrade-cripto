import type { Decision, IRiskManager, ITradeRepository, MarketSnapshot, QuoteFn, RiskVerdict, SizeBucket, Token } from '@btrade/core';
import { toNumber, toUnits } from '@btrade/core';

export interface RiskConfig {
  minConfidence: number;
  /** native wei never to be spent */
  gasReserveNative: bigint;
  sizePct: Record<SizeBucket, number>;
  minProfitPct: number;
  /** 0 disables */
  stopLossPct: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  /** minimum trade value in QUOTE units */
  minTradeValue: number;
  /** hard cap per trade in QUOTE units; amount is clamped down to it. 0 disables */
  maxTradeValue: number;
  maxGasCostPct: number;
  tradeCooldownSec: number;
  maxTradesPerDay: number;
  maxDailyLossPct: number;
}

export class RiskManager implements IRiskManager {
  constructor(
    private readonly cfg: RiskConfig,
    private readonly trades: ITradeRepository,
    private readonly now: () => number = Date.now,
  ) {}

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
    if (last && nowSec - last.ts < c.tradeCooldownSec) reasons.push(`cooldown: ${Math.ceil(c.tradeCooldownSec - (nowSec - last.ts))}s left`);
    if (recent.length >= c.maxTradesPerDay) reasons.push(`max trades/day reached (${recent.length}/${c.maxTradesPerDay})`);

    // sizing
    const balIn = isBuy ? s.balances.quote : s.balances.base;
    const avail = tokenIn.native ? (balIn > c.gasReserveNative ? balIn - c.gasReserveNative : 0n) : balIn;
    const bps = BigInt(Math.round(c.sizePct[decision.sizeBucket] * 100));
    let amountIn = (avail * bps) / 10_000n;
    if (amountIn > 0n && c.maxTradeValue > 0) {
      // clamp to cap; for sells convert the QUOTE cap to BASE via the spot price
      const cap = isBuy
        ? toUnits(c.maxTradeValue, quote.decimals)
        : s.price > 0 ? toUnits(c.maxTradeValue / s.price, base.decimals) : amountIn;
      if (amountIn > cap) amountIn = cap;
    }
    if (amountIn <= 0n) return reject([...reasons, `no available ${tokenIn.symbol} (after gas reserve)`]);

    // daily loss (realized, rolling 24h, vs portfolio value in QUOTE) — stop-loss exits stay allowed
    const realizedLoss = -recent.reduce((a, t) => a + Math.min(0, t.realizedPnlQuote), 0);
    const portfolio = toNumber(s.balances.quote, quote.decimals) + toNumber(s.balances.base, base.decimals) * s.price;
    const lossPct = portfolio > 0 ? (realizedLoss / portfolio) * 100 : 0;
    const dailyLossHit = c.maxDailyLossPct > 0 && lossPct >= c.maxDailyLossPct;

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

    // gas cost in QUOTE terms (only computable if native is base or quote)
    const gasNative = toNumber(s.estGasCostNative, 18);
    const gasQuote = base.native ? gasNative * s.price : quote.native ? gasNative : null;
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
        stopLoss = c.stopLossPct > 0 && sellPrice <= entry * (1 - c.stopLossPct / 100);
        if (!stopLoss) {
          // sellPrice comes from a quote already net of the pool fee; buy-side fee is in avgEntry.
          const gasPerUnit = gasQuote !== null ? gasQuote / toNumber(amountIn, base.decimals) : 0;
          const required = entry * (1 + c.minProfitPct / 100) + gasPerUnit;
          if (sellPrice < required) reasons.push(`sell price ${sellPrice.toPrecision(6)} < required ${required.toPrecision(6)} (entry ${entry.toPrecision(6)} + profit + gas/unit)`);
        }
      }
    }
    if (dailyLossHit && !stopLoss) reasons.push(`daily loss ${lossPct.toFixed(2)}% >= max ${c.maxDailyLossPct}%`);

    return { approved: reasons.length === 0, amountIn, amountOutMin, reasons };
  }
}
