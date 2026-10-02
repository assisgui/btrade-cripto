import { pino } from 'pino';
import { isAddress } from 'viem';
import { accountKey, toUnits, type Address, type IDexAdapter, type Token, type ChainConfig } from '@btrade/core';
import { EvmChainAdapter, getChainConfig } from '@btrade/chain-evm';
import { PaperDexAdapter, V3Adapter, V3_FEE_TIERS } from '@btrade/dex-uniswap-v3';
import { ChangeDetector, GeckoTerminalProvider, OnChainUsdOracle, SnapshotBuilder } from '@btrade/market-data';
import { JevDecisionEngine, MockDecisionEngine } from '@btrade/decision-jev';
import { RiskManager } from '@btrade/risk';
import { SqliteStorage } from '@btrade/storage';
import { CompositeNotifier, ConsoleNotifier } from '@btrade/notifier';
import { loadConfig, type Config } from './config.js';
import { ChainBalanceSource, PaperBalanceSource } from './BalanceSources.js';
import { TradingBot } from './TradingBot.js';

async function resolveToken(spec: string, chain: EvmChainAdapter, cfg: ChainConfig): Promise<Token> {
  if (spec.toLowerCase() === 'native') {
    const w = cfg.wrappedNative;
    if (!w) throw new Error(`Chain ${cfg.name}/${cfg.network} has no wrappedNative configured (set WRAPPED_NATIVE_ADDRESS)`);
    return { symbol: cfg.nativeSymbol, address: w.address, decimals: cfg.nativeDecimals, native: true };
  }
  if (isAddress(spec)) return chain.getTokenInfo(spec as Address);
  const sym = Object.keys(cfg.tokens).find((k) => k.toLowerCase() === spec.toLowerCase());
  const t = sym ? cfg.tokens[sym] : undefined;
  if (!t || !sym) throw new Error(`Unknown token "${spec}" on ${cfg.name}/${cfg.network}. Known: ${Object.keys(cfg.tokens).join(', ') || '(none)'}; or pass an address.`);
  return { symbol: sym, address: t.address, decimals: t.decimals, native: false };
}

function buildChainConfig(c: Config): ChainConfig {
  const cfg = getChainConfig(c.CHAIN, c.MODE === 'testnet' ? 'testnet' : 'mainnet');
  if (c.MODE === 'fork') cfg.rpcUrl = c.FORK_RPC_URL; // mainnet config (id 143 + addresses), local fork RPC
  else if (c.RPC_URL) cfg.rpcUrl = c.RPC_URL;
  if (c.GECKO_NETWORK) cfg.geckoNetwork = c.GECKO_NETWORK;
  if (c.WRAPPED_NATIVE_ADDRESS) {
    cfg.wrappedNative = { symbol: `W${cfg.nativeSymbol}`, address: c.WRAPPED_NATIVE_ADDRESS as Address, decimals: cfg.nativeDecimals };
    cfg.tokens[cfg.wrappedNative.symbol] = { address: cfg.wrappedNative.address, decimals: cfg.nativeDecimals };
  }
  const uni = { ...(cfg.dexes['uniswap-v3'] ?? {}) };
  if (c.UNISWAP_V3_FACTORY) uni.factory = c.UNISWAP_V3_FACTORY as Address;
  if (c.UNISWAP_V3_ROUTER) uni.swapRouter = c.UNISWAP_V3_ROUTER as Address;
  if (c.UNISWAP_V3_QUOTER) uni.quoter = c.UNISWAP_V3_QUOTER as Address;
  if (Object.keys(uni).length) cfg.dexes['uniswap-v3'] = uni;
  return cfg;
}

