/**
 * Clears a Uniswap Token Jar when it pays to: checks the jar's balance of its
 * candidate assets, prices them with the Uniswap API, and calls release(). Then
 * it can swap what it took back into the resource token. Used by the command
 * line here and by GTMMAXING's hourly job.
 */
import { createPublicClient, createWalletClient, fallback, http, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { candidateAssets, decide, type Decision, type PricedAsset } from "./decide.ts";

const API = "https://trade-api.gateway.uniswap.org/v1";
const NATIVE = zeroAddress;
export const DEFAULT_RPC_URLS = ["https://base-rpc.publicnode.com", "https://gateway.tenderly.co/public/base"];
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

export interface KeeperOptions {
  jar: Address;
  apiKey: string;
  /** Needed to clear; without it the run only reports its decision. */
  keeperKey?: Hex | undefined;
  /** Swap what was released back into the resource token, which refills the keeper for the next clearing. */
  swap?: boolean | undefined;
  rpcUrls?: readonly string[] | undefined;
  /** Comma-separated extra tokens to check. */
  assets?: string | undefined;
  margin?: bigint | undefined;
  /** For tests. */
  clients?: { rpc: PublicClient; wallet?: WalletClient } | undefined;
  fetcher?: typeof fetch | undefined;
}

export interface KeeperReport {
  jar: Address;
  releaser: Address;
  nonce: string;
  cost: string;
  resource: Address;
  assets: { address: string; balance: string; value: string }[];
  decision: Omit<Decision, "value" | "profit"> & { value: string; profit: string };
  release?: { tx: Hex; status: string };
  swaps?: { asset: string; tx: Hex; status: string }[];
}

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

type Quote = { quote: { output: { amount: string; minimumAmount?: string }; gasPrice?: string }; permitData?: unknown };

export async function runKeeper(options: KeeperOptions): Promise<KeeperReport> {
  const { jar } = options;
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const transport = fallback((options.rpcUrls ?? DEFAULT_RPC_URLS).map((url) => http(url)));
  const rpc = options.clients?.rpc ?? createPublicClient({ chain: base, transport }) as PublicClient;
  const account = options.keeperKey ? privateKeyToAccount(options.keeperKey) : null;
  const swapper = account?.address ?? "0x000000000000000000000000000000000000dEaD";

  const api = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetcher(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": options.apiKey }, body: JSON.stringify(body) });
    const parsed = await response.json() as T & { errorCode?: string; detail?: string };
    if (!response.ok) throw new Error(`${path}: ${parsed.errorCode ?? response.status} ${parsed.detail ?? ""}`);
    return parsed;
  };
  const quoteTo = (tokenIn: string, resource: Address, amount: bigint, from: string) => api<Quote>("/quote", {
    type: "EXACT_INPUT", amount: amount.toString(), tokenIn, tokenOut: resource, tokenInChainId: base.id, tokenOutChainId: base.id, swapper: from, protocols: ["V2", "V3", "V4"],
  });
  const price = async (asset: string, resource: Address): Promise<PricedAsset> => {
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
  };

  // The jar names the live releaser: a rotated-out releaser still answers its view calls.
  const releaser = await rpc.readContract({ address: jar, abi: ABI, functionName: "releaser" });
  const [nonce, [total, fee], resource, maxLength] = await Promise.all([
    rpc.readContract({ address: releaser, abi: ABI, functionName: "nonce" }),
    rpc.readContract({ address: releaser, abi: ABI, functionName: "releaseCost" }),
    rpc.readContract({ address: releaser, abi: ABI, functionName: "resource" }),
    rpc.readContract({ address: releaser, abi: ABI, functionName: "maxReleaseLength" }),
  ]);
  const priced = await Promise.all(candidateAssets(NATIVE, COMMON_ASSETS, options.assets).map((asset) => price(asset, resource)));
  const report: KeeperReport = {
    jar, releaser, nonce: nonce.toString(), cost: total.toString(), resource,
    assets: priced.map((a) => ({ address: a.address, balance: a.balance.toString(), value: a.value.toString() })),
    decision: { release: false, assets: [], value: "0", profit: "0", reason: "nothing worth naming" },
  };
  // Nothing to clear: spend no quotes on gas pricing, since an empty jar is the usual hourly answer.
  if (priced.every((asset) => asset.value === 0n)) return report;

  // Gas in resource terms: price this chain's gas through the same API.
  const gasPrice = await rpc.getGasPrice();
  const unitsPerHundredthEth = await quoteTo(NATIVE, resource, 10n ** 16n, swapper).then((r) => BigInt(r.quote.output.amount)).catch(() => 0n);
  const toResource = (gas: bigint) => gas * gasPrice * unitsPerHundredthEth / 10n ** 16n;
  const decision = decide(priced, { cost: total, maxAssets: Number(maxLength) }, { base: toResource(RELEASED_GAS.base), perAsset: toResource(RELEASED_GAS.perAsset) }, options.margin ?? 0n);
  report.decision = { ...decision, value: decision.value.toString(), profit: decision.profit.toString() };
  if (!decision.release || !account) return report;

  const wallet = (options.clients?.wallet ?? createWalletClient({ account, chain: base, transport })) as WalletClient;
  const allowance = await rpc.readContract({ address: resource, abi: ABI, functionName: "allowance", args: [account.address, releaser] });
  if (allowance < total) {
    const approve = await wallet.writeContract({ account, chain: base, address: resource, abi: ABI, functionName: "approve", args: [releaser, total] });
    await rpc.waitForTransactionReceipt({ hash: approve });
  }
  const { request } = await rpc.simulateContract({ account, address: releaser, abi: ABI, functionName: "release", args: [nonce, decision.assets as Address[], account.address, fee] });
  const release = await wallet.writeContract(request);
  const receipt = await rpc.waitForTransactionReceipt({ hash: release });
  report.release = { tx: release, status: receipt.status };
  if (receipt.status !== "success" || !options.swap) return report;

  report.swaps = [];
  for (const asset of decision.assets) {
    if (asset.toLowerCase() === resource.toLowerCase()) continue;
    const held = asset === NATIVE ? priced.find((p) => p.address === NATIVE)!.balance : await rpc.readContract({ address: asset as Address, abi: ABI, functionName: "balanceOf", args: [account.address] });
    const approval = asset === NATIVE ? null : (await api<{ approval?: { to: Address; data: Hex; value?: string } | null }>("/check_approval", { walletAddress: account.address, token: asset, amount: held.toString(), chainId: base.id, tokenOut: resource, tokenOutChainId: base.id })).approval;
    if (approval) await rpc.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account, chain: base, to: approval.to, data: approval.data, value: BigInt(approval.value ?? "0") }) });
    const quoted = await quoteTo(asset, resource, held, account.address);
    const signature = quoted.permitData ? await wallet.signTypedData({ account, ...(quoted.permitData as object) } as never) : undefined;
    const { swap } = await api<{ swap: { to: Address; data: Hex; value?: string } }>("/swap", { quote: quoted.quote, ...(signature ? { signature, permitData: quoted.permitData } : {}) });
    const hash = await wallet.sendTransaction({ account, chain: base, to: swap.to, data: swap.data, value: BigInt(swap.value ?? "0") });
    const swapped = await rpc.waitForTransactionReceipt({ hash });
    report.swaps.push({ asset, tx: hash, status: swapped.status });
  }
  return report;
}
