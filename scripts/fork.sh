#!/usr/bin/env sh
# Local anvil fork of Monad mainnet (chain id 143). Requires foundry's `anvil`.
exec anvil --fork-url "${FORK_UPSTREAM_RPC:-https://rpc.monad.xyz}" --chain-id 143 --port 8545
