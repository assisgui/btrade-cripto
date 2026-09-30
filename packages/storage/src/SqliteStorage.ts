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
  constructor(private db: DatabaseSync, private account: string) {}
  insert(t: Trade): void {
    this.db.prepare(
      'INSERT INTO trades (ts, side, mode, token_in, token_out, amount_in, amount_out, price, realized_pnl_quote, tx_hash, paper, value_usd, gas_usd, realized_pnl_usd, account) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(t.ts, t.side, t.mode, t.tokenIn, t.tokenOut, t.amountIn.toString(), t.amountOut.toString(), t.price, t.realizedPnlQuote, t.txHash, t.paper ? 1 : 0, t.valueUsd ?? null, t.gasUsd ?? null, t.realizedPnlUsd ?? null, this.account);
  }
  recent(limit: number): Trade[] {
    return this.db.prepare('SELECT * FROM trades WHERE account = ? ORDER BY id DESC LIMIT ?').all(this.account, limit).map((r) => this.map(r));
  }
  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM trades WHERE account = ?').get(this.account) as { n: number }).n);
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
    const r = this.db.prepare('SELECT * FROM trades WHERE account = ? ORDER BY id DESC LIMIT 1').get(this.account);
    return r ? this.map(r) : null;
  }
  since(ts: number): Trade[] {
    return this.db.prepare('SELECT * FROM trades WHERE account = ? AND ts >= ? ORDER BY id ASC').all(this.account, ts).map((r) => this.map(r));
  }
}

class PositionRepo implements IPositionRepository {
  constructor(private db: DatabaseSync, private account: string) {}
  get(key: string): Position | null {
    const r = this.db.prepare('SELECT * FROM positions WHERE account = ? AND pair = ?').get(this.account, key);
    return r
      ? { size: BigInt(r.size as string), avgEntryPrice: r.avg_entry_price as number, realizedPnlQuote: r.realized_pnl_quote as number, updatedAt: r.updated_at as number }
      : null;
  }
  save(key: string, p: Position): void {
    this.db.prepare(
      'INSERT INTO positions (account, pair, size, avg_entry_price, realized_pnl_quote, updated_at) VALUES (?,?,?,?,?,?) ' +
      'ON CONFLICT(account, pair) DO UPDATE SET size=excluded.size, avg_entry_price=excluded.avg_entry_price, realized_pnl_quote=excluded.realized_pnl_quote, updated_at=excluded.updated_at',
    ).run(this.account, key, p.size.toString(), p.avgEntryPrice, p.realizedPnlQuote, p.updatedAt);
  }
}

class DecisionLogRepo implements IDecisionLogRepository {
  constructor(private db: DatabaseSync, private account: string) {}
  log(e: { ts: number; snapshot: MarketSnapshot; decision: Decision | null; outcome: string }): void {
    this.db.prepare('INSERT INTO decision_log (ts, snapshot, decision, outcome, account) VALUES (?,?,?,?,?)')
      .run(e.ts, json(e.snapshot), e.decision ? json(e.decision) : null, e.outcome, this.account);
  }
}

class PaperBalanceRepo implements IPaperBalanceRepository {
  constructor(private db: DatabaseSync, private account: string) {}
  get(key: string): bigint | null {
    const r = this.db.prepare('SELECT amount FROM paper_balances WHERE account = ? AND key = ?').get(this.account, key);
    return r ? BigInt(r.amount as string) : null;
  }
  set(key: string, amount: bigint): void {
    this.db.prepare('INSERT INTO paper_balances (account, key, amount) VALUES (?,?,?) ON CONFLICT(account, key) DO UPDATE SET amount=excluded.amount')
      .run(this.account, key, amount.toString());
  }
}

