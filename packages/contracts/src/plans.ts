/**
 * Paid credit plans sold through Stripe Payment Links (live account "Bags App").
 * Credits sell at roughly 1.5 cents each; one credit still covers $0.01 of
 * product usage (`CREDIT_ATOMIC`). Annual plans add the full year of credits
 * when the yearly invoice is paid. The link ids are how the Stripe webhook
 * knows which plan a checkout bought, so a new link must be added here.
 */
export type PlanId = "starter" | "growth" | "unlimited";
export type Billing = "monthly" | "annual";

export interface PlanPrice {
  /** USD charged per billing period. */
  usd: number;
  /** Public Stripe Payment Link. */
  url: string;
  /** Stripe Payment Link id (`plink_...`), reported on the completed checkout. */
  linkId: string;
}

export interface CreditPlan {
  id: PlanId;
  name: string;
  /** Credits added for each month the plan covers. */
  monthlyCredits: number;
  /** Shown instead of a credit count; still granted as `monthlyCredits` under fair use. */
  unlimited: boolean;
  prices: Record<Billing, PlanPrice>;
}

export const CREDIT_PLANS: readonly CreditPlan[] = [
  {
    id: "starter", name: "Starter", monthlyCredits: 2_000, unlimited: false,
    prices: {
      monthly: { usd: 30, url: "https://buy.stripe.com/8x214o9aobNr7Tx85v5gc02", linkId: "plink_1UVzDYLFFDNJNkHJJ4fWmieL" },
      annual: { usd: 300, url: "https://buy.stripe.com/00w5kE4U84kZflZfxX5gc03", linkId: "plink_1UVzFmLFFDNJNkHJbQW9Dy7X" },
    },
  },
  {
    id: "growth", name: "Growth", monthlyCredits: 4_500, unlimited: false,
    prices: {
      monthly: { usd: 60, url: "https://buy.stripe.com/3cI28s4U818N6PtbhH5gc04", linkId: "plink_1UVzGELFFDNJNkHJnlfjOxwk" },
      annual: { usd: 600, url: "https://buy.stripe.com/14A4gAbiw6t78XBadD5gc05", linkId: "plink_1UVzGgLFFDNJNkHJtvftWZKw" },
    },
  },
  {
    id: "unlimited", name: "Unlimited", monthlyCredits: 10_000, unlimited: true,
    prices: {
      monthly: { usd: 129, url: "https://buy.stripe.com/3cI5kEbiw4kZddRetT5gc08", linkId: "plink_1UVzxYLFFDNJNkHJoG37CnPv" },
      annual: { usd: 1_290, url: "https://buy.stripe.com/00w14o3Q4eZDehV4Tj5gc09", linkId: "plink_1UVzyVLFFDNJNkHJbNAsT6il" },
    },
  },
];

/** Credits one paid billing period adds. */
export const periodCredits = (plan: CreditPlan, billing: Billing): number => plan.monthlyCredits * (billing === "annual" ? 12 : 1);

export function planByLinkId(linkId: string): { plan: CreditPlan; billing: Billing } | null {
  for (const plan of CREDIT_PLANS) {
    for (const billing of ["monthly", "annual"] as const) if (plan.prices[billing].linkId === linkId) return { plan, billing };
  }
  return null;
}

export function planById(id: string): CreditPlan | null {
  return CREDIT_PLANS.find((plan) => plan.id === id) ?? null;
}
