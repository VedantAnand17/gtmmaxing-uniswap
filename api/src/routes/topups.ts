import { Hono, type Context } from "hono";
import { topupCreateSchema, topupProofSchema } from "@found/contracts";
import type { Env } from "../config.js";
import { TopupError, type TopupService } from "../application/topups/index.js";
import type { UserRow } from "../store/users.js";
import { ALLOWED_ORIGINS, browserCors } from "./cors.js";

export interface TopupRouteDeps {
  /** Null until a Uniswap key and a treasury are configured. */
  service: TopupService | null;
  resolveUser: (request: Request) => Promise<UserRow | null>;
}

/** Wallet top-ups for the signed-in owner of /topup/: quote, then one wallet action at a time. */
export function topupsRoute(deps: TopupRouteDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/topups/*", browserCors(["GET", "POST", "OPTIONS"]));
  app.use("/topups", browserCors(["GET", "POST", "OPTIONS"]));

  app.get("/topups/options", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(deps.service ? await deps.service.options() : { enabled: false });
  });

  const guarded = async (c: Context, run: (service: TopupService, user: UserRow) => Promise<unknown>) => {
    if (!deps.service) return c.json({ error: "not_found" }, 404);
    const origin = c.req.header("origin");
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return c.json({ error: "origin_not_allowed" }, 403);
    const user = await deps.resolveUser(c.req.raw);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    c.header("cache-control", "no-store");
    try {
      return c.json({ topup: await run(deps.service, user) });
    } catch (error) {
      if (error instanceof TopupError) return c.json({ error: error.code }, error.status);
      throw error;
    }
  };

  app.post("/topups", (c) => guarded(c, async (service, user) => {
    const input = topupCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new TopupError("invalid_request");
    return service.create(user, input.data);
  }));

  app.post("/topups/:id/next", (c) => guarded(c, async (service, user) => {
    const proof = topupProofSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!proof.success) throw new TopupError("invalid_request");
    return service.advance(user, c.req.param("id"), proof.data);
  }));

  app.get("/topups/:id", (c) => guarded(c, (service, user) => service.get(user, c.req.param("id"))));
  return app;
}
