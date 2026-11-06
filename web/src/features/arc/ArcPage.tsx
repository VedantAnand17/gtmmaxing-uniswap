import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ARC_TESTNET, type ArcOptions, type ArcPayment } from "@found/contracts";
import { api } from "../../lib/apiClient";
import { leavePage } from "../../lib/navigation";
import { useSession } from "../../lib/useSession";
import { WalletError, addChain, connectWallet, parseAmount, performAction } from "../topup/wallet";
import { ArcRequestError } from "./arcClient";

const CONFIRM_TRIES = 15;
const CONFIRM_WAIT_MS = 2000;

const ERRORS: Record<string, string> = {
  no_wallet: "No browser wallet found. Install one such as MetaMask or Rabby, then reload this page.",
  rejected: "You declined that in your wallet. Nothing was sent.",
  wrong_chain: "Your wallet couldn't switch to Arc Testnet. Add the network in your wallet and try again.",
  reverted: "That transaction failed. Check you hold enough test USDC, then try again.",
  payment_mismatch: "That transaction didn't send test USDC to GTMMAXING.",
  payment_reverted: "That transaction failed on Arc, so nothing was paid.",
  payment_already_used: "That payment was already confirmed on another account.",
  not_confirmed: "Arc hasn't confirmed this yet. Check the explorer, or try again in a moment.",
};
const errorText = (error: unknown) => ERRORS[error instanceof WalletError || error instanceof ArcRequestError ? error.code : ""] ?? "That didn't go through. Please try again.";

const erc20Transfer = (to: string, amount: string) =>
  `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${BigInt(amount).toString(16).padStart(64, "0")}`;

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="lookup-start feature-start">
      <div className="lookup-start-content connect-panel workspace-card">
        <h1>{title}</h1>
        {children}
      </div>
    </section>
  );
}

/** Keeps retrying while Arc catches up with a transfer the wallet already sent; it never sends again. */
async function confirmWithRetry(txHash: string): Promise<ArcPayment> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.arc.confirm(txHash);
    } catch (error) {
      if (!(error instanceof ArcRequestError) || error.code !== "not_confirmed" || attempt >= CONFIRM_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_WAIT_MS));
    }
  }
}

function Checkout({ options }: { options: ArcOptions }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [payment, setPayment] = useState<ArcPayment | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: connectWallet,
    onSuccess: setWallet,
    onError: (failure) => setError(errorText(failure)),
  });

  const pay = useMutation({
    mutationFn: async () => {
      setError(null);
      const micros = parseAmount(amount, ARC_TESTNET.usdcDecimals);
      if (!micros) throw new Error("invalid_amount");
      setStep("Switching to Arc Testnet");
      await addChain({ chainId: options.chain_id!, name: options.chain_name!, rpcUrl: options.rpc_url!, explorerUrl: options.explorer_url!, currency: { name: "USDC", symbol: "USDC", decimals: 18 } });
      setStep("Confirm the transfer in your wallet");
      // The ERC-20 interface, in 6 decimals. Arc's native balance is the same money in 18 decimals, so never mix them.
      const proof = await performAction(wallet!, { kind: "send_tx", label: "Send test USDC", tx: { chain_id: options.chain_id!, to: options.usdc!, data: erc20Transfer(options.treasury!, micros), value: "0" } });
      setStep("Checking the payment on Arc");
      return confirmWithRetry(proof.tx_hash!);
    },
    onSuccess: (done) => { setStep(null); setPayment(done); },
    onError: (failure) => { setStep(null); setError((failure as Error).message === "invalid_amount" ? "Enter a valid amount." : errorText(failure)); },
  });

  if (payment) {
    return (
      <Panel title={`${(payment.micros / 1_000_000).toLocaleString("en-US")} test USDC received`}>
        <p role="status">Your payment reached GTMMAXING on Arc Testnet and was checked on the chain. In real USDC, this would buy {payment.credits_equivalent.toLocaleString("en-US")} credits.</p>
        <p className="agent-hint">Test USDC has no value, so no credits were added.</p>
        <p><a href={payment.explorer_url} target="_blank" rel="noreferrer">View the payment on the Arc explorer</a></p>
        <button type="button" className="workspace-button workspace-button-secondary" onClick={() => { setPayment(null); setAmount("1"); }}>Send another</button>
      </Panel>
    );
  }

  return (
    <Panel title="Try USDC on Arc">
      <p>Pay with USDC on Arc, where USDC is also the gas token and payments are final in under a second, so there's no second token to buy and no wait.</p>
      <p className="approval-notice" role="note"><strong>This is a test.</strong> It uses free test USDC on Arc Testnet and doesn't add credits. <a href={options.faucet_url} target="_blank" rel="noreferrer">Get test USDC from the faucet</a>.</p>
      {!wallet ? (
        <div className="connect-actions">
          <button type="button" className="workspace-button" disabled={connect.isPending} onClick={() => connect.mutate()}>{connect.isPending ? "Connecting…" : "Connect wallet"}</button>
        </div>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); pay.mutate(); }}>
          <div className="agent-field">
            <label htmlFor="arc-amount">Amount in test USDC</label>
            <input id="arc-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </div>
          {step && <p role="status" className="approval-notice">{step}…</p>}
          <div className="connect-actions">
            <button type="submit" className="workspace-button" disabled={pay.isPending || !amount.trim()}>{pay.isPending ? "Paying…" : "Pay with test USDC"}</button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="agent-error">{error}</p>}
    </Panel>
  );
}

export function ArcPage() {
  const { session, isLoading } = useSession();
  const options = useQuery({ queryKey: ["arc-options"], queryFn: () => api.arc.options(), retry: false });
  if (isLoading || options.isLoading) return <Panel title="Try USDC on Arc"><p role="status">Loading…</p></Panel>;
  if (!options.data?.enabled) return <Panel title="Try USDC on Arc"><p>The Arc test checkout isn't available right now.</p></Panel>;
  if (!session) {
    return (
      <Panel title="Sign in to try USDC on Arc">
        <p>Sign in with Google so the test payment is recorded on your account.</p>
        <div className="connect-actions">
          <button type="button" className="workspace-button" onClick={() => { const start = api.session.signIn("/arc/"); if ("redirect" in start) leavePage(start.redirect); }}>Sign in with Google</button>
        </div>
      </Panel>
    );
  }
  return <Checkout options={options.data} />;
}
