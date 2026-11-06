import {
  BASE_CHAIN_ID, BASE_USDC, JAR_HAIRCUT_BPS, JAR_MAX_MICROS, NATIVE_TOKEN, TOPUP_MAX_MICROS, TOPUP_MICROS_PER_CREDIT, TOPUP_MIN_MICROS,
  creditsForMicros, parsePlanChoice, planPaymentCredits, planPriceMicros, topupAuthorization,
  type TopupAction, type TopupCreate, type TopupOptions, type TopupProof, type TopupRail, type TopupView,
} from "@found/contracts";
import type { ChainReader, ChainTx } from "../../payments/chain-reader.js";
import { UniswapError, type UniswapApi, type UniswapPlan, type UniswapTx } from "../../payments/uniswap.js";
import type { TopupRow, TopupStore } from "../../store/topups.js";
import { TOPUP_CHAINS, isJarToken, isTopupChain } from "./catalog.js";

const QUOTE_LIFETIME_MS = 15 * 60_000;
const SIGNATURE_LIFETIME_MS = 60 * 60_000;
const MAX_RECENT = 20;
const RECENT_WINDOW_MS = 10 * 60_000;
/** A bridge can deliver a little more than quoted; anything further off is someone else's payment. */
const DELIVERY_OVER_TOLERANCE = 1.1;
/** A plan must land at or above its price, so its quotes run tight and are sized to clear it by this much. */
const PLAN_SLIPPAGE_PERCENT = 0.5;
const PLAN_MARGIN_PER_MILLE = 1002n;
/** One whole token of a very cheap coin is under Uniswap's minimum quote, so pricing retries with this many. */
const PLAN_PROBE_RETRY = 10_000n;

export class TopupError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 429 | 502 = 400) {
    super(code);
  }
}

export interface TopupServiceDeps {
  store: TopupStore;
  uniswap: UniswapApi;
  chains: ChainReader;
  treasury: string;
  jar: { address: string; releaser: string } | null;
  verifySignature(input: { wallet: string; message: string; signature: string }): Promise<boolean>;
  newId(): string;
  now(): number;
}

/** A step's result; `action` is its answer when it is not the stored one, such as waiting for funds. */
interface Stepped {
  row: TopupRow;
  action?: TopupAction;
}
type Fail = (error: string) => Promise<Stepped>;

interface Payer {
  id: string;
  email: string;
  creditAccountId: string;
}

const creditsFor = (plan: string | null, micros: number) => {
  const choice = parsePlanChoice(plan);
  return choice ? planPaymentCredits(choice, micros) : creditsForMicros(micros);
};
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const afterHaircut = (micros: number) => Math.floor(micros * (10_000 - JAR_HAIRCUT_BPS) / 10_000);
const erc20Transfer = (to: string, amount: string) =>
  `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${BigInt(amount).toString(16).padStart(64, "0")}`;

/**
 * Turns a wallet payment into credits. Nothing is credited on a claim or a
 * quote: every credit traces to USDC seen on Base (`usdc` and `swap` rails) or
 * a checked, priced transfer into the jar (`jar` rail). The server decides each
 * wallet action, so the page cannot redirect a payment.
 */
export class TopupService {
  private readonly treasury: string;

  constructor(private readonly deps: TopupServiceDeps) {
    this.treasury = deps.treasury.toLowerCase();
  }

  async options(): Promise<TopupOptions> {
    return {
      enabled: true,
      micros_per_credit: TOPUP_MICROS_PER_CREDIT,
      min_micros: TOPUP_MIN_MICROS,
      max_micros: TOPUP_MAX_MICROS,
      chains: TOPUP_CHAINS,
      jar: this.deps.jar ? await this.jarOption(this.deps.jar) : null,
    };
  }

  private async jarOption(jar: { address: string; releaser: string }): Promise<NonNullable<TopupOptions["jar"]>> {
    const { nonce, threshold } = await this.deps.chains.releaser(jar.releaser);
    const committed = await this.deps.store.jarCommitted(nonce, this.deps.now());
    return { chain_id: BASE_CHAIN_ID, address: jar.address, max_micros: JAR_MAX_MICROS, available_micros: Math.max(0, threshold - committed), haircut_bps: JAR_HAIRCUT_BPS };
  }

