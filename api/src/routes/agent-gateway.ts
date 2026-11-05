import { Hono } from "hono";
import { cors } from "hono/cors";
import { answerText, outcomeToolDefinitions } from "@found/contracts";
import { createAgentOpenApi } from "../agent-openapi.js";
import type { Env } from "../config.js";
import type { AgentGateway } from "../application/agent-gateway/index.js";
import { agentResources, bearerChallenge, type AgentAccess, type AgentAuthenticator } from "../auth/agent-auth.js";
import { verifySigned } from "../auth/session.js";
import { requestSource } from "../domain/request-source.js";
import type { ApiKeyService, TenantLimits } from "../store/external.js";

const MAX_BODY_BYTES = 64 * 1024;

class RequestBodyTooLarge extends Error {}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestBodyTooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLarge();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export interface AgentGatewayRouteDeps {
  access: AgentAccess;
  auth: AgentAuthenticator;
  gateway: AgentGateway;
  apiKeys: ApiKeyService;
  limits: TenantLimits;
  issuer: (request: Request) => string;
  sessionSecret: string | null;
  now?: () => number;
}

/**
 * REST adapter for the agent gateway at /v1/agent: the same seven outcome
 * tools the MCP connector exposes, for the CLI and scripts. Agent tokens and
 * OAuth tokens issued for this resource are accepted; answers are the shared
 * shape as JSON (`answer`) plus its TOON-style `text`.
 */
export function agentGatewayRoute(deps: AgentGatewayRouteDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const now = deps.now ?? Date.now;
  app.use("*", async (c, next) => {
    if (!deps.access.open) return c.json({ error: "not_found" }, 404);
    await next();
  });
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["authorization", "content-type", "x-gtm-source"], maxAge: 86400 }));

  app.get("/tools", (c) => c.json({ tools: outcomeToolDefinitions() }));

  app.get("/openapi.json", (c) => c.json(createAgentOpenApi(deps.issuer(c.req.raw))));

  app.post("/tools/:name", async (c) => {
    const issuer = deps.issuer(c.req.raw);
    const metadata = `${issuer}/.well-known/oauth-protected-resource/v1/agent`;
    const auth = await deps.auth.authenticate(c.req.raw, agentResources(issuer).api);
    if (!auth.ok) {
      const challenge = bearerChallenge(metadata, c.req.header("authorization") ? { error: "invalid_token" } : {});
      return c.json({ error: auth.error }, auth.status, { "www-authenticate": challenge });
    }
    const { principal } = auth;
    const tenant = await deps.apiKeys.tenant(principal.agent.tenantId);
    if (tenant) {
      const rate = await deps.limits.consumeRate(tenant);
      if (!rate.allowed) return c.json({ error: "rate_limited" }, 429, { "retry-after": String(Math.max(1, Math.ceil((rate.resetAt - now()) / 1000))) });
    }
    let raw: string;
    try {
      raw = await readBoundedText(c.req.raw, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) return c.json({ error: "request_too_large" }, 413);
      throw error;
    }
    let args: unknown;
    try { args = raw ? JSON.parse(raw) as unknown : {}; } catch { return c.json({ error: "invalid_json" }, 400); }
    const name = c.req.param("name");
    const scope = deps.gateway.requiredScope(name, args);
    if (!principal.scopes.has(scope)) {
      return c.json({ error: "insufficient_scope" }, 403, { "www-authenticate": bearerChallenge(metadata, { error: "insufficient_scope", scope, description: "This agent cannot spend credits" }) });
    }
    const answer = await deps.gateway.call(principal, name, args, {
      baseUrl: issuer,
      source: requestSource(c.req.raw),
      schedule: (work) => { try { c.executionCtx.waitUntil(work); } catch { /* No execution context outside Workers. */ } },
    });
    c.header("cache-control", "no-store");
    if (c.req.header("accept")?.includes("text/plain")) return c.text(answerText(answer));
    return c.json({ answer, text: answerText(answer) });
  });

  /** Signed one-hour link from gtm_results: the signature is the authorization. */
  app.get("/runs/:id/export.csv", async (c) => {
    const token = c.req.query("token");
    const data = token && deps.sessionSecret ? await verifySigned(token, deps.sessionSecret) : null;
    const [kind, runId, expires] = data?.split("|") ?? [];
    if (kind !== "csv" || !runId || runId !== c.req.param("id") || !(Number(expires) > now())) return c.json({ error: "invalid_link" }, 403);
    const found = await deps.gateway.rows(runId);
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.body(deps.gateway.csv(found.run), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${runId}.csv"`,
      "cache-control": "no-store",
    });
  });

  return app;
}
