import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, NATIVE_TOKEN, topupAuthorization } from "@found/contracts";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { accounts } from "../src/db/schema.js";
import { CREDIT_ATOMIC } from "../src/domain/credits.js";
import { walletTypedData } from "../src/application/topups/index.js";
import { TOPUP_CHAINS } from "../src/application/topups/catalog.js";
import { DEFAULT_RPC_URLS, type ChainReader, type ChainTx, type UsdcDelivery } from "../src/payments/chain-reader.js";
import { UniswapError, type UniswapApi, type UniswapPlan, type UniswapQuoteInput } from "../src/payments/uniswap.js";
import { createTestDb, SESSION_SECRET, signIn } from "./helpers.js";

const TREASURY = "0x00000000000000000000000000000000000000aa";
const JAR = "0x00000000000000000000000000000000000000bb";
const RELEASER = "0x00000000000000000000000000000000000000cc";
const ROUTER = "0x00000000000000000000000000000000000000dd";
const ARB_ADDRESS = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const account = privateKeyToAccount("0x1000000000000000000000000000000000000000000000000000000000000001");
const stranger = privateKeyToAccount("0x2000000000000000000000000000000000000000000000000000000000000002");
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

class FakeChains implements ChainReader {
  txs = new Map<string, ChainTx>();
  deliveries: UsdcDelivery[] = [];
  nonce = 0;
  threshold = 5_000_000;
  async tx(_chainId: number, txHash: string) { return this.txs.get(txHash) ?? null; }
  async blockNumber() { return 100; }
  async usdcDeliveries() { return this.deliveries; }
  async releaser() { return { nonce: this.nonce, threshold: this.threshold }; }
  add(txHash: string, tx: Partial<ChainTx>) {
    this.txs.set(txHash, { hash: txHash, success: true, from: account.address.toLowerCase(), to: ROUTER, data: "0xswap", value: 0n, transfers: [], ...tx });
  }
}

class FakeUniswap implements UniswapApi {
  routing = "CLASSIC";
  output = { amount: "10000000", minimumAmount: "9800000" };
  /** When set, quotes scale with the amount: USDC micros per one raw token unit, at 0.5% slippage. */
  rate: number | null = null;
  approval: { to: string; data: string; value: string } | null = null;
  permitData: Record<string, unknown> | null = null;
  plan = {} as UniswapPlan;
  patches: unknown[] = [];
  quotes: UniswapQuoteInput[] = [];
  swapInputs: unknown[] = [];
  async quote(input: UniswapQuoteInput) {
    this.quotes.push(input);
    if (this.rate !== null && Number(input.amount) * this.rate < 1_000) throw new UniswapError(400, "QuoteAmountTooLowError", "too small");
    const output = this.rate === null ? this.output : { amount: String(Math.floor(Number(input.amount) * this.rate)), minimumAmount: String(Math.floor(Number(input.amount) * this.rate * 0.995)) };
    return { routing: this.routing, quote: { output, swapper: input.swapper }, permitData: this.permitData };
  }
  async checkApproval() { return this.approval; }
  async swap(input: unknown) { this.swapInputs.push(input); return { to: ROUTER, data: "0xswap", value: "0", chainId: 42161 }; }
  async createPlan() { return this.plan; }
  async getPlan() { return this.plan; }
  async patchPlan(_id: string, body: unknown) { this.patches.push(body); return this.plan; }
}

async function setup(extra: Record<string, string> = {}) {
  const chains = new FakeChains();
  const uniswap = new FakeUniswap();
  const runtime = await createRuntime(
    { PROVIDER_MODE: "mock", SESSION_SECRET, UNISWAP_API_KEY: "key", TOPUP_TREASURY: TREASURY, ...extra },
    { db: await createTestDb(), topups: { chains, uniswap } },
  );
  const headers = { cookie: await signIn(runtime, { sub: "payer", email: "payer@example.com" }) };
  const user = (await runtime.deps.users.byGoogleSub("payer"))!;
  return { runtime, chains, uniswap, headers, user };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Body = { error: string; topup: { id: string; status: string; action: { kind: string } } };

async function authorize(s: Setup, signer = account, wallet = signer.address) {
  const issued_at = Date.now();
  const signature = await signer.signMessage({ message: topupAuthorization({ account: s.user.email, wallet, issuedAt: issued_at }) });
  return { wallet, signature, issued_at };
}

async function post(runtime: Runtime, headers: Record<string, string>, path: string, body: unknown) {
  const response = await runtime.app.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Body };
}