  /** `maxMicros` lowers the limit on one payment, for an agent spending its own wallet. */
  async create(user: Payer, input: TopupCreate, { maxMicros = TOPUP_MAX_MICROS }: { maxMicros?: number } = {}): Promise<TopupView> {
    const choice = input.plan === undefined ? null : parsePlanChoice(input.plan);
    if (input.plan !== undefined && !choice) throw new TopupError("invalid_plan");
    if (choice && input.rail === "jar") throw new TopupError("plan_not_for_jar");
    const now = this.deps.now();
    const wallet = input.wallet.toLowerCase();
    if (Math.abs(now - input.issued_at) > SIGNATURE_LIFETIME_MS) throw new TopupError("stale_wallet_signature");
    const signed = await this.deps.verifySignature({
      wallet,
      message: topupAuthorization({ account: user.email, wallet, issuedAt: input.issued_at }),
      signature: input.signature,
    });
    if (!signed) throw new TopupError("bad_wallet_signature");
    if (!isTopupChain(input.chain_id)) throw new TopupError("chain_not_supported");
    if (await this.deps.store.countRecent(user.id, now - RECENT_WINDOW_MS) >= MAX_RECENT) throw new TopupError("too_many_topups", 429);

    const rail = this.railFor(input);
    const base = {
      id: this.deps.newId(), userId: user.id, accountId: user.creditAccountId, wallet, rail, plan: input.plan ?? null,
      sourceChainId: input.chain_id, tokenIn: input.token.toLowerCase(), amountIn: input.amount,
      status: "open", createdAt: now, expiresAt: now + QUOTE_LIFETIME_MS,
      startBlock: await this.deps.chains.blockNumber(BASE_CHAIN_ID),
    };

    if (rail === "usdc") {
      const micros = choice ? planPriceMicros(choice) : Number(input.amount);
      if (!choice) this.assertLimits(micros, maxMicros);
      const action = this.sendTx("Send USDC to GTMMAXING", { chainId: BASE_CHAIN_ID, to: BASE_USDC, data: erc20Transfer(this.treasury, String(micros)), value: "0" });
      await this.deps.store.insert({ ...base, amountIn: String(micros), phase: "paying", pendingAction: JSON.stringify(action), expectedMicros: micros, minimumMicros: micros });
      return this.viewOf(base.id);
    }

    if (rail === "jar") {
      try {
        return await this.createJar(input, base);
      } catch (error) {
        // `auto` promised a payment that goes through, so one that doesn't fit the jar becomes a swap.
        if (input.rail !== "auto" || !(error instanceof TopupError) || !["jar_deposit_too_large", "jar_full"].includes(error.code)) throw error;
      }
    }

    const swap = { swapper: wallet, recipient: this.treasury, tokenIn: input.token, tokenInChainId: input.chain_id, tokenOut: BASE_USDC, tokenOutChainId: BASE_CHAIN_ID };
    const sized = choice ? await this.sizePlanPayment(swap, input.amount, planPriceMicros(choice)) : { amount: input.amount, quote: await this.quote({ ...swap, amount: input.amount }) };
    const quote = sized.quote;
    const expected = Number(quote.quote.output?.amount);
    const minimum = Number(quote.quote.output?.minimumAmount ?? expected);
    if (!choice) this.assertLimits(expected, maxMicros);
    await this.deps.store.insert({ ...base, rail: "swap", amountIn: sized.amount, routing: quote.routing, quoteJson: JSON.stringify(quote), phase: quote.routing === "CHAINED" ? "plan" : "approve", expectedMicros: expected, minimumMicros: minimum });
    const stepped = await this.step((await this.deps.store.get(base.id))!, {});
    return this.view(stepped.row, stepped.action);
  }

