import {
  CAPABILITIES,
  MAX_BATCH_PEOPLE,
  OUTCOME_TOOLS,
  OUTCOME_TOOL_NAMES,
  accountInput,
  capabilityQuote,
  lookupEventSchema,
  parseAgentInput,
  resultsInput,
  searchCapabilities,
  shapeAnswer,
  toolRequestFor,
  toolsInput,
  type AgentAnswer,
  type AgentAnswerDraft,
  type AgentNext,
  type AgentScope,
  type CapabilityDefinition,
  type LookupResult,
  type OutcomeToolName,
  type ToolId,
  type ToolRequest,
  type ToolRun,
} from "@found/contracts";
import type { AgentPrincipal } from "../../auth/agent-auth.js";
import { randomToken } from "../../auth/google.js";
import type { ProviderMode } from "../../config.js";
import { atomicToCredits, CREDIT_ATOMIC } from "../../domain/credits.js";
import { emailAtCompany } from "../../domain/identity.js";
import { toLookupKey } from "../../domain/normalize.js";
import type { LookupKey } from "../../domain/types.js";
import { publicVerdict, reconcileVerdict } from "../../domain/verdict.js";
import { reportError } from "../../observability.js";
import type { AgentRunRecord, AgentRunStore } from "../../store/agent-runs.js";
import { EXECUTION_FRESHNESS_MS, type AgentApprovalStore, type ApprovalRecord } from "../../store/agent-approvals.js";
import type { CreditsService } from "../../store/credits.js";
import type { LookupRunStore } from "../../store/lookup-runs.js";
import { hashRequest, type IdempotencyStore } from "../../store/external.js";
import type { MachineLookupJob, MachineLookupJobStore } from "../../store/jobs.js";
import { ToolRunError } from "../../store/tool-runs.js";
import type { ToolLauncher } from "../../tools/launcher.js";
import { sha256Hex } from "../../util.js";
import type { LookupBatch } from "../lookup-batch.js";
import { inputRefusal, type PersonContext, planBatch, planBuildList, planContacts, planFindSignals, planResearchCompany, singleTool, type AgentPlan, type CommonArgs, type LookupStep, type PlanContext, type Planned, type Refusal, type ToolStep } from "./plans.js";

const TERMINAL = new Set<ToolRun["status"]>(["completed", "not_found", "error", "reconciliation_needed"]);
const RESULTS_PAGE = 5;
/** How long a lookup claim waits for its job to start; the running job renews the full lease every minute. */
const AGENT_LOOKUP_CLAIM_MS = 2 * 60 * 1000;

/** What a finished run keeps on the server: every row, plus the answer it gave. */
export interface AgentRunResult {
  rows: Record<string, unknown>[];
  columns: string[];
  label: string;
  summary: string;
  next: AgentNext;
  failures: number;
}

export interface CallContext {
  /** Keeps background work alive after the response (Workers waitUntil). */
  schedule?: (work: Promise<unknown>) => void;
  /** Origin for links in answers, e.g. https://gtmmaxing.com. */
  baseUrl?: string;
  /** Integration that sent the request, saved on runs for attribution. */
  source?: string | null;
}

export interface AgentGatewayDeps {
  /** Where an account out of credits can add them, when that is offered. */
  topUpLink?: (shortfallCredits: number) => string;
  /** Wallet top-ups are on, so an agent its owner allows can be told where to buy. */
  canTopUp?: boolean;
  runs: AgentRunStore;
  credits: CreditsService;
  tools: ToolLauncher;
  lookups: {
    batch: LookupBatch;
    idempotency: IdempotencyStore;
    jobs: MachineLookupJobStore;
    providerMode: ProviderMode;
    /** Starts a claimed job durably; the returned promise is whatever must stay alive for it. */
    dispatch: (job: MachineLookupJob, ownerToken: string) => Promise<unknown>;
    /** Whether the operator budget can hold one paid lookup; omitted means always. */
    ready?: () => Promise<boolean>;
  };
  /** History's write side for the run's email lookups; absent in tests that do not exercise it. */
  history?: LookupRunStore;
  /**
   * World ID Agent Pass: when set, an over-cap call saves a human checkpoint
   * and answers with its approval link instead of a plain refusal.
   */
  approvals?: { store: AgentApprovalStore; link: (id: string) => string } | null;
  /** Signs `data` into a URL-safe token for download links; null disables links. */
  sign: ((data: string) => Promise<string>) | null;
  inlineWaitMs: number;
  pollMs?: number;
  now?: () => number;
}

type Advance = { run: AgentRunRecord; work: Promise<unknown>[] };

/**
 * Agent gateway: the seven outcome tools over the existing engines. Every paid
 * call passes the budget guard before anything is sent (input and filters,
 * idempotent replay, quote, max_credits, balance, the agent's own cap), runs
 * as an agent run whose steps are ordinary tool runs and machine lookup jobs,
 * and answers in the shared shape. Supplier names never leave this module.
 */
export class AgentGateway {
  readonly runs: AgentRunStore;
  private readonly now: () => number;

  constructor(private readonly deps: AgentGatewayDeps) {
    this.runs = deps.runs;
    this.now = deps.now ?? Date.now;
  }

  /** The scope a call needs; surfaces answer 403 insufficient_scope without calling. */
  requiredScope(name: string, args: unknown): AgentScope {
    if (name === "gtm_tools") {
      const parsed = toolsInput.safeParse(args);
      return parsed.success && parsed.data.action === "run" && parsed.data.dry_run !== true ? "gtm:run" : "gtm:read";
    }
    const tool = OUTCOME_TOOLS[name as OutcomeToolName] as { paid: boolean } | undefined;
    const dryRun = typeof args === "object" && args !== null && (args as { dry_run?: unknown }).dry_run === true;
    return tool?.paid && !dryRun ? "gtm:run" : "gtm:read";
  }

  async call(principal: AgentPrincipal, name: string, args: unknown, ctx: CallContext = {}): Promise<AgentAnswer> {
    const balance = await this.balance(principal);
    if (!OUTCOME_TOOL_NAMES.includes(name as OutcomeToolName)) {
      return refused({ reason: "unknown_tool", summary: "Unknown tool; use one of the gtm_ tools.", fields: OUTCOME_TOOL_NAMES }, balance);
    }
    const tool = name as OutcomeToolName;
    if (tool === "gtm_results") return this.results(principal, args, balance, ctx);
    if (tool === "gtm_account") return this.account(principal, args, balance);
    if (tool === "gtm_tools") return this.tools(principal, args, balance, ctx);
    const planned = tool === "gtm_build_list" ? planBuildList(args)
      : tool === "gtm_research_company" ? planResearchCompany(args)
        : tool === "gtm_find_signals" ? planFindSignals(args)
          : await planContacts(args, this.planContext(principal));
    return this.execute(principal, tool, planned, balance, ctx);
  }

