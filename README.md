# btrade

TypeScript trading-bot monorepo (pnpm workspaces, ESM, no build step). Reads on-chain prices from a DEX, builds a market snapshot, asks a decision engine (TypeSafe **jev** or a mock) for buy/sell/hold, runs a strict risk veto, then executes (or simulates) the swap. Initial target: Monad + Uniswap V3 / PancakeSwap V3 (`DEX=uniswap-v3|pancakeswap-v3`).

## Setup
```sh
pnpm install
cp .env.example .env      # edit; never commit .env
pnpm typecheck && pnpm test
pnpm dev                  # tsx watch;  pnpm start = single run
```
Requires Node >= 22.5 (uses built-in `node:sqlite`).

## Modes
| MODE | Data | Execution |
|---|---|---|
| `paper` (default) | Monad mainnet (read-only) | simulated against paper balances in SQLite, no key needed |
| `fork` | Local anvil fork of Monad mainnet (id 143) via `FORK_RPC_URL` | real txs sent to the fork only; refuses to start unless RPC host is localhost |
| `testnet` | Monad testnet (10143) | not useful: no Uniswap/Pancake deployed there; needs `PRIVATE_KEY` + addresses in env |
| `live` | Monad mainnet | real txs; needs `PRIVATE_KEY` and `CONFIRM_LIVE=true` |

Quick paper smoke test: `MODE=paper DECISION_ENGINE=mock MAX_TICKS=2 POLL_INTERVAL_SEC=5 pnpm start`.
Defaults target the liquid PancakeSwap V3 MON/cbBTC 0.05% pool with tiny risk limits (`MAX_TRADE_VALUE` clamps each trade).
Sell rule: quote price (already net of pool fee) >= avgEntry*(1+MIN_PROFIT_PCT) + gas per unit.

### Fork (execution validation, needs foundry `anvil`)
```sh
pnpm fork            # anvil --fork-url $FORK_UPSTREAM_RPC --chain-id 143 --port 8545
pnpm fork:fund       # anvil_setBalance 10000 MON for the PRIVATE_KEY address (local only)
pnpm fork:e2e        # quote + swap MON->cbBTC, then half back (approve + multicall/unwrap)
MODE=fork pnpm start # run the bot against the fork
```
The `paused` flag in the `bot_state` table pauses the loop (hook for future Telegram control).

## Add a chain
Create `packages/chain-evm/src/chains/<name>.ts` exporting a `ChainConfig` (id, RPC, tokens, DEX addresses, `geckoNetwork`) and add it to `CHAINS` in `packages/chain-evm/src/registry.ts`. Select with `CHAIN=<name>`.

## Add a DEX
Implement `IDexAdapter` (`quote`, `swap`, `getPoolInfo`) in a new `packages/dex-<name>`; V3-style DEXes only need a preset (`V3_FEE_TIERS`) plus addresses under `dexes['<name>']`, put its addresses under `dexes['<name>']` in the chain config, and add a case in `buildDex` in `apps/bot/src/main.ts`. `PaperDexAdapter` wraps any `IDexAdapter`.

## Notifications
Implement `INotifier` (e.g. Telegram) and add it to the `CompositeNotifier` in the composition root.

## Reporting / USD
Decisions and the profit rule stay in QUOTE (cbBTC); USD is reporting only. `USD_ORACLE=onchain` (default) quotes WMON->USDC on the uniswap-v3 preset and derives cbBTC/USD from the mid price (`off` disables; failures just yield null). Each tick logs a `portfolio` line (value in cbBTC/USD, pnl vs start, vs HODL); rows go to `portfolio_snapshots` every `PORTFOLIO_SNAPSHOT_SEC` (300). The HODL benchmark (initial balances/prices) is stored in `bot_state` (`hodl_init:<mode>`). Trades carry `value_usd`, `gas_usd`, `realized_pnl_usd`; DB migrations are automatic.
`pnpm report` (uses `DB_PATH`) prints start vs now, realized pnl, vs HODL and the last 20 trades.
`GAS_RESERVE_NATIVE` defaults to 10.5: Monad requires EOAs to keep a 10 MON reserve balance (https://docs.monad.xyz/developer-essentials/reserve-balance).
