/** Cents for amounts of a dollar or more; more decimals below that, so small amounts stay readable. */
export function dollars(usd: number): string {
  if (usd === 0 || usd >= 1) {
    return `$${usd.toFixed(2)}`;
  }
  return `$${usd.toFixed(usd >= 0.01 ? 3 : 4)}`;
}
