import { and, desc, eq, gt, inArray, or, sql, sum } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { cryptoTopups } from "../db/schema.js";

export type TopupRow = typeof cryptoTopups.$inferSelect;
export type NewTopup = typeof cryptoTopups.$inferInsert;
export type TopupPatch = Partial<Pick<TopupRow, "phase" | "pendingAction" | "expectedTo" | "expectedData" | "planId" | "status" | "error" | "sourceTx">>;

const isUniqueViolation = (error: unknown) => /UNIQUE constraint failed/i.test(String((error as { message?: unknown; cause?: unknown })?.message) + String((error as { cause?: unknown })?.cause));

export class TopupStore {
  constructor(private readonly db: Database) {}

  async insert(row: NewTopup): Promise<void> {
    await this.db.insert(cryptoTopups).values(row);
  }

  async get(id: string): Promise<TopupRow | null> {
    return (await this.db.select().from(cryptoTopups).where(eq(cryptoTopups.id, id)).get()) ?? null;
  }

  async patch(id: string, patch: TopupPatch): Promise<void> {
    await this.db.update(cryptoTopups).set(patch).where(eq(cryptoTopups.id, id));
  }

  /** False when another top-up already used this source transaction. */
  async recordSourceTx(id: string, sourceTx: string, phase: string): Promise<boolean> {
    try {
      await this.db.update(cryptoTopups).set({ sourceTx, phase, pendingAction: null }).where(eq(cryptoTopups.id, id));
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /**
   * Marks the top-up credited; its trigger adds the credits in the same
   * statement. False when this payment already credited a top-up.
   */
  async credit(id: string, input: { credits: number; micros: number; chainId: number; txHash: string; logIndex: number; jarNonce?: number; at: number }): Promise<boolean> {
    try {
      const done = await this.db.update(cryptoTopups).set({
        status: "credited", phase: "done", pendingAction: null, credits: input.credits, settledMicros: input.micros,
        settledChainId: input.chainId, settledTx: input.txHash, settledLogIndex: input.logIndex, creditedAt: input.at,
        ...(input.jarNonce === undefined ? {} : { jarNonce: input.jarNonce }),
      }).where(and(eq(cryptoTopups.id, id), eq(cryptoTopups.status, "open"))).returning({ id: cryptoTopups.id });
      return done.length > 0;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /**
   * Jar value this round has promised: credited under the current releaser
   * nonce, plus deposits still open or being checked.
   */
  async jarCommitted(nonce: number, now: number): Promise<number> {
    const row = await this.db.select({ total: sum(cryptoTopups.jarMicros) }).from(cryptoTopups).where(and(
      eq(cryptoTopups.rail, "jar"),
      or(
        and(eq(cryptoTopups.status, "credited"), eq(cryptoTopups.jarNonce, nonce)),
        and(eq(cryptoTopups.status, "open"), or(gt(cryptoTopups.expiresAt, now), inArray(cryptoTopups.phase, ["settling"]))),
      ),
    )).get();
    return Number(row?.total ?? 0);
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(cryptoTopups).where(eq(cryptoTopups.id, id));
  }

  async countRecent(userId: string, since: number): Promise<number> {
    const row = await this.db.select({ count: sql<number>`count(*)` }).from(cryptoTopups)
      .where(and(eq(cryptoTopups.userId, userId), gt(cryptoTopups.createdAt, since))).get();
    return Number(row?.count ?? 0);
  }

  async latest(userId: string, limit: number): Promise<TopupRow[]> {
    return this.db.select().from(cryptoTopups).where(eq(cryptoTopups.userId, userId)).orderBy(desc(cryptoTopups.createdAt)).limit(limit).all();
  }
}
