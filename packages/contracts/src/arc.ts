import { z } from "zod";
import { txHashSchema } from "./topups.js";

/**
 * Arc Testnet, where USDC is the gas token. Its native balance has 18 decimals
 * and the ERC-20 interface has 6, over one shared balance, so payments here only
 * ever use the ERC-20 interface and never mix the two.
 */
export const ARC_TESTNET = {
  chainId: 5042002,
  name: "Arc Testnet",
  rpcUrl: "https://rpc.testnet.arc.network",
  explorerUrl: "https://explorer.testnet.arc.io",
  faucetUrl: "https://faucet.circle.com",
  usdc: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
} as const;

export const arcOptionsSchema = z.object({
  enabled: z.boolean(),
  chain_id: z.number().int().optional(),
  chain_name: z.string().optional(),
  rpc_url: z.string().optional(),
  explorer_url: z.string().optional(),
  faucet_url: z.string().optional(),
  usdc: z.string().optional(),
  treasury: z.string().optional(),
});
export type ArcOptions = z.infer<typeof arcOptionsSchema>;

export const arcConfirmSchema = z.object({ tx_hash: txHashSchema }).strict();

/** A confirmed test payment. Test USDC has no value, so `credits_granted` is always 0. */
export const arcPaymentSchema = z.object({
  tx_hash: txHashSchema,
  wallet: z.string(),
  micros: z.number().int(),
  /** What the same amount would buy in real USDC, shown for comparison only. */
  credits_equivalent: z.number().int(),
  credits_granted: z.literal(0),
  explorer_url: z.string(),
});
export type ArcPayment = z.infer<typeof arcPaymentSchema>;
export const arcPaymentResponseSchema = z.object({ payment: arcPaymentSchema });
