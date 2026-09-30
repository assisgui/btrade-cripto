// pnpm report  (reads DB_PATH; works for paper/fork/live DBs)
import { existsSync } from 'node:fs';
import { hodlBalances, investedUsd, portfolioMetrics, toNumber, valueInQuote, type HodlInit } from '@btrade/core';
import { SqliteStorage } from '@btrade/storage';

const path = process.env.DB_PATH ?? './data/btrade.db';
if (path !== ':memory:' && !existsSync(path)) {
  console.error(`No DB at ${path}`);
  process.exit(1);
}
const probe = new SqliteStorage(path); // no account: nothing is assigned
const accounts = probe.accounts().filter((a) => a.account !== 'default');
const legacy = probe.hasLegacyData();
probe.close();
if (legacy && !process.env.ACCOUNT) {
  console.error('This DB has data not yet assigned to a wallet account. Start the bot once (it adopts the data for its wallet),');
  console.error('or set ACCOUNT=<wallet>:<chainId>:<BASE/QUOTE> explicitly to assign it.');
  process.exit(1);
}
if (process.argv.includes('--accounts')) {
  console.log('account                                                          trades  flows');
  for (const a of accounts) console.log(`${a.account.padEnd(64)} ${String(a.trades).padEnd(7)} ${a.flows}`);
  if (!accounts.length) console.log('(no accounts)');
  process.exit(0);
}
let account = process.env.ACCOUNT;
if (!account) {
  if (accounts.length !== 1) {
    console.error(accounts.length ? 'Several accounts in this DB; set ACCOUNT=<key> (see `pnpm report --accounts`):' : 'No accounts in this DB (start the bot once so it migrates legacy rows, or set ACCOUNT).');
    for (const a of accounts) console.error(`  ${a.account}  (${a.trades} trades)`);
    process.exit(1);
  }
  account = accounts[0]!.account;
}
const s = new SqliteStorage(path, { account });
const n = (v: number | null | undefined, d = 6) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));
const p = (v: number | null) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`);

// token decimals persisted by the bot at start (`pair_info`); fallback 18 / 6
const info = JSON.parse(s.state.get('pair_info') ?? '{}') as { baseDecimals?: number; quoteDecimals?: number };
const bDec = info.baseDecimals ?? 18;
const qDec = info.quoteDecimals ?? 6;
const fmtAmt = (v: bigint, dec: number) => toNumber(v, dec).toPrecision(8);
const inits = s.state.list('hodl_init:');
const last = s.portfolio.last();
const trades = s.trades.recent(1_000_000);
const flows = s.flows.all();
const netFlowQuote = flows.reduce((a, f) => a + f.valueQuote, 0);
const flowsUsdKnown = flows.every((f) => f.valueUsd !== null);
const netFlowUsd = flows.length === 0 ? 0 : flowsUsdKnown ? flows.reduce((a, f) => a + (f.valueUsd ?? 0), 0) : null;
const realizedQ = trades.reduce((a, t) => a + t.realizedPnlQuote, 0);
const realizedUsdTrades = trades.filter((t) => t.realizedPnlUsd !== null && t.realizedPnlUsd !== undefined);
const realizedUsd = realizedUsdTrades.length ? realizedUsdTrades.reduce((a, t) => a + (t.realizedPnlUsd ?? 0), 0) : null;

console.log(`== btrade report (${path}) ==\naccount: ${account}`);
if (!inits.length || !last) {
  console.log('No portfolio data yet (run the bot at least one tick).');
}
for (const { key, value } of inits) {
  if (!last) break;
  const init = JSON.parse(value) as HodlInit;
  const price = last.balanceBase > 0 ? (last.valueQuote - last.balanceQuote) / last.balanceBase : init.price;
  const usdNow = last.valueUsd;
  const px = price > 0 ? price : init.price;
  const m = portfolioMetrics(init, last.balanceBase, last.balanceQuote, px, null, null, flows);
  const invUsd = investedUsd(init, flows, null);
  const pnlUsdPct = invUsd !== null && usdNow !== null && invUsd > 0 ? (usdNow / invUsd - 1) * 100 : null;
  // stored hodl_value_* may predate the flows: recompute quote-side from balances; adjust USD by the flow value missing from it
  const hodlQ = valueInQuote(hodlBalances(init, flows).base, hodlBalances(init, flows).quote, px);
  const missingQ = hodlQ - last.hodlValueQuote;
  const hodlUsd = last.hodlValueUsd === null ? null : last.hodlValueUsd + (Math.abs(missingQ) > 1e-9 && netFlowUsd !== null ? netFlowUsd : 0);
  const hodlUsdPct = hodlUsd !== null && usdNow !== null && hodlUsd > 0 ? (usdNow / hodlUsd - 1) * 100 : null;
  console.log(`mode: ${key.slice('hodl_init:'.length)}   since: ${new Date(init.ts).toISOString()}   last snapshot: ${new Date(last.ts * 1000).toISOString()}`);
  console.log(`invested: ${n(m.investedQuote, 8)} quote / ${n(invUsd, 2)} USD  (start ${n(m.startValueQuote, 8)} + net flows)`);
  console.log(`value (quote): invested ${n(m.investedQuote, 8)} -> now ${n(last.valueQuote, 8)}   pnl vs invested (${p(m.pnlQuotePct)})`);
  console.log(`value (USD):   invested ${n(invUsd, 2)} -> now ${n(usdNow, 2)}   pnl vs invested (${p(pnlUsdPct)})`);
  console.log(`vs HODL (incl. flows): quote ${n(hodlQ, 8)} (${p(hodlQ > 0 ? (last.valueQuote / hodlQ - 1) * 100 : null)})   USD ${n(hodlUsd, 2)} (${p(hodlUsdPct)})`);
}
console.log(`flows: ${flows.length}   net deposits: ${n(netFlowQuote, 6)} quote / ${n(netFlowUsd, 2)} USD`);
console.log(`realized pnl: ${n(realizedQ, 8)} quote / ${n(realizedUsd, 4)} USD   trades: ${s.trades.count()}`);
if (flows.length) {
  console.log('\nLast flows (max 10):');
  console.log('id  time                  asset  amount          price         value_quote   value_usd');
  for (const f of s.flows.recent(10)) {
    console.log([
      String(f.id).padEnd(3), new Date(f.ts * 1000).toISOString().slice(0, 19).padEnd(21), f.asset.padEnd(6),
      f.amount.toFixed(6).padEnd(15), f.price.toPrecision(6).padEnd(13), n(f.valueQuote, 6).padEnd(13), n(f.valueUsd, 4),
    ].join(' '));
  }
}
console.log('\nLast 20 trades:');
console.log('id  time                  side  in(whole)     out(whole)        price         value_usd  pnl_quote     pnl_usd');
for (const t of s.trades.recent(20)) {
  console.log([
    String(t.id).padEnd(3), new Date(t.ts * 1000).toISOString().slice(0, 19).padEnd(21), t.side.padEnd(5),
    fmtAmt(t.amountIn, t.side === 'buy' ? qDec : bDec).padEnd(13), fmtAmt(t.amountOut, t.side === 'buy' ? bDec : qDec).padEnd(13), t.price.toPrecision(6).padEnd(13),
    n(t.valueUsd, 4).padEnd(10), n(t.realizedPnlQuote, 8).padEnd(13), n(t.realizedPnlUsd, 4),
  ].join(' '));
}
s.close();
