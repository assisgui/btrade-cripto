import type { Action, Decision, IDecisionEngine, MarketSnapshot, SizeBucket } from '@btrade/core';

export type MockMode = 'random' | 'fixed';

export interface MockOptions {
  mode?: MockMode;
  fixedAction?: Action;
  sizeBucket?: SizeBucket;
  confidence?: number;
  rng?: () => number;
}

export class MockDecisionEngine implements IDecisionEngine {
  constructor(private readonly o: MockOptions = {}) {}

  async decide(_s: MarketSnapshot): Promise<Decision> {
    const rng = this.o.rng ?? Math.random;
    const actions: Action[] = ['buy', 'sell', 'hold'];
    const action = this.o.mode === 'fixed' ? (this.o.fixedAction ?? 'hold') : (actions[Math.floor(rng() * 3)] as Action);
    const sizes: SizeBucket[] = ['small', 'medium', 'large'];
    const sizeBucket = this.o.sizeBucket ?? (sizes[Math.floor(rng() * 3)] as SizeBucket);
    const confidence = this.o.confidence ?? 0.5 + rng() * 0.5;
    const probabilities = { buy: 0, sell: 0, hold: 0 } as Record<Action, number>;
    probabilities[action] = confidence;
    for (const a of actions) if (a !== action) probabilities[a] = (1 - confidence) / 2;
    return { action, sizeBucket, confidence, probabilities, raw: { mock: true } };
  }
}