  /** Brings a run forward without waiting: starts due steps and settles it once every step is done. */
  async advance(runId: string, ctx: CallContext = {}): Promise<AgentRunRecord | null> {
    const run = await this.runs.get(runId);
    if (!run || run.status !== "running") return run;
    const step = await this.step(run);
    if (step.work.length) this.keepAlive(Promise.allSettled(step.work).then(() => this.settle(run.id)), ctx);
    return step.run;
  }

  /** Scheduled recovery for runs whose isolate stopped before they settled. */
  async recover(limit = 20): Promise<void> {
    for (const run of await this.runs.running(limit)) {
      try { await this.settle(run.id); }
      catch (error) { reportError("agent_run_recovery_failed", error, { service: run.id }); }
    }
  }

  /** Every row of a finished run, for exports and full-table views; scoped to an account unless a signed link authorized it. */
  async rows(runId: string, accountId?: string): Promise<{ run: AgentRunRecord; rows: Record<string, unknown>[] } | null> {
    const run = await this.runs.get(runId, accountId);
    if (!run) return null;
    return { run, rows: (run.result as AgentRunResult | null)?.rows ?? [] };
  }

  /** CSV of a run's full rows, with spreadsheet formula injection neutralized. */
  csv(run: AgentRunRecord): string {
    const result = run.result as AgentRunResult | null;
    const rows = result?.rows ?? [];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const escape = (value: unknown) => {
      let text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
      if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n") + "\r\n";
  }

  /* Budget guard and execution */

  private async execute(principal: AgentPrincipal, tool: OutcomeToolName, planned: Planned, balance: number, ctx: CallContext): Promise<AgentAnswer> {
    if (!planned.ok) return refused(planned.refusal, balance);
    const { plan, common } = planned;
    const requestHash = await sha256Hex(JSON.stringify(planned.canonical));
    if (common.dryRun) {
      const quote = await this.uncachedQuote(principal, plan);
      return shapeAnswer({ status: "quote", summary: `This would cost at most ${credits(quote)}; nothing was sent.`, quote, balance, next: planNext(tool, planned.canonical, quote) });
    }
    if (common.idempotencyKey) {
      const existing = await this.runs.find(principal.agent.id, common.idempotencyKey);
      if (existing) return this.replay(principal, existing, requestHash, balance, ctx);
    }
    const quote = await this.uncachedQuote(principal, plan);
    const cacheOnly = quote === 0;
    // 3. Nothing paid runs without the caller's own ceiling.
    if (!cacheOnly && common.maxCredits === undefined) return refused({ reason: "max_credits_required", summary: `Nothing was sent: this costs at most ${credits(quote)}, so add max_credits to run it.`, quote, next: planNext(tool, planned.canonical, quote) }, balance);
    if (!cacheOnly && quote > common.maxCredits!) return refused({ reason: "over_max_credits", summary: `Nothing was sent: this costs up to ${credits(quote)}, above your max_credits of ${common.maxCredits}.`, quote, next: planNext(tool, planned.canonical, quote) }, balance);
    const blocked = this.unavailable(principal, plan);
    if (blocked) return refused({ ...blocked, quote }, balance);
    // Without operator budget every paid lookup errors before any provider runs; say so instead of a retry hint that cannot work.
    if (!cacheOnly && (plan.named?.deferredQuote || plan.steps.some((step) => step.kind === "lookup")) && this.deps.lookups.ready && !(await this.deps.lookups.ready())) {
      return refused({ reason: "temporarily_unavailable", summary: "Nothing was sent: email lookups are temporarily unavailable on our side, so nothing was charged; try again later.", quote }, balance);
    }
    if (!cacheOnly && balance < quote) {
      const shortfall = quote - balance;
      const topUp = this.deps.topUpLink?.(shortfall);
      const buyOwn = Boolean(this.deps.canTopUp && principal.agent.allowTopup && ctx.baseUrl);
      const ask = buyOwn ? ", so buy credits from your wallet at top_up, or ask the owner" : topUp ? ", so ask the account owner to add credits at the link and repeat this call" : "";
      return refused({ reason: "insufficient_credits", summary: `Nothing was sent: this needs up to ${credits(quote)} and you have ${balance}${ask}.`, quote, next: { tool: "gtm_account", args: {} }, ...(topUp ? { link: topUp } : {}), ...(buyOwn ? { top_up: { url: `${ctx.baseUrl}/v1/agent/topups`, credits: shortfall } } : {}) }, balance);
    }
    // 4. The agent's own cap, enforced atomically with creating the run.
    const admitted = await this.runs.admit({
      accountId: principal.user.creditAccountId,
      agentId: principal.agent.id,
      tool,
      requestKey: common.idempotencyKey ?? `auto:${randomToken(16)}`,
      requestHash,
      plan,
      reservedCredits: cacheOnly ? 0 : quote,
      source: ctx.source ?? null,
    }, { credits: principal.agent.creditCap, period: principal.agent.capPeriod }, !cacheOnly);
    if (admitted.kind === "existing") return this.replay(principal, admitted.run, requestHash, balance, ctx);
    if (admitted.kind === "over_cap" && this.deps.approvals) {
      const outcome = await this.overCap(principal, tool, plan, requestHash, quote, admitted.spent, balance, ctx);
      if ("status" in outcome) return outcome;
      const run = await this.waitFor(outcome.run.id, ctx);
      const settled = run.status !== "running";
      return this.answer(run, { cost: settled ? run.chargedCredits : 0, balance: await this.balance(principal), baseUrl: ctx.baseUrl });
    }
    if (admitted.kind === "over_cap") {
      const left = Math.max(0, principal.agent.creditCap - admitted.spent);
      return refused({
        reason: "over_agent_cap",
        summary: `Nothing was sent: this needs up to ${credits(quote)} but this agent has ${left} left of its ${PERIOD_WORDS[principal.agent.capPeriod]} cap of ${credits(principal.agent.creditCap)}.`,
        quote,
      }, balance);
    }
    const run = await this.waitFor(admitted.run.id, ctx);
    const settled = run.status !== "running";
    return this.answer(run, { cost: settled ? run.chargedCredits : 0, balance: await this.balance(principal), baseUrl: ctx.baseUrl });
  }

  /**
   * Human checkpoint for a call past the agent's cap. An approval the owner
   * gave with fresh World ID admits exactly this request once; otherwise the
   * request is saved (or the open one reused) and the agent gets the link.
   */
  private async overCap(principal: AgentPrincipal, tool: OutcomeToolName, plan: AgentPlan, requestHash: string, quote: number, spent: number, balance: number, ctx: CallContext): Promise<AgentAnswer | { run: AgentRunRecord }> {
    const { store, link } = this.deps.approvals!;
    const latest = await store.latest(principal.agent.id, requestHash);
    if (latest?.status === "used" && latest.runId) {
      const run = await this.runs.get(latest.runId, principal.user.creditAccountId);
      if (run) return this.replay(principal, run, requestHash, balance, ctx);
    }
    if (latest && store.usable(latest, quote)) {
      const admitted = await this.runs.admitApproved({
        accountId: principal.user.creditAccountId, agentId: principal.agent.id, tool, requestHash, plan, reservedCredits: quote, source: ctx.source ?? null,
      }, { id: latest.id, minAuthTime: Math.floor((this.now() - EXECUTION_FRESHNESS_MS) / 1000) });
      if (admitted.kind === "admitted") {
        await store.markUsed(latest.id, admitted.run.id);
        return { run: admitted.run };
      }
      if (admitted.kind === "existing") return this.replay(principal, admitted.run, requestHash, balance, ctx);
    }
    if (latest?.status === "denied") {
      return refused({ reason: "approval_denied", summary: "Nothing was sent: the account owner denied this request past the agent's credit cap.", quote, next: humanNext("The user denied this request; do not retry it without asking them.") }, balance);
    }
    const open: ApprovalRecord = latest && latest.status === "pending" && latest.credits >= quote ? latest : await store.create({
      userId: principal.user.id, accountId: principal.user.creditAccountId, agentId: principal.agent.id, tool, requestHash,
      description: plan.hint, credits: quote, capCredits: principal.agent.creditCap, capPeriod: principal.agent.capPeriod, spentCredits: spent,
    });
    const left = Math.max(0, principal.agent.creditCap - spent);
    return shapeAnswer({
      status: "refused", reason: "approval_required", cost: 0, balance, quote,
      summary: `Nothing was sent: this needs ${credits(quote)} but this agent has ${left} left; the owner can approve it with World ID.`,
      link: link(open.id),
      next: humanNext("Ask the user to open the link and approve with World ID, then repeat this exact call."),
    });
  }

  private async uncachedQuote(principal: AgentPrincipal, plan: AgentPlan): Promise<number> {
    let quote = 0;
    const cacheOnlyVerifications: string[] = [];
    for (const step of plan.steps) {
      if (step.kind === "tool") {
        step.cacheOnly = await this.deps.tools.hasCached(principal.user.creditAccountId, step.request);
        if (!step.cacheOnly) quote += CAPABILITIES[step.capability].price.credits;
        continue;
      }
      const keys = (await Promise.all(step.urls.map((url) => toLookupKey(url, `mode:${this.deps.lookups.providerMode}`)))).filter((key): key is LookupKey => key !== null);
      if (keys.length !== step.urls.length) throw new Error("agent plan has an invalid lookup URL");
      const preflight = await this.deps.lookups.batch.prepare({
        keys,
        accountId: principal.user.creditAccountId,
        chargeCredits: true,
        propagateErrors: true,
      });
      const uncached = new Set([...preflight.billableKeys, ...preflight.cacheMissKeys]);
      step.cacheOnlyHashes = keys.map((key) => key.urlHash).filter((urlHash) => !uncached.has(urlHash));
      quote += preflight.billableCount * CAPABILITIES["email-finder"].price.credits;
      if (plan.verify) {
        for (const urlHash of preflight.candidateKeys) {
          const row = preflight.command.cachedRows.get(urlHash);
          if (!row?.email) {
            quote += CAPABILITIES["verify-email"].price.credits;
            continue;
          }
          const request = toolRequestFor("verify-email", { email: row.email });
          if (!request.ok) throw new Error("cached lookup has an invalid email");
          if (await this.deps.tools.hasCached(principal.user.creditAccountId, request.request)) cacheOnlyVerifications.push(row.email);
          else quote += CAPABILITIES["verify-email"].price.credits;
        }
      }
    }
    plan.cacheOnlyVerifications = cacheOnlyVerifications;
    // Contacts asked for by name: the email and phone steps do not exist yet, so price them per person now.
    if (plan.named && !plan.named.resolved) quote += plan.named.deferredQuote;
    return quote;
  }

  private async replay(principal: AgentPrincipal, run: AgentRunRecord, requestHash: string, balance: number, ctx: CallContext): Promise<AgentAnswer> {
    if (run.requestHash !== requestHash) {
      return refused({ reason: "idempotency_conflict", summary: "Nothing was sent: that idempotency_key was already used for a different request." }, balance);
    }
    const current = (await this.advance(run.id, ctx)) ?? run;
    return this.answer(current, { cost: 0, runCost: current.chargedCredits, replayed: true, balance: await this.balance(principal), baseUrl: ctx.baseUrl });
  }

  /** Access gates and availability, checked before any money moves. */
  private unavailable(principal: AgentPrincipal, plan: AgentPlan): Refusal | null {
    for (const step of plan.steps) {
      if (step.kind !== "tool") continue;
      if (this.deps.tools.denied(principal.user.email, step.capability)) return { reason: "tool_not_enabled", summary: `Nothing was sent: ${CAPABILITIES[step.capability].title.toLowerCase()} is not enabled for this account yet.` };
      if (!this.deps.tools.available(step.capability)) return { reason: "temporarily_unavailable", summary: `Nothing was sent: ${CAPABILITIES[step.capability].title.toLowerCase()} is temporarily unavailable; try again later.` };
    }
    return null;
  }

  /** Advances a fresh run, waiting up to the inline budget before answering with a run handle. */
  private async waitFor(runId: string, ctx: CallContext): Promise<AgentRunRecord> {
    const deadline = this.now() + this.deps.inlineWaitMs;
    let run = (await this.runs.get(runId))!;
    for (;;) {
      const step = await this.step(run);
      run = step.run;
      if (run.status !== "running") return run;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        if (step.work.length) this.keepAlive(Promise.allSettled(step.work).then(() => this.settle(runId)), ctx);
        return run;
      }
      if (step.work.length) {
        const all = Promise.allSettled(step.work);
        const finished = await Promise.race([all.then(() => true), delay(remaining).then(() => false)]);
        if (!finished) {
          this.keepAlive(all.then(() => this.settle(runId)), ctx);
          return (await this.runs.get(runId))!;
        }
      } else {
        await delay(Math.min(this.deps.pollMs ?? 200, remaining));
      }
    }
  }