  /**
   * Uniswap only quotes an exact output on one chain, so a plan's payment is
   * sized from exact-input quotes: price the token, scale to clear the plan's
   * price at the worst delivery, then check. Anything over comes back as credits.
   */
  private async sizePlanPayment(swap: Omit<Parameters<UniswapApi["quote"]>[0], "amount">, probe: string, price: number) {
    const at = (amount: bigint) => this.quote({ ...swap, amount: amount.toString(), slippageTolerance: PLAN_SLIPPAGE_PERCENT });
    const worst = (quoted: Awaited<ReturnType<typeof at>>) => BigInt(quoted.quote.output?.minimumAmount ?? quoted.quote.output?.amount ?? "0");
    let amount = BigInt(probe);
    let quoted = await at(amount).catch(async (error: unknown) => {
      if (!(error instanceof TopupError) || error.code !== "no_route") throw error;
      amount *= PLAN_PROBE_RETRY;
      return at(amount);
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const delivered = worst(quoted);
      if (delivered === 0n) break;
      amount = amount * BigInt(price) * PLAN_MARGIN_PER_MILLE / (delivered * 1000n) + 1n;
      quoted = await at(amount);
      if (worst(quoted) >= BigInt(price)) return { amount: amount.toString(), quote: quoted };
    }
    throw new TopupError("no_route");
  }

  private railFor(input: TopupCreate): TopupRail {
    if (input.rail === "jar") {
      if (!this.deps.jar) throw new TopupError("jar_unavailable");
      if (input.chain_id !== BASE_CHAIN_ID || !isJarToken(input.token)) throw new TopupError("token_not_accepted");
      return "jar";
    }
    if (input.rail === "auto" && this.deps.jar && input.chain_id === BASE_CHAIN_ID && isJarToken(input.token)) return "jar";
    return input.chain_id === BASE_CHAIN_ID && same(input.token, BASE_USDC) ? "usdc" : "swap";
  }

  private async createJar(input: TopupCreate, base: Omit<TopupRow, "routing" | "quoteJson" | "planId" | "phase" | "pendingAction" | "expectedTo" | "expectedData" | "sourceTx" | "expectedMicros" | "minimumMicros" | "jarMicros" | "jarNonce" | "error" | "credits" | "settledMicros" | "settledChainId" | "settledTx" | "settledLogIndex" | "creditedAt">): Promise<TopupView> {
    const jar = this.deps.jar!;
    const price = await this.quote({ swapper: base.wallet, amount: input.amount, tokenIn: input.token, tokenInChainId: BASE_CHAIN_ID, tokenOut: BASE_USDC, tokenOutChainId: BASE_CHAIN_ID });
    const gross = Number(price.quote.output?.amount);
    const promised = afterHaircut(gross);
    if (gross < TOPUP_MIN_MICROS) throw new TopupError("amount_too_small");
    if (promised > JAR_MAX_MICROS) throw new TopupError("jar_deposit_too_large");
    const native = same(input.token, NATIVE_TOKEN);
    const action = this.sendTx("Send to the GTMMAXING token jar", native
      ? { chainId: BASE_CHAIN_ID, to: jar.address, data: "0x", value: input.amount }
      : { chainId: BASE_CHAIN_ID, to: input.token, data: erc20Transfer(jar.address, input.amount), value: "0" });
    await this.deps.store.insert({
      ...base, phase: "paying", pendingAction: JSON.stringify(action), jarMicros: promised,
      expectedMicros: promised, minimumMicros: afterHaircut(Number(price.quote.output?.minimumAmount ?? gross)),
    });
    // The jar pays the treasury a fixed price per clearing, so one round can only promise that much value.
    const { nonce, threshold } = await this.deps.chains.releaser(jar.releaser);
    if (await this.deps.store.jarCommitted(nonce, this.deps.now()) > threshold) {
      await this.deps.store.remove(base.id);
      throw new TopupError("jar_full", 409);
    }
    return this.viewOf(base.id);
  }

  async get(user: Payer, id: string): Promise<TopupView> {
    return this.view(await this.owned(user, id));
  }

  async advance(user: Payer, id: string, proof: TopupProof): Promise<TopupView> {
    const row = await this.owned(user, id);
    if (row.status !== "open") return this.view(row);
    const stepped = await this.step(row, proof);
    return this.view(stepped.row, stepped.action);
  }

  private async step(row: TopupRow, proof: TopupProof): Promise<Stepped> {
    const reload = async () => (await this.deps.store.get(row.id))!;
    const fail: Fail = async (error) => {
      await this.deps.store.patch(row.id, { status: "failed", error, pendingAction: null });
      return { row: await reload() };
    };
    const expiredBeforePaying = this.deps.now() > row.expiresAt && !row.sourceTx && !row.planId && !proof.tx_hash;
    if (expiredBeforePaying) {
      await this.deps.store.patch(row.id, { status: "expired", pendingAction: null });
      return { row: await reload() };
    }
    try {
      if (row.phase === "plan") return await this.stepPlan(row, proof, fail, reload);
      if (row.phase === "approve") return await this.stepApprove(row, proof, reload);
      if (row.phase === "paying") {
        if (!proof.tx_hash) return { row };
        if (!(await this.deps.store.recordSourceTx(row.id, proof.tx_hash, "settling"))) return await fail("payment_already_used");
        return await this.settle(await reload(), fail, reload);
      }
      if (row.phase === "settling") return await this.settle(row, fail, reload);
    } catch (error) {
      if (error instanceof TopupError && error.status !== 502) throw error;
      // Once money may be moving, a failed read says nothing about the payment: keep it open and look again.
      const latest = await reload();
      if (latest.planId || latest.phase === "settling") {
        console.warn({ event: "topup_retry", topup: row.id, message: String((error as Error).message).slice(0, 200) });
        return this.waiting(latest, "Checking the payment");
      }
      if (error instanceof UniswapError && error.status < 500) return await fail(error.noRoute ? "no_route" : "uniswap_refused");
      if (error instanceof UniswapError) throw new TopupError("uniswap_unavailable", 502);
      throw error;
    }
    return { row };
  }

  /** Approval if needed, then the permit signature if the quote has one, then the swap transaction. */
  private async stepApprove(row: TopupRow, proof: TopupProof, reload: () => Promise<TopupRow>): Promise<Stepped> {
    const quoted = JSON.parse(row.quoteJson!) as { routing: string; quote: unknown; permitData?: Record<string, unknown> | null };
    const native = same(row.tokenIn, NATIVE_TOKEN);
    if (!native) {
      const approval = await this.deps.uniswap.checkApproval({
        walletAddress: row.wallet, token: row.tokenIn, amount: row.amountIn, chainId: row.sourceChainId, tokenOut: BASE_USDC, tokenOutChainId: BASE_CHAIN_ID,
        ...(quoted.routing === "BRIDGE" ? { quote: quoted.quote } : {}),
      });
      if (approval) {
        return { row, action: this.sendTx("Approve the token for the swap", { ...approval, chainId: approval.chainId ?? row.sourceChainId }) };
      }
    }
    if (quoted.permitData && !proof.signature) {
      return { row, action: { kind: "sign_typed_data", label: "Sign the swap permit", chain_id: row.sourceChainId, typed_data: walletTypedData(quoted.permitData) } };
    }
    const swap = await this.deps.uniswap.swap({ quote: quoted.quote, ...(quoted.permitData && proof.signature ? { signature: proof.signature, permitData: quoted.permitData } : {}) });
    const action = this.sendTx("Confirm the payment", { ...swap, chainId: swap.chainId ?? row.sourceChainId });
    await this.deps.store.patch(row.id, { phase: "paying", pendingAction: JSON.stringify(action), expectedTo: swap.to.toLowerCase(), expectedData: swap.data });
    return { row: await reload() };
  }

  private async stepPlan(row: TopupRow, proof: TopupProof, fail: Fail, reload: () => Promise<TopupRow>): Promise<Stepped> {
    const quoted = JSON.parse(row.quoteJson!) as { quote: unknown };
    let plan: UniswapPlan;
    if (!row.planId) {
      plan = await this.deps.uniswap.createPlan(quoted.quote);
      await this.deps.store.patch(row.id, { planId: plan.planId });
    } else if (proof.tx_hash || proof.signature) {
      const known = await this.deps.uniswap.getPlan(row.planId);
      // A retry after a lost response must not submit the same proof twice.
      const alreadySent = known.steps.some((step) => (proof.tx_hash && same(step.proof?.txHash, proof.tx_hash)) || (proof.signature && same(step.proof?.signature, proof.signature)));
      plan = alreadySent ? known : await this.deps.uniswap.patchPlan(row.planId, { steps: [{ stepIndex: known.currentStepIndex ?? 0, proof: { ...(proof.tx_hash ? { txHash: proof.tx_hash } : {}), ...(proof.signature ? { signature: proof.signature } : {}) } }] });
    } else {
      plan = await this.deps.uniswap.getPlan(row.planId);
    }
    // Set by this server on the quote and echoed by Uniswap: a plan paying anyone else proves nothing.
    if ((plan.recipient && !same(plan.recipient, this.treasury)) || (plan.swapper && !same(plan.swapper, row.wallet))) return fail("payment_mismatch");
    if (plan.status === "COMPLETED") {
      await this.deps.store.patch(row.id, { phase: "settling", pendingAction: null });
      return this.settle(await reload(), fail, reload);
    }
    if (plan.status === "FAILED") return fail("route_failed");
    let current = plan.steps[plan.currentStepIndex ?? 0];
    if (current?.status === "STEP_ERROR") {
      plan = await this.deps.uniswap.getPlan(row.planId ?? plan.planId, true);
      current = plan.steps[plan.currentStepIndex ?? 0];
      if (!current || current.status === "STEP_ERROR") return fail("route_failed");
    }
    return { row: await reload(), action: current ? planAction(current, row.sourceChainId) : { kind: "wait", label: "Waiting for the route" } };
  }

  private async settle(row: TopupRow, fail: Fail, reload: () => Promise<TopupRow>): Promise<Stepped> {
    if (row.rail === "swap" && row.routing === "CHAINED") return this.settlePlan(row, fail, reload);
    const tx = await this.deps.chains.tx(row.sourceChainId, row.sourceTx!);
    if (!tx) return this.waiting(row, "Waiting for the transaction to confirm");
    if (!tx.success) return fail("payment_reverted");
    if (tx.from !== row.wallet) return fail("payment_mismatch");

    if (row.rail === "usdc") {
      const paid = tx.transfers.find((transfer) => same(transfer.token, BASE_USDC) && transfer.from === row.wallet && same(transfer.to, this.treasury));
      if (!paid) return fail("payment_mismatch");
      return this.creditOr(row, Number(paid.value), BASE_CHAIN_ID, tx.hash, paid.logIndex, fail, reload);
    }

    if (row.rail === "jar") return this.settleJar(row, tx, fail, reload);

    // Binds the transaction to the swap Uniswap built for this top-up, whose recipient this server set.
    if (!same(tx.to, row.expectedTo) || !same(tx.data, row.expectedData)) return fail("payment_mismatch");
    if (row.sourceChainId === BASE_CHAIN_ID) {
      const paid = tx.transfers.find((transfer) => same(transfer.token, BASE_USDC) && same(transfer.to, this.treasury));
      if (!paid) return fail("payment_mismatch");
      return this.creditOr(row, Number(paid.value), BASE_CHAIN_ID, tx.hash, paid.logIndex, fail, reload);
    }
    return this.deliver(row, reload);
  }

  /**
   * A plan ending in a swap on Base names the very transaction that paid the
   * treasury. One ending in a bridge has only its source-chain proof, so the
   * delivery has to be found.
   */
  private async settlePlan(row: TopupRow, fail: Fail, reload: () => Promise<TopupRow>): Promise<Stepped> {
    const plan = await this.deps.uniswap.getPlan(row.planId!);
    const last = plan.steps[plan.steps.length - 1];
    if (!last?.proof?.txHash || last.stepType === "BRIDGE" || last.tokenInChainId !== BASE_CHAIN_ID) return this.deliver(row, reload);
    const tx = await this.deps.chains.tx(BASE_CHAIN_ID, last.proof.txHash);
    if (!tx) return this.waiting(row, "Waiting for the funds to arrive on Base");
    const paid = tx.transfers.find((transfer) => same(transfer.token, BASE_USDC) && same(transfer.to, this.treasury));
    if (!tx.success || !paid) return fail("payment_mismatch");
    return this.creditOr(row, Number(paid.value), BASE_CHAIN_ID, tx.hash, paid.logIndex, fail, reload);
  }

  private async settleJar(row: TopupRow, tx: ChainTx, fail: Fail, reload: () => Promise<TopupRow>): Promise<Stepped> {
    const jar = this.deps.jar;
    if (!jar) return fail("jar_unavailable");
    const amount = BigInt(row.amountIn);
    const deposit = same(row.tokenIn, NATIVE_TOKEN)
      ? (same(tx.to, jar.address) && tx.value >= amount ? { logIndex: -1 } : null)
      : tx.transfers.find((transfer) => same(transfer.token, row.tokenIn) && transfer.from === row.wallet && same(transfer.to, jar.address) && transfer.value >= amount);
    if (!deposit) return fail("payment_mismatch");
    // Reprice now: value lost since the quote is not credited, value gained is the searcher's margin.
    const price = await this.quote({ swapper: row.wallet, amount: row.amountIn, tokenIn: row.tokenIn, tokenInChainId: BASE_CHAIN_ID, tokenOut: BASE_USDC, tokenOutChainId: BASE_CHAIN_ID });
    const now = afterHaircut(Number(price.quote.output?.minimumAmount ?? price.quote.output?.amount));
    const micros = Math.min(row.jarMicros ?? 0, now);
    const { nonce } = await this.deps.chains.releaser(jar.releaser);
    return this.creditOr(row, micros, BASE_CHAIN_ID, tx.hash, deposit.logIndex, fail, reload, nonce);
  }

  /**
   * Finds the delivery to the treasury. A relayer sends it from a transaction we
   * cannot name in advance, so we match by size against deliveries no top-up
   * has used. The caller has already proved this payer paid for a delivery to
   * the treasury, so a match can never mint credits from nothing.
   */
  private async deliver(row: TopupRow, reload: () => Promise<TopupRow>): Promise<Stepped> {
    const deliveries = await this.deps.chains.usdcDeliveries(this.treasury, row.startBlock);
    const jarPrice = this.deps.jar ? (await this.deps.chains.releaser(this.deps.jar.releaser)).threshold : null;
    const ceiling = row.expectedMicros * DELIVERY_OVER_TOLERANCE;
    for (const delivery of deliveries) {
      const micros = Number(delivery.value);
      if (micros < row.minimumMicros || micros > ceiling || micros === jarPrice) continue;
      const credited = await this.deps.store.credit(row.id, { credits: creditsFor(row.plan, micros), micros, chainId: BASE_CHAIN_ID, txHash: delivery.txHash, logIndex: delivery.logIndex, at: this.deps.now() });
      if (credited) return { row: await reload() };
    }
    return this.waiting(row, "Waiting for the funds to arrive on Base");
  }

  private async creditOr(row: TopupRow, micros: number, chainId: number, txHash: string, logIndex: number, fail: Fail, reload: () => Promise<TopupRow>, jarNonce?: number): Promise<Stepped> {
    const credited = await this.deps.store.credit(row.id, { credits: creditsFor(row.plan, micros), micros, chainId, txHash, logIndex, at: this.deps.now(), ...(jarNonce === undefined ? {} : { jarNonce }) });
    return credited ? { row: await reload() } : fail("payment_already_used");
  }

  private waiting(row: TopupRow, label: string): Stepped {
    return { row, action: { kind: "wait", label } };
  }

  private sendTx(label: string, tx: UniswapTx): TopupAction {
    return { kind: "send_tx", label, tx: { chain_id: tx.chainId!, to: tx.to, data: tx.data, value: tx.value ?? "0" } };
  }

  private async quote(input: Parameters<UniswapApi["quote"]>[0]) {
    try {
      return await this.deps.uniswap.quote(input);
    } catch (error) {
      if (error instanceof UniswapError && error.noRoute) throw new TopupError("no_route");
      if (error instanceof UniswapError) throw new TopupError("uniswap_unavailable", 502);
      throw error;
    }
  }

  private assertLimits(micros: number, maxMicros: number) {
    if (!Number.isFinite(micros) || micros < TOPUP_MIN_MICROS) throw new TopupError("amount_too_small");
    if (micros > maxMicros) throw new TopupError("amount_too_large");
  }

  private async owned(user: Payer, id: string): Promise<TopupRow> {
    const row = await this.deps.store.get(id);
    if (!row || row.userId !== user.id) throw new TopupError("not_found", 404);
    return row;
  }

  private async viewOf(id: string): Promise<TopupView> {
    return this.view((await this.deps.store.get(id))!);
  }

  private view(row: TopupRow, action?: TopupAction): TopupView {
    const pending = row.pendingAction ? JSON.parse(row.pendingAction) as TopupAction : null;
    return {
      id: row.id,
      rail: row.rail as TopupRail,
      routing: row.routing,
      plan: row.plan,
      amount_in: row.amountIn,
      status: row.status as TopupView["status"],
      estimated_credits: creditsFor(row.plan, row.expectedMicros),
      minimum_credits: creditsFor(row.plan, row.minimumMicros),
      credits: row.credits,
      settlement_tx: row.settledTx,
      action: row.status === "open" ? (action ?? pending ?? { kind: "wait", label: "Checking the payment" }) : { kind: "none" },
      error: row.error,
    };
  }
}

const DOMAIN_FIELDS: Record<string, string> = { name: "string", version: "string", chainId: "uint256", verifyingContract: "address", salt: "bytes32" };

/**
 * The Uniswap API returns EIP-712 data as `{ domain, types, values }`, while
 * `eth_signTypedData_v4` needs `{ domain, types: { EIP712Domain, ... },
 * primaryType, message }`. The primary type is the one no other type refers to.
 */
export function walletTypedData(data: Record<string, unknown>): Record<string, unknown> {
  const domain = (data.domain ?? {}) as Record<string, unknown>;
  const types = (data.types ?? {}) as Record<string, { name: string; type: string }[]>;
  const referenced = new Set(Object.values(types).flat().map((field) => field.type.replace(/\[\d*\]$/, "")));
  const primaryType = data.primaryType ?? Object.keys(types).find((name) => !referenced.has(name));
  return {
    domain,
    types: {
      ...types,
      EIP712Domain: Object.keys(DOMAIN_FIELDS).filter((field) => field in domain).map((name) => ({ name, type: DOMAIN_FIELDS[name]! })),
    },
    primaryType,
    message: data.message ?? data.values,
  };
}

function planAction(step: UniswapPlan["steps"][number], sourceChainId: number): TopupAction {
  if (step.status !== "AWAITING_ACTION") return { kind: "wait", label: "Waiting for the previous step to finish" };
  const chainId = step.tokenInChainId ?? sourceChainId;
  const payload = step.payload ?? {};
  if (step.method === "SIGN_MSG") return { kind: "sign_typed_data", label: "Sign this step", chain_id: chainId, typed_data: walletTypedData(payload) };
  const tx = payload as { to?: string; data?: string; value?: string; chainId?: number };
  if (step.method !== "SEND_TX" || !tx.to || !tx.data) throw new TopupError("uniswap_step_unsupported", 502);
  return { kind: "send_tx", label: "Confirm this step", tx: { chain_id: tx.chainId ?? chainId, to: tx.to, data: tx.data, value: tx.value ?? "0" } };
}
