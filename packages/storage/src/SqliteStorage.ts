import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Decision, IBotStateRepository, IDecisionLogRepository, IPaperBalanceRepository, IPositionRepository, IStorage,
  ITradeRepository, MarketSnapshot, Position, Trade, IPortfolioRepository, PortfolioSnapshot, Flow, IFlowRepository,
} from '@btrade/core';

// loaded via require: vite/vitest can't resolve the `node:sqlite` builtin through static import
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncT;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

class TradeRepo implements ITradeRepository {
  constructor(private db: DatabaseSync) {}
  insert(t: Trade): void {
    this.db.prepare(
      'INSERT INTO trades (ts, side, mode, token_in, token_out, amount_in, amount_out, price, realized_pnl_quote, tx_hash, paper, value_usd, gas_usd, realized_pnl_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(t.ts, t.side, t.mode, t.tokenIn, t.tokenOut, t.amountIn.toString(), t.amountOut.toString(), t.price, t.realizedPnlQuote, t.txHash, t.paper ? 1 : 0, t.valueUsd ?? null, t.gasUsd ?? null, t.realizedPnlUsd ?? null);
  }
  recent(limit: number): Trade[] {
    return this.db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit).map((r) => this.map(r));
  }
  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM trades').get() as { n: number }).n);
  }
  private map(r: Record<string, unknown>): Trade {
    return {
      id: r.id as number, ts: r.ts as number, side: r.side as 'buy' | 'sell', mode: r.mode as string,
      tokenIn: r.token_in as Trade['tokenIn'], tokenOut: r.token_out as Trade['tokenOut'],
      amountIn: BigInt(r.amount_in as string), amountOut: BigInt(r.amount_out as string), price: r.price as number,
      realizedPnlQuote: r.realized_pnl_quote as number, txHash: (r.tx_hash as string | null) ?? null, paper: r.paper === 1,
      valueUsd: (r.value_usd as number | null) ?? null, gasUsd: (r.gas_usd as number | null) ?? null, realizedPnlUsd: (r.realized_pnl_usd as number | null) ?? null,
    };
  }
  last(): Trade | null {
    const r = this.db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 1').get();
    return r ? this.map(r) : null;
  }
  since(ts: number): Trade[] {
    return this.db.prepare('SELECT * FROM trades WHERE ts >= ? ORDER BY id ASC').all(ts).map((r) => this.map(r));
  }
}

class PositionRepo implements IPositionRepository {
  constructor(private db: DatabaseSync) {}
  get(key: string): Position | null {
    const r = this.db.prepare('SELECT * FROM positions WHERE pair = ?').get(key);
    return r
      ? { size: BigInt(r.size as string), avgEntryPrice: r.avg_entry_price as number, realizedPnlQuote: r.realized_pnl_quote as number, updatedAt: r.updated_at as number }
      : null;
  }
  save(key: string, p: Position): void {
    this.db.prepare(
      'INSERT INTO positions (pair, size, avg_entry_price, realized_pnl_quote, updated_at) VALUES (?,?,?,?,?) ' +
      'ON CONFLICT(pair) DO UPDATE SET size=excluded.size, avg_entry_price=excluded.avg_entry_price, realized_pnl_quote=excluded.realized_pnl_quote, updated_at=excluded.updated_at',
    ).run(key, p.size.toString(), p.avgEntryPrice, p.realizedPnlQuote, p.updatedAt);
  }
}

class DecisionLogRepo implements IDecisionLogRepository {
  constructor(private db: DatabaseSync) {}
  log(e: { ts: number; snapshot: MarketSnapshot; decision: Decision | null; outcome: string }): void {
    this.db.prepare('INSERT INTO decision_log (ts, snapshot, decision, outcome) VALUES (?,?,?,?)')
      .run(e.ts, json(e.snapshot), e.decision ? json(e.decision) : null, e.outcome);
  }
}

class PaperBalanceRepo implements IPaperBalanceRepository {
  constructor(private db: DatabaseSync) {}
  get(key: string): bigint | null {
    const r = this.db.prepare('SELECT amount FROM paper_balances WHERE key = ?').get(key);
    return r ? BigInt(r.amount as string) : null;
  }
  set(key: string, amount: bigint): void {
    this.db.prepare('INSERT INTO paper_balances (key, amount) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET amount=excluded.amount')
      .run(key, amount.toString());
  }
}

class BotStateRepo implements IBotStateRepository {
  constructor(private db: DatabaseSync) {}
  get(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key);
    return r ? (r.value as string) : null;
  }
  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO bot_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  isPaused(): boolean {
    return this.get('paused') === '1';
  }
  setPaused(p: boolean): void {
    this.set('paused', p ? '1' : '0');
  }
  list(prefix: string): { key: string; value: string }[] {
    return this.db.prepare('SELECT key, value FROM bot_state WHERE substr(key, 1, ?) = ? ORDER BY key').all(prefix.length, prefix)
      .map((r) => ({ key: r.key as string, value: r.value as string }));
  }
}

