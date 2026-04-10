// USD to ZAR exchange rate — update periodically
export const USD_TO_ZAR = 16.39;

export function usdToZar(usd: number): string {
  return (usd * USD_TO_ZAR).toFixed(2);
}

export function formatCostDual(usd: number): string {
  return `$${usd.toFixed(4)} (R${usdToZar(usd)})`;
}