  /** Steps until nothing new can start here; external jobs finish via their own workflows and cron. */
  async settle(runId: string): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const run = await this.runs.get(runId);
      if (!run || run.status !== "running") return;
      const step = await this.step(run);
      if (!step.work.length) return;
      await Promise.allSettled(step.work);
    }
  }

  private keepAlive(work: Promise<unknown>, ctx: CallContext): void {
    const guarded = work.catch(() => undefined);
    ctx.schedule?.(guarded);
  }

  /** One idempotent pass: start what is due (deterministic keys make concurrent passes converge), then settle if done. */
  private async step(run: AgentRunRecord): Promise<Advance> {
    const plan = run.plan as AgentPlan;
    const work: Promise<unknown>[] = [];
    let changed = false;
    let pending = false;
    let lines: Map<string, LookupResult> | null = null;
    let lookupFailed = false;
    let lookupPending = false;
    for (const step of plan.steps) {
      if (step.kind === "lookup") {
        const lookup = await this.stepLookup(run, step);
        if (lookup.work) work.push(lookup.work);
        if (!lookup.done) { pending = true; lookupPending = true; }
        lines = lookup.lines ?? lines;
        lookupFailed ||= lookup.failed === true;
        continue;
      }
      const tool = await this.stepTool(run, step);
      changed ||= tool.changed;
      if (tool.work) work.push(tool.work);
      if (!tool.done) pending = true;
    }
    if (plan.named && !plan.named.resolved && !pending && !work.length) {
      // Every profile search has finished: look up contacts for the profiles found.
      const urls: string[] = [];
      const people: Record<string, PersonContext> = {};
      const companyOf: Record<string, string> = {};
      for (const step of plan.steps) {
        if (step.kind !== "tool" || step.capability !== "profile-finder" || !step.runId) continue;
        const row = (await this.deps.tools.get(step.runId, run.accountId))?.result?.rows[0];
        const url = typeof row?.url === "string" ? row.url : null;
        if (!url || urls.includes(url)) continue;
        urls.push(url);
        if (step.about?.company) companyOf[url] = step.about.company;
        people[url] = { name: typeof row?.name === "string" ? row.name : null, title: typeof row?.title === "string" && row.title ? row.title : null, company: null };
      }
      if (urls.length && plan.emails) plan.steps.push({ kind: "lookup", tenantId: plan.named.tenantId, urls, chargeAfterChecks: true });
      if (plan.phones) urls.forEach((url, index) => {
        const request = toolRequestFor("phone-pilot", { profile: url });
        if (request.ok) plan.steps.push({ kind: "tool", key: `phone:${index}`, capability: "phone-pilot", request: request.request, subject: url });
      });
      plan.people = { ...plan.people, ...people };
      plan.named.resolved = true;
      plan.named.companyOf = companyOf;
      await this.runs.savePlan(run.id, plan);
      return this.step({ ...run, plan });
    }
    if (plan.verify && !plan.verifyPlanned && lines && !lookupPending) {
      const emails = [...new Set([...lines.values()].filter((line) => !atOtherCompany(plan, line)).map((line) => line.email).filter((email): email is string => !!email))];
      emails.forEach((email, index) => {
        const request = CAPABILITIES["verify-email"].toolRequest!({ email });
        plan.steps.push({ kind: "tool", key: `verify:${index}`, capability: "verify-email", request: request as ToolRequest, subject: email, cacheOnly: plan.cacheOnlyVerifications?.includes(email) === true });
      });
      plan.verifyPlanned = true;
      await this.runs.savePlan(run.id, plan);
      return this.step({ ...run, plan });
    }
    if (changed) await this.runs.savePlan(run.id, plan);
    if (pending || work.length) return { run: { ...run, plan }, work };
    const finished = await this.finish(run, plan, lines, lookupFailed);
    return { run: finished, work: [] };
  }

  private async stepTool(run: AgentRunRecord, step: ToolStep): Promise<{ done: boolean; changed: boolean; work?: Promise<unknown> }> {
    if (step.error) return { done: true, changed: false };
    if (!step.runId) {
      try {
        const opened = await this.deps.tools.open(run.accountId, `${run.id}:${step.key}`, step.request, run.id, run.reservedCredits === 0 || step.cacheOnly === true);
        step.runId = opened.id;
        if (opened.status === "queued") return { done: false, changed: true, work: this.deps.tools.dispatch(opened) };
        return { done: TERMINAL.has(opened.status), changed: true };
      } catch (error) {
        if (!(error instanceof ToolRunError)) throw error;
        step.error = error.code;
        return { done: true, changed: true };
      }
    }
    const toolRun = await this.deps.tools.get(step.runId, run.accountId);
    if (toolRun?.status === "queued") return { done: false, changed: false, work: this.deps.tools.dispatch(toolRun) };
    return { done: !toolRun || TERMINAL.has(toolRun.status), changed: false };
  }

  /** Emails run as a durable machine lookup job on the agent's tenant, charged to the owner's credits. */
  private async stepLookup(run: AgentRunRecord, step: LookupStep): Promise<{ done: boolean; lines?: Map<string, LookupResult>; failed?: boolean; work?: Promise<unknown> }> {
    const { jobs, idempotency, providerMode, dispatch } = this.deps.lookups;
    const key = `agent:${run.id}`;
    const job = await jobs.find(step.tenantId, key);
    if (!job) {
      const keys = (await Promise.all(step.urls.map((url) => toLookupKey(url, `mode:${providerMode}`)))).filter((k): k is LookupKey => k !== null);
      const requestHash = await hashRequest({ run: run.id, urls: step.urls });
      // A short claim: if this isolate stops between claiming and recording the job, a later poll takes over
      // within two minutes instead of waiting out the ten-minute job lease (2026-10-28: a 92-person email step sat idle 10 minutes).
      const claim = await idempotency.claim(step.tenantId, key, requestHash, AGENT_LOOKUP_CLAIM_MS);
      if (claim.kind !== "claimed") return { done: false };
      const started = await jobs.start(step.tenantId, key, requestHash, claim.ownerToken, keys, providerMode, null, step.chargeAfterChecks ? null : run.accountId, run.id);
      return { done: false, work: dispatch(started, claim.ownerToken) };
    }
    if (job.status === "in_progress") return { done: false };
    if (job.status === "failed") return { done: true, failed: true, ...(job.responseBody ? { lines: parseLookupLines(job.responseBody) } : {}) };
    if (!job.responseBody) return { done: true, failed: true };
    return { done: true, lines: parseLookupLines(job.responseBody) };
  }

  private async finish(run: AgentRunRecord, plan: AgentPlan, lines: Map<string, LookupResult> | null, lookupFailed: boolean): Promise<AgentRunRecord> {
    const toolRuns = new Map<string, ToolRun | null>();
    for (const step of plan.steps) {
      if (step.kind === "lookup") {
        continue;
      }
      const toolRun = step.runId ? await this.deps.tools.get(step.runId, run.accountId) : null;
      toolRuns.set(step.key, toolRun);
    }
    const skipped = await this.chargeCheckedEmails(run, plan, toolRuns, lines);
    await this.recordLookupHistory(run, plan, lines, skipped);
    const charged = await this.deps.credits.agentCharges(run.id, run.accountId);
    const result = compose(run, plan, toolRuns, lines, lookupFailed, charged, skipped);
    // A run that returns rows completes; the summary names what failed. Otherwise one person's failure would
    // read as everyone's, and callers that stop on errors would drop results already charged.
    const status = result.rows.length ? "completed" : result.failures ? "error" : "not_found";
    await this.runs.finish(run.id, status, result, charged);
    return (await this.runs.get(run.id))!;
  }

  /**
   * Charges one credit per email that passed the checks, under the same
   * per-profile claim the lookup engine uses, so repeats stay free. Emails at
   * another company than the list asked for, invalid mailboxes and emails the
   * balance no longer covers are left uncharged and out of the answer.
   */
  private async chargeCheckedEmails(run: AgentRunRecord, plan: AgentPlan, toolRuns: Map<string, ToolRun | null>, lines: Map<string, LookupResult> | null): Promise<Map<string, Skip>> {
    const skipped = new Map<string, Skip>();
    const lookup = plan.steps.find((step): step is LookupStep => step.kind === "lookup");
    if (!lookup?.chargeAfterChecks || !lines) return skipped;
    for (const url of lookup.urls) {
      const line = lines.get(url);
      if (!line?.email || line.status !== "found") continue;
      if (atOtherCompany(plan, line)) { skipped.set(url, "other_company"); continue; }
      if (mailboxVerdict(plan, toolRuns, line) === "invalid") { skipped.set(url, "invalid"); continue; }
      const key = await toLookupKey(url, `mode:${this.deps.lookups.providerMode}`);
      if (!key) continue;
      const charge = await this.deps.credits.claimAndDebit(run.accountId, "lookup", key.urlHash, CREDIT_ATOMIC, "lookup", run.id);
      if (charge.status === "insufficient") skipped.set(url, "unpaid");
    }
    return skipped;
  }

  /**
   * Saves the run's email lookup to the owner's History once charges are
   * final: every profile in order, misses included, with what this run
   * charged. Emails withheld from the agent stay withheld here too.
   */
  private async recordLookupHistory(run: AgentRunRecord, plan: AgentPlan, lines: Map<string, LookupResult> | null, skipped: Map<string, Skip>): Promise<void> {
    const history = this.deps.history;
    const lookup = plan.steps.find((step): step is LookupStep => step.kind === "lookup");
    if (!history || !lookup) return;
    try {
      const keys = await Promise.all(lookup.urls.map((url) => toLookupKey(url, `mode:${this.deps.lookups.providerMode}`)));
      const charged = await this.deps.credits.agentLookupCharges(run.id, run.accountId, keys.flatMap((key) => key ? [key.urlHash] : []));
      const record = { runId: `agent:${run.id}`, source: "agent" as const };
      await history.start(record, run.accountId, run.id, lookup.urls.length);
      for (const [index, url] of lookup.urls.entries()) {
        const key = keys[index];
        const line = lines?.get(url);
        const withheld = skipped.get(url);
        const item: LookupResult = !line
          ? { key: url, url: key?.url ?? url, status: "error", name: null, title: null, email: null, deliverability: null }
          : withheld ? { ...line, status: withheld === "unpaid" ? "error" : "not_found", email: null, deliverability: null } : line;
        await history.record(record.runId, index, key?.urlHash ?? url, item, key ? charged.get(key.urlHash) ?? 0 : 0);
      }
      await history.finish(record.runId);
    } catch (err) {
      reportError("lookup_history_write_failed", err);
    }
  }

  /* Free tools */

  private async results(principal: AgentPrincipal, args: unknown, balance: number, ctx: CallContext): Promise<AgentAnswer> {
    const parsed = parseAgentInput(resultsInput, args);
    if (!parsed.ok) return refused(inputRefusal(parsed), balance);
    const found = await this.runs.get(parsed.data.run_id, principal.user.creditAccountId);
    if (!found) return refused({ reason: "run_not_found", summary: "No run with that id on this account.", fields: ["run_id"] }, balance);
    const run = principal.scopes.has("gtm:run") ? ((await this.advance(found.id, ctx)) ?? found) : found;
    const currentBalance = await this.balance(principal);
    const offset = parsed.data.offset ?? 0;
    if (parsed.data.format === "csv" && run.status !== "running") {
      const rows = (run.result as AgentRunResult | null)?.rows.length ?? 0;
      const link = await this.csvLink(run, ctx.baseUrl);
      if (!link) return refused({ reason: "export_unavailable", summary: "CSV links are not available on this deployment; page through rows instead." }, currentBalance);
      const status = run.status === "completed" ? "completed" : run.status === "not_found" ? "not_found" : "error";
      return shapeAnswer({ status, summary: `A CSV of all ${rows} rows is ready; the link works for one hour.`, run_id: run.id, cost: 0, run_cost: run.chargedCredits, balance: currentBalance, total: rows, link, next: { tool: "gtm_results", args: { run_id: run.id, format: "rows" } } });
    }
    return this.answer(run, { cost: 0, runCost: run.chargedCredits, balance: currentBalance, offset, baseUrl: ctx.baseUrl });
  }

  private async account(principal: AgentPrincipal, args: unknown, balance: number): Promise<AgentAnswer> {
    const parsed = parseAgentInput(accountInput, args);
    if (!parsed.ok) return refused(inputRefusal(parsed), balance);
    const { agent } = principal;
    const spent = await this.runs.spent(agent.id, agent.capPeriod);
    const left = Math.max(0, agent.creditCap - spent);
    const recent = (await this.runs.recent(agent.id, 5)).map((run) => ({
      tool: run.tool, status: run.status, cost: run.status === "running" ? run.reservedCredits : run.chargedCredits, when: new Date(run.createdAt).toISOString().slice(0, 16).replace("T", " "),
    }));
    const quote = parsed.data.quote ? capabilityQuote(parsed.data.quote.capability, parsed.data.quote.count) : undefined;
    const summary = quote !== undefined
      ? `That batch costs at most ${credits(quote)}; you have ${balance}, and this agent has ${left} of ${agent.creditCap} ${PERIOD_WORDS[agent.capPeriod]} credits left.`
      : `${credits(balance)} on pay as you go; this agent has ${left} of ${agent.creditCap} ${PERIOD_WORDS[agent.capPeriod]} credits left.`;
    const next: AgentNext = quote !== undefined && parsed.data.quote
      ? { tool: "gtm_tools", args: { action: "run", capability: parsed.data.quote.capability, input: CAPABILITIES[parsed.data.quote.capability].example, max_credits: quote } }
      : balance < 2
        ? humanNext("Ask the user to add credits at https://gtmmaxing.com/outboundmaxing/ or review the balance at https://gtmmaxing.com/usage/.")
        : left < 2
          ? humanNext("Ask the user to raise this agent's credit cap before running another search.")
          : { tool: "gtm_build_list", args: { titles: ["VP Sales"], max_credits: 2 } };
    return shapeAnswer({
      status: "completed", summary, cost: 0, balance, ...(quote !== undefined ? { quote } : {}),
      label: "recent", columns: ["tool", "status", "cost", "when"], rows: recent, total: recent.length, next,
    });
  }

  private async tools(principal: AgentPrincipal, args: unknown, balance: number, ctx: CallContext): Promise<AgentAnswer> {
    const parsed = parseAgentInput(toolsInput, args);
    if (!parsed.ok) return refused(inputRefusal(parsed), balance);
    const { action, query, capability, input } = parsed.data;
    if (action === "search") {
      const matches = searchCapabilities(query ?? "");
      return shapeAnswer({
        status: matches.length ? "completed" : "not_found",
        summary: matches.length ? `Found ${counted(matches.length, "matching tools")}.` : "No tool matches; try other words.",
        label: "tools", columns: ["capability", "title", "credits"], rows: matches.map((m) => ({ capability: m.id, title: m.title, credits: m.credits })), total: matches.length,
        balance, next: matches[0] ? { tool: "gtm_tools", args: { action: "describe", capability: matches[0].id } } : { tool: "gtm_tools", args: { action: "search", query: "lead list" } },
      });
    }
    if (!capability) return refused({ reason: "invalid_input", summary: "Nothing was sent: name a capability, found with action search.", fields: ["action", "query", "capability", "input"] }, balance);
    const definition: CapabilityDefinition = CAPABILITIES[capability];
    if (action === "describe") {
      return shapeAnswer({
        status: "completed",
        // Answers keep one sentence of at most 24 words, so price and batch size lead and the description follows.
        summary: `${definition.title} (${definition.price.credits} ${definition.price.credits === 1 ? "credit" : "credits"} per ${definition.price.unit}${"people" in definition.input.shape ? `, up to ${MAX_BATCH_PEOPLE} people per call` : ""}): ${definition.description}`,
        fields: Object.keys(definition.input.shape), balance,
        // A batch capability's example shows the batch form, so callers with a list reach for it.
        next: { tool: "gtm_tools", args: { action: "run", capability, input: definition.batch ? batchExample(definition.example) : definition.example, max_credits: capabilityQuote(capability) } },
      });
    }
    const common: CommonArgs = { maxCredits: parsed.data.max_credits, idempotencyKey: parsed.data.idempotency_key, dryRun: parsed.data.dry_run === true };
    let planned: Planned;
    if (capability === "email-finder") {
      const people = parseAgentInput(definition.input, input);
      planned = people.ok
        ? await planContacts({ people: (people.data as { people: string[] }).people, max_credits: common.maxCredits, idempotency_key: common.idempotencyKey, dry_run: common.dryRun }, this.planContext(principal), "gtm_tools")
        : { ok: false, refusal: inputRefusal(people) };
    } else if (definition.batch && typeof input === "object" && input !== null && "people" in input) {
      const checked = parseAgentInput(definition.input, input);
      planned = checked.ok
        ? planBatch(capability as ToolId, checked.data as Record<string, unknown>, common, { tool: "gtm_tools", capability })
        : { ok: false, refusal: inputRefusal(checked) };
    } else {
      // Name what was searched ("vercel.com", "Dentists in Austin") rather than the tool, which the caller already knows.
      const given = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
      const subject = Object.entries(given).find(([key, value]) => key !== "location" && typeof value === "string" && value.trim())?.[1] as string | undefined;
      const place = typeof given.location === "string" && given.location.trim() ? ` in ${given.location.trim()}` : "";
      planned = singleTool(capability, input ?? {}, common, { tool: "gtm_tools", capability, input: input ?? {} }, subject ? `${subject.trim()}${place}` : definition.title);
    }
    return this.execute(principal, "gtm_tools", planned, balance, ctx);
  }

  /* Answers */

  private answer(run: AgentRunRecord, options: { cost: number; runCost?: number; replayed?: boolean; balance: number; offset?: number; baseUrl?: string | undefined }): AgentAnswer {
    const plan = run.plan as AgentPlan;
    const base = { run_id: run.id, cost: options.cost, balance: options.balance, ...(options.runCost !== undefined ? { run_cost: options.runCost } : {}), ...(options.replayed ? { replayed: true } : {}) };
    if (run.status === "running") {
      return shapeAnswer({ ...base, status: "running", summary: `Still working on ${plan.hint}; check back in about ten seconds.`, label: plan.label, total: 0, next: { tool: "gtm_results", args: { run_id: run.id } } });
    }
    const result = run.result as AgentRunResult;
    const offset = options.offset ?? 0;
    const draft: AgentAnswerDraft = {
      ...base,
      status: run.status === "completed" ? "completed" : run.status === "not_found" ? "not_found" : "error",
      // Rows came back but some lookups failed: rerunning the same request retries just those.
      ...(run.status === "completed" && result.failures ? { reason: "partial_failure" } : {}),
      summary: result.summary,
      label: result.label,
      columns: result.columns,
      rows: result.rows.slice(offset, offset + RESULTS_PAGE),
      total: result.rows.length,
      next: result.next ?? { tool: "gtm_results", args: { run_id: run.id, format: "csv" } },
    };
    if (offset > 0) {
      const end = Math.min(result.rows.length, offset + RESULTS_PAGE);
      draft.summary = end > offset ? `Rows ${offset + 1} to ${end} of ${result.rows.length}.` : `No rows after ${result.rows.length}.`;
      draft.next = end < result.rows.length ? { tool: "gtm_results", args: { run_id: run.id, offset: end } } : { tool: "gtm_results", args: { run_id: run.id, format: "csv" } };
    }
    return shapeAnswer(draft);
  }

  private async csvLink(run: AgentRunRecord, baseUrl: string | undefined): Promise<string | null> {
    if (!this.deps.sign || !baseUrl) return null;
    const token = await this.deps.sign(`csv|${run.id}|${this.now() + 60 * 60 * 1000}`);
    return `${baseUrl}/v1/agent/runs/${run.id}/export.csv?token=${encodeURIComponent(token)}`;
  }

  private planContext(principal: AgentPrincipal): PlanContext {
    const accountId = principal.user.creditAccountId;
    return {
      tenantId: principal.agent.tenantId,
      cacheNamespace: `mode:${this.deps.lookups.providerMode}`,
      runRows: async (runId) => {
        const run = await this.runs.get(runId, accountId);
        if (!run || run.status === "running") return null;
        const source = run.plan as AgentPlan;
        const main = source.capability === "icp" ? source.steps.find((step): step is ToolStep => step.kind === "tool") : undefined;
        return { rows: (run.result as AgentRunResult).rows, company: main ? main.request.query.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? null : null };
      },
    };
  }

  private async balance(principal: AgentPrincipal): Promise<number> {
    return atomicToCredits(await this.deps.credits.balance(principal.user.creditAccountId));
  }
}

