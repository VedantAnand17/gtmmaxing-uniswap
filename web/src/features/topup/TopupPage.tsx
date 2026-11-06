import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { BASE_CHAIN_ID, parsePlanChoice, periodCredits, type PlanChoice, type TopupOptions, type TopupProof, type TopupRail, type TopupView } from "@found/contracts";
import { api } from "../../lib/apiClient";
import { leavePage } from "../../lib/navigation";
import type { Session } from "../../lib/session";
import { useSession } from "../../lib/useSession";
import { TopupRequestError } from "./topupClient";
import { WalletError, authorizeWallet, connectWallet, parseAmount, performAction, readToken } from "./wallet";

const OTHER = "other";
const WAIT_MS = 4000;
const SIGNATURE_REUSE_MS = 50 * 60_000;
const IN_FLIGHT_KEY = "gtm-topup-in-flight";

/**
 * The top-up whose wallet step has happened and the proof the server may not
 * have received. Kept across errors and reloads, so that recovering means
 * re-reporting this proof and never asking the wallet to pay again.
 */
interface InFlight {
  id: string;
  proof: TopupProof;
}
function readInFlight(): InFlight | null {
  try {
    return JSON.parse(window.localStorage.getItem(IN_FLIGHT_KEY) ?? "null") as InFlight | null;
  } catch {
    return null;
  }
}
function writeInFlight(value: InFlight | null) {
  try {
    if (value) window.localStorage.setItem(IN_FLIGHT_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(IN_FLIGHT_KEY);
  } catch { /* Without storage, a reload just loses the resume prompt. */ }
}

const ERRORS: Record<string, string> = {
  amount_too_small: "That's under the $1 minimum. Try a larger amount.",
  amount_too_large: "That's over the $500 limit for one payment. Try a smaller amount.",
  no_route: "Uniswap has no route for that token and amount right now. Try another token or a larger amount.",
  uniswap_unavailable: "Pricing is unavailable right now. Nothing was sent; please try again shortly.",
  uniswap_refused: "Uniswap refused this payment. Nothing was credited; please get a new quote.",
  jar_full: "The token jar is full until it's next cleared. Use a swap instead, or try again later.",
  jar_deposit_too_large: "That's too large for the token jar. Use a swap instead.",
  token_not_accepted: "The token jar doesn't accept that token. Use a swap instead.",
  bad_wallet_signature: "That wallet signature didn't match. Please try again.",
  stale_wallet_signature: "That wallet signature expired. Please try again.",
  too_many_topups: "Too many quotes in a few minutes. Please wait a moment and try again.",
  chain_not_supported: "That network isn't supported yet.",
  invalid_plan: "That plan isn't available. Please choose one from the plans page.",
  payment_mismatch: "That transaction doesn't match this payment, so it wasn't credited. Contact us if funds left your wallet.",
  payment_reverted: "That transaction failed onchain, so nothing was paid. Your funds stayed in your wallet, apart from network fees.",
  payment_already_used: "That transaction has already been used for a top-up.",
  route_failed: "The route stopped partway. Your wallet may hold an intermediate token instead of what you started with; you can use it for a new payment.",
  no_wallet: "No browser wallet found. Install one such as MetaMask or Rabby, then reload this page.",
  rejected: "You declined that in your wallet. Nothing further was sent.",
  wrong_chain: "Your wallet couldn't switch to that network. Add the network in your wallet and try again.",
  reverted: "That transaction failed onchain. Please try again.",
};
const errorText = (code: string | null | undefined) => ERRORS[code ?? ""] ?? "That didn't go through. Please try again.";
const codeOf = (error: unknown) => error instanceof TopupRequestError || error instanceof WalletError ? error.code : "failed";
const credits = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "credit" : "credits"}`;
/** A raw token amount for reading: enough digits to recognise it in the wallet, without the dust. */
function tokenAmount(raw: string, decimals: number): string {
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const leadingZeros = fraction.match(/^0*/)![0].length;
  const shown = fraction.slice(0, whole === "0" ? leadingZeros + 4 : 4).replace(/0+$/, "");
  return `${Number(whole).toLocaleString("en-US")}${shown ? `.${shown}` : ""}`;
}
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

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

const PlansLink = () => <p className="connect-account">Prefer to pay by card? <a href="/outboundmaxing/#plans">See monthly plans</a>.</p>;
const planLabel = ({ plan, billing }: PlanChoice) => `${plan.name}, ${billing === "annual" ? "one year" : "one month"}`;

export function TopupPage() {
  const { session, isLoading } = useSession();
  const search = useLocation({ select: (location) => location.search as Record<string, unknown> });
  const needed = Number(search.credits);
  const shortfall = Number.isInteger(needed) && needed > 0 ? needed : null;
  const planParam = typeof search.plan === "string" ? search.plan : null;
  const choice = parsePlanChoice(planParam);
  const options = useQuery({ queryKey: ["topup-options"], queryFn: () => api.topups.options(), retry: false });
  const signIn = useMutation({
    mutationFn: async () => {
      const start = api.session.signIn(`/topup/${choice ? `?plan=${planParam}` : shortfall ? `?credits=${shortfall}` : ""}`);
      if ("redirect" in start) leavePage(start.redirect);
    },
  });

  const title = choice ? `Buy ${choice.plan.name}` : "Add credits";
  if (isLoading || options.isLoading) return <Panel title={title}><p role="status">Loading…</p></Panel>;
  if (!options.data?.enabled) return <Panel title={title}><p>Wallet payments aren't available right now.</p><PlansLink /></Panel>;
  if (!session) {
    return (
      <Panel title={choice ? `Sign in to buy ${choice.plan.name}` : "Sign in to add credits"}>
        <p>Credits go to your GTMMAXING account, so sign in with Google first.</p>
        <div className="connect-actions">
          <button type="button" className="workspace-button" disabled={signIn.isPending} onClick={() => signIn.mutate()}>Sign in with Google</button>
        </div>
      </Panel>
    );
  }
  return <TopupForm options={options.data} session={session} shortfall={shortfall} choice={choice} planParam={planParam} />;
}

interface Picked {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
}

function TopupForm({ options, session, shortfall, choice, planParam }: { options: TopupOptions; session: Session; shortfall: number | null; choice: PlanChoice | null; planParam: string | null }) {
  const chains = options.chains ?? [];
  const queryClient = useQueryClient();
  const [wallet, setWallet] = useState<string | null>(null);
  const [chainId, setChainId] = useState(chains[0]?.id ?? BASE_CHAIN_ID);
  const chain = chains.find((entry) => entry.id === chainId);
  const [tokenChoice, setTokenChoice] = useState(chain?.tokens[0]?.address ?? OTHER);
  const [otherToken, setOtherToken] = useState("");
  const [amount, setAmount] = useState("");
  const [useJar, setUseJar] = useState(false);
  const [paying, setPaying] = useState<Picked | null>(null);
  const [topup, setTopup] = useState<TopupView | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signature = useRef<{ wallet: string; signature: string; issued_at: number } | null>(null);
  /** Set once a payment step has reached the wallet: from then on the only way forward is to check on it. */
  const [resuming, setResuming] = useState<InFlight | null>(() => readInFlight());

  const listed = chain?.tokens.find((token) => token.address === tokenChoice);
  const jar = options.jar;
  const jarOffered = Boolean(!choice && jar && listed?.jar && chainId === jar.chain_id && jar.available_micros > 0);
  const rail: TopupRail | undefined = jarOffered && useJar ? "jar" : undefined;
  const custom = tokenChoice === OTHER;
  const tokenReady = custom ? /^0x[0-9a-fA-F]{40}$/.test(otherToken.trim()) : Boolean(listed);
  const haircut = jar ? jar.haircut_bps / 100 : 0;

  const connect = useMutation({
    mutationFn: connectWallet,
    onSuccess: setWallet,
    onError: (failure) => setError(errorText(codeOf(failure))),
  });

  const quote = useMutation({
    mutationFn: async () => {
      setError(null);
      const picked: Picked = listed
        ? { chainId, address: listed.address, symbol: listed.symbol, decimals: listed.decimals }
        : { chainId, address: otherToken.trim(), ...(await readToken(chainId, otherToken.trim())) };
      // For a plan the server sizes the payment; one whole token is only there to price it.
      const raw = choice ? (10n ** BigInt(picked.decimals)).toString() : parseAmount(amount, picked.decimals);
      if (!raw) throw new TopupRequestError("invalid_amount");
      setPaying(picked);
      const reusable = signature.current && signature.current.wallet === wallet && Date.now() - signature.current.issued_at < SIGNATURE_REUSE_MS;
      if (!reusable) signature.current = { wallet: wallet!, ...(await authorizeWallet(session.user.email, wallet!)) };
      const { signature: signed, issued_at } = signature.current!;
      return api.topups.create({ wallet: wallet!, signature: signed, issued_at, chain_id: picked.chainId, token: picked.address, amount: raw, ...(rail ? { rail } : {}), ...(choice ? { plan: planParam! } : {}) });
    },
    onSuccess: setTopup,
    onError: (failure) => setError(codeOf(failure) === "invalid_amount" ? "Enter a valid amount." : errorText(codeOf(failure))),
  });

  /** Follows the server's actions until the payment is credited or stops. */
  const pay = useMutation({
    mutationFn: async (start: InFlight | null) => {
      setError(null);
      let pending = start;
      let current = pending ? await api.topups.next(pending.id, pending.proof) : topup!;
      for (;;) {
        setTopup(current);
        const action = current.action;
        if (current.status !== "open" || action.kind === "none") return current;
        setProgress(action.label);
        if (action.kind === "wait") {
          await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
          current = await api.topups.next(current.id, {});
        } else {
          pending = { id: current.id, proof: await performAction(wallet ?? await connectWallet(), action) };
          writeInFlight(pending);
          setResuming(pending);
          current = await api.topups.next(pending.id, pending.proof);
        }
      }
    },
    onSuccess: (done) => {
      setProgress(null);
      writeInFlight(null);
      setResuming(null);
      if (done.status === "credited") void queryClient.invalidateQueries();
    },
    onError: (failure) => {
      setProgress(null);
      setError(errorText(codeOf(failure)));
      // A record from another account can never finish here, so it must not block this page.
      if (codeOf(failure) === "not_found") {
        writeInFlight(null);
        setResuming(null);
      }
    },
  });

  // A payment left unfinished by a reload or a closed tab carries on by itself; nothing is sent again.
  const { mutate: payMutate } = pay;
  const leftOver = useRef(resuming);
  useEffect(() => {
    if (leftOver.current) payMutate(leftOver.current);
    leftOver.current = null;
  }, [payMutate]);

  if (topup?.status === "credited") {
    return (
      <Panel title={`${credits(topup.credits ?? 0)} added`}>
        <p role="status">{shortfall ? "Your agent can repeat its request now; it won't be charged twice." : choice ? `${planLabel(choice)} is paid. They're in your balance and ready to use.` : "They're in your balance and ready to use."}</p>
        {topup.settlement_tx && <p><a href={`https://basescan.org/tx/${topup.settlement_tx}`} target="_blank" rel="noreferrer">View the payment on Basescan</a></p>}
        <Link to="/usage" className="feature-back-link">See your balance on Usage</Link>
        <p className="connect-account">Signed in as {session.user.email}</p>
      </Panel>
    );
  }

  const stopped = topup && topup.status !== "open";
  const reset = () => { setTopup(null); setError(null); writeInFlight(null); setResuming(null); };

  if (resuming && !stopped) {
    return (
      <Panel title="Finishing your payment">
        <p role="status">Your wallet has sent this payment. Credits arrive once the USDC reaches us; you don't need to pay again.</p>
        {progress && <p role="status" className="approval-notice">{progress}…</p>}
        {pay.isError && (
          <>
            <p role="alert" className="agent-error">We couldn't confirm it just now. Nothing was sent again.</p>
            <div className="connect-actions">
              <button type="button" className="workspace-button" onClick={() => pay.mutate(resuming)}>Check again</button>
            </div>
          </>
        )}
        <p className="connect-account">Signed in as {session.user.email}.</p>
      </Panel>
    );
  }

  return (
    <Panel title={choice ? `Buy ${choice.plan.name}` : "Add credits"}>
      {choice ? (
        <p>
          ${choice.plan.prices[choice.billing].usd.toLocaleString("en-US")} for {credits(periodCredits(choice.plan, choice.billing))}, covering {choice.billing === "annual" ? "one year" : "one month"} with no renewal.
          {" "}Pay with almost any token you hold, on the network it's already on, and Uniswap converts it. Any amount over the price comes back as extra credits.
        </p>
      ) : (
        <p>
          {shortfall ? `Your agent needs ${credits(shortfall)} more. ` : ""}
          Pay with almost any token you hold, on the network it's already on. Uniswap converts it, and credits arrive once the USDC reaches us. About 67 credits per $1.
        </p>
      )}
      {!wallet ? (
        <div className="connect-actions">
          <button type="button" className="workspace-button" disabled={connect.isPending} onClick={() => connect.mutate()}>
            {connect.isPending ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      ) : !topup ? (
        <form onSubmit={(event) => { event.preventDefault(); quote.mutate(); }}>
          <div className="agent-field">
            <label htmlFor="topup-chain">Network</label>
            <select id="topup-chain" className="topup-select" value={chainId} onChange={(event) => {
              const next = Number(event.target.value);
              setChainId(next);
              setTokenChoice(chains.find((entry) => entry.id === next)?.tokens[0]?.address ?? OTHER);
              setUseJar(false);
            }}>
              {chains.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </div>
          <div className="agent-field">
            <label htmlFor="topup-token">Token</label>
            <select id="topup-token" className="topup-select" value={tokenChoice} onChange={(event) => { setTokenChoice(event.target.value); setUseJar(false); }}>
              {chain?.tokens.map((token) => <option key={token.address} value={token.address}>{token.symbol}</option>)}
              <option value={OTHER}>Another token…</option>
            </select>
            {custom && <input aria-label="Token address" placeholder="0x…" spellCheck={false} value={otherToken} onChange={(event) => setOtherToken(event.target.value)} />}
          </div>
          {!choice && (
            <div className="agent-field">
              <label htmlFor="topup-amount">Amount{listed ? ` in ${listed.symbol}` : ""}</label>
              <input id="topup-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </div>
          )}
          {jarOffered && (
            <label className="topup-jar">
              <input type="checkbox" checked={useJar} onChange={(event) => setUseJar(event.target.checked)} />
              <span>
                <strong>Small payment? Use the token jar.</strong> One plain transfer with no swap. Up to ${(jar!.max_micros / 1_000_000).toFixed(2)}, and {haircut}% goes to whoever converts the jar later.
              </span>
            </label>
          )}
          <div className="connect-actions">
            <button type="submit" className="workspace-button" disabled={quote.isPending || !tokenReady || (!choice && !amount.trim())}>
              {quote.isPending ? "Getting a quote…" : "Get a quote"}
            </button>
          </div>
        </form>
      ) : stopped ? (
        <>
          <p role="alert" className="agent-error">{topup.status === "expired" ? "That quote expired before it was paid. Nothing was sent." : errorText(topup.error)}</p>
          <div className="connect-actions"><button type="button" className="workspace-button" onClick={reset}>Start again</button></div>
        </>
      ) : (
        <>
          <dl className="approval-details">
            {choice && <div><dt>Plan</dt><dd>{planLabel(choice)}</dd></div>}
            {paying && <div><dt>You'll pay</dt><dd>{tokenAmount(topup.amount_in, paying.decimals)} {paying.symbol}</dd></div>}
            <div><dt>You'll get</dt><dd>About {credits(topup.estimated_credits)}, and at least {credits(topup.minimum_credits)}</dd></div>
            <div><dt>Route</dt><dd>{ROUTE[topup.rail === "swap" ? (topup.routing ?? "CLASSIC") : topup.rail] ?? "Uniswap route to USDC on Base"}</dd></div>
          </dl>
          {progress && <p role="status" className="approval-notice">{progress}…</p>}
          <div className="connect-actions">
            <button type="button" className="workspace-button workspace-button-secondary" disabled={pay.isPending} onClick={reset}>Change</button>
            <button type="button" className="workspace-button" disabled={pay.isPending} onClick={() => pay.mutate(null)}>{pay.isPending ? "Paying…" : "Pay"}</button>
          </div>
        </>
      )}
      {error && <p role="alert" className="agent-error">{error}</p>}
      {wallet && <p className="connect-account">Paying from {short(wallet)}. Signed in as {session.user.email}.</p>}
      <PlansLink />
    </Panel>
  );
}

const ROUTE: Record<string, string> = {
  usdc: "Direct USDC transfer on Base",
  jar: "Plain transfer into the GTMMAXING token jar",
  CLASSIC: "Uniswap swap to USDC on Base",
  BRIDGE: "Uniswap bridge to USDC on Base",
  CHAINED: "Uniswap swap and bridge to USDC on Base, in several wallet steps",
};
