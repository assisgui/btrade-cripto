// pnpm report  (reads DB_PATH; works for paper/fork/live DBs)
import { existsSync } from 'node:fs';
import { portfolioMetrics, type HodlInit } from '@btrade/core';
import { SqliteStorage } from '@btrade/storage';

const path = process.env.DB_PATH ?? './data/btrade.db';
if (path !== ':memory:' && !existsSync(path)) {
  console.error(`No DB at ${path}`);
  process.exit(1);
}
const s = new SqliteStorage(path);
const n = (v: number | null | undefined, d = 6) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));
const p = (v: number | null) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`);

const inits = s.state.list('hodl_init:');
const last = s.portfolio.last();
const trades = s.trades.recent(1_000_000);
const realizedQ = trades.reduce((a, t) => a + t.realizedPnlQuote, 0);
const realizedUsdTrades = trades.filter((t) => t.realizedPnlUsd !== null && t.realizedPnlUsd !== undefined);
const realizedUsd = realizedUsdTrades.length ? realizedUsdTrades.reduce((a, t) => a + (t.realizedPnlUsd ?? 0), 0) : null;

console.log(`== btrade report (${path}) ==`);
if (!inits.length || !last) {
  console.log('No portfolio data yet (run the bot at least one tick).');
}
for (const { key, value } of inits) {
  if (!last) break;
  const init = JSON.parse(value) as HodlInit;
  const price = last.balanceBase > 0 ? (last.valueQuote - last.balanceQuote) / last.balanceBase : init.price;
  const usdNow = last.valueUsd;
  const m = portfolioMetrics(init, last.balanceBase, last.balanceQuote, price > 0 ? price : init.price, null, null);
  const pnlUsdPct = m.startValueUsd !== null && usdNow !== null && m.startValueUsd > 0 ? (usdNow / m.startValueUsd - 1) * 100 : null;
  const hodlUsdPct = last.hodlValueUsd !== null && usdNow !== null && last.hodlValueUsd > 0 ? (usdNow / last.hodlValueUsd - 1) * 100 : null;
  console.log(`mode: ${key.slice('hodl_init:'.length)}   since: ${new Date(init.ts).toISOString()}   last snapshot: ${new Date(last.ts * 1000).toISOString()}`);
  console.log(`value (quote): start ${n(m.startValueQuote, 8)} -> now ${n(last.valueQuote, 8)}   (${p(m.pnlQuotePct)})`);
  console.log(`value (USD):   start ${n(m.startValueUsd, 2)} -> now ${n(usdNow, 2)}   (${p(pnlUsdPct)})`);
  console.log(`vs HODL: quote ${n(last.hodlValueQuote, 8)} (${p(m.vsHodlQuotePct)})   USD ${n(last.hodlValueUsd, 2)} (${p(hodlUsdPct)})`);
}
console.log(`realized pnl: ${n(realizedQ, 8)} quote / ${n(realizedUsd, 4)} USD   trades: ${s.trades.count()}`);
console.log('\nLast 20 trades:');
console.log('id  time                  side  in(raw)       out(raw)          price         value_usd  pnl_quote     pnl_usd');
for (const t of s.trades.recent(20)) {
  console.log([
    String(t.id).padEnd(3), new Date(t.ts * 1000).toISOString().slice(0, 19).padEnd(21), t.side.padEnd(5),
    t.amountIn.toString().padEnd(13), t.amountOut.toString().padEnd(13), t.price.toPrecision(6).padEnd(13),
    n(t.valueUsd, 4).padEnd(10), n(t.realizedPnlQuote, 8).padEnd(13), n(t.realizedPnlUsd, 4),
  ].join(' '));
}
s.close();
