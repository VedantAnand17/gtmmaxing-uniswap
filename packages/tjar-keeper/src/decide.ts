/**
 * The keeper's decision, free of chain access so it can be tested exactly.
 * Amounts are in the jar's resource token's smallest unit.
 */
export interface PricedAsset {
  address: string;
  balance: bigint;
  /** What the Uniswap API guarantees for this balance, after slippage. Zero when it has no route. */
  value: bigint;
  /** Failed a pre-trade simulation, or has no code: naming it would revert the whole release. */
  unsafe?: boolean;
}

export interface Terms {
  /** `releaseCost().total`: threshold plus any protocol fee. */
  cost: bigint;
  /** Most assets one release may name. */
  maxAssets: number;
}

export interface Decision {
  release: boolean;
  assets: string[];
  value: bigint;
  profit: bigint;
  reason: string;
}

/**
 * A release costs the same however many assets it names, so name the most
 * valuable ones. Each named asset adds gas, so stop once one is worth less than
 * its own gas. Clear only if the result beats the cost, the gas and the margin.
 */
export function decide(assets: PricedAsset[], terms: Terms, gas: { base: bigint; perAsset: bigint }, margin: bigint): Decision {
  const candidates = assets
    .filter((asset) => !asset.unsafe && asset.balance > 0n && asset.value > gas.perAsset)
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    .slice(0, terms.maxAssets);
  const value = candidates.reduce((sum, asset) => sum + asset.value, 0n);
  const totalGas = gas.base + gas.perAsset * BigInt(candidates.length);
  const profit = value - terms.cost - totalGas;
  if (candidates.length === 0) return { release: false, assets: [], value: 0n, profit: -terms.cost, reason: "nothing worth naming" };
  if (profit < margin) return { release: false, assets: [], value, profit, reason: "below threshold, gas and margin" };
  return { release: true, assets: candidates.map((asset) => asset.address), value, profit, reason: "profitable" };
}

/** Every token that has ever entered the jar, from its transfer logs. A jar keeps no list of its own. */
export function assetsFromLogs(logs: { address: string }[]): string[] {
  return [...new Set(logs.map((log) => log.address.toLowerCase()))];
}
