import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';
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
          `Decide the next trade for ${base.symbol}/${quote.symbol}. Goal: grow total portfolio value in ${quote.symbol} by buying low and selling high; buy and sell are equally valid. Read now.buyAllowedNow, now.sellAllowedNow and buyOpportunity.`,
          {
            buy: `Choose buy when now.buyAllowedNow is true AND buyOpportunity.pctBelowLastSell is negative AND the 1h return is not a sharp fall. Buying ${base.symbol} below the last sell price increases the ${base.symbol} held.`,
            sell: 'Choose sell when now.sellAllowedNow is true AND price is at a local high (recent trend up, RSI high).',
            hold: 'Choose hold when now.buyAllowedNow is false and now.sellAllowedNow is false, or when the price is above the last sell price and not at a sell level, or the market is falling sharply.',
          },
        ),
        buyback: noul(
          `Is now a good moment to buy back ${base.symbol} with idle ${quote.symbol}? Consider buyOpportunity (price vs last sell), the recent trend and RSI; a run-up just below the last sell is not a good buy-back.`,
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
      buybackProbability: res.answers.buyback?.noul,
      raw: res,
    };
  }
}
