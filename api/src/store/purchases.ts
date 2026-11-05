import { and, eq, isNull } from "drizzle-orm";
import type { Billing, PlanId } from "@found/contracts";
import type { Database } from "../db/client.js";
import { creditPurchases, stripeSubscriptions } from "../db/schema.js";

export interface PurchaseBuyer {
  userId: string;
  accountId: string;
}

export interface NewPurchase {
  /** Stripe checkout session or invoice id; the idempotency key. */
  id: string;
  subscriptionId: string | null;
  buyer: PurchaseBuyer | null;
  email: string | null;
  plan: PlanId;
  billing: Billing;
  credits: number;
  amountCents: number;
  currency: string;
}

export interface SubscriptionRecord {
  id: string;
  customerId: string | null;
  userId: string | null;
  email: string | null;
  plan: string;
  billing: string;
}

/**
 * Stripe credit purchases. Recording a purchase with a buyer adds its credits
 * through the `credit_purchases_grant_*` triggers in the same statement, so a
 * replayed webhook can never grant twice. Purchases whose email has no account
 * yet wait, and `claim` credits them when that person first signs in.
 */
export class PurchaseStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when this call recorded the purchase; false for a replay. */
  async record(purchase: NewPurchase): Promise<boolean> {
    const ts = this.now();
    const inserted = await this.db.insert(creditPurchases).values({
      id: purchase.id,
      subscriptionId: purchase.subscriptionId,
      userId: purchase.buyer?.userId ?? null,
      accountId: purchase.buyer?.accountId ?? null,
      email: normalizeEmail(purchase.email),
      plan: purchase.plan,
      billing: purchase.billing,
      credits: purchase.credits,
      amountCents: purchase.amountCents,
      currency: purchase.currency,
      createdAt: ts,
      creditedAt: purchase.buyer ? ts : null,
    }).onConflictDoNothing().returning({ id: creditPurchases.id });
    return inserted.length > 0;
  }

  async rememberSubscription(record: SubscriptionRecord): Promise<void> {
    await this.db.insert(stripeSubscriptions).values({ ...record, email: normalizeEmail(record.email), createdAt: this.now() }).onConflictDoNothing();
  }

  async subscription(id: string): Promise<SubscriptionRecord | null> {
    const row = await this.db.select().from(stripeSubscriptions).where(eq(stripeSubscriptions.id, id)).get();
    return row ?? null;
  }

  /** Credits every waiting purchase made with this email to the new account. Returns the credits added. */
  async claim(email: string, buyer: PurchaseBuyer): Promise<number> {
    const normalized = normalizeEmail(email);
    if (!normalized) return 0;
    const ts = this.now();
    const claimed = await this.db.update(creditPurchases)
      .set({ userId: buyer.userId, accountId: buyer.accountId, creditedAt: ts })
      .where(and(eq(creditPurchases.email, normalized), isNull(creditPurchases.accountId)))
      .returning({ credits: creditPurchases.credits });
    await this.db.update(stripeSubscriptions)
      .set({ userId: buyer.userId })
      .where(and(eq(stripeSubscriptions.email, normalized), isNull(stripeSubscriptions.userId)));
    return claimed.reduce((total, row) => total + row.credits, 0);
  }
}

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}
