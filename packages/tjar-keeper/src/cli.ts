#!/usr/bin/env node
/**
 * Clears a Uniswap Token Jar when it pays to: checks the jar's balance of its
 * candidate assets, prices them with the Uniswap API, and calls release(). Then
 * it can swap what it took back into the resource token. Dry run unless --execute.
 *
 *   JAR=0x.. UNISWAP_API_KEY=.. [RPC_URL=..] [KEEPER_KEY=0x..] [ASSETS=0x..,0x..] [MARGIN=..]
 *     node src/cli.ts [--execute] [--swap]
 */
import { createPublicClient, createWalletClient, http, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { candidateAssets, decide, type PricedAsset } from "./decide.ts";

const API = "https://trade-api.gateway.uniswap.org/v1";
const NATIVE = zeroAddress;
const DEFAULT_RPC = "https://base-rpc.publicnode.com";
/** A jar lists nothing, and free RPCs refuse to search logs across all tokens, so check the liquid Base tokens. */
const COMMON_ASSETS = [
  "0x4200000000000000000000000000000000000006", // WETH
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
  "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
  "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", // USDT
  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
];
const RELEASED_GAS = { base: 120_000n, perAsset: 45_000n };

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const execute = process.argv.includes("--execute");
const swapAfter = process.argv.includes("--swap");
const jar = env("JAR") as Address;
const rpc = createPublicClient({ chain: base, transport: http(process.env.RPC_URL ?? DEFAULT_RPC) });
const apiKey = env("UNISWAP_API_KEY");

const ABI = parseAbi([
  "function releaser() view returns (address)",
  "function nonce() view returns (uint256)",
  "function releaseCost() view returns (uint256 total, uint256 fee)",
  "function resource() view returns (address)",
  "function maxReleaseLength() view returns (uint256)",
  "function release(uint256 nonce, address[] assets, address recipient, uint256 maxFee)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

async function api<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey }, body: JSON.stringify(body) });
  const parsed = await response.json() as T & { errorCode?: string; detail?: string };
  if (!response.ok) throw new Error(`${path}: ${parsed.errorCode ?? response.status} ${parsed.detail ?? ""}`);
  return parsed;
}

const quoteTo = (tokenIn: string, resource: Address, amount: bigint, swapper: string) =>
  api<{ quote: { output: { amount: string; minimumAmount?: string }; gasPrice?: string }; permitData?: unknown }>("/quote", {
    type: "EXACT_INPUT", amount: amount.toString(), tokenIn, tokenOut: resource, tokenInChainId: base.id, tokenOutChainId: base.id, swapper, protocols: ["V2", "V3", "V4"],
  });

async function price(asset: string, resource: Address, swapper: string): Promise<PricedAsset> {
  const code = asset === NATIVE ? "0x1" : await rpc.getCode({ address: asset as Address });
  if (!code) return { address: asset, balance: 0n, value: 0n, unsafe: true };
  const balance = asset === NATIVE
    ? await rpc.getBalance({ address: jar })
    : await rpc.readContract({ address: asset as Address, abi: ABI, functionName: "balanceOf", args: [jar] }).catch(() => null);
  if (balance === null) return { address: asset, balance: 0n, value: 0n, unsafe: true };
  if (balance === 0n) return { address: asset, balance, value: 0n };
  if (asset.toLowerCase() === resource.toLowerCase()) return { address: asset, balance, value: balance };
  try {
    const { quote } = await quoteTo(asset, resource, balance, swapper);
    return { address: asset, balance, value: BigInt(quote.output.minimumAmount ?? quote.output.amount) };
  } catch {
    return { address: asset, balance, value: 0n };
  }
}

