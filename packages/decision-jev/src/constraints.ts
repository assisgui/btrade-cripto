export interface RiskConstraintsForModel {
  minProfitPct: number;
  stopLossPct: number;
  gasReserveNative: number;
  minConfidence: number;
  sizePct: { small: number; medium: number; large: number };
}