const create = async (s: Setup, input: Record<string, unknown>, signer = account) =>
  post(s.runtime, s.headers, "/topups", { ...(await authorize(s, signer)), amount: "1000000", ...input });
const next = (s: Setup, id: string, proof: Record<string, unknown> = {}) => post(s.runtime, s.headers, `/topups/${id}/next`, proof);
const balance = async (s: Setup) => (await s.runtime.deps.credits.balance(s.user.creditAccountId)) / CREDIT_ATOMIC;
const FREE = 10;
const WITH_JAR = { TOPUP_JAR: JAR, TOPUP_RELEASER: RELEASER };

describe("chain access", () => {
  it("has a working endpoint for every chain the page offers, and avoids the Base one that refuses log searches", () => {
    for (const chain of TOPUP_CHAINS) expect(DEFAULT_RPC_URLS[chain.id], chain.name).toMatch(/^https:/);
    expect(DEFAULT_RPC_URLS[8453]).not.toContain("mainnet.base.org");
  });
});

describe("walletTypedData", () => {
  it("turns the Uniswap API's permit shape into one a wallet can really sign", async () => {
    // The exact shape POST /plan returned for a Permit2 step on 2026-11-06.
    const uniswapPermit = {
      domain: { name: "Permit2", chainId: 42161, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      types: {
        PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
        PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
      },
      values: { details: { token: ARB_ADDRESS, amount: "1461501637330902918203684832716283019655932542975", expiration: "1796529198", nonce: "0" }, spender: "0x2d01411773c8C24805306E89A41F7855C3c4Fe65", sigDeadline: "1793938998" },
    };
    const typed = walletTypedData(uniswapPermit) as never as Parameters<typeof account.signTypedData>[0];
    expect(typed).toMatchObject({ primaryType: "PermitSingle", message: uniswapPermit.values, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } });
    await expect(account.signTypedData(typed)).resolves.toMatch(/^0x[0-9a-f]{130}$/);
  });
});

