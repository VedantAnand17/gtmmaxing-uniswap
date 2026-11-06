import { BASE_CHAIN_ID, BASE_USDC } from "@found/contracts";
import type { Address, Hash, PublicClient } from "viem";

export interface ChainTransfer {
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

/** A mined transaction, with addresses lowercased and its ERC-20 transfers decoded. */
export interface ChainTx {
  hash: string;
  success: boolean;
  from: string;
  to: string | null;
  data: string;
  value: bigint;
  transfers: ChainTransfer[];
}

export interface UsdcDelivery {
  txHash: string;
  logIndex: number;
  value: bigint;
}

/** Read-only chain access for checking payments. It holds no keys. */
export interface ChainReader {
  /** Null until the transaction is mined and past the confirmation depth. */
  tx(chainId: number, hash: string): Promise<ChainTx | null>;
  blockNumber(chainId: number): Promise<number>;
  /** USDC transfers into `to` on Base since `fromBlock`, past the confirmation depth. */
  usdcDeliveries(to: string, fromBlock: number): Promise<UsdcDelivery[]>;
  releaser(address: string): Promise<{ nonce: number; threshold: number }>;
}

/**
 * viem's defaults are not usable here: mainnet.base.org answers every
 * eth_getLogs with "request limit reached", and that search is how a bridge
 * delivery is found. Override with TOPUP_RPC_URLS.
 */
export const DEFAULT_RPC_URLS: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  130: "https://unichain-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
};

const CONFIRMATIONS = 3n;
/** Keeps one `eth_getLogs` inside what public RPCs serve; about two hours on Base. */
const MAX_LOG_RANGE = 3_600n;

export function createChainReader(rpcOverrides: Record<string, string> = {}): ChainReader {
  // Loaded on first use, so requests that never touch a chain do not pay for viem.
  const clients = new Map<number, Promise<PublicClient>>();
  const client = (chainId: number) => {
    let existing = clients.get(chainId);
    if (!existing) {
      existing = (async () => {
        const [{ createPublicClient, http }, chains] = await Promise.all([import("viem"), import("viem/chains")]);
        const chain = Object.values(chains).find((candidate) => (candidate as { id?: number }).id === chainId);
        if (!chain) throw new Error(`unsupported chain ${chainId}`);
        return createPublicClient({ chain: chain as never, transport: http(rpcOverrides[String(chainId)] ?? DEFAULT_RPC_URLS[chainId]) }) as unknown as PublicClient;
      })();
      clients.set(chainId, existing);
    }
    return existing;
  };
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topicAddress = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

  return {
    async tx(chainId, hash) {
      const rpc = await client(chainId);
      const receipt = await rpc.getTransactionReceipt({ hash: hash as Hash }).catch(() => null);
      if (!receipt) return null;
      if ((await rpc.getBlockNumber()) < receipt.blockNumber + CONFIRMATIONS) return null;
      const tx = await rpc.getTransaction({ hash: hash as Hash });
      const transfers: ChainTransfer[] = [];
      for (const log of receipt.logs) {
        const [signature, from, to] = log.topics;
        if (signature !== TRANSFER || !from || !to || log.topics.length !== 3) continue;
        transfers.push({ logIndex: log.logIndex, token: log.address.toLowerCase(), from: topicAddress(from), to: topicAddress(to), value: BigInt(log.data) });
      }
      return { hash, success: receipt.status === "success", from: tx.from.toLowerCase(), to: tx.to?.toLowerCase() ?? null, data: tx.input, value: tx.value, transfers };
    },
    async blockNumber(chainId) {
      return Number(await (await client(chainId)).getBlockNumber());
    },
    async usdcDeliveries(to, fromBlock) {
      const rpc = await client(BASE_CHAIN_ID);
      const head = await rpc.getBlockNumber();
      const latest = head - CONFIRMATIONS;
      const start = BigInt(fromBlock);
      if (latest < start) return [];
      const end = latest < start + MAX_LOG_RANGE ? latest : start + MAX_LOG_RANGE;
      const logs = await rpc.getLogs({
        address: BASE_USDC,
        event: { type: "event", name: "Transfer", inputs: [{ type: "address", indexed: true, name: "from" }, { type: "address", indexed: true, name: "to" }, { type: "uint256", indexed: false, name: "value" }] },
        args: { to: to as Address },
        fromBlock: start,
        toBlock: end,
      });
      return logs.map((log) => ({ txHash: log.transactionHash, logIndex: log.logIndex, value: log.args.value ?? 0n }));
    },
    async releaser(address) {
      const rpc = await client(BASE_CHAIN_ID);
      const abi = [
        { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
        { type: "function", name: "threshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      ] as const;
      const [nonce, threshold] = await Promise.all([
        rpc.readContract({ address: address as Address, abi, functionName: "nonce" }),
        rpc.readContract({ address: address as Address, abi, functionName: "threshold" }),
      ]);
      return { nonce: Number(nonce), threshold: Number(threshold) };
    },
  };
}
