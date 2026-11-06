import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { arcTestPayments } from "../db/schema.js";

export type ArcPaymentRow = typeof arcTestPayments.$inferSelect;

export class ArcPaymentStore {
  constructor(private readonly db: Database) {}

  async get(txHash: string): Promise<ArcPaymentRow | null> {
    return (await this.db.select().from(arcTestPayments).where(eq(arcTestPayments.txHash, txHash)).get()) ?? null;
  }

  /** The stored row: this one, or whichever got there first if two requests raced. */
  async insert(row: ArcPaymentRow): Promise<ArcPaymentRow> {
    await this.db.insert(arcTestPayments).values(row).onConflictDoNothing();
    return (await this.get(row.txHash))!;
  }
}