class BotStateRepo implements IBotStateRepository {
  constructor(private db: DatabaseSync, private account: string) {}
  private k(key: string): string {
    return GLOBAL_STATE_KEYS.has(key) ? key : `${this.account}|${key}`;
  }
  get(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM bot_state WHERE key = ?').get(this.k(key));
    return r ? (r.value as string) : null;
  }
  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO bot_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.k(key), value);
  }
  isPaused(): boolean {
    return this.get('paused') === '1';
  }
  setPaused(p: boolean): void {
    this.set('paused', p ? '1' : '0');
  }
  list(prefix: string): { key: string; value: string }[] {
    const full = `${this.account}|${prefix}`;
    const cut = this.account.length + 1;
    return this.db.prepare('SELECT key, value FROM bot_state WHERE substr(key, 1, ?) = ? ORDER BY key').all(full.length, full)
      .map((r) => ({ key: (r.key as string).slice(cut), value: r.value as string }));
  }
}

class PortfolioRepo implements IPortfolioRepository {
  constructor(private db: DatabaseSync, private account: string) {}
  insert(s: PortfolioSnapshot): void {
    this.db.prepare(
      'INSERT INTO portfolio_snapshots (ts, balance_base, balance_quote, value_quote, value_usd, hodl_value_quote, hodl_value_usd, account) VALUES (?,?,?,?,?,?,?,?)',
    ).run(s.ts, s.balanceBase, s.balanceQuote, s.valueQuote, s.valueUsd, s.hodlValueQuote, s.hodlValueUsd, this.account);
  }
  private map(r: Record<string, unknown> | undefined): PortfolioSnapshot | null {
    if (!r) return null;
    return {
      ts: r.ts as number, balanceBase: r.balance_base as number, balanceQuote: r.balance_quote as number, valueQuote: r.value_quote as number,
      valueUsd: (r.value_usd as number | null) ?? null, hodlValueQuote: r.hodl_value_quote as number, hodlValueUsd: (r.hodl_value_usd as number | null) ?? null,
    };
  }
  first(): PortfolioSnapshot | null {
    return this.map(this.db.prepare('SELECT * FROM portfolio_snapshots WHERE account = ? ORDER BY id ASC LIMIT 1').get(this.account));
  }
  last(): PortfolioSnapshot | null {
    return this.map(this.db.prepare('SELECT * FROM portfolio_snapshots WHERE account = ? ORDER BY id DESC LIMIT 1').get(this.account));
  }
}

class FlowRepo implements IFlowRepository {
  constructor(private db: DatabaseSync, private account: string) {}
  insert(f: Flow): void {
    this.db.prepare('INSERT INTO flows (ts, asset, amount, price, value_quote, value_usd, account) VALUES (?,?,?,?,?,?,?)')
      .run(f.ts, f.asset, f.amount, f.price, f.valueQuote, f.valueUsd, this.account);
  }
  private map(r: Record<string, unknown>): Flow {
    return {
      id: r.id as number, ts: r.ts as number, asset: r.asset as 'base' | 'quote', amount: r.amount as number, price: r.price as number,
      valueQuote: r.value_quote as number, valueUsd: (r.value_usd as number | null) ?? null,
    };
  }
  all(): Flow[] {
    return this.db.prepare('SELECT * FROM flows WHERE account = ? ORDER BY id ASC').all(this.account).map((r) => this.map(r));
  }
  recent(limit: number): Flow[] {
    return this.db.prepare('SELECT * FROM flows WHERE account = ? ORDER BY id DESC LIMIT ?').all(this.account, limit).map((r) => this.map(r));
  }
  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM flows WHERE account = ?').get(this.account) as { n: number }).n);
  }
}

/** Idempotent: adds a column only when missing (existing DBs keep working). */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export interface StorageOptions {
  /** account key `${wallet}:${chainId}:${pairKey}`. When given, legacy rows (NULL account) are migrated to it. */
  account?: string;
}
export interface MigrationReport { account: string; rows: Record<string, number>; stateKeys: number; rebuilt: string[] }

const DEFAULT_ACCOUNT = 'default';
/** state keys shared by all accounts */
const GLOBAL_STATE_KEYS = new Set(['paused']);
const SCOPED_TABLES = ['trades', 'flows', 'portfolio_snapshots', 'decision_log'] as const;

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

export class SqliteStorage implements IStorage {
  private readonly db: DatabaseSync;
  readonly account: string;
  /** what the startup migration changed (all zero on a migrated DB) */
  readonly migration: MigrationReport;
  readonly trades: ITradeRepository;
  readonly positions: IPositionRepository;
  readonly decisions: IDecisionLogRepository;
  readonly paperBalances: IPaperBalanceRepository;
  readonly state: IBotStateRepository;
  readonly portfolio: IPortfolioRepository;
  readonly flows: IFlowRepository;

