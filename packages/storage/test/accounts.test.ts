import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteStorage } from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const tmp = () => join(mkdtempSync(join(tmpdir(), 'btrade-acc-')), 't.db');
const trade = (ts: number) => ({ ts, side: 'buy' as const, mode: 'live', tokenIn: '0x01' as never, tokenOut: '0x02' as never, amountIn: 1n, amountOut: 2n, price: 1, realizedPnlQuote: 0, txHash: null, paper: false });
const snap = { ts: 1, balanceBase: 1, balanceQuote: 1, valueQuote: 2, valueUsd: null, hodlValueQuote: 2, hodlValueUsd: null };

function legacyDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, side TEXT NOT NULL, mode TEXT NOT NULL, token_in TEXT NOT NULL, token_out TEXT NOT NULL, amount_in TEXT NOT NULL, amount_out TEXT NOT NULL, price REAL NOT NULL, realized_pnl_quote REAL NOT NULL DEFAULT 0, tx_hash TEXT, paper INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE positions (pair TEXT PRIMARY KEY, size TEXT NOT NULL, avg_entry_price REAL NOT NULL, realized_pnl_quote REAL NOT NULL DEFAULT 0, updated_at REAL NOT NULL);
    CREATE TABLE paper_balances (key TEXT PRIMARY KEY, amount TEXT NOT NULL);
    CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO trades (ts, side, mode, token_in, token_out, amount_in, amount_out, price) VALUES (5,'buy','live','a','b','1','2',1.5);
    INSERT INTO positions VALUES ('A/B','42',1.5,0.1,9);
    INSERT INTO paper_balances VALUES ('native','77');
    INSERT INTO bot_state VALUES ('hodl_init:live','{"x":1}'),('paused','1'),('pair_info','{}');`);
  db.close();
}

describe('account scoping', () => {
  it('two accounts in one DB are isolated', () => {
    const p = tmp();
    const a = new SqliteStorage(p, { account: 'w1:1:A/B' });
    const b = new SqliteStorage(p, { account: 'w2:1:A/B' });
    a.trades.insert(trade(1)); a.positions.save('A/B', { size: 5n, avgEntryPrice: 1, realizedPnlQuote: 0, updatedAt: 1 });
    a.flows.insert({ ts: 1, asset: 'quote', amount: 1, price: 1, valueQuote: 1, valueUsd: null });
    a.state.set('k', 'va'); a.portfolio.insert(snap); a.paperBalances.set('native', 1n);
    expect(b.trades.count()).toBe(0); expect(b.trades.last()).toBeNull(); expect(b.trades.since(0)).toEqual([]);
    expect(b.positions.get('A/B')).toBeNull(); expect(b.flows.all()).toEqual([]); expect(b.state.get('k')).toBeNull();
    expect(b.portfolio.last()).toBeNull(); expect(b.paperBalances.get('native')).toBeNull();
    b.positions.save('A/B', { size: 9n, avgEntryPrice: 2, realizedPnlQuote: 0, updatedAt: 1 });
    b.state.set('k', 'vb');
    expect(a.positions.get('A/B')?.size).toBe(5n); expect(a.state.get('k')).toBe('va'); expect(a.state.list('k')).toEqual([{ key: 'k', value: 'va' }]);
    expect(a.accounts().map((x) => x.account)).toEqual(['w1:1:A/B', 'w2:1:A/B']);
    b.state.setPaused(true); expect(a.state.isPaused()).toBe(true); // paused is global
    a.close(); b.close();
  });

  it('an account-less open (report probe) never steals legacy data; the wallet account adopts it afterwards', () => {
    const p = tmp();
    legacyDb(p);
    const probe = new SqliteStorage(p);
    expect(probe.hasLegacyData()).toBe(true);
    probe.close();
    const w = new SqliteStorage(p, { account: 'w1:143:A/B' });
    expect(w.trades.count()).toBe(1);
    expect(w.positions.get('A/B')?.size).toBe(42n);
    expect(w.paperBalances.get('native')).toBe(77n);
    expect(w.state.get('hodl_init:live')).toBe('{"x":1}');
    expect(w.state.isPaused()).toBe(true);
    expect(w.hasLegacyData()).toBe(false);
    expect(w.accounts().map((x) => x.account)).toEqual(['w1:143:A/B']);
    w.close();
  });

  it("prefers state parked under 'default|' over an unprefixed twin written later by a stale process", () => {
    const p = tmp();
    legacyDb(p);
    new SqliteStorage(p, { account: 'default' }).close(); // what an account-less open with the old logic did
    const db = new DatabaseSync(p);
    db.exec(`UPDATE bot_state SET key = 'default|' || key WHERE key = 'hodl_init:live';
      INSERT INTO bot_state VALUES ('hodl_init:live','{"stale":1}');`);
    db.close();
    const w = new SqliteStorage(p, { account: 'w1:143:A/B' });
    expect(w.state.get('hodl_init:live')).toBe('{"x":1}');
    expect(w.hasLegacyData()).toBe(false);
    w.close();
  });

  it('migrates legacy rows, renames state keys, rebuilds positions PK; idempotent', () => {
    const p = tmp(); legacyDb(p);
    const acc = 'w1:1:A/B';
    const s = new SqliteStorage(p, { account: acc });
    expect(s.migration.rows).toMatchObject({ trades: 1, positions: 1, paper_balances: 1 });
    expect(s.migration.stateKeys).toBe(2);
    expect(s.trades.count()).toBe(1);
    expect(s.positions.get('A/B')).toMatchObject({ size: 42n, avgEntryPrice: 1.5, realizedPnlQuote: 0.1, updatedAt: 9 });
    expect(s.paperBalances.get('native')).toBe(77n);
    expect(s.state.get('hodl_init:live')).toBe('{"x":1}'); expect(s.state.get('pair_info')).toBe('{}'); expect(s.state.isPaused()).toBe(true);
    expect(new SqliteStorage(p, { account: 'other' }).trades.count()).toBe(0);
    s.close();
    const again = new SqliteStorage(p, { account: acc });
    expect(again.migration).toMatchObject({ rows: {}, stateKeys: 0, rebuilt: [] });
    expect(again.trades.count()).toBe(1); expect(again.positions.get('A/B')?.size).toBe(42n);
    again.close();
  });
});
