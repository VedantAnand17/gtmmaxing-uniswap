import { describe, expect, it } from "vitest";
import type { PublicClient, WalletClient } from "viem";
import { runKeeper } from "../src/keeper.ts";

const JAR = "0x00000000000000000000000000000000000000bb";
const RELEASER = "0x00000000000000000000000000000000000000cc";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KEY = "0x1000000000000000000000000000000000000000000000000000000000000001";

/** A jar holding `held` wei that costs $2 to clear, with ETH at `usdcPerEth`. */
function chain(held: bigint, usdcPerEth = 2_000) {
  const sent: string[] = [];
  const rpc = {
    readContract: async ({ functionName }: { functionName: string }) => ({
      releaser: RELEASER, nonce: 3n, releaseCost: [2_000_000n, 0n], resource: USDC, maxReleaseLength: 20n, balanceOf: 0n, allowance: 2_000_000n,
    } as Record<string, unknown>)[functionName],
    getCode: async () => "0x1",
    getBalance: async () => held,
    getGasPrice: async () => 10_000_000n,
    simulateContract: async (call: unknown) => ({ request: call }),
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as PublicClient;
  const wallet = {
    writeContract: async ({ functionName }: { functionName: string }) => { sent.push(functionName); return "0xrelease"; },
    sendTransaction: async () => { sent.push("swap"); return "0xswap"; },
  } as unknown as WalletClient;
  const fetcher = (async (url: string, init: { body: string }) => {
    if (url.endsWith("/swap")) return Response.json({ swap: { to: USDC, data: "0x" } });
    const amount = Number((JSON.parse(init.body) as { amount: string }).amount) / 1e18 * usdcPerEth * 1e6;
    return Response.json({ quote: { output: { amount: String(Math.floor(amount)), minimumAmount: String(Math.floor(amount)) } } });
  }) as unknown as typeof fetch;
  return { rpc, wallet, fetcher, sent };
}

const run = (c: ReturnType<typeof chain>, keeperKey: `0x${string}` | undefined = KEY) =>
  runKeeper({ jar: JAR, apiKey: "key", keeperKey, swap: true, clients: { rpc: c.rpc, wallet: c.wallet }, fetcher: c.fetcher });

describe("runKeeper", () => {
  it("does nothing for an empty jar, and asks Uniswap nothing about gas", async () => {
    const c = chain(0n);
    expect((await run(c)).decision.release).toBe(false);
    expect(c.sent).toEqual([]);
  });

  it("leaves a jar that isn't worth clearing yet", async () => {
    const c = chain(900_000_000_000_000n); // $1.80 against a $2 price.
    expect((await run(c)).decision.release).toBe(false);
    expect(c.sent).toEqual([]);
  });

  it("clears a profitable jar and swaps the proceeds back, which refills it for next time", async () => {
    const c = chain(1_100_000_000_000_000n); // $2.20.
    const report = await run(c);
    expect(report.decision.release).toBe(true);
    expect(report.release).toMatchObject({ tx: "0xrelease", status: "success" });
    expect(c.sent).toEqual(["release", "swap"]);
  });

  it("only reports without a key, even when clearing would pay", async () => {
    const c = chain(1_100_000_000_000_000n);
    const report = await runKeeper({ jar: JAR, apiKey: "key", clients: { rpc: c.rpc, wallet: c.wallet }, fetcher: c.fetcher });
    expect(report.decision.release).toBe(true);
    expect(c.sent).toEqual([]);
  });
});
