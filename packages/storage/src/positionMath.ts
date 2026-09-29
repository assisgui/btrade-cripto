import type { Position } from '@btrade/core';
import { toNumber } from '@btrade/core';

/** Weighted-average entry update on buy. price = QUOTE per BASE. */
export function applyBuy(pos: Position | null, baseBought: bigint, price: number, baseDecimals: number, now: number): Position {
  const oldSize = pos ? toNumber(pos.size, baseDecimals) : 0;
  const add = toNumber(baseBought, baseDecimals);
  const total = oldSize + add;
  const avg = total > 0 ? ((pos?.avgEntryPrice ?? 0) * oldSize + price * add) / total : price;
  return { size: (pos?.size ?? 0n) + baseBought, avgEntryPrice: avg, realizedPnlQuote: pos?.realizedPnlQuote ?? 0, updatedAt: now };
}

/** Realized PnL (in QUOTE) on sell; avg entry unchanged. */
export function applySell(pos: Position, baseSold: bigint, price: number, baseDecimals: number, now: number): { position: Position; realizedPnlQuote: number } {
  const realized = (price - pos.avgEntryPrice) * toNumber(baseSold, baseDecimals);
  const size = pos.size > baseSold ? pos.size - baseSold : 0n;
  return {
    position: { ...pos, size, realizedPnlQuote: pos.realizedPnlQuote + realized, updatedAt: now },
    realizedPnlQuote: realized,
  };
}
