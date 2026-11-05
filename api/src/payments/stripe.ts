import { periodCredits, planById, planByLinkId, type Billing, type CreditPlan } from "@found/contracts";
import { timingSafeEqual } from "../auth/session.js";
import type { PurchaseBuyer, PurchaseStore } from "../store/purchases.js";
import type { UserRow } from "../store/users.js";

/** Stripe's default replay window for signed webhooks. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a `Stripe-Signature` header (`t=<unix>,v1=<hex hmac>`): HMAC-SHA256
 * of `<t>.<raw body>` with the endpoint's signing secret, within the window.
 */
export async function verifyStripeSignature(payload: string, header: string | undefined, secret: string, nowMs: number): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((part) => part.split("=", 2) as [string, string | undefined]);
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key, value]) => key === "v1" && value).map(([, value]) => value!);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  return signatures.some((signature) => /^[0-9a-f]{64}$/.test(signature) && timingSafeEqual(expected, hexBytes(signature)));
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export type StripeOutcome =
  | { status: "credited"; purchaseId: string; plan: string; credits: number }
  | { status: "awaiting_signup"; purchaseId: string; plan: string; credits: number }
  | { status: "duplicate"; purchaseId: string }
  | { status: "ignored"; reason: string };

export interface StripeUsers {
  byId(id: string): Promise<UserRow | null>;
  byEmail(email: string): Promise<UserRow | null>;
}

/**
 * Turns paid Stripe checkouts and renewals into credits. The first payment
 * arrives as a completed checkout (which carries the Payment Link and the
 * GTMMAXING user id passed as `client_reference_id`); each later period
 * arrives as a paid renewal invoice for the subscription recorded then.
 */
export class StripeCredits {
  constructor(private readonly deps: { purchases: PurchaseStore; users: StripeUsers }) {}

  async handle(event: StripeEvent): Promise<StripeOutcome> {
    const object = event.data.object;
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") return this.checkout(object);
    if (event.type === "invoice.paid") return this.renewal(object);
    return { status: "ignored", reason: "event_type" };
  }

  private async checkout(session: Record<string, unknown>): Promise<StripeOutcome> {
    const bought = planByLinkId(str(session.payment_link) ?? "");
    if (!bought) return { status: "ignored", reason: "unknown_payment_link" };
    if (session.payment_status !== "paid") return { status: "ignored", reason: "unpaid" };
    const sessionId = str(session.id);
    if (!sessionId) return { status: "ignored", reason: "malformed" };
    const details = session.customer_details as { email?: unknown } | null | undefined;
    const email = str(details?.email) ?? str(session.customer_email);
    const user = await this.buyer(str(session.client_reference_id), email);
    const subscriptionId = idOf(session.subscription);
    if (subscriptionId) {
      await this.deps.purchases.rememberSubscription({ id: subscriptionId, customerId: idOf(session.customer), userId: user?.userId ?? null, email, plan: bought.plan.id, billing: bought.billing });
    }
    return this.grant({ id: sessionId, subscriptionId, user, email, ...bought, amountCents: num(session.amount_total), currency: str(session.currency) ?? "usd" });
  }

  private async renewal(invoice: Record<string, unknown>): Promise<StripeOutcome> {
    // The first invoice is credited through its checkout; only later periods count here.
    if (invoice.billing_reason !== "subscription_cycle") return { status: "ignored", reason: "not_renewal" };
    const parent = invoice.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
    const subscriptionId = idOf(invoice.subscription) ?? idOf(parent?.subscription_details?.subscription);
    const invoiceId = str(invoice.id);
    const subscription = subscriptionId ? await this.deps.purchases.subscription(subscriptionId) : null;
    const plan = subscription ? planById(subscription.plan) : null;
    if (!invoiceId || !subscription || !plan) return { status: "ignored", reason: "unknown_subscription" };
    const email = str(invoice.customer_email) ?? subscription.email;
    const user = await this.buyer(subscription.userId, email);
    return this.grant({ id: invoiceId, subscriptionId, user, email, plan, billing: subscription.billing as Billing, amountCents: num(invoice.amount_paid), currency: str(invoice.currency) ?? "usd" });
  }

  private async grant(input: { id: string; subscriptionId: string | null; user: PurchaseBuyer | null; email: string | null; plan: CreditPlan; billing: Billing; amountCents: number; currency: string }): Promise<StripeOutcome> {
    const credits = periodCredits(input.plan, input.billing);
    const recorded = await this.deps.purchases.record({
      id: input.id, subscriptionId: input.subscriptionId, buyer: input.user, email: input.email,
      plan: input.plan.id, billing: input.billing, credits, amountCents: input.amountCents, currency: input.currency,
    });
    if (!recorded) return { status: "duplicate", purchaseId: input.id };
    return { status: input.user ? "credited" : "awaiting_signup", purchaseId: input.id, plan: input.plan.id, credits };
  }

  /** The signed-in buyer named on the checkout, else the GTMMAXING account with the paying email. */
  private async buyer(userId: string | null, email: string | null): Promise<PurchaseBuyer | null> {
    const byId = userId ? await this.deps.users.byId(userId) : null;
    const user = byId ?? (email ? await this.deps.users.byEmail(email).catch(() => null) : null);
    return user ? { userId: user.id, accountId: user.creditAccountId } : null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Stripe fields are ids unless expanded into objects. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  return value && typeof value === "object" ? str((value as { id?: unknown }).id) : null;
}
