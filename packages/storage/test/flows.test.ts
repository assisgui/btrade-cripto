import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStorage, applyBuy, applyWithdrawal } from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('flows storage', () => {
  it('inserts and lists', () => {
    const s = new SqliteStorage(':memory:');
    s.flows.insert({ ts: 1, asset: 'quote', amount: 7, price: 0.02, valueQuote: 7, valueUsd: null });
    s.flows.insert({ ts: 2, asset: 'base', amount: -3, price: 0.02, valueQuote: -0.06, valueUsd: -0.06 });
    expect(s.flows.count()).toBe(2);
    expect(s.flows.all()[0]).toMatchObject({ asset: 'quote', amount: 7, valueUsd: null });
    expect(s.flows.recent(1)[0]?.asset).toBe('base');
  });
  it('migrates an existing DB (idempotent, data kept)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'btrade-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO bot_state VALUES ('hodl_init:live','{}');");
    old.close();
    for (let i = 0; i < 2; i++) {
      const s = new SqliteStorage(path, { account: 'x' });
      expect(s.flows.count()).toBe(i);
      s.flows.insert({ ts: 1, asset: 'quote', amount: 1, price: 1, valueQuote: 1, valueUsd: 1 });
      expect(s.state.get('hodl_init:live')).toBe('{}');
      s.close();
    }
  });
  it('base deposit = buy at flow price; withdrawal keeps entry, no realized', () => {
    const E = 10n ** 18n;
    const pos = { size: 100n * E, avgEntryPrice: 1, realizedPnlQuote: 0, updatedAt: 0 };
    const a = applyBuy(pos, 100n * E, 3, 18, 1);
    expect(a.avgEntryPrice).toBeCloseTo(2);
    const w = applyWithdrawal(a, 50n * E, 2);
    expect(w.size).toBe(150n * E);
    expect(w.avgEntryPrice).toBeCloseTo(2);
    expect(w.realizedPnlQuote).toBe(0);
  });
});
