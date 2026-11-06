import { useEffect, useState } from "react";
import { CREDIT_PLANS, parsePlanChoice, type Billing, type CreditPlan } from "@found/contracts";
import { api } from "../../lib/apiClient";
import { leavePage } from "../../lib/navigation";
import type { SessionUser } from "../../lib/session";

export const AGENCY_CTA = "https://calendly.com/himalay-getbags";

/** The Stripe checkout for this plan, naming the signed-in buyer so the payment credits their account. */
export function checkoutUrl(plan: CreditPlan, billing: Billing, user: SessionUser): string {
  const url = new URL(plan.prices[billing].url);
  if (user.id) url.searchParams.set("client_reference_id", user.id);
  url.searchParams.set("prefilled_email", user.email);
  return url.toString();
}

/** `?plan=growth-annual`, set when sign-in returns here to finish choosing a plan. */
function pendingChoice(search: string): { plan: CreditPlan; billing: Billing } | null {
  return parsePlanChoice(new URLSearchParams(search).get("plan"));
}

const formatCredits = (credits: number) => credits.toLocaleString("en-US");
const monthlyEquivalent = (plan: CreditPlan) => Math.round(plan.prices.annual.usd / 12);
const FAIR_USE_CREDITS = CREDIT_PLANS.find((plan) => plan.unlimited)?.monthlyCredits ?? 0;

export function PricingPlans() {
  const [billing, setBilling] = useState<Billing>("monthly");
  const [opening, setOpening] = useState<string | null>(null);
  const [purchased, setPurchased] = useState(false);
  const annual = billing === "annual";

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("purchase") === "success") setPurchased(true);
    const pending = pendingChoice(window.location.search);
    if (!pending) return;
    setBilling(pending.billing);
    setOpening(pending.plan.id);
    window.history.replaceState(null, "", `${window.location.pathname}#plans`);
    void api.session.current().then((session) => {
      if (session) leavePage(checkoutUrl(pending.plan, pending.billing, session.user));
      else setOpening(null);
    });
  }, []);

  async function choose(plan: CreditPlan) {
    setOpening(plan.id);
    const session = await api.session.current();
    if (session) return leavePage(checkoutUrl(plan, billing, session.user));
    const start = api.session.signIn(`/outboundmaxing/?plan=${plan.id}-${billing}`);
    leavePage("redirect" in start ? start.redirect : checkoutUrl(plan, billing, start.session.user));
  }

  return (
    <>
      {purchased && <p className="plan-purchased" role="status">Payment received. Your credits are being added to your GTMMAXING account. <a href="/?workspace=1">Open your workspace</a></p>}
      <fieldset className="billing-toggle">
        <legend className="sr-only">Billing frequency</legend>
        <label>
          <input type="radio" name="billing" value="monthly" checked={!annual} onChange={() => setBilling("monthly")} />
          <span>Monthly</span>
        </label>
        <label>
          <input type="radio" name="billing" value="annual" checked={annual} onChange={() => setBilling("annual")} />
          <span>Annually</span>
        </label>
      </fieldset>
      <p className="billing-note">Annual plans are billed upfront and add the full year of credits at once. Save up to 19%.</p>
      <div className="plan-grid" aria-live="polite" aria-atomic="true">
        {CREDIT_PLANS.map((plan) => {
          const featured = plan.id === "growth";
          const price = plan.prices[billing];
          return (
            <article className={`plan-card${featured ? " plan-card-featured" : ""}`} key={plan.id} aria-labelledby={`plan-${plan.id}`}>
              <h3 id={`plan-${plan.id}`}>{plan.name}</h3>
              <p className="plan-price"><strong>${annual ? monthlyEquivalent(plan) : price.usd}</strong><span>/month</span></p>
              <p className="plan-billing">{annual ? `$${price.usd.toLocaleString("en-US")} billed annually` : "Billed monthly"}</p>
              <p className="plan-alternate">{annual ? `$${plan.prices.monthly.usd}/month with monthly billing` : `$${monthlyEquivalent(plan)}/month, billed annually`}</p>
              <div className="plan-divider" />
              <p className="plan-credits">{plan.unlimited ? "Unlimited credits*" : <><strong>{formatCredits(plan.monthlyCredits)}</strong> credits / month</>}</p>
              <ul className="plan-features">
                <li>Unlimited seats</li>
                <li>Email lookups included</li>
                <li>Phone lookups included</li>
                <li>{plan.unlimited ? "Fair use policy applies" : "Unused credits roll over"}</li>
              </ul>
              <a
                className={`agency-button workspace-button${featured ? "" : " agency-button-outline"}`}
                href={price.url}
                aria-busy={opening === plan.id}
                onClick={(event) => { event.preventDefault(); void choose(plan); }}
              >
                {opening === plan.id ? "Opening checkout…" : `Choose ${plan.name}`}
              </a>
              <a className="plan-crypto" href={`/topup/?plan=${plan.id}-${billing}`} aria-label={`Pay for ${plan.name} with crypto`}>Pay with crypto</a>
            </article>
          );
        })}
      </div>
      <p className="plan-footnote">Monthly plans add their credits every month. Unused credits roll over. Card checkout is handled securely by Stripe. Crypto payments go through Uniswap, from almost any token on eight networks, and cover one billing period with no renewal.<br />*Unlimited is subject to our fair use policy of {formatCredits(FAIR_USE_CREDITS)} credits a month. <a href={AGENCY_CTA}>Need more? Talk to us.</a></p>
    </>
  );
}
