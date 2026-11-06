import { arcOptionsSchema, arcPaymentResponseSchema, type ArcOptions, type ArcPayment } from "@found/contracts";
import { LOOKUP_BASE, liveAuthHeaders } from "../../lib/session";

export interface ArcClient {
  options(): Promise<ArcOptions>;
  confirm(txHash: string): Promise<ArcPayment>;
}

export class ArcRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function call(path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${LOOKUP_BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...liveAuthHeaders() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ArcRequestError("network_error");
  }
  const parsed = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new ArcRequestError(parsed?.error ?? "request_failed");
  return parsed;
}

export const liveArc: ArcClient = {
  options: async () => arcOptionsSchema.parse(await call("/arc/options")),
  confirm: async (txHash) => arcPaymentResponseSchema.parse(await call("/arc/payments", { tx_hash: txHash })).payment,
};
