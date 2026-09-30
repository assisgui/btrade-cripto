import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type { Action, Decision, DecisionContext, IDecisionEngine, MarketSnapshot, SizeBucket } from '@btrade/core';
import type { RiskConstraintsForModel } from './constraints.js';
import { serializeState } from './serialize.js';

export interface JevOptions {
  model: string;
  constraints: RiskConstraintsForModel;
  /** optional injected client (tests); defaults to new TypeSafeClient() reading TYPESAFE_API_KEY */
  client?: Pick<TypeSafeClient, 'systemOne'>;
  /** debug logger (pino-compatible) for the exact state sent to jev */
  log?: { debug(obj: Record<string, unknown>, msg: string): void };
}

export class JevDecisionEngine implements IDecisionEngine {
  private readonly client: Pick<TypeSafeClient, 'systemOne'>;

  constructor(private readonly o: JevOptions) {
    this.client = o.client ?? new TypeSafeClient();
  }

  async decide(s: MarketSnapshot, ctx?: DecisionContext): Promise<Decision> {
    const { base, quote } = s.pair;
    const state = serializeState(s, this.o.constraints, ctx);
    this.o.log?.debug({ state }, 'jev state');
    const res = await this.client.systemOne({
      model: this.o.model,
      state,
      questions: {
        action: choice(
          `What should the bot do now with the ${base.symbol}/${quote.symbol} position? Goal: maximize portfolio value in ${quote.symbol}. Use the objective, portfolio, indicators, recentCloses and the \`now\` block (what is allowed right now).`,
          {
            buy: `Buy ${base.symbol} using ${quote.symbol} (expected to outperform holding ${quote.symbol}; only executes if now.buyAllowedNow is true).`,
            sell: `Sell ${base.symbol} for ${quote.symbol} (protect value; only executes if now.sellAllowedNow is true).`,
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
