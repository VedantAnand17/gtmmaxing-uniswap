import { ARC_TESTNET, type ArcOptions } from "@found/contracts";
import type { ArcClient } from "../features/arc/arcClient";

const OPTIONS: ArcOptions = {
  enabled: true, chain_id: ARC_TESTNET.chainId, chain_name: ARC_TESTNET.name, rpc_url: ARC_TESTNET.rpcUrl,
  explorer_url: ARC_TESTNET.explorerUrl, faucet_url: ARC_TESTNET.faucetUrl, usdc: ARC_TESTNET.usdc,
  treasury: "0x00000000000000000000000000000000000000aa",
};

/** Simulates the server's confirmation; the wallet itself is the browser's. */
export const mockArc: ArcClient = {
  options: async () => OPTIONS,
  confirm: async (txHash) => ({ tx_hash: txHash, wallet: "0x1111111111111111111111111111111111111111", micros: 1_000_000, credits_equivalent: 66, credits_granted: 0, explorer_url: `${ARC_TESTNET.explorerUrl}/tx/${txHash}` }),
};
