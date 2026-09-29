/** bigint raw amount -> JS number (lossy, for ratios/logging only). */
export function toNumber(amount: bigint, decimals: number): number {
  const neg = amount < 0n;
  const s = (neg ? -amount : amount).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  const n = Number(decimals ? `${int}.${frac}` : int);
  return neg ? -n : n;
}

/** decimal number/string -> raw bigint */
export function toUnits(value: number | string, decimals: number): bigint {
  const str = typeof value === 'number' ? value.toFixed(decimals) : value;
  const [i = '0', f = ''] = str.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(i + frac);
}
