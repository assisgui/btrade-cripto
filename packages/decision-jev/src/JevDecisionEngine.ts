import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type { Action, Decision, IDecisionEngine, MarketSnapshot, SizeBucket } from '@btrade/core';
import type { RiskConstraintsForModel } from './constraints.js';
import { serializeState } from './serialize.js';

export interface JevOptions {
  model: string;
  constraints: RiskConstraintsForModel;
  /** optional injected client (tests); defaults to new TypeSafeClient() reading TYPESAFE_API_KEY */
  client?: Pick<TypeSafeClient, 'systemOne'>;
}

export class JevDecisionEngine implements IDecisionEngine {
  private readonly client: Pick<TypeSafeClient, 'systemOne'>;

  constructor(private readonly o: JevOptions) {
    this.client = o.client ?? new TypeSafeClient();
  }

  async decide(s: MarketSnapshot): Promise<Decision> {
    const { base, quote } = s.pair;
    const res = await this.client.systemOne({
      model: this.o.model,
      state: serializeState(s, this.o.constraints),
      questions: {
        action: choice(
          `What should the bot do now with the ${base.symbol}/${quote.symbol} position? Consider momentum, RSI, costs, and the stated constraints.`,
          {
            buy: `Buy ${base.symbol} using ${quote.symbol} (price expected to rise, or a good entry).`,
            sell: `Sell ${base.symbol} for ${quote.symbol} (take profit / exit; must respect the minimum profit constraint unless stop-loss).`,
            hold: 'Do nothing: no clear edge, costs too high, or waiting is better.',
          },
        ),
        size: choice('If a trade is made, how large should it be relative to available balance?', {
          small: 'Low conviction or high uncertainty; small fraction.',
          medium: 'Moderate conviction; medium fraction.',
          large: 'High conviction and low risk; large fraction.',
        }),
      },
    });
    const a = res.answers.action;
    const z = res.answers.size;
    const p = a.probabilities as Record<Action, number>;
    return {
      action: a.choice as Action,
      sizeBucket: z.choice as SizeBucket,
      confidence: a.confidence,
      probabilities: { buy: p.buy ?? 0, sell: p.sell ?? 0, hold: p.hold ?? 0 },
      raw: res,
    };
  }
}
