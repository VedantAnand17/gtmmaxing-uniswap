import { describe, expect, it } from "vitest";
import { candidateAssets, decide, type PricedAsset } from "../src/decide.ts";

const asset = (address: string, value: bigint, extra: Partial<PricedAsset> = {}): PricedAsset => ({ address, balance: 1n, value, ...extra });
const GAS = { base: 10n, perAsset: 5n };

describe("decide", () => {
  it("clears once the assets beat the release cost, gas and margin", () => {
    expect(decide([asset("a", 200n)], { cost: 100n, maxAssets: 20 }, GAS, 20n)).toMatchObject({ release: true, assets: ["a"], profit: 85n });
  });

  it("waits while the jar is worth less than that", () => {
    expect(decide([asset("a", 110n)], { cost: 100n, maxAssets: 20 }, GAS, 0n)).toMatchObject({ release: false, profit: -5n });
    expect(decide([asset("a", 120n)], { cost: 100n, maxAssets: 20 }, GAS, 10n)).toMatchObject({ release: false, profit: 5n });
  });

  it("names the most valuable assets up to the releaser's limit", () => {
    const result = decide([asset("low", 50n), asset("high", 300n), asset("mid", 100n)], { cost: 100n, maxAssets: 2 }, GAS, 0n);
    expect(result.assets).toEqual(["high", "mid"]);
  });

  it("drops assets not worth their own gas, empty balances and anything that would revert the release", () => {
    const result = decide([asset("good", 300n), asset("dust", 5n), asset("empty", 90n, { balance: 0n }), asset("bad", 90n, { unsafe: true })], { cost: 100n, maxAssets: 20 }, GAS, 0n);
    expect(result.assets).toEqual(["good"]);
  });

  it("does nothing for an empty jar", () => {
    expect(decide([], { cost: 100n, maxAssets: 20 }, GAS, 0n).release).toBe(false);
  });
});

describe("candidateAssets", () => {
  it("lists each token once, whatever its casing, with the operator's extras", () => {
    expect(candidateAssets("0x0", ["0xAB"], "0xab, 0xCD")).toEqual(["0x0", "0xab", "0xcd"]);
    expect(candidateAssets("0x0", ["0xAB"])).toEqual(["0x0", "0xab"]);
  });
});
