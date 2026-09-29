import type { IBalanceSource, IChainAdapter, IPaperBalanceRepository, Token } from '@btrade/core';
import { balanceKey } from '@btrade/core';

export class ChainBalanceSource implements IBalanceSource {
  constructor(private readonly chain: IChainAdapter) {}
  getBalance(token: Token) {
    return this.chain.getTokenBalance(token);
  }
  getNativeBalance() {
    return this.chain.getNativeBalance();
  }
}

export class PaperBalanceSource implements IBalanceSource {
  constructor(private readonly repo: IPaperBalanceRepository) {}
  async getBalance(token: Token) {
    return this.repo.get(balanceKey(token)) ?? 0n;
  }
  async getNativeBalance() {
    return this.repo.get('native') ?? 0n;
  }
}
