import { topupOptionsSchema, topupResponseSchema, type TopupCreate, type TopupOptions, type TopupProof, type TopupView } from "@found/contracts";
import { LOOKUP_BASE, liveAuthHeaders } from "../../lib/session";

export interface TopupsClient {
  options(): Promise<TopupOptions>;
  create(input: TopupCreate): Promise<TopupView>;
  next(id: string, proof: TopupProof): Promise<TopupView>;
}

export class TopupRequestError extends Error {
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
    throw new TopupRequestError("network_error");
  }
  const parsed = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new TopupRequestError(parsed?.error ?? "request_failed");
  return parsed;
}

export const liveTopups: TopupsClient = {
  options: async () => topupOptionsSchema.parse(await call("/topups/options")),
  create: async (input) => topupResponseSchema.parse(await call("/topups", input)).topup,
  next: async (id, proof) => topupResponseSchema.parse(await call(`/topups/${encodeURIComponent(id)}/next`, proof)).topup,
};
