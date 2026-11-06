import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, NATIVE_TOKEN, topupAuthorization } from "@found/contracts";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { CREDIT_ATOMIC } from "../src/domain/credits.js";
import { walletTypedData } from "../src/application/topups/index.js";
import { TOPUP_CHAINS } from "../src/application/topups/catalog.js";
import { DEFAULT_RPC_URLS, type ChainReader, type ChainTx, type UsdcDelivery } from "../src/payments/chain-reader.js";
import type { UniswapApi, UniswapPlan, UniswapQuoteInput } from "../src/payments/uniswap.js";
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
  approval: { to: string; data: string; value: string } | null = null;
  permitData: Record<string, unknown> | null = null;
  plan = {} as UniswapPlan;
  patches: unknown[] = [];
  quotes: UniswapQuoteInput[] = [];
  swapInputs: unknown[] = [];
  async quote(input: UniswapQuoteInput) {
    this.quotes.push(input);
    return { routing: this.routing, quote: { output: this.output, swapper: input.swapper }, permitData: this.permitData };
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
    const WITH_JAR = { TOPUP_JAR: JAR, TOPUP_RELEASER: RELEASER };
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

  it("another account cannot read or advance a top-up", async () => {
    const s = await setup();
    const id = (await create(s, { chain_id: 8453, token: BASE_USDC })).body.topup.id;
    const otherHeaders = { cookie: await signIn(s.runtime, { sub: "other", email: "other@example.com" }) };
    expect((await next({ ...s, headers: otherHeaders }, id)).status).toBe(404);
  });
});
