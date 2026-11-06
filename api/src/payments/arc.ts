import { ARC_TESTNET } from "@found/contracts";
import type { Hash, PublicClient } from "viem";

export interface ArcTransfer {
  token: string;
  from: string;
  to: string;
  value: bigint;
}

/** Read-only access to Arc. Finality is under a second, so a receipt needs no confirmation depth. */
export interface ArcReader {
  /** Null until the transaction has a receipt. */
  receipt(txHash: string): Promise<{ success: boolean; transfers: ArcTransfer[] } | null>;
}

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

export function createArcReader(): ArcReader {
  // Loaded on first use, so requests that never touch Arc do not pay for viem.
  let client: Promise<PublicClient> | null = null;
  const rpc = () => client ??= import("viem").then(({ createPublicClient, defineChain, http }) => createPublicClient({
    chain: defineChain({
      id: ARC_TESTNET.chainId,
      name: ARC_TESTNET.name,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [ARC_TESTNET.rpcUrl] } },
    }),
    transport: http(ARC_TESTNET.rpcUrl),
  }) as unknown as PublicClient);

  return {
    async receipt(txHash) {
      const receipt = await (await rpc()).getTransactionReceipt({ hash: txHash as Hash }).catch(() => null);
      if (!receipt) return null;
      const transfers: ArcTransfer[] = [];
      for (const log of receipt.logs) {
        const [signature, from, to] = log.topics;
        if (signature !== TRANSFER || !from || !to || log.topics.length !== 3) continue;
        transfers.push({ token: log.address.toLowerCase(), from: topicAddress(from), to: topicAddress(to), value: BigInt(log.data) });
      }
      return { success: receipt.status === "success", transfers };
    },
  };
}
