import { createPublicClient, http, parseEther, toHex, formatEther } from 'viem';
import { botAddress, forkRpc } from './forkCommon.js';

const rpc = forkRpc();
const address = botAddress();
const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();
if (chainId !== 143) throw new Error(`Unexpected chain id ${chainId} (expected 143 fork)`);
await client.request({ method: 'anvil_setBalance' as never, params: [address, toHex(parseEther(process.env.FORK_FUND_MON ?? '10000'))] as never });
console.log(`funded ${address} on ${rpc}: ${formatEther(await client.getBalance({ address }))} MON`);