const PERIOD_WORDS = { day: "daily", week: "weekly", month: "monthly" } as const;
const SINGULAR: Record<string, string> = { people: "person", companies: "company", businesses: "business", contacts: "contact" };
/** "1 person", "3 people", "1 brief". */
const counted = (n: number, plural: string) => `${n} ${n === 1 ? SINGULAR[plural] ?? plural.replace(/s$/, "") : plural}`;
const credits = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function planNext(tool: OutcomeToolName, canonical: unknown, maxCredits: number): AgentNext {
  const args = typeof canonical === "object" && canonical !== null
    ? Object.fromEntries(Object.entries(canonical).filter(([key]) => key !== "tool"))
    : {};
  if (tool === "gtm_tools") {
    if (typeof args.capability === "string" && args.input !== undefined) {
      return { tool, args: { action: "run", capability: args.capability, input: args.input, max_credits: maxCredits } };
    }
    if (Array.isArray(args.people)) {
      return { tool, args: { action: "run", capability: "email-finder", input: { people: args.people }, max_credits: maxCredits } };
    }
  }
  return { tool, args: { ...args, max_credits: maxCredits } };
}

function humanNext(message: string): AgentNext {
  return { tool: "human", args: { message } };
}

function parseLookupLines(body: string): Map<string, LookupResult> {
  const lines = new Map<string, LookupResult>();
  for (const text of body.split("\n")) {
    if (!text.trim()) continue;
    try {
      const event = lookupEventSchema.safeParse(JSON.parse(text));
      if (event.success && "status" in event.data) lines.set(event.data.key, event.data);
    } catch {
      continue;
    }
  }
  return lines;
}

