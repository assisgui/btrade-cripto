# Architecture

## Tick flow (`apps/bot/src/TradingBot.ts`)
```
poll every POLL_INTERVAL_SEC
  paused? -> skip
  SnapshotBuilder.build()      quotes (both directions), liquidity, impact, gas, balances, position, indicators
  ChangeDetector.check()       price > CHANGE_THRESHOLD_BPS | balances changed | HEARTBEAT_SEC  else skip
  IDecisionEngine.decide()     jev (one systemOne call: action + size choices) or mock
  IRiskManager.evaluate()      final veto -> {approved, amountIn, amountOutMin, reasons}
  IDexAdapter.swap()           real (V3Adapter) or PaperDexAdapter (simulated)
  persist (trade, position, decision log) -> INotifier.notify()
```
Each tick is error-isolated; SIGINT/SIGTERM stop the loop gracefully.

## Packages
| Package | Role |
|---|---|
| `core` | Interfaces + domain types only (bigint amounts). |
| `chain-evm` | `EvmChainAdapter` (viem), chain configs (`chains/monad.ts`) + registry. |
| `dex-uniswap-v3` (name kept) | generic `V3Adapter` configured by `{name, factory, router, quoter, feeTiers}`; presets `uniswap-v3`, `pancakeswap-v3` (SwapRouter02/QuoterV2-compatible); `PaperDexAdapter` decorator. |
| `market-data` | `GeckoTerminalProvider`, pure indicators, `SnapshotBuilder`, `ChangeDetector`. |
| `decision-jev` | `JevDecisionEngine` (TypeSafe SDK), `MockDecisionEngine`. |
| `risk` | `RiskManager` (all veto rules, env-configurable). |
| `storage` | SQLite (`node:sqlite`) repos: trades, position, decision log, paper balances, bot state. |
| `notifier` | `ConsoleNotifier`, `CompositeNotifier`. |
| `apps/bot` | zod config, composition root (`main.ts`), `TradingBot`. |

Packages export `src/index.ts` directly; run with `tsx`, typecheck with `tsc --noEmit`.
Prices are QUOTE per BASE; cost basis is a weighted average updated on buys, realized PnL on sells.

Risk: sell requires `price_net >= avgEntry*(1+MIN_PROFIT_PCT) + gas/unit` (no fee term: quote is net of pool fee). `MAX_TRADE_VALUE` clamps amount. `MODE=fork` = mainnet config on a local anvil fork (localhost-only guard); scripts in `apps/bot/scripts`.
