import { ARC_TESTNET, creditsForMicros, type ArcOptions, type ArcPayment } from "@found/contracts";
import type { ArcReader } from "../payments/arc.js";
import type { ArcPaymentRow, ArcPaymentStore } from "../store/arc-payments.js";

export class ArcCheckoutError extends Error {
  constructor(readonly code: string, readonly status: 400 | 409 = 400) {
    super(code);
  }
}

/**
 * USDC checkout on Arc Testnet. It proves the same flow as a real payment, a
 * wallet transfer that only counts once the chain shows it reached the treasury,
 * but test USDC is free from a faucet, so nothing here may ever grant credits.
 */
export class ArcCheckout {
  private readonly treasury: string;

  constructor(private readonly deps: { store: ArcPaymentStore; reader: ArcReader; treasury: string; now(): number }) {
    this.treasury = deps.treasury.toLowerCase();
  }

  options(): ArcOptions {
    return {
      enabled: true,
      chain_id: ARC_TESTNET.chainId,
      chain_name: ARC_TESTNET.name,
      rpc_url: ARC_TESTNET.rpcUrl,
      explorer_url: ARC_TESTNET.explorerUrl,
      faucet_url: ARC_TESTNET.faucetUrl,
      usdc: ARC_TESTNET.usdc,
      treasury: this.deps.treasury,
    };
  }

  async confirm(userId: string, txHash: string): Promise<ArcPayment> {
    const hash = txHash.toLowerCase();
    const known = await this.deps.store.get(hash);
    if (known) {
      if (known.userId !== userId) throw new ArcCheckoutError("payment_already_used", 409);
      return view(known);
    }
    // An unreachable network says nothing about the payment, so both cases mean "look again".
    const receipt = await this.deps.reader.receipt(hash).catch(() => null);
    if (!receipt) throw new ArcCheckoutError("not_confirmed", 409);
    if (!receipt.success) throw new ArcCheckoutError("payment_reverted");
    const paid = receipt.transfers.find((transfer) => transfer.token === ARC_TESTNET.usdc.toLowerCase() && transfer.to === this.treasury);
    if (!paid) throw new ArcCheckoutError("payment_mismatch");
    const row = await this.deps.store.insert({ txHash: hash, userId, wallet: paid.from, micros: Number(paid.value), createdAt: this.deps.now() });
    if (row.userId !== userId) throw new ArcCheckoutError("payment_already_used", 409);
    return view(row);
  }
}

const view = (row: ArcPaymentRow): ArcPayment => ({
  tx_hash: row.txHash,
  wallet: row.wallet,
  micros: row.micros,
  credits_equivalent: creditsForMicros(row.micros),
  credits_granted: 0,
  explorer_url: `${ARC_TESTNET.explorerUrl}/tx/${row.txHash}`,
});
