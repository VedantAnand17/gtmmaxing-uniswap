import { z } from "zod";

/**
 * One verdict per email, reconciled server-side when verifiers disagree.
 * Only the explicit mailbox-check tool reports "risky" (catch-all, disputed or undecided);
 * returned emails carry only "deliverable" or "invalid", or no verdict.
 */
export const emailVerdictSchema = z.enum(["deliverable", "risky", "invalid"]);
export type EmailVerdict = z.infer<typeof emailVerdictSchema>;

/**
 * Agent identities. Every connected agent (AI-app connector, CLI login or
 * self-service token) is one row with its own scopes and credit cap.
 */
export const AGENT_SCOPES = ["gtm:read", "gtm:run"] as const;
export const agentScopeSchema = z.enum(AGENT_SCOPES);
export const agentKindSchema = z.enum(["connector", "cli", "token"]);
export const capPeriodSchema = z.enum(["day", "week", "month"]);
export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentKind = z.infer<typeof agentKindSchema>;
export type CapPeriod = z.infer<typeof capPeriodSchema>;

export const creditCapSchema = z.number().int().min(1).max(1_000_000);

/** The ENS text record that names an agent; clearing or changing it stops the agent. Reverse-dotted per ENSIP-5. */
export const AGENT_ENS_RECORD_KEY = "com.gtmmaxing.agent";

export const agentEnsSchema = z.object({
  name: z.string(),
  /** active: the record names this agent. stopped: it does not. unknown: the chain has been unreadable too long to say. */
  status: z.enum(["active", "stopped", "unknown"]),
});
export type AgentEns = z.infer<typeof agentEnsSchema>;

export const agentEnsLinkSchema = z.object({ name: z.string().trim().min(3).max(255) }).strict();
/** 409 from linking: what the owner must set on the name first. */
export const agentEnsMismatchSchema = z.object({ error: z.literal("ens_record_mismatch"), name: z.string(), key: z.string(), value: z.string() });
export type AgentEnsMismatch = z.infer<typeof agentEnsMismatchSchema>;

export const agentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: agentKindSchema,
  /** Client name the agent reported, e.g. from MCP initialize. */
  client: z.string().nullable(),
  scopes: z.array(agentScopeSchema),
  credit_cap: z.number().int().positive(),
  cap_period: capPeriodSchema,
  /** Credits spent or reserved in the current cap window. */
  spent: z.number().int().nonnegative(),
  /** The owner lets this agent use code mode (gtm_execute); off by default. */
  allow_execute: z.boolean(),
  /** The ENS name this agent answers to, when the owner linked one. */
  ens: agentEnsSchema.nullable(),
  /** The owner lets this agent buy credits from its own wallet; off by default. */
  allow_topup: z.boolean(),
  created_at: z.number().int(),
  last_used_at: z.number().int().nullable(),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentListResponseSchema = z.object({ agents: z.array(agentSummarySchema) });

export const agentTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(agentScopeSchema).min(1).optional(),
  credit_cap: creditCapSchema.optional(),
  cap_period: capPeriodSchema.optional(),
}).strict();
/** The token is shown once; only its hash is stored. */
export const agentTokenCreatedSchema = z.object({ agent: agentSummarySchema, token: z.string() });

export const agentUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  credit_cap: creditCapSchema.optional(),
  cap_period: capPeriodSchema.optional(),
  allow_execute: z.boolean().optional(),
  allow_topup: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Nothing to update");

/** GET /oauth/requests/:id: what the connector consent screen shows. */
export const connectorConsentSchema = z.object({
  id: z.string(),
  client: z.object({
    id: z.string(),
    name: z.string(),
    /** Host (or app scheme) that receives the authorization; consent must display it. */
    redirect_host: z.string(),
    /** Loopback or app-scheme redirect: any local app could claim it, so warn. */
    local_redirect: z.boolean(),
  }),
  scopes: z.array(agentScopeSchema),
  expires_at: z.number().int(),
});
export const consentDecisionSchema = z.object({
  credit_cap: creditCapSchema.optional(),
  cap_period: capPeriodSchema.optional(),
}).strict();
export const consentResultSchema = z.object({ redirect_to: z.string() });

/** GET /oauth/device: what the CLI code-match screen shows. */
export const deviceLoginSchema = z.object({
  user_code: z.string(),
  client: z.string(),
  scopes: z.array(agentScopeSchema),
  status: z.enum(["pending", "approved", "denied", "issued"]),
  expires_at: z.number().int(),
});
export const deviceDecisionSchema = z.object({
  user_code: z.string().trim().min(4).max(16),
  credit_cap: creditCapSchema.optional(),
  cap_period: capPeriodSchema.optional(),
}).strict();

/** RFC 7591 registration request; unknown metadata is accepted and ignored. */
export const oauthClientRegistrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
}).passthrough();

/**
 * OAuth Client ID Metadata Document: public clients only. A client that prefers another
 * method (ChatGPT prefers private_key_jwt) is accepted when it also lists "none" as supported.
 */
export const clientMetadataDocumentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
}).passthrough().refine(
  (document) => (document.token_endpoint_auth_method ?? "none") === "none" || document.token_endpoint_auth_methods_supported?.includes("none") === true,
  { message: "Client must support token_endpoint_auth_method none", path: ["token_endpoint_auth_method"] },
);

/**
 * World ID Agent Pass: a request an agent made past its credit cap, saved
 * for the account owner to verify with World ID and approve or deny.
 */
export const agentApprovalStatusSchema = z.enum(["pending", "approved", "denied", "used", "expired"]);
export const worldVerifyFailureSchema = z.enum([
  "cancelled", "issuer_mismatch", "exchange_failed", "invalid_token", "stale_authentication", "insufficient_assurance",
  "unavailable", "identity_mismatch", "identity_in_use", "expired", "unknown_attempt",
]);
export const agentApprovalSchema = z.object({
  id: z.string(),
  agent: z.object({ id: z.string(), name: z.string() }),
  tool: z.string(),
  description: z.string(),
  credits: z.number().int(),
  cap_credits: z.number().int(),
  cap_period: capPeriodSchema,
  spent_credits: z.number().int(),
  status: agentApprovalStatusSchema,
  created_at: z.number().int(),
  expires_at: z.number().int(),
  decided_at: z.number().int().nullable(),
  /** World ID checks for this request: whether one passed, until when it can approve, and how. */
  world: z.object({
    linked: z.boolean(),
    verified: z.boolean(),
    fresh_until: z.number().int().nullable(),
    method: z.enum(["proof", "passkey"]).nullable(),
    level: z.string().nullable(),
    last_error: worldVerifyFailureSchema.nullable(),
  }),
});
export type AgentApproval = z.infer<typeof agentApprovalSchema>;
export type AgentApprovalStatus = z.infer<typeof agentApprovalStatusSchema>;
export type WorldVerifyFailure = z.infer<typeof worldVerifyFailureSchema>;
export const agentApprovalResponseSchema = z.object({ approval: agentApprovalSchema });
export const worldStartResponseSchema = z.object({ authorize_url: z.string().url() });
