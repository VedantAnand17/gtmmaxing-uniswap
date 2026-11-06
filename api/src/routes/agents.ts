import { Hono, type Context } from "hono";
import { AGENT_ENS_RECORD_KEY, AGENT_SCOPES, agentEnsLinkSchema, agentTokenCreateSchema, agentUpdateSchema, type AgentSummary } from "@found/contracts";
import type { AgentCap, Env } from "../config.js";
import { EnsUnavailableError, normalizeEnsName, type AgentEnsGuard, type EnsReader } from "../application/agent-ens.js";
import type { AgentAccess } from "../auth/agent-auth.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { AgentRunStore } from "../store/agent-runs.js";
import type { UserRow } from "../store/users.js";
import { ALLOWED_ORIGINS, browserCors } from "./cors.js";

export interface AgentsRouteDeps {
  access: AgentAccess;
  agents: AgentStore;
  runs: AgentRunStore;
  ens: AgentEnsGuard;
  ensReader: EnsReader;
  defaultCap: AgentCap;
  resolveUser: (request: Request) => Promise<UserRow | null>;
}

/**
 * Account management for connected agents (session-authenticated, for the
 * web account page): list every agent with its cap and current spend, create
 * self-service agent tokens (shown once), change caps, and revoke.
 */
export function agentsRoute(deps: AgentsRouteDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/agents", browserCors(["GET", "POST", "OPTIONS"]));
  app.use("/agents/*", browserCors(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]));

  const summary = async (agent: AgentRecord): Promise<AgentSummary> => {
    const status = await deps.ens.status(agent);
    return {
    id: agent.id, name: agent.name, kind: agent.kind, client: agent.detectedClient, scopes: agent.scopes,
    credit_cap: agent.creditCap, cap_period: agent.capPeriod, spent: await deps.runs.spent(agent.id, agent.capPeriod), allow_execute: agent.allowExecute, allow_topup: agent.allowTopup,
    ens: agent.ensName && status ? { name: agent.ensName, status } : null,
    created_at: agent.createdAt, last_used_at: agent.lastUsedAt,
    };
  };

  const signedIn = async (c: Context, write: boolean): Promise<UserRow | Response> => {
    if (!deps.access.open) return c.json({ error: "not_found" }, 404);
    if (write) {
      const origin = c.req.header("origin");
      if (origin && !ALLOWED_ORIGINS.includes(origin)) return c.json({ error: "origin_not_allowed" }, 403);
    }
    const user = await deps.resolveUser(c.req.raw);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!deps.access.allows(user.email)) return c.json({ error: "agent_access_pilot_only" }, 403);
    c.header("cache-control", "no-store");
    return user;
  };
  const body = async (c: Context): Promise<unknown> => {
    if (!c.req.header("content-type")?.includes("application/json")) return undefined;
    try { return await c.req.json(); } catch { return undefined; }
  };

  app.get("/agents", async (c) => {
    const user = await signedIn(c, false); if (user instanceof Response) return user;
    return c.json({ agents: await Promise.all((await deps.agents.list(user.id)).map(summary)) });
  });

  app.post("/agents/tokens", async (c) => {
    const user = await signedIn(c, true); if (user instanceof Response) return user;
    const input = agentTokenCreateSchema.safeParse(await body(c));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    const { agent, secret } = await deps.agents.create(user.id, {
      kind: "token",
      name: input.data.name,
      scopes: input.data.scopes ?? [...AGENT_SCOPES],
      creditCap: input.data.credit_cap ?? deps.defaultCap.credits,
      capPeriod: input.data.cap_period ?? deps.defaultCap.period,
    });
    return c.json({ agent: await summary(agent), token: secret }, 201);
  });

  app.patch("/agents/:id", async (c) => {
    const user = await signedIn(c, true); if (user instanceof Response) return user;
    const input = agentUpdateSchema.safeParse(await body(c));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    const agent = await deps.agents.update(user.id, c.req.param("id"), { name: input.data.name, creditCap: input.data.credit_cap, capPeriod: input.data.cap_period, allowExecute: input.data.allow_execute, allowTopup: input.data.allow_topup });
    return agent ? c.json({ agent: await summary(agent) }) : c.json({ error: "not_found" }, 404);
  });

  // Linking proves control of the name: only someone who can write its records can make them name this agent.
  app.put("/agents/:id/ens", async (c) => {
    const user = await signedIn(c, true); if (user instanceof Response) return user;
    const input = agentEnsLinkSchema.safeParse(await body(c));
    const name = input.success ? await normalizeEnsName(input.data.name) : null;
    if (!name) return c.json({ error: "invalid_ens_name" }, 400);
    const agent = await deps.agents.active(c.req.param("id"));
    if (agent?.ownerUserId !== user.id) return c.json({ error: "not_found" }, 404);
    let value: string | null;
    try {
      value = await deps.ensReader.text(name, AGENT_ENS_RECORD_KEY);
    } catch (error) {
      if (error instanceof EnsUnavailableError) return c.json({ error: "ens_unavailable" }, 503);
      throw error;
    }
    if (value !== agent.id) return c.json({ error: "ens_record_mismatch", name, key: AGENT_ENS_RECORD_KEY, value: agent.id }, 409);
    const linked = await deps.agents.setEnsName(user.id, agent.id, name);
    return linked ? c.json({ agent: await summary(linked) }) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/agents/:id/ens", async (c) => {
    const user = await signedIn(c, true); if (user instanceof Response) return user;
    const agent = await deps.agents.setEnsName(user.id, c.req.param("id"), null);
    return agent ? c.json({ agent: await summary(agent) }) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/agents/:id", async (c) => {
    const user = await signedIn(c, true); if (user instanceof Response) return user;
    return (await deps.agents.revoke(user.id, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