  /** path ':memory:' for tests */
  constructor(path: string, opts: StorageOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.account = opts.account ?? DEFAULT_ACCOUNT;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, side TEXT NOT NULL, mode TEXT NOT NULL,
        token_in TEXT NOT NULL, token_out TEXT NOT NULL, amount_in TEXT NOT NULL, amount_out TEXT NOT NULL, price REAL NOT NULL,
        realized_pnl_quote REAL NOT NULL DEFAULT 0, tx_hash TEXT, paper INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS positions (account TEXT NOT NULL, pair TEXT NOT NULL, size TEXT NOT NULL, avg_entry_price REAL NOT NULL,
        realized_pnl_quote REAL NOT NULL DEFAULT 0, updated_at REAL NOT NULL, PRIMARY KEY (account, pair));
      CREATE TABLE IF NOT EXISTS decision_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, snapshot TEXT NOT NULL, decision TEXT, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_balances (account TEXT NOT NULL, key TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (account, key));
      CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, balance_base REAL NOT NULL,
        balance_quote REAL NOT NULL, value_quote REAL NOT NULL, value_usd REAL, hodl_value_quote REAL NOT NULL, hodl_value_usd REAL);
      CREATE TABLE IF NOT EXISTS flows (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, asset TEXT NOT NULL, amount REAL NOT NULL,
        price REAL NOT NULL, value_quote REAL NOT NULL, value_usd REAL);
    `);
    for (const c of ['value_usd', 'gas_usd', 'realized_pnl_usd']) addColumnIfMissing(this.db, 'trades', c, 'REAL');
    // only an explicit, real account adopts legacy rows; opening without one (e.g. the report probe) never assigns data
    this.migration = this.migrate(opts.account !== undefined && opts.account !== DEFAULT_ACCOUNT);
    this.trades = new TradeRepo(this.db, this.account);
    this.positions = new PositionRepo(this.db, this.account);
    this.decisions = new DecisionLogRepo(this.db, this.account);
    this.paperBalances = new PaperBalanceRepo(this.db, this.account);
    this.state = new BotStateRepo(this.db, this.account);
    this.portfolio = new PortfolioRepo(this.db, this.account);
    this.flows = new FlowRepo(this.db, this.account);
  }

  /** Idempotent schema + data migration to account scoping, in one transaction. Legacy rows go to this.account. */
  private migrate(assignLegacy: boolean): MigrationReport {
    const rep: MigrationReport = { account: this.account, rows: {}, stateKeys: 0, rebuilt: [] };
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of SCOPED_TABLES) addColumnIfMissing(db, t, 'account', 'TEXT');
      // PK changes need a table rebuild: create new, copy (legacy rows -> this.account), drop, rename
      if (!hasColumn(db, 'positions', 'account')) {
        db.exec(`ALTER TABLE positions RENAME TO positions_old;
          CREATE TABLE positions (account TEXT NOT NULL, pair TEXT NOT NULL, size TEXT NOT NULL, avg_entry_price REAL NOT NULL,
            realized_pnl_quote REAL NOT NULL DEFAULT 0, updated_at REAL NOT NULL, PRIMARY KEY (account, pair));`);
        const r = db.prepare('INSERT INTO positions (account, pair, size, avg_entry_price, realized_pnl_quote, updated_at) SELECT ?, pair, size, avg_entry_price, realized_pnl_quote, updated_at FROM positions_old').run(this.account);
        db.exec('DROP TABLE positions_old');
        rep.rows.positions = Number(r.changes); rep.rebuilt.push('positions');
      }
      if (!hasColumn(db, 'paper_balances', 'account')) {
        db.exec(`ALTER TABLE paper_balances RENAME TO paper_balances_old;
          CREATE TABLE paper_balances (account TEXT NOT NULL, key TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (account, key));`);
        const r = db.prepare('INSERT INTO paper_balances (account, key, amount) SELECT ?, key, amount FROM paper_balances_old').run(this.account);
        db.exec('DROP TABLE paper_balances_old');
        rep.rows.paper_balances = Number(r.changes); rep.rebuilt.push('paper_balances');
      }
      if (assignLegacy) {
        for (const t of [...SCOPED_TABLES, 'positions', 'paper_balances'] as const) {
          // legacy = never assigned (NULL) or parked under the placeholder by an account-less open (positions/paper_balances rebuild)
          const n = Number(db.prepare(`UPDATE OR IGNORE ${t} SET account = ? WHERE account IS NULL OR account = '${DEFAULT_ACCOUNT}'`).run(this.account).changes);
          if (n) rep.rows[t] = n;
        }
        // unprefixed (legacy) state keys -> `${account}|key`; keys containing '|' are already scoped
        const dflt = `${DEFAULT_ACCOUNT}|`;
        // 'default|' keys first: they hold the original state parked by an account-less open; an unprefixed twin can only
        // have been written afterwards by a stale pre-scoping process and must not win (INSERT OR IGNORE keeps the first)
        const legacy = db.prepare(
          "SELECT key, value FROM bot_state WHERE instr(key, '|') = 0 OR substr(key, 1, ?) = ? ORDER BY substr(key, 1, ?) = ? DESC, key",
        ).all(dflt.length, dflt, dflt.length, dflt) as { key: string; value: string }[];
        for (const { key, value } of legacy) {
          const bare = key.startsWith(dflt) ? key.slice(dflt.length) : key;
          if (GLOBAL_STATE_KEYS.has(bare)) continue;
          db.prepare('INSERT OR IGNORE INTO bot_state (key, value) VALUES (?,?)').run(`${this.account}|${bare}`, value);
          db.prepare('DELETE FROM bot_state WHERE key = ?').run(key);
          rep.stateKeys++;
        }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_account_ts ON trades (account, ts);
        CREATE INDEX IF NOT EXISTS idx_flows_account_ts ON flows (account, ts);
        CREATE INDEX IF NOT EXISTS idx_portfolio_account_ts ON portfolio_snapshots (account, ts);
        CREATE INDEX IF NOT EXISTS idx_decision_account_ts ON decision_log (account, ts);`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return rep;
  }

  /** True when the DB holds rows/state not yet assigned to a real account (pre-scoping data). */
  hasLegacyData(): boolean {
    const scoped = SCOPED_TABLES.some((t) =>
      hasColumn(this.db, t, 'account') &&
      (this.db.prepare(`SELECT 1 FROM ${t} WHERE account IS NULL OR account = '${DEFAULT_ACCOUNT}' LIMIT 1`).get() !== undefined));
    const keyed = ['positions', 'paper_balances'].some((t) =>
      this.db.prepare(`SELECT 1 FROM ${t} WHERE account = '${DEFAULT_ACCOUNT}' LIMIT 1`).get() !== undefined);
    const state = (this.db.prepare("SELECT key FROM bot_state WHERE instr(key, '|') = 0 OR key LIKE 'default|%'").all() as { key: string }[])
      .some(({ key }) => !GLOBAL_STATE_KEYS.has(key.replace(/^default\|/, '')));
    return scoped || keyed || state;
  }

  /** All accounts present in the DB (any table) with their trade/flow counts. */
  accounts(): { account: string; trades: number; flows: number }[] {
    const rows = this.db.prepare(
      `SELECT account, SUM(t) AS trades, SUM(f) AS flows FROM (
         SELECT account, COUNT(*) AS t, 0 AS f FROM trades GROUP BY account
         UNION ALL SELECT account, 0, COUNT(*) FROM flows GROUP BY account
         UNION ALL SELECT account, 0, 0 FROM positions GROUP BY account
         UNION ALL SELECT account, 0, 0 FROM portfolio_snapshots GROUP BY account
       ) WHERE account IS NOT NULL GROUP BY account ORDER BY account`,
    ).all() as { account: string; trades: number; flows: number }[];
    return rows.map((r) => ({ account: r.account, trades: Number(r.trades), flows: Number(r.flows) }));
  }

  close(): void {
    this.db.close();
  }
}