/** `{ profile, ...rest }` as `{ people: [profile], ...rest }`. */
function batchExample(example: Record<string, unknown>): Record<string, unknown> {
  const { profile, ...rest } = example;
  return typeof profile === "string" ? { people: [profile], ...rest } : example;
}

function refused(refusal: Refusal, balance: number): AgentAnswer {
  return shapeAnswer({
    status: "refused", reason: refusal.reason, summary: refusal.summary, cost: 0, balance,
    ...(refusal.quote !== undefined ? { quote: refusal.quote } : {}),
    ...(refusal.fields ? { fields: refusal.fields } : {}),
    ...(refusal.link ? { link: refusal.link } : {}),
    ...(refusal.top_up ? { top_up: refusal.top_up } : {}),
    next: refusal.next ?? { tool: "gtm_account", args: {} },
  });
}

/** Rows and the answer text for a finished run, from its engine results. */
type Skip = "other_company" | "invalid" | "unpaid";

/** A list asked for one company and this email is at another (they may have moved on). */
function atOtherCompany(plan: AgentPlan, line: LookupResult): boolean {
  const company = plan.people?.[line.url]?.company;
  return !!company && !!line.email && !emailAtCompany(line.email, company);
}

function mailboxCheck(plan: AgentPlan, toolRuns: Map<string, ToolRun | null>, email: string) {
  const step = plan.steps.find((s): s is ToolStep => s.kind === "tool" && s.capability === "verify-email" && s.subject === email);
  return step ? toolRuns.get(step.key)?.result?.rows[0] ?? null : null;
}

