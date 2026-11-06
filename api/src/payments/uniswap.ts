/**
 * The Uniswap API calls behind wallet top-ups. The key stays on the server: the
 * browser only ever receives the wallet action each call produces.
 */
const BASE_URL = "https://trade-api.gateway.uniswap.org/v1";

export interface UniswapQuoteInput {
  swapper: string;
  /** Omitted when only pricing a token: nothing executes from that quote. */
  recipient?: string;
  amount: string;
  tokenIn: string;
  tokenInChainId: number;
  tokenOut: string;
  tokenOutChainId: number;
}

export interface UniswapQuote {
  routing: string;
  quote: { output?: { amount?: string; minimumAmount?: string } } & Record<string, unknown>;
  permitData?: Record<string, unknown> | null;
}

export interface UniswapTx {
  to: string;
  data: string;
  value?: string;
  chainId?: number;
}

export interface UniswapPlanStep {
  stepIndex: number;
  method: string;
  payloadType?: string;
  status: string;
  tokenInChainId?: number;
  payload?: Record<string, unknown>;
}

export interface UniswapPlan {
  planId: string;
  status: string;
  swapper?: string;
  recipient?: string;
  currentStepIndex?: number;
  steps: UniswapPlanStep[];
}

export interface UniswapApi {
  quote(input: UniswapQuoteInput): Promise<UniswapQuote>;
  checkApproval(input: { walletAddress: string; token: string; amount: string; chainId: number; tokenOut: string; tokenOutChainId: number; quote?: unknown }): Promise<UniswapTx | null>;
  swap(input: { quote: unknown; signature?: string; permitData?: unknown }): Promise<UniswapTx>;
  createPlan(quote: unknown): Promise<UniswapPlan>;
  getPlan(planId: string, forceRefresh?: boolean): Promise<UniswapPlan>;
  patchPlan(planId: string, body: { steps: { stepIndex: number; proof: { txHash?: string; signature?: string } }[] }): Promise<UniswapPlan>;
}

export class UniswapError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail: string) {
    super(`uniswap ${status} ${code}: ${detail}`);
  }
  /** No route for this token, chain and size: the payer's input, not an outage. */
  get noRoute() {
    return this.code === "ResourceNotFound" || this.code === "QuoteAmountTooLowError" || this.status === 404;
  }
}

export function createUniswapClient(apiKey: string, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): UniswapApi {
  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const response = await fetcher(`${BASE_URL}${path}`, {
      method,
      headers: { "x-api-key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new UniswapError(response.status, String(parsed?.errorCode ?? "unknown"), String(parsed?.detail ?? ""));
    return parsed as T;
  };
  return {
    // Multi-step routes are only returned with this header; the integration guide does not mention it (see FEEDBACK.md).
    quote: (input) => call<UniswapQuote>("POST", "/quote", {
      type: "EXACT_INPUT",
      // The payer's own transaction delivers the funds: no UniswapX orders, whose fillers settle out of our sight.
      protocols: ["V2", "V3", "V4"],
      ...input,
    }, { "x-chained-actions-enabled": "true" }),
    checkApproval: async (input) => (await call<{ approval?: UniswapTx | null }>("POST", "/check_approval", input)).approval ?? null,
    swap: async (input) => (await call<{ swap: UniswapTx }>("POST", "/swap", input)).swap,
    createPlan: (quote) => call<UniswapPlan>("POST", "/plan", { routing: "CHAINED", quote }),
    getPlan: (planId, forceRefresh) => call<UniswapPlan>("GET", `/plan/${encodeURIComponent(planId)}${forceRefresh ? "?forceRefresh=true" : ""}`),
    patchPlan: (planId, body) => call<UniswapPlan>("PATCH", `/plan/${encodeURIComponent(planId)}`, body),
  };
}
