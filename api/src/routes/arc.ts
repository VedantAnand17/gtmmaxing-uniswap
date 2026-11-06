import { Hono, type Context } from "hono";
import { arcConfirmSchema } from "@found/contracts";
import type { Env } from "../config.js";
import { ArcCheckoutError, type ArcCheckout } from "../application/arc-checkout.js";
import type { UserRow } from "../store/users.js";
import { ALLOWED_ORIGINS, browserCors } from "./cors.js";

export interface ArcRouteDeps {
  /** Null until a treasury is configured. */
  checkout: ArcCheckout | null;
  resolveUser: (request: Request) => Promise<UserRow | null>;
}

/** The USDC test checkout on Arc: read the options, then confirm a transaction the wallet sent. */
export function arcRoute(deps: ArcRouteDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/arc/*", browserCors(["GET", "POST", "OPTIONS"]));

  app.get("/arc/options", (c) => {
    c.header("cache-control", "no-store");
    return c.json(deps.checkout ? deps.checkout.options() : { enabled: false });
  });

  app.post("/arc/payments", async (c: Context) => {
    if (!deps.checkout) return c.json({ error: "not_found" }, 404);
    const origin = c.req.header("origin");
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return c.json({ error: "origin_not_allowed" }, 403);
    const user = await deps.resolveUser(c.req.raw);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const input = arcConfirmSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    c.header("cache-control", "no-store");
    try {
      return c.json({ payment: await deps.checkout.confirm(user.id, input.data.tx_hash) });
    } catch (error) {
      if (error instanceof ArcCheckoutError) return c.json({ error: error.code }, error.status);
      throw error;
    }
  });
  return app;
}
