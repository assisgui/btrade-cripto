import { describe, expect, it } from 'vitest';
import { SqliteStorage, applyBuy, applySell } from '../src/index.js';

describe('position math', () => {
  it('weighted avg on buy', () => {
    const p1 = applyBuy(null, 10n * 10n ** 18n, 2, 18, 0);
    const p2 = applyBuy(p1, 30n * 10n ** 18n, 4, 18, 0);
    expect(p2.avgEntryPrice).toBeCloseTo(3.5);
    expect(p2.size).toBe(40n * 10n ** 18n);
  });
  it('realized pnl on sell', () => {
    const p = applyBuy(null, 10n * 10n ** 18n, 2, 18, 0);
    const { position, realizedPnlQuote } = applySell(p, 4n * 10n ** 18n, 3, 18, 0);
    expect(realizedPnlQuote).toBeCloseTo(4);
    expect(position.size).toBe(6n * 10n ** 18n);
    expect(position.avgEntryPrice).toBe(2);
  });
});

describe('SqliteStorage', () => {
  it('roundtrips repos', () => {
    const s = new SqliteStorage(':memory:');
    s.paperBalances.set('native', 123456789012345678901n);
    expect(s.paperBalances.get('native')).toBe(123456789012345678901n);
    expect(s.paperBalances.get('x')).toBeNull();
    s.state.setPaused(true);
    expect(s.state.isPaused()).toBe(true);
    s.positions.save('A/B', { size: 5n, avgEntryPrice: 1.5, realizedPnlQuote: 0, updatedAt: 1 });
    expect(s.positions.get('A/B')?.size).toBe(5n);
    s.trades.insert({ ts: 10, side: 'buy', mode: 'paper', tokenIn: '0x01', tokenOut: '0x02', amountIn: 1n, amountOut: 2n, price: 1, realizedPnlQuote: 0, txHash: null, paper: true });
    expect(s.trades.last()?.amountOut).toBe(2n);
    expect(s.trades.since(11)).toHaveLength(0);
    s.close();
  });
});

describe('migration', () => {
  it('upgrades a pre-USD DB in place and is idempotent', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const path = join(mkdtempSync(join(tmpdir(), 'btrade-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, side TEXT NOT NULL, mode TEXT NOT NULL,
      token_in TEXT NOT NULL, token_out TEXT NOT NULL, amount_in TEXT NOT NULL, amount_out TEXT NOT NULL, price REAL NOT NULL,
      realized_pnl_quote REAL NOT NULL DEFAULT 0, tx_hash TEXT, paper INTEGER NOT NULL DEFAULT 0);
      INSERT INTO trades (ts, side, mode, token_in, token_out, amount_in, amount_out, price) VALUES (1,'buy','paper','0x1','0x2','1','2',3);`);
    old.close();
    for (let i = 0; i < 2; i++) {
      const s = new SqliteStorage(path, { account: 'x' });
      expect(s.trades.last()?.valueUsd).toBeNull();
      s.close();
    }
    const s = new SqliteStorage(path, { account: 'x' });
    s.trades.insert({ ts: 2, side: 'sell', mode: 'paper', tokenIn: '0x02', tokenOut: '0x01', amountIn: 1n, amountOut: 1n, price: 1, realizedPnlQuote: 0.5, txHash: null, paper: true, valueUsd: 10, gasUsd: 0.1, realizedPnlUsd: 5 });
    expect(s.trades.last()?.realizedPnlUsd).toBe(5);
    s.portfolio.insert({ ts: 1, balanceBase: 1, balanceQuote: 2, valueQuote: 3, valueUsd: null, hodlValueQuote: 3, hodlValueUsd: null });
    expect(s.portfolio.last()?.valueQuote).toBe(3);
    expect(s.trades.count()).toBe(2);
    s.state.set('hodl_init:paper', '{}');
    expect(s.state.list('hodl_init:')).toHaveLength(1);
    s.close();
  });
});
