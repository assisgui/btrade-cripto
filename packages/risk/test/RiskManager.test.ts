import { describe, expect, it } from 'vitest';
import type { Decision, MarketSnapshot, Quote, Token, Trade } from '@btrade/core';
import { RiskManager, type RiskConfig } from '../src/index.js';

const base: Token = { symbol: 'MON', address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', decimals: 18, native: true };
const quote: Token = { symbol: 'WBTC', address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8, native: false };
const E18 = 10n ** 18n;
const NOW = 1_800_000_000_000;

const cfg: RiskConfig = {
  minConfidence: 0.6, gasReserveNative: 1n * E18, sizePct: { small: 10, medium: 25, large: 50 },
  minProfitPct: 1, stopLossPct: 10, maxSlippageBps: 100, maxPriceImpactBps: 100, minTradeValue: 0.00001, maxTradeValue: 0,
  maxGasCostPct: 5, tradeCooldownSec: 300, maxTradesPerDay: 5, maxDailyLossPct: 5,
};

const price = 0.000001; // WBTC per MON
const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  timestamp: NOW, pair: { base, quote }, price, priceBuy: price, priceSell: price, poolLiquidity: 1n, usd: null,
  priceImpactBps: { buy: 1, sell: 1 }, gasPrice: 100n * 10n ** 9n, estGasCostNative: 250_000n * 100n * 10n ** 9n / 1000n,
  balances: { native: 1001n * E18, base: 1001n * E18, quote: 1_000_000n },
  position: { size: 1000n * E18, avgEntryPrice: price, realizedPnlQuote: 0, updatedAt: 0 },
  unrealizedPnlPct: 0, secondsSinceLastTrade: null, lastDecision: null, indicators: null, ...over,
});
const dec = (action: Decision['action'], over: Partial<Decision> = {}): Decision => ({
  action, sizeBucket: 'medium', confidence: 0.9, probabilities: { buy: 0, sell: 0, hold: 0 }, raw: null, ...over,
});
/** quote at given QUOTE-per-BASE price */
const quoter = (px: number, impact = 1) => async (tin: Token, _o: Token, amountIn: bigint): Promise<Quote> => {
  const out = tin.native
    ? BigInt(Math.floor(Number(amountIn) / 1e18 * px * 1e8))
    : BigInt(Math.floor(Number(amountIn) / 1e8 / px * 1e18));
  return { amountIn, amountOut: out, priceImpactBps: impact, fee: 3000, route: [] };
};
const trade = (o: Partial<Trade> = {}): Trade => ({
  ts: NOW / 1000 - 10_000, side: 'sell', mode: 'paper', tokenIn: base.address, tokenOut: quote.address,
  amountIn: 1n, amountOut: 1n, price, realizedPnlQuote: 0, txHash: null, paper: true, ...o,
});
const mk = (c: Partial<RiskConfig> = {}, trades: Trade[] = []) =>
  new RiskManager({ ...cfg, ...c }, { insert() {}, recent: () => trades, count: () => trades.length, last: () => trades.at(-1) ?? null, since: () => trades }, () => NOW);

