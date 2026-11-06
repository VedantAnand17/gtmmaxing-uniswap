import { z } from "zod";
import { periodCredits, planById, type Billing, type CreditPlan } from "./plans.js";

/**
 * Credit top-ups paid from a crypto wallet. Money settles as USDC on Base, by
 * one of three rails: `usdc` (plain transfer), `swap` (any token on any chain
 * the Uniswap API routes, delivered straight to the treasury) or `jar` (a small
 * transfer into our Uniswap Token Jar, cleared later for USDC by a searcher).
 */
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/** Same price as the Starter plan: about 1.5 cents per credit. */
export const TOPUP_MICROS_PER_CREDIT = 15_000;
export const TOPUP_MIN_MICROS = 1_000_000;
export const TOPUP_MAX_MICROS = 500_000_000;
/** Share of a jar deposit kept back: it pays the searcher who clears the jar and the price risk until then. */
export const JAR_HAIRCUT_BPS = 500;
export const JAR_MAX_MICROS = 2_000_000;
/** The most an agent's wallet may spend on one top-up. */
export const AGENT_TOPUP_MAX_MICROS = 50_000_000;

export const creditsForMicros = (micros: number) => Math.floor(micros / TOPUP_MICROS_PER_CREDIT);

export interface PlanChoice {
  plan: CreditPlan;
  billing: Billing;
}

/** Reads `growth-annual` into a plan and its billing period. */
export function parsePlanChoice(value: string | null | undefined): PlanChoice | null {
  const [id, billing] = (value ?? "").split("-");
  const plan = planById(id ?? "");
  return plan && (billing === "monthly" || billing === "annual") ? { plan, billing } : null;
}

export const planPriceMicros = ({ plan, billing }: PlanChoice) => plan.prices[billing].usd * 1_000_000;

/**
 * Credits for a wallet payment toward a plan: the plan's credits, plus anything
 * paid above its price at the top-up rate, since a swap rarely lands exactly.
 * Paying less than the price buys only what was paid for.
 */
export function planPaymentCredits(choice: PlanChoice, micros: number): number {
  const price = planPriceMicros(choice);
  return micros >= price ? periodCredits(choice.plan, choice.billing) + creditsForMicros(micros - price) : creditsForMicros(micros);
}

/** What the wallet signs so a transfer from it can credit this account, and only this account. */
export function topupAuthorization(input: { account: string; wallet: string; issuedAt: number }): string {
  return `GTMMAXING credit top-up\nAccount: ${input.account.toLowerCase()}\nWallet: ${input.wallet.toLowerCase()}\nIssued: ${input.issuedAt}`;
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const topupRailSchema = z.enum(["usdc", "swap", "jar"]);
export type TopupRail = z.infer<typeof topupRailSchema>;

export const topupTokenSchema = z.object({ symbol: z.string(), address, decimals: z.number().int(), jar: z.boolean().optional() });
export const topupChainSchema = z.object({ id: z.number().int(), name: z.string(), tokens: z.array(topupTokenSchema) });
export const topupOptionsSchema = z.object({
  enabled: z.boolean(),
  micros_per_credit: z.number().int().optional(),
  min_micros: z.number().int().optional(),
  max_micros: z.number().int().optional(),
  chains: z.array(topupChainSchema).optional(),
  jar: z.object({ chain_id: z.number().int(), address, max_micros: z.number().int(), available_micros: z.number().int(), haircut_bps: z.number().int() }).nullable().optional(),
});
export type TopupOptions = z.infer<typeof topupOptionsSchema>;
export type TopupChain = z.infer<typeof topupChainSchema>;
export type TopupToken = z.infer<typeof topupTokenSchema>;

export const topupCreateSchema = z.object({
  wallet: address,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2048),
  issued_at: z.number().int(),
  chain_id: z.number().int().positive(),
  token: address,
  amount: z.string().regex(/^[1-9][0-9]{0,77}$/),
  /** `auto` uses the jar when the payment fits it, and a swap otherwise. */
  rail: z.enum(["usdc", "swap", "jar", "auto"]).optional(),
  /** A plan such as `growth-annual`. The server sizes the payment, so `amount` only prices the token: send one whole unit. */
  plan: z.string().max(40).optional(),
});
export type TopupCreate = z.infer<typeof topupCreateSchema>;

export const topupProofSchema = z.object({ tx_hash: txHashSchema.optional(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4096).optional() });
export type TopupProof = z.infer<typeof topupProofSchema>;

const walletTxSchema = z.object({ chain_id: z.number().int(), to: address, data: z.string(), value: z.string() });
/** The one thing the wallet does next. The server drives the sequence, so the page only follows it. */
export const topupActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send_tx"), label: z.string(), tx: walletTxSchema }),
  z.object({ kind: z.literal("sign_typed_data"), label: z.string(), chain_id: z.number().int(), typed_data: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("wait"), label: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type TopupAction = z.infer<typeof topupActionSchema>;
export type TopupWalletTx = z.infer<typeof walletTxSchema>;

export const topupViewSchema = z.object({
  id: z.string(),
  rail: topupRailSchema,
  routing: z.string().nullable(),
  /** The plan being bought, such as `growth-annual`; null for a plain top-up. */
  plan: z.string().nullable(),
  /** What the wallet pays, in the token's smallest unit. */
  amount_in: z.string(),
  status: z.enum(["open", "credited", "failed", "expired"]),
  estimated_credits: z.number().int(),
  minimum_credits: z.number().int(),
  credits: z.number().int().nullable(),
  settlement_tx: z.string().nullable(),
  action: topupActionSchema,
  error: z.string().nullable(),
});
export type TopupView = z.infer<typeof topupViewSchema>;
export const topupResponseSchema = z.object({ topup: topupViewSchema });

/** GET /v1/agent/topups/options: the wallet options, plus what this agent signs and whether its owner allows it. */
export const agentTopupOptionsSchema = topupOptionsSchema.extend({ allowed: z.boolean(), account: z.string(), max_micros_per_payment: z.number().int() });