function buildDex(c: Config, chain: EvmChainAdapter, cfg: ChainConfig): IDexAdapter {
  const feeTiers = V3_FEE_TIERS[c.DEX];
  const a = cfg.dexes[c.DEX];
  if (!a?.factory || !a.swapRouter || !a.quoter) {
    throw new Error(`Missing ${c.DEX} addresses for ${cfg.name}/${cfg.network}: set them in the chain config (or UNISWAP_V3_* env for uniswap-v3)`);
  }
  return new V3Adapter(chain, { name: c.DEX, factory: a.factory, router: a.swapRouter, quoter: a.quoter, feeTiers: [...feeTiers] });
}

async function main() {
  const c = loadConfig();
  const log = pino({ level: c.LOG_LEVEL });
  const paper = c.MODE === 'paper';
  const chainCfg = buildChainConfig(c);
  const chain = new EvmChainAdapter(chainCfg, { privateKey: c.PRIVATE_KEY as `0x${string}` | undefined });
  const base = await resolveToken(c.BASE_TOKEN, chain, chainCfg);
  const quote = await resolveToken(c.QUOTE_TOKEN, chain, chainCfg);
  const pair = { base, quote };
  if (!paper && !chain.address) throw new Error('PRIVATE_KEY is required outside paper mode');
  const account = accountKey(paper ? undefined : chain.address, chainCfg.chainId, pair);
  const storage = new SqliteStorage(c.DB_PATH, { account });
  const mig = storage.migration;
  if (mig.stateKeys || mig.rebuilt.length || Object.keys(mig.rows).length) log.info({ ...mig }, 'migrated legacy rows to account');

  const realDex = buildDex(c, chain, chainCfg);
  const gasReserve = toUnits(c.GAS_RESERVE_NATIVE, chainCfg.nativeDecimals);
  let dex: IDexAdapter = realDex;
  let balances;
  if (paper) {
    const seed = (key: string, v: number, dec: number) => { if (storage.paperBalances.get(key) === null) storage.paperBalances.set(key, toUnits(v, dec)); };
    if (base.native) seed('native', c.PAPER_BALANCE_BASE, base.decimals);
    else if (quote.native) seed('native', c.PAPER_BALANCE_QUOTE, quote.decimals);
    else seed('native', c.PAPER_BALANCE_NATIVE, chainCfg.nativeDecimals);
    if (!base.native) seed(base.address.toLowerCase(), c.PAPER_BALANCE_BASE, base.decimals);
    if (!quote.native) seed(quote.address.toLowerCase(), c.PAPER_BALANCE_QUOTE, quote.decimals);
    dex = new PaperDexAdapter(realDex, storage.paperBalances, { simulatedGasCost: () => chain.estimateFee(c.SWAP_GAS_UNITS) });
    balances = new PaperBalanceSource(storage.paperBalances);
  } else {
    balances = new ChainBalanceSource(chain);
  }

  const geckoNetwork = chainCfg.geckoNetwork;
  const market = geckoNetwork
    ? new GeckoTerminalProvider({
        network: geckoNetwork,
        pool: async () => c.GECKO_POOL ?? (await realDex.getPoolInfo(base, quote)).address,
        baseTokenAddress: base.address,
        refreshSec: c.CANDLE_REFRESH_SEC,
      })
    : null;

  const builder = new SnapshotBuilder(
    { pair, chain, dex, balances, market, positions: storage.positions, trades: storage.trades, state: storage.state },
    {
      probePct: c.SIZE_MEDIUM_PCT, gasReserve, gasUnits: c.SWAP_GAS_UNITS,
      fallbackProbeBase: toUnits(c.PROBE_BASE_FALLBACK, base.decimals),
      onWarn: (m, e) => log.warn({ err: (e as Error)?.message }, m),
    },
  );
  const sizePct = { small: c.SIZE_SMALL_PCT, medium: c.SIZE_MEDIUM_PCT, large: c.SIZE_LARGE_PCT };
  const engine =
    c.DECISION_ENGINE === 'jev'
      ? new JevDecisionEngine({
          model: c.JEV_MODEL,
          constraints: { minProfitPct: c.MIN_PROFIT_PCT, stopLossPct: c.STOP_LOSS_PCT, gasReserveNative: c.GAS_RESERVE_NATIVE, minConfidence: c.MIN_CONFIDENCE, sizePct },
          log,
        })
      : new MockDecisionEngine({ mode: c.MOCK_MODE, fixedAction: c.MOCK_ACTION });
  const risk = new RiskManager(
    {
      minConfidence: c.MIN_CONFIDENCE, gasReserveNative: gasReserve, sizePct, minProfitPct: c.MIN_PROFIT_PCT,
      stopLossPct: c.STOP_LOSS_PCT, maxSlippageBps: c.MAX_SLIPPAGE_BPS, maxPriceImpactBps: c.MAX_PRICE_IMPACT_BPS,
      minTradeValue: c.MIN_TRADE_VALUE, maxTradeValue: c.MAX_TRADE_VALUE, maxGasCostPct: c.MAX_GAS_COST_PCT, tradeCooldownSec: c.TRADE_COOLDOWN_SEC,
      maxTradesPerDay: c.MAX_TRADES_PER_DAY, maxDailyLossPct: c.MAX_DAILY_LOSS_PCT, sameSideStepPct: c.SAME_SIDE_STEP_PCT, rebuyDiscountPct: c.REBUY_DISCOUNT_PCT,
      buybackMinProb: c.BUYBACK_MIN_PROB, maxBuyRsi: c.MAX_BUY_RSI, maxBuyReturn1hPct: c.MAX_BUY_RETURN_1H_PCT,
    },
    storage.trades,
  );
  const notifier = new CompositeNotifier([new ConsoleNotifier((o, m) => log.info(o, m))]);
  const detector = new ChangeDetector({ thresholdBps: c.CHANGE_THRESHOLD_BPS, heartbeatSec: c.HEARTBEAT_SEC });

  let usdOracle: OnChainUsdOracle | null = null;
  const usdCfg = chainCfg.dexes['uniswap-v3'];
  const usdc = chainCfg.tokens.USDC;
  const wmon = chainCfg.wrappedNative;
  if (c.USD_ORACLE === 'onchain' && usdCfg?.factory && usdCfg.swapRouter && usdCfg.quoter && usdc && wmon && base.native) {
    const usdDex = new V3Adapter(chain, { name: 'uniswap-v3', factory: usdCfg.factory, router: usdCfg.swapRouter, quoter: usdCfg.quoter, feeTiers: [...V3_FEE_TIERS['uniswap-v3']] });
    usdOracle = new OnChainUsdOracle({
      dex: usdDex, baseToken: { symbol: wmon.symbol, address: wmon.address, decimals: wmon.decimals, native: false },
      usdToken: { symbol: 'USDC', address: usdc.address, decimals: usdc.decimals, native: false }, probeAmount: 10,
      midPrice: () => bot.lastMid, onWarn: (m, e) => log.warn({ err: (e as Error)?.message }, m),
    });
  } else if (c.USD_ORACLE === 'onchain') log.warn('USD oracle unavailable for this pair/chain; USD values disabled');

  const bot: TradingBot = new TradingBot(
    { pair, mode: c.MODE, engineName: c.DECISION_ENGINE, builder, detector, engine, risk, dex, storage, notifier, balances, usdOracle, log },
    { pollIntervalSec: c.POLL_INTERVAL_SEC, gasReserve, initialCostBasis: c.INITIAL_COST_BASIS, maxTicks: c.MAX_TICKS, portfolioSnapshotSec: c.PORTFOLIO_SNAPSHOT_SEC, flowToleranceNative: c.FLOW_TOLERANCE_NATIVE },
  );

  log.info({ mode: c.MODE, chain: `${chainCfg.name}/${chainCfg.network}`, dex: dex.name, base: base.symbol, quote: quote.symbol, wallet: chain.address ?? '(none)', account }, 'btrade starting');
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, 'shutting down');
    await bot.stop();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await bot.start();
  storage.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