class PortfolioRepo implements IPortfolioRepository {
  constructor(private db: DatabaseSync) {}
  insert(s: PortfolioSnapshot): void {
    this.db.prepare(
      'INSERT INTO portfolio_snapshots (ts, balance_base, balance_quote, value_quote, value_usd, hodl_value_quote, hodl_value_usd) VALUES (?,?,?,?,?,?,?)',
    ).run(s.ts, s.balanceBase, s.balanceQuote, s.valueQuote, s.valueUsd, s.hodlValueQuote, s.hodlValueUsd);
  }
  private map(r: Record<string, unknown> | undefined): PortfolioSnapshot | null {
    if (!r) return null;
    return {
      ts: r.ts as number, balanceBase: r.balance_base as number, balanceQuote: r.balance_quote as number, valueQuote: r.value_quote as number,
      valueUsd: (r.value_usd as number | null) ?? null, hodlValueQuote: r.hodl_value_quote as number, hodlValueUsd: (r.hodl_value_usd as number | null) ?? null,
    };
  }
  first(): PortfolioSnapshot | null {
    return this.map(this.db.prepare('SELECT * FROM portfolio_snapshots ORDER BY id ASC LIMIT 1').get());
  }
  last(): PortfolioSnapshot | null {
    return this.map(this.db.prepare('SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT 1').get());
  }
}

class FlowRepo implements IFlowRepository {
  constructor(private db: DatabaseSync) {}
  insert(f: Flow): void {
    this.db.prepare('INSERT INTO flows (ts, asset, amount, price, value_quote, value_usd) VALUES (?,?,?,?,?,?)')
      .run(f.ts, f.asset, f.amount, f.price, f.valueQuote, f.valueUsd);
  }
  private map(r: Record<string, unknown>): Flow {
    return {
      id: r.id as number, ts: r.ts as number, asset: r.asset as 'base' | 'quote', amount: r.amount as number, price: r.price as number,
      valueQuote: r.value_quote as number, valueUsd: (r.value_usd as number | null) ?? null,
    };
  }
  all(): Flow[] {
    return this.db.prepare('SELECT * FROM flows ORDER BY id ASC').all().map((r) => this.map(r));
  }
  recent(limit: number): Flow[] {
    return this.db.prepare('SELECT * FROM flows ORDER BY id DESC LIMIT ?').all(limit).map((r) => this.map(r));
  }
  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM flows').get() as { n: number }).n);
  }
}

/** Idempotent: adds a column only when missing (existing DBs keep working). */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export class SqliteStorage implements IStorage {
  private readonly db: DatabaseSync;
  readonly trades: ITradeRepository;
  readonly positions: IPositionRepository;
  readonly decisions: IDecisionLogRepository;
  readonly paperBalances: IPaperBalanceRepository;
  readonly state: IBotStateRepository;
  readonly portfolio: IPortfolioRepository;
  readonly flows: IFlowRepository;

  /** path ':memory:' for tests */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, side TEXT NOT NULL, mode TEXT NOT NULL,
        token_in TEXT NOT NULL, token_out TEXT NOT NULL, amount_in TEXT NOT NULL, amount_out TEXT NOT NULL, price REAL NOT NULL,
        realized_pnl_quote REAL NOT NULL DEFAULT 0, tx_hash TEXT, paper INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS positions (pair TEXT PRIMARY KEY, size TEXT NOT NULL, avg_entry_price REAL NOT NULL,
        realized_pnl_quote REAL NOT NULL DEFAULT 0, updated_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, snapshot TEXT NOT NULL, decision TEXT, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_balances (key TEXT PRIMARY KEY, amount TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, balance_base REAL NOT NULL,
        balance_quote REAL NOT NULL, value_quote REAL NOT NULL, value_usd REAL, hodl_value_quote REAL NOT NULL, hodl_value_usd REAL);
      CREATE TABLE IF NOT EXISTS flows (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, asset TEXT NOT NULL, amount REAL NOT NULL,
        price REAL NOT NULL, value_quote REAL NOT NULL, value_usd REAL);
    `);
    for (const c of ['value_usd', 'gas_usd', 'realized_pnl_usd']) addColumnIfMissing(this.db, 'trades', c, 'REAL');
    this.trades = new TradeRepo(this.db);
    this.positions = new PositionRepo(this.db);
    this.decisions = new DecisionLogRepo(this.db);
    this.paperBalances = new PaperBalanceRepo(this.db);
    this.state = new BotStateRepo(this.db);
    this.portfolio = new PortfolioRepo(this.db);
    this.flows = new FlowRepo(this.db);
  }

  close(): void {
    this.db.close();
  }
}
