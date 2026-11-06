import { AGENT_TOPUP_MAX_MICROS, CREDIT_PLANS, TOPUP_MAX_MICROS, TOPUP_MICROS_PER_CREDIT, TOPUP_MIN_MICROS, JAR_MAX_MICROS, periodCredits } from "@found/contracts";
import { SITE_URL } from "../lib/seo";

const API_URL = "https://api.gtmmaxing.com";
const usd = (micros: number) => micros / 1_000_000;

/** Machine-readable prices and ways to pay, so an agent can compare and buy without reading the page. */
export function GET() {
  const body = {
    name: "GTMMAXING",
    currency: "USD",
    plans: CREDIT_PLANS.map((plan) => ({
      id: plan.id,
      name: plan.name,
      unlimited_under_fair_use: plan.unlimited,
      prices: (["monthly", "annual"] as const).map((billing) => ({
        billing,
        usd: plan.prices[billing].usd,
        credits: periodCredits(plan, billing),
        pay_by_card: `${SITE_URL}/outboundmaxing/?plan=${plan.id}-${billing}`,
        pay_with_crypto: `${SITE_URL}/topup/?plan=${plan.id}-${billing}`,
      })),
    })),
    pay_as_you_go: {
      usd_per_credit: usd(TOPUP_MICROS_PER_CREDIT),
      min_usd: usd(TOPUP_MIN_MICROS),
      max_usd: usd(TOPUP_MAX_MICROS),
      pay_with_crypto: `${SITE_URL}/topup/`,
    },
    crypto: {
      via: "Uniswap",
      settles_in: "USDC on Base",
      networks: ["Base", "Arbitrum", "Ethereum", "Optimism", "Polygon", "BNB Chain", "Unichain", "Avalanche"],
      token_jar: { for_payments_under_usd: usd(JAR_MAX_MICROS), note: "Small Base payments can go into a Uniswap Token Jar instead of a swap, for 5% less credit." },
    },
    agents: {
      summary: "An agent token can buy credits from the agent's own wallet once its owner switches that on. Plans stay with the owner.",
      max_usd_per_payment: usd(AGENT_TOPUP_MAX_MICROS),
      options: `${API_URL}/v1/agent/topups/options`,
      buy: `${API_URL}/v1/agent/topups`,
      openapi: `${SITE_URL}/openapi.json`,
      guide: `${SITE_URL}/developers/buy-credits/`,
    },
  };
  return new Response(`${JSON.stringify(body, null, 2)}\n`, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