/** No verdict unless a definitive check ran: a null finder deliverability covers failed or undecided checks, catch-alls and acceptances with no validator configured. */
function mailboxVerdict(plan: AgentPlan, toolRuns: Map<string, ToolRun | null>, line: LookupResult) {
  const check = line.email && plan.verify ? mailboxCheck(plan, toolRuns, line.email) : null;
  const outcomes = [
    ...(line.deliverability ? [{ source: "finder", status: line.deliverability }] : []),
    ...(check ? [{ source: "mailbox", status: String(check.verdict ?? "") }] : []),
  ];
  return outcomes.length ? publicVerdict(outcomes) : null;
}

function compose(run: AgentRunRecord, plan: AgentPlan, toolRuns: Map<string, ToolRun | null>, lines: Map<string, LookupResult> | null, lookupFailed: boolean, charged: number, skipped: Map<string, Skip> = new Map()): AgentRunResult {
  const failed = (run: ToolRun | null | undefined) => !run || run.status === "error" || run.status === "reconciliation_needed";
  const toolSteps = plan.steps.filter((step): step is ToolStep => step.kind === "tool");
  const failures = toolSteps.filter((step) => step.error || failed(toolRuns.get(step.key))).length + (lookupFailed ? 1 : 0);
  const base = { columns: plan.columns, label: plan.label, failures };
  const chargeText = charged ? `${credits(charged)} charged` : "nothing was charged";
  // "Try again" made agents rerun a blocked source in a loop; a short wait is what actually helps.
  const unsure = toolSteps.some((step) => toolRuns.get(step.key)?.status === "reconciliation_needed");
  const nothing = failures ? `a data source was unavailable, so it failed and ${chargeText}; ${unsure ? "this exact request can run again in about an hour" : "wait a few minutes before rerunning"}` : `nothing matched and ${chargeText}`;

  if (plan.shape === "contacts") {
    const lookup = plan.steps.find((step): step is LookupStep => step.kind === "lookup");
    const urls = lookup?.urls ?? toolSteps.filter((step) => step.capability === "phone-pilot").map((step) => step.subject!);
    // People asked for by name whose profile search found no one, or failed.
    const unmatched = toolSteps.filter((step) => step.capability === "profile-finder" && !toolRuns.get(step.key)?.result?.rows.length)
      .map((step) => ({ name: step.about?.name ?? null, company: step.about?.company ?? null, status: step.error || failed(toolRuns.get(step.key)) ? "error" : "no_profile" }));
    const noProfile = unmatched.filter((row) => row.status === "no_profile").length;
    const searchFailed = unmatched.length - noProfile;
    const unmatchedText = [
      noProfile ? `${counted(noProfile, "people")} had no LinkedIn match` : "",
      searchFailed ? `${searchFailed} profile ${searchFailed === 1 ? "search" : "searches"} failed, so retry ${searchFailed === 1 ? "it" : "them"}` : "",
    ].filter(Boolean).join("; ");
    const bySubject = (capability: string, subject: string) => {
      const step = toolSteps.find((s) => s.capability === capability && s.subject === subject);
      return step ? toolRuns.get(step.key)?.result?.rows[0] ?? null : null;
    };
    const contactRows = urls.map((url) => {
      const line = lines?.get(url);
      const known = plan.people?.[url];
      const phone = plan.phones ? bySubject("phone-pilot", url) : null;
      const skip = skipped.get(url);
      const email = skip ? null : line?.email ?? null;
      const verdict = email && line ? mailboxVerdict(plan, toolRuns, line) : null;
      return {
        name: line?.name ?? known?.name ?? null, title: line?.title ?? known?.title ?? null,
        ...(plan.emails ? { email, verdict } : {}),
        ...(plan.phones ? { phone: phone?.phone ?? null, type: phone?.type ?? null } : {}),
        // People asked for by name keep the company they were asked with, next to the profile found.
        ...(plan.named ? { company: plan.named.companyOf?.[url] ?? null } : {}),
        url, status: email || phone?.phone ? "found" : line?.status === "error" || skip === "unpaid" ? "error" : "not_found",
      };
    });
    const rows: Record<string, unknown>[] = [...contactRows, ...unmatched.map((person) => ({
      name: person.name, title: null, ...(plan.emails ? { email: null, verdict: null } : {}), ...(plan.phones ? { phone: null, type: null } : {}),
      company: person.company, url: null, status: person.status,
    }))];
    const skips = (reason: Skip) => [...skipped.values()].filter((value) => value === reason).length;
    const company = Object.values(plan.people ?? {}).find((person) => person.company)?.company;
    const skipText = [
      skips("other_company") ? `${counted(skips("other_company"), "emails")} at a different company than ${company ?? "the list"} skipped free` : "",
      skips("invalid") ? `${skips("invalid")} invalid ${skips("invalid") === 1 ? "mailbox" : "mailboxes"} skipped free` : "",
      skips("unpaid") ? `${counted(skips("unpaid"), "emails")} not returned because the balance ran out` : "",
    ].filter(Boolean).join("; ");
    const found = contactRows.filter((row) => row.status === "found");
    // Name the people whose lookup errored so a genuine miss never reads as a failure, and the retry is targeted.
    const errored = contactRows.filter((row) => row.status === "error").map((row) => row.name ?? row.url.replace(/^.*\/in\//, "").replace(/\/$/, ""));
    const retry = errored.length === 1 ? "it" : "them";
    const failedText = `${errored.length > 3 ? `${errored.length} lookups` : errored.length > 1 ? `${errored.slice(0, -1).join(", ")} and ${errored.at(-1)}` : errored[0]} failed${charged ? ` after ${credits(charged)} charged` : " free"}, so retry ${retry}`;
    if (!found.length) {
      const missed = contactRows.filter((row) => row.status === "not_found").length;
      const outcome = errored.length
        ? `: ${missed ? `${missed} had no email; ` : ""}${failedText}`
        : `; ${unmatchedText ? `${unmatchedText}, ` : ""}${nothing}`;
      return { ...base, rows: [], summary: `No contacts found for ${plan.hint}${skipText ? ` (${skipText})` : ""}${outcome}.`, next: { tool: "gtm_results", args: { run_id: run.id, format: "csv" } } };
    }
    const emails = contactRows.filter((row) => "email" in row && row.email);
    const verdicts = (v: string) => emails.filter((row) => (row as { verdict?: string }).verdict === v).length;
    const phones = contactRows.filter((row) => "phone" in row && row.phone).length;
    const parts = [
      ...(plan.emails ? [`${emails.length} of ${rows.length} emails`] : []),
      ...(plan.phones ? [`${phones} of ${rows.length} mobiles`] : []),
    ];
    const verdictCounts = plan.emails ? [["deliverable", verdicts("deliverable")], ["invalid", verdicts("invalid")]].filter(([, n]) => n).map(([v, n]) => `${n} ${v}`).join(", ") : "";
    const verdictText = verdictCounts ? `: ${verdictCounts}` : "";
    return { ...base, rows, summary: `Found ${parts.join(" and ")}${verdictText}${skipText ? `; ${skipText}` : ""}${unmatchedText ? `; ${unmatchedText}` : ""}${errored.length ? `; ${failedText}` : failures ? `; ${failures} failed${charged ? ` after ${credits(charged)} charged` : " free"}` : ""}.`, next: { tool: "gtm_results", args: { run_id: run.id, format: "csv" } } };
  }

  if (plan.shape === "research") {
    const company = toolRuns.get("company")?.result?.rows[0] ?? null;
    const brief = toolRuns.get("brief")?.result?.rows[0] ?? null;
    if (!company && !brief) return { ...base, rows: [], summary: `No company details found for ${plan.hint}; ${nothing}.`, next: { tool: "gtm_results", args: { run_id: run.id, format: "csv" } } };
    const row = {
      name: company?.name ?? brief?.company ?? null, domain: company?.domain ?? plan.hint, industry: company?.industry ?? null, employees: company?.employees ?? null,
      country: company?.country ?? null, about: company?.about ?? null, whatTheyDo: brief?.whatTheyDo ?? null, sellsTo: brief?.sellsTo ?? null,
      products: brief?.products ?? null, customers: brief?.customers ?? null, pricing: brief?.pricing ?? null, linkedin: company?.url ?? null, website: brief?.url ?? null,
    };
    const what = brief?.whatTheyDo ?? company?.industry ?? "company details found";
    const missing = [!company ? "company details" : "", !brief ? "website brief" : ""].filter(Boolean);
    return {
      ...base, failures: failures + (missing.length ? 1 : 0), rows: [row], summary: `${String(row.name ?? plan.hint)}: ${String(what).trim().replace(/[.!?]+$/, "")}${missing.length ? `; partial research because ${missing.join(" and ")} unavailable` : ""}.`,
      next: { tool: "gtm_build_list", args: { company: plan.hint, titles: ["Head of Sales"], max_credits: CAPABILITIES.icp.price.credits } },
    };
  }

  if (plan.shape === "batch") {
    const rows = toolSteps.map((step) => {
      const toolRun = toolRuns.get(step.key);
      const row = toolRun?.result?.rows[0];
      // Profile batches keep the URL asked about; name batches keep the found profile URL.
      const about = step.about ?? { url: step.subject ?? "" };
      if (row) return { ...row, ...(about.url ? { url: about.url } : {}), status: "found" };
      return { ...about, status: step.error || failed(toolRun) ? "error" : "not_found" };
    });
    const found = rows.filter((row) => row.status === "found").length;
    const missed = rows.filter((row) => row.status === "not_found").length;
    const errored = rows.length - found - missed;
    const parts = [
      missed ? `${missed} had none` : "",
      errored ? `${errored} failed${charged ? "" : " free"}, so retry ${errored === 1 ? "it" : "them"}` : "",
    ].filter(Boolean).join("; ");
    return {
      ...base, rows: found ? rows : [],
      summary: found
        ? `Found ${found} of ${counted(rows.length, plan.label)}${parts ? `; ${parts}` : ""}; ${chargeText}.`
        : `No ${plan.label} for ${plan.hint}; ${errored ? `${parts}; ${chargeText}` : nothing}.`,
      next: { tool: "gtm_results", args: { run_id: run.id, format: "csv" } },
    };
  }

  const main = toolRuns.get("main");
  // An explicit mailbox check keeps its real verdict, including risky, in the one verdict vocabulary.
  const rows = (main?.result?.rows ?? []).map((row) => plan.capability === "verify-email"
    ? { ...row, verdict: reconcileVerdict([{ source: "mailbox", status: String(row.verdict ?? "") }]).verdict }
    : row);
  const noun = plan.label;
  if (!rows.length) return { ...base, rows: [], summary: `No ${noun} for ${plan.hint}; ${nothing}.`, next: { tool: "gtm_results", args: { run_id: run.id, format: "csv" } } };
  const people = plan.capability === "people-search" || plan.capability === "icp";
  return {
    ...base, rows,
    summary: `Found ${counted(rows.length, noun)} for ${plan.hint}.`,
    // Finding emails is the next step; mailbox checks are a separate paid choice the caller adds with verify. Budgeted at the real per-person quote so following it is never refused.
    next: people ? { tool: "gtm_find_contacts", args: { run_id: run.id, max_credits: rows.length * CAPABILITIES["email-finder"].price.credits } } : { tool: "gtm_results", args: { run_id: run.id, format: "csv" } },
  };
}