async function main() {
  const account = process.env.KEEPER_KEY ? privateKeyToAccount(process.env.KEEPER_KEY as Hex) : null;
  if (execute && !account) throw new Error("--execute needs KEEPER_KEY");
  const swapper = account?.address ?? "0x000000000000000000000000000000000000dEaD";

  // The jar names the live releaser: a rotated-out releaser still answers its view calls.
  const releaser = await rpc.readContract({ address: jar, abi: ABI, functionName: "releaser" });
  const [nonce, [total, fee], resource, maxLength] = await Promise.all([
    rpc.readContract({ address: releaser, abi: ABI, functionName: "nonce" }),
    rpc.readContract({ address: releaser, abi: ABI, functionName: "releaseCost" }),
    rpc.readContract({ address: releaser, abi: ABI, functionName: "resource" }),
    rpc.readContract({ address: releaser, abi: ABI, functionName: "maxReleaseLength" }),
  ]);
  const assets = candidateAssets(NATIVE, COMMON_ASSETS, process.env.ASSETS);
  const priced = await Promise.all(assets.map((asset) => price(asset, resource, swapper)));

  // Gas in resource terms: price this chain's gas through the same API.
  const gasPrice = await rpc.getGasPrice();
  const weiPerUnit = await quoteTo(NATIVE, resource, 10n ** 16n, swapper).then((r) => BigInt(r.quote.output.amount)).catch(() => 0n);
  const toResource = (gas: bigint) => gas * gasPrice * weiPerUnit / 10n ** 16n;
  const decision = decide(priced, { cost: total, maxAssets: Number(maxLength) }, { base: toResource(RELEASED_GAS.base), perAsset: toResource(RELEASED_GAS.perAsset) }, BigInt(process.env.MARGIN ?? "0"));

  console.log(JSON.stringify({ jar, releaser, nonce: nonce.toString(), cost: total.toString(), resource, assets: priced.map((a) => ({ address: a.address, balance: a.balance.toString(), value: a.value.toString() })), decision: { ...decision, value: decision.value.toString(), profit: decision.profit.toString() } }, null, 2));
  if (!decision.release || !execute) return;

  const wallet = createWalletClient({ account: account!, chain: base, transport: http(process.env.RPC_URL ?? DEFAULT_RPC) });
  const allowance = await rpc.readContract({ address: resource, abi: ABI, functionName: "allowance", args: [account!.address, releaser] });
  if (allowance < total) {
    const approve = await wallet.writeContract({ address: resource, abi: ABI, functionName: "approve", args: [releaser, total] });
    await rpc.waitForTransactionReceipt({ hash: approve });
  }
  const { request } = await rpc.simulateContract({ account: account!, address: releaser, abi: ABI, functionName: "release", args: [nonce, decision.assets as Address[], account!.address, fee] });
  const release = await wallet.writeContract(request);
  const receipt = await rpc.waitForTransactionReceipt({ hash: release });
  console.log(JSON.stringify({ release, status: receipt.status }));
  if (receipt.status !== "success" || !swapAfter) return;

  for (const asset of decision.assets) {
    if (asset.toLowerCase() === resource.toLowerCase()) continue;
    const held = asset === NATIVE ? priced.find((p) => p.address === NATIVE)!.balance : await rpc.readContract({ address: asset as Address, abi: ABI, functionName: "balanceOf", args: [account!.address] });
    const approval = asset === NATIVE ? null : (await api<{ approval?: { to: Address; data: Hex; value?: string } | null }>("/check_approval", { walletAddress: account!.address, token: asset, amount: held.toString(), chainId: base.id, tokenOut: resource, tokenOutChainId: base.id })).approval;
    if (approval) await rpc.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: approval.to, data: approval.data, value: BigInt(approval.value ?? "0") }) });
    const quoted = await quoteTo(asset, resource, held, account!.address);
    const signature = quoted.permitData ? await wallet.signTypedData(quoted.permitData as never) : undefined;
    const { swap } = await api<{ swap: { to: Address; data: Hex; value?: string } }>("/swap", { quote: quoted.quote, ...(signature ? { signature, permitData: quoted.permitData } : {}) });
    const hash = await wallet.sendTransaction({ to: swap.to, data: swap.data, value: BigInt(swap.value ?? "0") });
    const swapped = await rpc.waitForTransactionReceipt({ hash });
    console.log(JSON.stringify({ swapped: asset, tx: hash, status: swapped.status }));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