describe("wallet top-ups", () => {
  it("is off without a Uniswap key and treasury", async () => {
    const runtime = await createRuntime({ PROVIDER_MODE: "mock", SESSION_SECRET }, { db: await createTestDb() });
    expect(await (await runtime.app.request("/topups/options")).json()).toEqual({ enabled: false });
    const headers = { cookie: await signIn(runtime, { sub: "a", email: "a@example.com" }) };
    expect((await post(runtime, headers, "/topups", {})).status).toBe(404);
  });

  it("requires sign-in and a wallet signature for this account", async () => {
    const s = await setup();
    expect((await post(s.runtime, {}, "/topups", {})).status).toBe(401);
    const signedByOther = await authorize(s, stranger, account.address);
    const refused = await post(s.runtime, s.headers, "/topups", { ...signedByOther, chain_id: 8453, token: BASE_USDC, amount: "1000000" });
    expect(refused).toMatchObject({ status: 400, body: { error: "bad_wallet_signature" } });
  });

  it("swap rail: any token, server-set treasury recipient, credits what actually arrived, exactly once", async () => {
    const s = await setup();
    s.uniswap.approval = { to: ARB_ADDRESS, data: "0xapprove", value: "0" };
    const created = await create(s, { chain_id: 42161, token: ARB_ADDRESS, amount: "30000000000000000000" });
    expect(created.status).toBe(200);
    expect(s.uniswap.quotes[0]).toMatchObject({ recipient: TREASURY, tokenOut: BASE_USDC, tokenOutChainId: 8453, tokenInChainId: 42161, swapper: account.address.toLowerCase() });
    expect(created.body.topup).toMatchObject({ rail: "swap", estimated_credits: 666, minimum_credits: 653, action: { kind: "send_tx", tx: { to: ARB_ADDRESS, data: "0xapprove" } } });

    const id = created.body.topup.id;
    s.uniswap.approval = null;
    const swap = await next(s, id);
    expect(swap.body.topup.action).toMatchObject({ kind: "send_tx", tx: { to: ROUTER, data: "0xswap", chain_id: 42161 } });

    s.chains.add(hash(1), {});
    expect((await next(s, id, { tx_hash: hash(1) })).body.topup.action.kind).toBe("wait");
    expect(await balance(s)).toBe(FREE);

    s.chains.deliveries = [{ txHash: hash(2), logIndex: 3, value: 9_900_000n }];
    const done = await next(s, id);
    expect(done.body.topup).toMatchObject({ status: "credited", credits: 660, settlement_tx: hash(2), action: { kind: "none" } });
    expect(await balance(s)).toBe(FREE + 660);
    await next(s, id);
    expect(await balance(s)).toBe(FREE + 660);
    expect(await s.runtime.deps.credits.ledgerSum(s.user.creditAccountId)).toBe(await s.runtime.deps.credits.balance(s.user.creditAccountId));
  });

  it("asks the wallet to sign a permit in wallet format, then sends the signature with the swap", async () => {
    const s = await setup();
    s.uniswap.permitData = { domain: { name: "Permit2" }, types: { PermitSingle: [{ name: "spender", type: "address" }] }, values: { spender: ROUTER } };
    const created = await create(s, { chain_id: 42161, token: ARB_ADDRESS });
    expect(created.body.topup).toMatchObject({ action: { kind: "sign_typed_data", typed_data: { primaryType: "PermitSingle", message: { spender: ROUTER } } } });
    expect((await next(s, created.body.topup.id, { signature: "0xabcd" })).body.topup.action.kind).toBe("send_tx");
    expect(s.uniswap.swapInputs[0]).toMatchObject({ signature: "0xabcd", permitData: s.uniswap.permitData });
  });

  it("will not credit a transaction that is not the one Uniswap built for this top-up, or a reverted one", async () => {
    const s = await setup();
    const a = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    s.chains.add(hash(1), { data: "0xsomethingelse" });
    s.chains.deliveries = [{ txHash: hash(2), logIndex: 0, value: 9_900_000n }];
    expect((await next(s, a, { tx_hash: hash(1) })).body.topup).toMatchObject({ status: "failed", error: "payment_mismatch" });

    const b = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    s.chains.add(hash(3), { success: false });
    expect((await next(s, b, { tx_hash: hash(3) })).body.topup).toMatchObject({ status: "failed", error: "payment_reverted" });

    const c = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    s.chains.add(hash(4), { from: stranger.address.toLowerCase() });
    expect((await next(s, c, { tx_hash: hash(4) })).body.topup).toMatchObject({ status: "failed", error: "payment_mismatch" });
    expect(await balance(s)).toBe(FREE);
  });

  it("one delivery credits one top-up: a second payer's top-up keeps waiting for its own", async () => {
    const s = await setup();
    const first = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    const second = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    s.chains.add(hash(1), {});
    s.chains.add(hash(2), {});
    s.chains.deliveries = [{ txHash: hash(9), logIndex: 0, value: 9_900_000n }];
    expect((await next(s, first, { tx_hash: hash(1) })).body.topup.status).toBe("credited");
    expect((await next(s, second, { tx_hash: hash(2) })).body.topup).toMatchObject({ status: "open", action: { kind: "wait" } });
    expect(await balance(s)).toBe(FREE + 660);
  });

  it("the same source transaction cannot pay for two top-ups", async () => {
    const s = await setup();
    const first = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    const second = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    s.chains.add(hash(1), {});
    await next(s, first, { tx_hash: hash(1) });
    expect((await next(s, second, { tx_hash: hash(1) })).body.topup).toMatchObject({ status: "failed", error: "payment_already_used" });
  });

  it("cross-chain plan: follows Uniswap's steps, submits proof, credits after delivery", async () => {
    const s = await setup();
    s.uniswap.routing = "CHAINED";
    const planned = (status: string, stepStatus: string): UniswapPlan => ({
      planId: "plan-1", status, recipient: TREASURY.toUpperCase().replace("0X", "0x"), swapper: account.address, currentStepIndex: 0,
      steps: [{ stepIndex: 0, method: "SEND_TX", payloadType: "TX", status: stepStatus, tokenInChainId: 42161, payload: { to: ROUTER, data: "0xstep", value: "0x00" } }],
    });
    s.uniswap.plan = planned("ACTIVE", "AWAITING_ACTION");
    const created = await create(s, { chain_id: 42161, token: ARB_ADDRESS });
    expect(created.body.topup).toMatchObject({ routing: "CHAINED", action: { kind: "send_tx", tx: { data: "0xstep", chain_id: 42161 } } });
    const id = created.body.topup.id;
    s.uniswap.plan = planned("IN_PROGRESS", "IN_PROGRESS");
    expect((await next(s, id, { tx_hash: hash(1) })).body.topup.action.kind).toBe("wait");
    expect(s.uniswap.patches).toEqual([{ steps: [{ stepIndex: 0, proof: { txHash: hash(1) } }] }]);
    s.uniswap.plan = planned("COMPLETED", "COMPLETE");
    s.chains.deliveries = [{ txHash: hash(2), logIndex: 1, value: 9_850_000n }];
    expect((await next(s, id)).body.topup).toMatchObject({ status: "credited", credits: 656 });
  });

  const completedPlan = (lastStep: Partial<UniswapPlan["steps"][number]>): UniswapPlan => ({
    planId: "plan-1", status: "COMPLETED", recipient: TREASURY, swapper: account.address, currentStepIndex: 1,
    steps: [
      { stepIndex: 0, stepType: "BRIDGE", method: "SEND_TX", status: "COMPLETE", tokenInChainId: 42161, proof: { txHash: hash(1) } },
      { stepIndex: 1, stepType: "CLASSIC", method: "SEND_TX", status: "COMPLETE", tokenInChainId: 8453, proof: { txHash: hash(7) }, ...lastStep },
    ],
  });

  it("credits a plan ending in a swap on Base from that exact transaction, without searching logs", async () => {
    // The shape of the first real payment on 2026-11-06: bridge to Base, then swap to USDC.
    const s = await setup();
    s.uniswap.routing = "CHAINED";
    s.chains.add(hash(7), { transfers: [{ logIndex: 43, token: BASE_USDC.toLowerCase(), from: ROUTER, to: TREASURY, value: 2_210_212n }] });
    s.chains.usdcDeliveries = async () => { throw new Error("must not search"); };
    s.uniswap.plan = completedPlan({});
    expect((await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup).toMatchObject({ status: "credited", credits: 147, settlement_tx: hash(7) });
  });

  it("a plan ending in a bridge falls back to finding the delivery, since its proof is on the source chain", async () => {
    const s = await setup();
    s.uniswap.routing = "CHAINED";
    s.chains.deliveries = [{ txHash: hash(8), logIndex: 0, value: 9_900_000n }];
    s.uniswap.plan = completedPlan({ stepType: "BRIDGE", tokenInChainId: 42161 });
    expect((await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup).toMatchObject({ status: "credited", settlement_tx: hash(8) });
  });

  it("a rate-limited chain read after payment means keep waiting, never an error or a lost payment", async () => {
    const s = await setup();
    s.uniswap.routing = "CHAINED";
    s.uniswap.plan = completedPlan({ stepType: "BRIDGE", tokenInChainId: 42161 });
    s.chains.usdcDeliveries = async () => { throw new Error("Rate limit exceeded"); };
    const created = await create(s, { chain_id: 42161, token: ARB_ADDRESS });
    expect(created).toMatchObject({ status: 200, body: { topup: { status: "open", action: { kind: "wait" } } } });
    s.chains.usdcDeliveries = async () => [{ txHash: hash(8), logIndex: 0, value: 9_900_000n }];
    expect((await next(s, created.body.topup.id)).body.topup.status).toBe("credited");
  });

  it("a Uniswap failure once a plan is running keeps the payment open", async () => {
    const s = await setup();
    s.uniswap.routing = "CHAINED";
    s.uniswap.plan = { planId: "plan-1", status: "ACTIVE", recipient: TREASURY, swapper: account.address, currentStepIndex: 0, steps: [{ stepIndex: 0, method: "SEND_TX", status: "AWAITING_ACTION", tokenInChainId: 42161, payload: { to: ROUTER, data: "0xstep" } }] };
    const id = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    s.uniswap.getPlan = async () => { throw new UniswapError(400, "BadRequest", "no"); };
    expect((await next(s, id)).body.topup).toMatchObject({ status: "open", action: { kind: "wait" } });
  });

  it("a proof sent twice is submitted to Uniswap once, so the page can safely retry", async () => {
    const s = await setup();
    s.uniswap.routing = "CHAINED";
    const step = { stepIndex: 0, method: "SEND_TX", tokenInChainId: 42161, payload: { to: ROUTER, data: "0xstep" } };
    s.uniswap.plan = { planId: "plan-1", status: "ACTIVE", recipient: TREASURY, swapper: account.address, currentStepIndex: 0, steps: [{ ...step, status: "AWAITING_ACTION" }] };
    const id = (await create(s, { chain_id: 42161, token: ARB_ADDRESS })).body.topup.id;
    s.uniswap.plan = { ...s.uniswap.plan, status: "IN_PROGRESS", steps: [{ ...step, status: "IN_PROGRESS", proof: { txHash: hash(1) } }] };
    await next(s, id, { tx_hash: hash(1) });
    expect(s.uniswap.patches).toEqual([]);
  });

  it("a plan that pays anyone but the treasury is never credited", async () => {
    const s = await setup();
    s.uniswap.routing = "CHAINED";
    s.uniswap.plan = { planId: "p", status: "COMPLETED", recipient: stranger.address, swapper: account.address, currentStepIndex: 0, steps: [] };
    s.chains.deliveries = [{ txHash: hash(2), logIndex: 1, value: 9_850_000n }];
    const created = await create(s, { chain_id: 42161, token: ARB_ADDRESS });
    expect(created.body.topup).toMatchObject({ status: "failed", error: "payment_mismatch" });
    expect(await balance(s)).toBe(FREE);
  });

  it("usdc rail: a plain transfer from the signed wallet credits the amount received", async () => {
    const s = await setup();
    const created = await create(s, { chain_id: 8453, token: BASE_USDC, amount: "3000000" });
    expect(created.body.topup).toMatchObject({ rail: "usdc", estimated_credits: 200, action: { kind: "send_tx", tx: { to: BASE_USDC, chain_id: 8453 } } });
    s.chains.add(hash(5), { to: BASE_USDC.toLowerCase(), transfers: [{ logIndex: 2, token: BASE_USDC.toLowerCase(), from: account.address.toLowerCase(), to: TREASURY, value: 3_000_000n }] });
    expect((await next(s, created.body.topup.id, { tx_hash: hash(5) })).body.topup).toMatchObject({ status: "credited", credits: 200 });
  });

  it("usdc rail: a transfer from some other wallet is refused", async () => {
    const s = await setup();
    const created = await create(s, { chain_id: 8453, token: BASE_USDC, amount: "3000000" });
    s.chains.add(hash(5), { from: stranger.address.toLowerCase(), transfers: [{ logIndex: 2, token: BASE_USDC.toLowerCase(), from: stranger.address.toLowerCase(), to: TREASURY, value: 3_000_000n }] });
    expect((await next(s, created.body.topup.id, { tx_hash: hash(5) })).body.topup).toMatchObject({ status: "failed", error: "payment_mismatch" });
    expect(await balance(s)).toBe(FREE);
  });

  it("refuses amounts outside the limits before the wallet does anything", async () => {
    const s = await setup();
    s.uniswap.output = { amount: "500000", minimumAmount: "490000" };
    expect(await create(s, { chain_id: 42161, token: ARB_ADDRESS })).toMatchObject({ status: 400, body: { error: "amount_too_small" } });
    s.uniswap.output = { amount: "600000000", minimumAmount: "590000000" };
    expect(await create(s, { chain_id: 42161, token: ARB_ADDRESS })).toMatchObject({ status: 400, body: { error: "amount_too_large" } });
  });

  describe("jar rail", () => {
    const jarTx = (s: Setup, n: number, amount = 1_000_000_000_000_000n) => s.chains.add(hash(n), { to: JAR, data: "0x", value: amount });

    it("takes a small plain transfer into the jar and credits its value less the haircut", async () => {
      const s = await setup(WITH_JAR);
      s.uniswap.output = { amount: "2000000", minimumAmount: "1960000" };
      const created = await create(s, { chain_id: 8453, token: NATIVE_TOKEN, amount: "1000000000000000", rail: "jar" });
      expect(created.body.topup).toMatchObject({ rail: "jar", action: { kind: "send_tx", tx: { to: JAR, value: "1000000000000000" } } });
      expect(s.uniswap.quotes[0]).toMatchObject({ tokenOut: BASE_USDC, tokenIn: NATIVE_TOKEN });
      expect(s.uniswap.quotes[0]).not.toHaveProperty("recipient");
      jarTx(s, 1);
      // Credited from the current quote's guaranteed output: 1.96 USDC less 5% = 1.862 USDC.
      expect((await next(s, created.body.topup.id, { tx_hash: hash(1) })).body.topup).toMatchObject({ status: "credited", credits: 124 });
    });

    it("refuses tokens outside the allowlist, so a thin pool cannot inflate a credit", async () => {
      const s = await setup(WITH_JAR);
      expect(await create(s, { chain_id: 8453, token: ARB_ADDRESS, rail: "jar" })).toMatchObject({ status: 400, body: { error: "token_not_accepted" } });
    });

    it("refuses a deposit above the per-deposit cap", async () => {
      const s = await setup(WITH_JAR);
      s.uniswap.output = { amount: "5000000", minimumAmount: "4900000" };
      expect(await create(s, { chain_id: 8453, token: NATIVE_TOKEN, rail: "jar" })).toMatchObject({ status: 400, body: { error: "jar_deposit_too_large" } });
    });

    it("never promises more credit value in one round than the jar's clearing price pays the treasury", async () => {
      const s = await setup(WITH_JAR);
      s.chains.threshold = 3_000_000;
      s.uniswap.output = { amount: "2000000", minimumAmount: "2000000" };
      const first = await create(s, { chain_id: 8453, token: NATIVE_TOKEN, rail: "jar" });
      expect(first.status).toBe(200);
      expect(await create(s, { chain_id: 8453, token: NATIVE_TOKEN, rail: "jar" })).toMatchObject({ status: 409, body: { error: "jar_full" } });
      s.chains.add(hash(1), { to: JAR, data: "0x", value: 1_000_000n });
      expect((await next(s, first.body.topup.id, { tx_hash: hash(1) })).body.topup.status).toBe("credited");
      expect(await create(s, { chain_id: 8453, token: NATIVE_TOKEN, rail: "jar" })).toMatchObject({ status: 409, body: { error: "jar_full" } });
      // A release advances the nonce: the treasury was paid, so a new round opens.
      s.chains.nonce = 1;
      expect((await create(s, { chain_id: 8453, token: NATIVE_TOKEN, rail: "jar" })).status).toBe(200);
    });

    it("does not credit a jar transfer smaller than promised, or one to another address", async () => {
      const s = await setup(WITH_JAR);
      s.uniswap.output = { amount: "1000000", minimumAmount: "1000000" };
      const a = await create(s, { chain_id: 8453, token: NATIVE_TOKEN, rail: "jar", amount: "1000000000000000" });
      s.chains.add(hash(1), { to: JAR, data: "0x", value: 1n });
      expect((await next(s, a.body.topup.id, { tx_hash: hash(1) })).body.topup).toMatchObject({ status: "failed", error: "payment_mismatch" });
      const b = await create(s, { chain_id: 8453, token: NATIVE_TOKEN, rail: "jar", amount: "1000000000000000" });
      s.chains.add(hash(2), { to: TREASURY, data: "0x", value: 1_000_000_000_000_000n });
      expect((await next(s, b.body.topup.id, { tx_hash: hash(2) })).body.topup).toMatchObject({ status: "failed", error: "payment_mismatch" });
      expect(await balance(s)).toBe(FREE);
    });
  });

  describe("buying a plan", () => {
    const WETH_RATE = 2_000 / 1e12; // 1e18 raw units are worth $2,000 in USDC micros.

    it("sizes a cross-chain payment so even the worst delivery covers the plan, and grants the plan's credits", async () => {
      const s = await setup();
      s.uniswap.rate = WETH_RATE;
      s.uniswap.routing = "CLASSIC";
      const created = await create(s, { chain_id: 42161, token: NATIVE_TOKEN, amount: "1000000000000000000", plan: "growth-monthly" });
      const topup = created.body.topup as never as { id: string; plan: string; amount_in: string; minimum_credits: number; estimated_credits: number };
      expect(topup.plan).toBe("growth-monthly");
      expect(s.uniswap.quotes.at(-1)).toMatchObject({ recipient: TREASURY, slippageTolerance: 0.5 });
      const worst = Number(topup.amount_in) * WETH_RATE * 0.995;
      expect(worst).toBeGreaterThanOrEqual(60_000_000);
      expect(worst).toBeLessThan(60_500_000);
      expect(topup.minimum_credits).toBeGreaterThanOrEqual(4_500);
      expect(s.uniswap.quotes.length).toBeLessThanOrEqual(3);
    });

    it("grants the plan, not the top-up rate, and returns anything above the price as credits", async () => {
      const s = await setup();
      const created = await create(s, { chain_id: 8453, token: BASE_USDC, plan: "growth-monthly" });
      const topup = created.body.topup as never as { id: string; amount_in: string; estimated_credits: number };
      expect(topup).toMatchObject({ amount_in: "60000000", estimated_credits: 4_500 });
      s.chains.add(hash(70), { to: BASE_USDC, transfers: [{ logIndex: 1, token: BASE_USDC, from: account.address.toLowerCase(), to: TREASURY, value: 60_150_000n }] });
      expect((await next(s, topup.id, { tx_hash: hash(70) })).body.topup).toMatchObject({ status: "credited", credits: 4_510 });
      expect(await balance(s)).toBe(FREE + 4_510);
    });

    it("sells annual plans above the single-payment limit, adding the full year", async () => {
      const s = await setup();
      const created = await create(s, { chain_id: 8453, token: BASE_USDC, plan: "unlimited-annual" });
      expect(created.body.topup).toMatchObject({ amount_in: "1290000000", estimated_credits: 120_000 });
    });

    it("never gives plan credits for less than the plan's price", async () => {
      const s = await setup();
      const created = await create(s, { chain_id: 8453, token: BASE_USDC, plan: "starter-monthly" });
      s.chains.add(hash(71), { to: BASE_USDC, transfers: [{ logIndex: 1, token: BASE_USDC, from: account.address.toLowerCase(), to: TREASURY, value: 3_000_000n }] });
      expect((await next(s, created.body.topup.id, { tx_hash: hash(71) })).body.topup).toMatchObject({ status: "credited", credits: 200 });
    });

    it("finds a size for a token too cheap to price one whole unit of", async () => {
      const s = await setup();
      s.uniswap.rate = 1 / 1e15; // One whole token is below Uniswap's minimum quotable size.
      const created = await create(s, { chain_id: 8453, token: ARB_ADDRESS, amount: "1000000000000000", plan: "starter-monthly" });
      expect(created.status).toBe(200);
    });

    it("refuses an unknown plan, and a plan through the jar", async () => {
      const s = await setup(WITH_JAR);
      expect((await create(s, { chain_id: 8453, token: BASE_USDC, plan: "mega-monthly" })).body.error).toBe("invalid_plan");
      expect((await create(s, { chain_id: 8453, token: NATIVE_TOKEN, plan: "starter-monthly", rail: "jar" })).body.error).toBe("plan_not_for_jar");
    });

    it("never lets rail auto put a plan in the jar", async () => {
      const s = await setup(WITH_JAR);
      s.uniswap.rate = 2_000 / 1e12;
      const created = await create(s, { chain_id: 8453, token: NATIVE_TOKEN, amount: "1000000000000000000", plan: "starter-monthly", rail: "auto" });
      expect(created.body.topup).toMatchObject({ rail: "swap", plan: "starter-monthly" });
    });

    it("gives up rather than quote a plan it cannot cover", async () => {
      const s = await setup();
      s.uniswap.output = { amount: "1000000", minimumAmount: "1000" }; // Never scales with the amount.
      expect((await create(s, { chain_id: 8453, token: ARB_ADDRESS, plan: "starter-monthly" })).body.error).toBe("no_route");
      expect(s.uniswap.quotes.length).toBeLessThanOrEqual(3);
    });
  });

  describe("agents buying their own credits", () => {
    const agentSetup = async (extra: Record<string, string> = {}) => {
      const s = await setup({ AGENT_GATEWAY_ENABLED: "true", ...extra });
      const made = await (await s.runtime.app.request("/agents/tokens", { method: "POST", headers: { ...s.headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Buyer" }) })).json() as { agent: { id: string; allow_topup: boolean }; token: string };
      return { ...s, agent: made.agent, bearer: { authorization: `Bearer ${made.token}` } };
    };
    type AgentSetup = Awaited<ReturnType<typeof agentSetup>>;
    const allow = (s: AgentSetup, on = true) => s.runtime.app.request(`/agents/${s.agent.id}`, { method: "PATCH", headers: { ...s.headers, "content-type": "application/json" }, body: JSON.stringify({ allow_topup: on }) });
    const buy = async (s: AgentSetup, input: Record<string, unknown>) => post(s.runtime, s.bearer, "/v1/agent/topups", { ...(await authorize(s)), ...input });

    it("is off until the owner allows this agent", async () => {
      const s = await agentSetup();
      expect(s.agent.allow_topup).toBe(false);
      expect(await buy(s, { chain_id: 8453, token: BASE_USDC, amount: "5000000" })).toMatchObject({ status: 403, body: { error: "top_up_not_allowed" } });
      expect((await post(s.runtime, {}, "/v1/agent/topups", {})).status).toBe(401);
    });

    it("lets an allowed agent pay from its own wallet and credits the owner's account", async () => {
      const s = await agentSetup();
      await allow(s);
      const options = await (await s.runtime.app.request("/v1/agent/topups/options", { headers: s.bearer })).json() as { account: string; enabled: boolean; allowed: boolean };
      expect(options).toMatchObject({ enabled: true, allowed: true, account: "payer@example.com" });
      const created = await buy(s, { chain_id: 8453, token: BASE_USDC, amount: "3000000" });
      s.chains.add(hash(80), { to: BASE_USDC, transfers: [{ logIndex: 1, token: BASE_USDC, from: account.address.toLowerCase(), to: TREASURY, value: 3_000_000n }] });
      const done = await post(s.runtime, s.bearer, `/v1/agent/topups/${created.body.topup.id}/next`, { tx_hash: hash(80) });
      expect(done.body.topup).toMatchObject({ status: "credited", credits: 200 });
      expect(await balance(s)).toBe(FREE + 200);
    });

    it("holds an agent to a smaller limit, and does not let it buy plans", async () => {
      const s = await agentSetup();
      await allow(s);
      expect((await buy(s, { chain_id: 8453, token: BASE_USDC, amount: "50000001" })).body.error).toBe("amount_too_large");
      expect((await buy(s, { chain_id: 8453, token: BASE_USDC, amount: "50000000" })).status).toBe(200);
      expect((await buy(s, { chain_id: 8453, token: BASE_USDC, amount: "50000000", plan: "starter-monthly" })).body.error).toBe("plan_not_for_agents");
    });

    it("rail auto puts a small payment in the jar and a larger one through a swap", async () => {
      const s = await agentSetup(WITH_JAR);
      await allow(s);
      s.uniswap.output = { amount: "1500000", minimumAmount: "1490000" };
      expect((await buy(s, { chain_id: 8453, token: NATIVE_TOKEN, amount: "1000000000000000", rail: "auto" })).body.topup).toMatchObject({ rail: "jar" });
      s.uniswap.output = { amount: "20000000", minimumAmount: "19900000" };
      expect((await buy(s, { chain_id: 8453, token: NATIVE_TOKEN, amount: "9000000000000000", rail: "auto" })).body.topup).toMatchObject({ rail: "swap" });
    });

    it("rail auto falls back to a swap when the jar is full", async () => {
      const s = await agentSetup(WITH_JAR);
      await allow(s);
      s.chains.threshold = 1_000_000;
      s.uniswap.output = { amount: "1500000", minimumAmount: "1490000" };
      expect((await buy(s, { chain_id: 8453, token: NATIVE_TOKEN, amount: "1000000000000000", rail: "auto" })).body.topup).toMatchObject({ rail: "swap" });
    });

    it("tells an allowed agent how to buy when it runs out, and tells others only the link", async () => {
      const s = await agentSetup({ WEB_APP_URL: "https://gtmmaxing.com", TOOLS_ENABLED: "true" });
      const call = async () => (await (await s.runtime.app.request("/v1/agent/tools/gtm_research_company", { method: "POST", headers: { ...s.bearer, "content-type": "application/json" }, body: JSON.stringify({ company: "vercel.com", max_credits: 500 }) })).json() as { answer: Record<string, unknown> }).answer;
      await s.runtime.deps.db.update(accounts).set({ balanceAtomic: CREDIT_ATOMIC }).where(eq(accounts.id, s.user.creditAccountId));
      const before = await call();
      expect(before).toMatchObject({ reason: "insufficient_credits", link: "https://gtmmaxing.com/topup/?credits=1" });
      expect(before).not.toHaveProperty("top_up");
      await allow(s);
      expect((await call()).top_up).toMatchObject({ url: expect.stringContaining("/v1/agent/topups") as string, credits: 1 });
    });
  });

  it("another account cannot read or advance a top-up", async () => {
    const s = await setup();
    const id = (await create(s, { chain_id: 8453, token: BASE_USDC })).body.topup.id;
    const otherHeaders = { cookie: await signIn(s.runtime, { sub: "other", email: "other@example.com" }) };
    expect((await next({ ...s, headers: otherHeaders }, id)).status).toBe(404);
  });
});
