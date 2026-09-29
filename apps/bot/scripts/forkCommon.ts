import { privateKeyToAccount } from 'viem/accounts';
import { isLocalRpc } from '../src/localRpc.js';

export function forkRpc(): string {
  const url = process.env.FORK_RPC_URL || 'http://127.0.0.1:8545';
  if (!isLocalRpc(url)) throw new Error('Refusing: FORK_RPC_URL must be localhost/127.0.0.1');
  return url;
}

/** Bot key from env; never printed. */
export function botKey(): `0x${string}` {
  const raw = process.env.PRIVATE_KEY?.trim();
  const k = raw && !raw.startsWith('0x') ? `0x${raw}` : raw;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('PRIVATE_KEY missing or malformed');
  return k as `0x${string}`;
}

export const botAddress = () => privateKeyToAccount(botKey()).address;
