import { describe, expect, it } from "vitest";
import { ARC_TESTNET } from "@found/contracts";
import { createRuntime } from "../src/runtime.js";
import { CREDIT_ATOMIC } from "../src/domain/credits.js";
import type { ArcReader, ArcTransfer } from "../src/payments/arc.js";
import { createTestDb, SESSION_SECRET, signIn } from "./helpers.js";

const TREASURY = "0x00000000000000000000000000000000000000aa";
const PAYER = "0x00000000000000000000000000000000000000f1";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

class FakeArc implements ArcReader {
  receipts = new Map<string, { success: boolean; transfers: ArcTransfer[] } | null>();
  failing = false;
  async receipt(txHash: string) {
    if (this.failing) throw new Error("rpc down");
    return this.receipts.get(txHash) ?? null;
  }
  pay(n: number, micros: bigint, overrides: Partial<ArcTransfer> = {}, success = true) {
    this.receipts.set(hash(n), { success, transfers: [{ token: ARC_TESTNET.usdc.toLowerCase(), from: PAYER, to: TREASURY, value: micros, ...overrides }] });
  }
}

async function setup(env: Record<string, string> = { TOPUP_TREASURY: TREASURY }) {
  const arc = new FakeArc();
  const runtime = await createRuntime({ PROVIDER_MODE: "mock", SESSION_SECRET, ...env }, { db: await createTestDb(), arc });
  const headers = { cookie: await signIn(runtime, { sub: "payer", email: "payer@example.com" }), "content-type": "application/json" };
  const user = (await runtime.deps.users.byGoogleSub("payer"))!;
  const confirm = async (tx_hash: unknown, as = headers) => {
    const response = await runtime.app.request("/arc/payments", { method: "POST", headers: as, body: JSON.stringify({ tx_hash }) });
    return { status: response.status, body: await response.json() as { error?: string; payment?: Record<string, unknown> } };
  };
  const balance = async () => (await runtime.deps.credits.balance(user.creditAccountId)) / CREDIT_ATOMIC;
  return { arc, runtime, headers, confirm, balance };
}

describe("USDC test checkout on Arc", () => {
  it("publishes the network, token and treasury a wallet needs", async () => {
    const s = await setup();
    expect(await (await s.runtime.app.request("/arc/options")).json()).toMatchObject({ enabled: true, chain_id: 5042002, usdc: ARC_TESTNET.usdc, treasury: TREASURY });
  });

  it("is off without a treasury", async () => {
    const s = await setup({});
    expect(await (await s.runtime.app.request("/arc/options")).json()).toEqual({ enabled: false });
    expect((await s.confirm(hash(1))).status).toBe(404);
  });

  it("confirms a real transfer to the treasury and never grants credits for test USDC", async () => {
    const s = await setup();
    const before = await s.balance();
    s.arc.pay(1, 1_500_000n);
    expect(await s.confirm(hash(1))).toMatchObject({ status: 200, body: { payment: { tx_hash: hash(1), wallet: PAYER, micros: 1_500_000, credits_equivalent: 100, credits_granted: 0, explorer_url: `${ARC_TESTNET.explorerUrl}/tx/${hash(1)}` } } });
    expect(await s.balance()).toBe(before);
  });

  it("requires sign-in", async () => {
    const s = await setup();
    expect((await s.confirm(hash(1), { "content-type": "application/json" } as never)).status).toBe(401);
  });

  it("refuses a malformed hash", async () => {
    expect(await (await setup()).confirm("0xnope")).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });

  it("says to wait while the transaction is unknown or the network is unreachable", async () => {
    const s = await setup();
    expect(await s.confirm(hash(2))).toMatchObject({ status: 409, body: { error: "not_confirmed" } });
    s.arc.failing = true;
    expect(await s.confirm(hash(2))).toMatchObject({ status: 409, body: { error: "not_confirmed" } });
  });

  it("refuses a failed transaction, another token, and a transfer to someone else", async () => {
    const s = await setup();
    s.arc.pay(3, 1_000_000n, {}, false);
    expect((await s.confirm(hash(3))).body.error).toBe("payment_reverted");
    s.arc.pay(4, 1_000_000n, { token: "0x00000000000000000000000000000000000000bb" });
    expect((await s.confirm(hash(4))).body.error).toBe("payment_mismatch");
    s.arc.pay(5, 1_000_000n, { to: "0x00000000000000000000000000000000000000cc" });
    expect((await s.confirm(hash(5))).body.error).toBe("payment_mismatch");
  });

  it("answers the same on a repeat, and refuses a payment another account claimed", async () => {
    const s = await setup();
    s.arc.pay(6, 2_000_000n);
    const first = await s.confirm(hash(6));
    expect(await s.confirm(hash(6))).toEqual(first);
    const other = { cookie: await signIn(s.runtime, { sub: "other", email: "other@example.com" }), "content-type": "application/json" };
    expect((await s.confirm(hash(6), other)).body.error).toBe("payment_already_used");
  });
});
