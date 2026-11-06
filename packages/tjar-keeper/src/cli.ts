#!/usr/bin/env node
/**
 * Runs the keeper once. Dry run unless --execute.
 *
 *   JAR=0x.. UNISWAP_API_KEY=.. [RPC_URL=..] [KEEPER_KEY=0x..] [ASSETS=0x..,0x..] [MARGIN=..]
 *     node src/cli.ts [--execute] [--swap]
 */
import type { Address, Hex } from "viem";
import { DEFAULT_RPC_URLS, runKeeper } from "./keeper.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const execute = process.argv.includes("--execute");
if (execute && !process.env.KEEPER_KEY) throw new Error("--execute needs KEEPER_KEY");

runKeeper({
  jar: env("JAR") as Address,
  apiKey: env("UNISWAP_API_KEY"),
  keeperKey: execute ? process.env.KEEPER_KEY as Hex : undefined,
  swap: process.argv.includes("--swap"),
  rpcUrls: process.env.RPC_URL ? [process.env.RPC_URL] : DEFAULT_RPC_URLS,
  assets: process.env.ASSETS,
  margin: BigInt(process.env.MARGIN ?? "0"),
}).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
