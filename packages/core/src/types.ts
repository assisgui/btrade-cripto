export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/**
 * A tradeable token. For the chain's native coin, `native` is true and `address`
 * is the wrapped-native contract (used for routing).
 */
export interface Token {
  symbol: string;
  address: Address;
  decimals: number;
  native: boolean;
}

/** BASE is what we accumulate/hold; QUOTE is the pricing asset. Price = QUOTE per BASE. */
export interface Pair {
  base: Token;
  quote: Token;
}

export interface Candle {
  /** unix seconds, candle open */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = 'minute' | 'hour' | 'day';

export interface Indicators {
  return5m: number | null;
  return1h: number | null;
  return24h: number | null;
  volatility: number | null;
  emaShort: number | null;
  emaLong: number | null;
  rsi14: number | null;
  /** last closes of the short (5m) candles, ascending, raw prices */
  recentCloses?: number[] | null;
}

export interface Position {
  /** size of BASE held as tracked by cost basis (raw units) */
  size: bigint;
  /** average entry price, QUOTE per BASE */
  avgEntryPrice: number;
  realizedPnlQuote: number;
  updatedAt: number;
}

export type Action = 'buy' | 'sell' | 'hold';
export type SizeBucket = 'small' | 'medium' | 'large';

export interface Decision {
  action: Action;
  sizeBucket: SizeBucket;
  confidence: number;
  probabilities: Record<Action, number>;
  /** P(yes) of the engine's separate 'good moment to buy back?' question, when asked */
  buybackProbability?: number;
  raw: unknown;
}

export interface MarketSnapshot {
  timestamp: number;
  pair: Pair;
  /** mid of executable buy/sell price, QUOTE per BASE */
  price: number;
  priceBuy: number | null;
  priceSell: number | null;
  poolLiquidity: bigint | null;
  priceImpactBps: { buy: number | null; sell: number | null };
  /** wei */
  gasPrice: bigint;
  /** estimated cost of one swap in native units (wei) */
  estGasCostNative: bigint;
  balances: { native: bigint; base: bigint; quote: bigint };
  position: Position | null;
  unrealizedPnlPct: number | null;
  secondsSinceLastTrade: number | null;
  lastDecision: { action: Action; confidence: number; at: number } | null;
  indicators: Indicators | null;
  /** reporting-only USD valuation; null when the oracle is off/unavailable */
  usd: UsdValuation | null;
}

export interface UsdValuation {
  monUsd: number;
  quoteUsd: number;
  portfolioUsd: number;
}

export interface Trade {
  id?: number;
  ts: number;
  side: 'buy' | 'sell';
  mode: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  /** QUOTE per BASE */
  price: number;
  realizedPnlQuote: number;
  txHash: string | null;
  paper: boolean;
  /** reporting-only USD values (null when no oracle) */
  valueUsd?: number | null;
  gasUsd?: number | null;
  realizedPnlUsd?: number | null;
}

export interface PortfolioSnapshot {
  ts: number;
  balanceBase: number;
  balanceQuote: number;
  valueQuote: number;
  valueUsd: number | null;
  hodlValueQuote: number;
  hodlValueUsd: number | null;
}

export interface ChainConfig {
  name: string;
  network: 'mainnet' | 'testnet';
  chainId: number;
  rpcUrl: string;
  nativeSymbol: string;
  nativeDecimals: number;
  explorerUrl?: string;
  wrappedNative?: { symbol: string; address: Address; decimals: number };
  tokens: Record<string, { address: Address; decimals: number }>;
  /** dex name -> contract addresses (e.g. uniswap-v3: factory/swapRouter/quoter) */
  dexes: Record<string, Record<string, Address>>;
  geckoNetwork?: string;
}

/** External deposit (+) / withdrawal (-) detected in the bot wallet. amount in whole units. */
export interface Flow {
  id?: number;
  /** unix seconds */
  ts: number;
  asset: 'base' | 'quote';
  amount: number;
  /** QUOTE per BASE at detection time */
  price: number;
  valueQuote: number;
  valueUsd: number | null;
}

export type SellReason = 'profit_target_reached' | 'stop_loss_active' | 'below_profit_target' | 'no_base_available' | 'waiting_price_step';
export interface BucketValue { value: number; belowMin: boolean }
export type BucketValues = Record<SizeBucket, BucketValue>;

/** What is possible right now under the risk rules (computed by @btrade/risk). Values in QUOTE. */
export interface NowState {
  sellAllowedNow: boolean;
  sellReason: SellReason;
  buyAllowedNow: boolean;
  buyReason: 'ok' | 'no_quote_balance' | 'below_min_trade_value' | 'waiting_price_step' | 'above_rebuy_target' | 'overheated';
  /** % the executable sell price must move to reach the profit target (positive = needs to rise) */
  pctToProfitTarget: number | null;
  /** % the sell price must move to reach the stop-loss (negative = needs to fall); null when disabled */
  pctToStopLoss: number | null;
  blocked: { cooldownSecLeft: number; dailyTradesLeft: number; dailyLossLimitHit: boolean };
  /** same-side ladder: another sell needs the price >= step above the last sell (another buy: below the last buy) */
  /** buy-back: a buy needs the price >= discountPct below the last sell (no sell yet = no constraint) */
  rebuy: { discountPct: number; lastSellPrice: number | null; targetPrice: number | null; pctToRebuyTarget: number | null };
  priceStep: { stepPct: number; lastSide: 'buy' | 'sell' | null; lastPrice: number | null; pctToNextSell: number | null; pctToNextBuy: number | null };
  tradeValueByBucket: { buy: BucketValues; sell: BucketValues };
}

/** Extra context handed to the decision engine alongside the snapshot. */
export interface DecisionContext {
  now?: NowState;
  pnlPctVsInvested?: number | null;
  /** most recent bot trades, newest first */
  recentTrades?: Pick<Trade, 'ts' | 'side' | 'price'>[];
}
