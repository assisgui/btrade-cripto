import { z } from 'zod';
import { isLocalRpc } from './localRpc.js';

const num = (def: number) => z.coerce.number().default(def);
const bool = (def: boolean) =>
  z.enum(['true', 'false']).default(def ? 'true' : 'false').transform((v) => v === 'true');
const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);
const optStr = z.string().optional().transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  MODE: z.enum(['paper', 'testnet', 'fork', 'live']).default('paper'),
  CONFIRM_LIVE: bool(false),
  CHAIN: z.string().default('monad'),
  DEX: z.enum(['uniswap-v3', 'pancakeswap-v3']).default('uniswap-v3'),
  RPC_URL: optStr,
  /** MODE=fork only: local anvil fork of Monad mainnet (must be localhost) */
  FORK_RPC_URL: z.string().default('http://127.0.0.1:8545'),
  PRIVATE_KEY: optStr,
  BASE_TOKEN: z.string().default('native'),
  QUOTE_TOKEN: z.string().default('WBTC'),
  // chain/DEX address overrides (needed for testnet)
  WRAPPED_NATIVE_ADDRESS: optStr,
  UNISWAP_V3_FACTORY: optStr,
  UNISWAP_V3_ROUTER: optStr,
  UNISWAP_V3_QUOTER: optStr,

  DECISION_ENGINE: z.enum(['jev', 'mock']).default('mock'),
  TYPESAFE_API_KEY: optStr,
  JEV_MODEL: z.string().default('jev-latest'),
  MOCK_MODE: z.enum(['random', 'fixed']).default('random'),
  MOCK_ACTION: z.enum(['buy', 'sell', 'hold']).default('hold'),

  POLL_INTERVAL_SEC: num(60),
  CHANGE_THRESHOLD_BPS: num(15),
  HEARTBEAT_SEC: num(900),
  CANDLE_REFRESH_SEC: num(300),
  GECKO_NETWORK: optStr,
  GECKO_POOL: optStr,
  MAX_TICKS: z.preprocess(emptyToUndef, z.coerce.number().int().optional()),

  PAPER_BALANCE_BASE: num(1000),
  PAPER_BALANCE_QUOTE: num(0.001),
  PAPER_BALANCE_NATIVE: num(10),
  INITIAL_COST_BASIS: z.preprocess(emptyToUndef, z.coerce.number().positive().optional()),
  PROBE_BASE_FALLBACK: num(1),
  SWAP_GAS_UNITS: z.coerce.bigint().default(300000n),

  // risk
  MIN_CONFIDENCE: num(0.6),
  GAS_RESERVE_NATIVE: num(10.5),
  SIZE_SMALL_PCT: num(10),
  SIZE_MEDIUM_PCT: num(25),
  SIZE_LARGE_PCT: num(50),
  MIN_PROFIT_PCT: num(1),
  STOP_LOSS_PCT: num(0),
  MAX_SLIPPAGE_BPS: num(50),
  MAX_PRICE_IMPACT_BPS: num(100),
  MIN_TRADE_VALUE: num(0.00001),
  /** hard cap per trade in QUOTE units (amount is clamped); 0 disables */
  MAX_TRADE_VALUE: num(0),
  MAX_GAS_COST_PCT: num(2),
  TRADE_COOLDOWN_SEC: num(600),
  MAX_TRADES_PER_DAY: num(6),
  MAX_DAILY_LOSS_PCT: num(5),

  FLOW_TOLERANCE_NATIVE: num(0.5),
  USD_ORACLE: z.enum(['onchain', 'off']).default('onchain'),
  PORTFOLIO_SNAPSHOT_SEC: num(300),

  DB_PATH: z.string().default('./data/btrade.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  if (c.PRIVATE_KEY && /^[0-9a-fA-F]{64}$/.test(c.PRIVATE_KEY)) c.PRIVATE_KEY = `0x${c.PRIVATE_KEY}`; // accept key without 0x prefix
  if (c.MODE === 'live' && !c.CONFIRM_LIVE) throw new Error('MODE=live requires CONFIRM_LIVE=true');
  if (c.MODE === 'fork' && !isLocalRpc(c.FORK_RPC_URL)) throw new Error('MODE=fork refuses to run: FORK_RPC_URL host must be localhost/127.0.0.1');
  if (c.MODE !== 'paper' && !c.PRIVATE_KEY) throw new Error(`MODE=${c.MODE} requires PRIVATE_KEY`);
  if (c.PRIVATE_KEY && !/^0x[0-9a-fA-F]{64}$/.test(c.PRIVATE_KEY)) throw new Error('PRIVATE_KEY must be 0x + 64 hex chars');
  if (c.DECISION_ENGINE === 'jev' && !c.TYPESAFE_API_KEY) throw new Error('DECISION_ENGINE=jev requires TYPESAFE_API_KEY');
  return c;
}
