import type {
  Address, Candle, ChainConfig, Decision, DecisionContext, Flow, Hex, NowState, MarketSnapshot, Pair, PortfolioSnapshot, Position, Timeframe, Token, Trade,
} from './types.js';

export interface IChainAdapter {
  readonly config: ChainConfig;
  /** wallet address, undefined when no key configured (read-only) */
  readonly address: Address | undefined;
  getNativeBalance(address?: Address): Promise<bigint>;
  getTokenBalance(token: Token, address?: Address): Promise<bigint>;
  /** wei */
  getGasPrice(): Promise<bigint>;
  /** fee in native wei for a given gas-unit estimate */
  estimateFee(gasUnits: bigint): Promise<bigint>;
  getTokenInfo(address: Address): Promise<Token>;
}

export interface IBalanceSource {
  getBalance(token: Token): Promise<bigint>;
  getNativeBalance(): Promise<bigint>;
}

export interface Quote {
  amountIn: bigint;
  amountOut: bigint;
  priceImpactBps: number;
  /** fee tier in hundredths of a bip (uniswap v3: 3000 = 0.3%) */
  fee: number;
  route: { pool: Address; fee: number; tokenIn: Address; tokenOut: Address }[];
  gasEstimate?: bigint;
}

export interface SwapParams {
  tokenIn: Token;
  tokenOut: Token;
  amountIn: bigint;
  amountOutMin: bigint;
  recipient?: Address;
}

export interface SwapResult {
  success: boolean;
  txHash: Hex | null;
  amountIn: bigint;
  /** actual (or, for real swaps, quoted-expected) amount out */
  amountOut: bigint;
  paper: boolean;
  gasUsed?: bigint;
}

export interface PoolInfo {
  address: Address;
  fee: number;
  liquidity: bigint;
  token0: Address;
  token1: Address;
  sqrtPriceX96: bigint;
  tick: number;
}

export interface IDexAdapter {
  readonly name: string;
  quote(tokenIn: Token, tokenOut: Token, amountIn: bigint): Promise<Quote>;
  swap(params: SwapParams): Promise<SwapResult>;
  getPoolInfo(tokenA: Token, tokenB: Token): Promise<PoolInfo>;
}

export interface IMarketDataProvider {
  getCandles(timeframe: Timeframe, aggregate: number, limit: number): Promise<Candle[]>;
}

export interface IDecisionEngine {
  decide(snapshot: MarketSnapshot, ctx?: DecisionContext): Promise<Decision>;
}

export interface RiskVerdict {
  approved: boolean;
  amountIn: bigint;
  amountOutMin: bigint;
  reasons: string[];
}

export type QuoteFn = (tokenIn: Token, tokenOut: Token, amountIn: bigint) => Promise<Quote>;

export interface IRiskManager {
  evaluate(decision: Decision, snapshot: MarketSnapshot, quoteFn: QuoteFn): Promise<RiskVerdict>;
  /** what is possible right now (sell/buy allowed, limits, bucket values) */
  assess(snapshot: MarketSnapshot): NowState;
}

export type BotEvent =
  | { type: 'started'; mode: string; pair: string; engine: string }
  | { type: 'stopped' }
  | { type: 'decision'; decision: Decision; price: number }
  | { type: 'vetoed'; decision: Decision; reasons: string[] }
  | { type: 'trade'; trade: Trade }
  | { type: 'flow'; flow: Flow }
  | { type: 'error'; message: string };

export interface INotifier {
  notify(event: BotEvent): Promise<void>;
}

export interface IUsdPriceOracle {
  /** USD price of BASE and QUOTE; null when unavailable (never throws) */
  getUsdPrices(): Promise<{ baseUsd: number; quoteUsd: number } | null>;
}

export interface IPortfolioRepository {
  insert(s: PortfolioSnapshot): void;
  first(): PortfolioSnapshot | null;
  last(): PortfolioSnapshot | null;
}

export interface ITradeRepository {
  insert(trade: Trade): void;
  recent(limit: number): Trade[];
  count(): number;
  last(): Trade | null;
  since(tsSeconds: number): Trade[];
}

export interface IPositionRepository {
  get(pairKey: string): Position | null;
  save(pairKey: string, position: Position): void;
}

export interface IDecisionLogRepository {
  log(entry: { ts: number; snapshot: MarketSnapshot; decision: Decision | null; outcome: string }): void;
}

export interface IPaperBalanceRepository {
  /** null if never initialised */
  get(key: string): bigint | null;
  set(key: string, amount: bigint): void;
}

export interface IBotStateRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  list(prefix: string): { key: string; value: string }[];
}

export interface IFlowRepository {
  insert(f: Flow): void;
  all(): Flow[];
  recent(limit: number): Flow[];
  count(): number;
}

export interface IStorage {
  flows: IFlowRepository;
  trades: ITradeRepository;
  positions: IPositionRepository;
  decisions: IDecisionLogRepository;
  paperBalances: IPaperBalanceRepository;
  state: IBotStateRepository;
  portfolio: IPortfolioRepository;
  close(): void;
}

export const pairKey = (p: Pair): string => `${p.base.symbol}/${p.quote.symbol}`;
/** Scope of all persisted data: `${wallet}:${chainId}:${pairKey}`; wallet = lowercase address, or 'paper' in paper mode. */
export const accountKey = (wallet: string | undefined, chainId: number, pair: Pair): string =>
  `${(wallet ?? 'paper').toLowerCase()}:${chainId}:${pairKey(pair)}`;
export const balanceKey = (t: Token): string => (t.native ? 'native' : t.address.toLowerCase());
export type { Position };