describe('RiskManager', () => {
  it('vetoes hold', async () => {
    expect((await mk().evaluate(dec('hold'), snap(), quoter(price))).approved).toBe(false);
  });
  it('approves a buy and sizes from quote balance', async () => {
    const v = await mk().evaluate(dec('buy'), snap(), quoter(price));
    expect(v.approved).toBe(true);
    expect(v.amountIn).toBe(250_000n); // 25% of 1_000_000
    expect(v.amountOutMin).toBeGreaterThan(0n);
  });
  it('low confidence rejected', async () => {
    const v = await mk().evaluate(dec('buy', { confidence: 0.3 }), snap(), quoter(price));
    expect(v.approved).toBe(false);
    expect(v.reasons.join()).toMatch(/confidence/);
  });
  it('native gas reserve is excluded from sell size', async () => {
    const v = await mk().evaluate(dec('sell'), snap({ balances: { native: 101n * E18, base: 101n * E18, quote: 0n } }), quoter(price * 1.05));
    expect(v.amountIn).toBe(25n * E18); // (101-1)*25%
  });
  it('zero available after reserve -> rejected', async () => {
    const v = await mk().evaluate(dec('sell'), snap({ balances: { native: E18 / 2n, base: E18 / 2n, quote: 0n } }), quoter(price));
    expect(v.approved).toBe(false);
  });
  it('sell below min profit rejected, above approved', async () => {
    expect((await mk().evaluate(dec('sell'), snap(), quoter(price * 1.005))).approved).toBe(false);
    expect((await mk().evaluate(dec('sell'), snap(), quoter(price * 1.05))).approved).toBe(true);
  });
  it('pool fee is not double counted (quote already net)', async () => {
    // fee=3000 (0.3%) is ignored: entry*(1+1%) + tiny gas is enough
    expect((await mk().evaluate(dec('sell'), snap(), quoter(price * 1.011))).approved).toBe(true);
  });
  it('gas per unit is added to the required sell price', async () => {
    const big = snap({ estGasCostNative: 1n * E18 }); // 1 MON gas over 250 MON sold -> +0.4%
    const s = { ...big, balances: { ...big.balances, base: 1001n * E18 } };
    expect((await mk({ maxGasCostPct: 100 }).evaluate(dec('sell'), s, quoter(price * 1.011))).approved).toBe(false);
    expect((await mk({ maxGasCostPct: 100 }).evaluate(dec('sell'), s, quoter(price * 1.02))).approved).toBe(true);
  });
  it('MAX_TRADE_VALUE clamps buy amount (not reject)', async () => {
    const v = await mk({ maxTradeValue: 0.0005 }).evaluate(dec('buy'), snap(), quoter(price)); // 50_000 units
    expect(v.approved).toBe(true);
    expect(v.amountIn).toBe(50_000n);
  });
  it('MAX_TRADE_VALUE clamps sell amount via price', async () => {
    const v = await mk({ maxTradeValue: 0.0001 }).evaluate(dec('sell'), snap(), quoter(price * 1.05));
    expect(v.approved).toBe(true);
    expect(Number(v.amountIn) / 1e18).toBeCloseTo(100, 6);
  });
  it('stop loss overrides profit rule', async () => {
    const v = await mk().evaluate(dec('sell'), snap(), quoter(price * 0.85));
    expect(v.approved).toBe(true);
    expect((await mk({ stopLossPct: 0 }).evaluate(dec('sell'), snap(), quoter(price * 0.85))).approved).toBe(false);
  });
  it('price impact rejected', async () => {
    const v = await mk().evaluate(dec('buy'), snap(), quoter(price, 500));
    expect(v.reasons.join()).toMatch(/price impact/);
  });
  it('slippage sets amountOutMin', async () => {
    const q = quoter(price);
    const v = await mk({ maxSlippageBps: 200 }).evaluate(dec('buy'), snap(), q);
    const full = (await q(quote, base, v.amountIn)).amountOut;
    expect(v.amountOutMin).toBe((full * 9800n) / 10000n);
  });
  it('min trade value', async () => {
    const v = await mk({ minTradeValue: 1 }).evaluate(dec('buy'), snap(), quoter(price));
    expect(v.reasons.join()).toMatch(/trade value/);
  });
  it('gas cost cap', async () => {
    const v = await mk({ maxGasCostPct: 0.0000001 }).evaluate(dec('buy'), snap(), quoter(price));
    expect(v.reasons.join()).toMatch(/gas cost/);
  });
  it('cooldown', async () => {
    const v = await mk({}, [trade({ ts: NOW / 1000 - 10 })]).evaluate(dec('buy'), snap(), quoter(price));
    expect(v.reasons.join()).toMatch(/cooldown/);
  });
  it('max trades per day', async () => {
    const ts = Array.from({ length: 5 }, (_, i) => trade({ ts: NOW / 1000 - 1000 - i }));
    const v = await mk({}, ts).evaluate(dec('buy'), snap(), quoter(price));
    expect(v.reasons.join()).toMatch(/max trades/);
  });
  it('daily loss limit blocks buys but not stop-loss sells', async () => {
    const loss = [trade({ realizedPnlQuote: -0.5 })]; // portfolio ~0.01+0.001 -> huge loss pct
    expect((await mk({}, loss).evaluate(dec('buy'), snap(), quoter(price))).reasons.join()).toMatch(/daily loss/);
    expect((await mk({}, loss).evaluate(dec('sell'), snap(), quoter(price * 0.8))).approved).toBe(true);
  });
  it('quote failure is a veto', async () => {
    const v = await mk().evaluate(dec('buy'), snap(), async () => { throw new Error('boom'); });
    expect(v.approved).toBe(false);
  });
});
