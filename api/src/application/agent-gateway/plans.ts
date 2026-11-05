import {
  CAPABILITIES,
  MAX_BATCH_PEOPLE,
  linkedinProfileUrl,
  buildListInput,
  findContactsInput,
  findSignalsInput,
  parseAgentInput,
  researchCompanyInput,
  toolRequestFor,
  type AgentInputResult,
  type AgentNext,
  type CapabilityId,
  type OutcomeToolName,
  type ToolId,
  type ToolRequest,
} from "@found/contracts";
import { toLookupKey } from "../../domain/normalize.js";
import type { LookupKey } from "../../domain/types.js";

/** One job on an existing engine. Keys are relative to the agent run id. */
export interface ToolStep {
  kind: "tool";
  key: string;
  capability: ToolId;
  request: ToolRequest;
  /** Person URL or email the step is about. */
  subject?: string;
  /** What the caller gave for this person, kept on their row: a profile URL, or a name and company. */
  about?: Record<string, string>;
  runId?: string;
  error?: string;
  cacheOnly?: boolean;
}
export interface LookupStep {
  kind: "lookup";
  tenantId: string;
  urls: string[];
  cacheOnlyHashes?: string[];
  /**
   * Emails are charged when the run finishes, only for those that passed the
   * company and mailbox checks. Absent on plans stored before 2026-10-23,
   * whose lookup job charged each email as it was found.
   */
  chargeAfterChecks?: boolean;
}

/** What the list run said about a person, keyed by profile URL. */
export interface PersonContext {
  name: string | null;
  title: string | null;
  /** The company domain the list was asked for; their email must be at it. */
  company: string | null;
}
export type PlanStep = ToolStep | LookupStep;

export interface AgentPlan {
  v: 1;
  /** "batch": one job per person, one row each, in the order asked. */
  shape: "rows" | "contacts" | "research" | "batch";
  capability: CapabilityId;
  label: string;
  columns: string[];
  /** A few words describing the request, for summaries. */
  hint: string;
  steps: PlanStep[];
  emails: boolean;
  phones: boolean;
  verify: boolean;
  verifyPlanned: boolean;
  cacheOnlyVerifications?: string[];
  people?: Record<string, PersonContext>;
  /**
   * Contacts asked for by name: the plan starts with a profile-finder step per person, and the
   * email lookup (and phones) for the profiles found are added once every one has finished.
   */
  named?: { tenantId: string; resolved: boolean; deferredQuote: number; companyOf?: Record<string, string> };
}

export interface Refusal { reason: string; summary: string; fields?: string[]; quote?: number; next?: AgentNext }
export interface CommonArgs { maxCredits?: number | undefined; idempotencyKey?: string | undefined; dryRun: boolean }
export type Planned = { ok: true; plan: AgentPlan; common: CommonArgs; canonical: unknown } | { ok: false; refusal: Refusal };

export interface PlanContext {
  tenantId: string;
  cacheNamespace: string;
  /** Rows of an earlier run on this account and the company it was asked for, or null. */
  runRows(runId: string): Promise<{ rows: Record<string, unknown>[]; company: string | null } | null>;
}

const COMMON = new Set(["max_credits", "idempotency_key", "dry_run"]);
const MAX_PEOPLE = 100;

const words = (list: readonly string[]) => list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
const short = (value: string, max = 40) => value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

export function refuse(refusal: Refusal): Planned { return { ok: false, refusal }; }

/** Turns a rejected input into "nothing was sent" with the fields the tool does accept. */
export function inputRefusal(result: Extract<AgentInputResult<unknown>, { ok: false }>): Refusal {
  const filters = result.fields.filter((field) => !COMMON.has(field));
  if (result.unsupported.length) {
    const verb = result.unsupported.length > 1 ? "are not filters" : "is not a filter";
    return { reason: "unsupported_filter", summary: `Nothing was sent: ${words(result.unsupported)} ${verb} this tool can apply; use ${words(filters)}.`, fields: result.fields };
  }
  const issue = result.invalid[0] ?? { field: "input", message: "invalid" };
  return { reason: "invalid_input", summary: `Nothing was sent: ${issue.field} is invalid (${issue.message.replace(/\.$/, "")}).`, fields: result.fields };
}

function common(data: { max_credits?: number | undefined; idempotency_key?: string | undefined; dry_run?: boolean | undefined }): CommonArgs {
  return { maxCredits: data.max_credits, idempotencyKey: data.idempotency_key, dryRun: data.dry_run === true };
}

/** The request without the budget and replay controls, which do not change what runs. */
function canonicalOf(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key, value]) => !COMMON.has(key) && value !== undefined));
}

function plan(capability: CapabilityId, steps: PlanStep[], hint: string, overrides: Partial<AgentPlan> = {}): AgentPlan {
  const definition = CAPABILITIES[capability];
  return {
    v: 1, shape: "rows", capability, label: definition.noun, columns: [...definition.preview], hint: short(hint, 64), steps,
    emails: false, phones: false, verify: false, verifyPlanned: false, ...overrides,
  };
}

/** A single job: the outcome tool's whole answer is that job's rows. */
export function singleTool(id: ToolId, input: unknown, args: CommonArgs, canonical: unknown, hint: string): Planned {
  const request = toolRequestFor(id, input);
  if (!request.ok) return refuse(inputRefusal(request));
  return { ok: true, plan: plan(id, [{ kind: "tool", key: "main", capability: id, request: request.request }], hint), common: args, canonical };
}

/**
 * One job per person for a capability that takes `people` in place of its single-person fields:
 * LinkedIn profiles (`profile`), or {name, company} pairs (`name` and `company`).
 */
export function planBatch(id: ToolId, input: Record<string, unknown>, args: CommonArgs, canonicalBase: Record<string, unknown>): Planned {
  const { people, profile, name, company, ...shared } = input;
  const fields = Object.keys(CAPABILITIES[id].input.shape);
  if (profile !== undefined || name !== undefined || company !== undefined) return refuse({ reason: "invalid_input", summary: `Nothing was sent: give either ${profile !== undefined ? "profile" : "name and company"} or people, not both.`, fields });
  if (!Array.isArray(people) || !people.length) return refuse({ reason: "invalid_input", summary: "Nothing was sent: people must list at least one person.", fields });
  if (people.length > MAX_BATCH_PEOPLE) return refuse({ reason: "too_many_people", summary: `Nothing was sent: split this into batches of at most ${MAX_BATCH_PEOPLE} people.`, fields: ["people"] });
  // A person is a profile URL or handle, or a {name, company} pair; duplicates collapse.
  const items = new Map<string, { input: Record<string, unknown>; about: Record<string, string> }>();
  for (const person of people) {
    if (typeof person === "string") {
      const url = linkedinProfileUrl(person);
      items.set(url, { input: { profile: url }, about: { url } });
    } else {
      const pair = person as { name: string; company: string };
      const key = `${pair.name.trim().toLowerCase()}|${pair.company.trim().toLowerCase()}`;
      if (!items.has(key)) items.set(key, { input: { name: pair.name.trim(), company: pair.company.trim() }, about: { name: pair.name.trim(), company: pair.company.trim() } });
    }
  }
  const steps: PlanStep[] = [];
  let invalid = 0;
  for (const [index, item] of [...items.values()].entries()) {
    const request = toolRequestFor(id, { ...shared, ...item.input });
    if (!request.ok) { invalid += 1; continue; }
    steps.push({ kind: "tool", key: `person:${index}`, capability: id, request: request.request, subject: item.about.url ?? `${item.about.name} at ${item.about.company}`, about: item.about });
  }
  if (invalid) return refuse({ reason: "invalid_input", summary: `Nothing was sent: ${invalid} of the people ${invalid > 1 ? "are" : "is"} not ${"profile" in CAPABILITIES[id].input.shape ? "a LinkedIn profile URL or handle" : "a name with a company"}.`, fields: ["people"] });
  return {
    ok: true,
    plan: plan(id, steps, `${items.size} ${items.size === 1 ? "person" : "people"}`, { shape: "batch", columns: [...CAPABILITIES[id].preview, "status"] }),
    common: args,
    canonical: { ...canonicalBase, input: { ...shared, people: [...items.values()].map((item) => item.about.url ?? item.input) } },
  };
}

export function planBuildList(raw: unknown): Planned {
  const parsed = parseAgentInput(buildListInput, raw);
  if (!parsed.ok) return refuse(inputRefusal(parsed));
  const { titles, company, location, business_type: businessType, limit } = parsed.data;
  const args = common(parsed.data);
  const canonical = { tool: "gtm_build_list", ...canonicalOf(parsed.data) };
  const unsupported = (given: string[], fields: string[], mode: string): Planned => refuse({
    reason: "unsupported_filter",
    summary: `Nothing was sent: ${words(given)} ${given.length > 1 ? "are not filters" : "is not a filter"} for ${mode}; use ${words(fields)}.`,
    fields,
  });
  // Tools take titles comma-joined, so a comma inside one title would silently split it: "Founder, Lead Generation Agency" searched any founder.
  const joined = titles?.find((title) => title.includes(","));
  if (joined) return refuse({ reason: "invalid_input", summary: `Nothing was sent: "${short(joined)}" has a comma; give each job title separately.`, fields: ["titles"] });
  if (businessType) {
    const extra = [titles ? "titles" : "", company ? "company" : ""].filter(Boolean);
    if (extra.length) return unsupported(extra, ["business_type", "location", "limit"], "local businesses");
    if (!location) return refuse({ reason: "invalid_input", summary: "Nothing was sent: location is required for local businesses.", fields: ["business_type", "location", "limit"] });
    return singleTool("local-leads", { business_type: businessType, location, limit }, args, canonical, `${businessType} in ${location ?? ""}`);
  }
  if (company) {
    if (location) return unsupported(["location"], ["company", "titles", "limit"], "decision-makers at one company");
    return singleTool("icp", { company, titles, limit }, args, canonical, `${titles ? titles.join(", ") : "decision-makers"} at ${company}`);
  }
  // The hint is shortened to 40 characters, so name many titles by count rather than cutting one mid-word.
  const titleHint = titles && titles.length > 2 ? `${titles[0]} and ${titles.length - 1} other titles` : titles?.join(", ");
  if (titles) return singleTool("people-search", { titles, location, limit }, args, canonical, `${titleHint}${location ? ` in ${location}` : ""}`);
  return refuse({ reason: "invalid_input", summary: "Nothing was sent: give titles, a company domain, or a business_type with a location.", fields: ["titles", "company", "business_type", "location", "limit"] });
}

export function planResearchCompany(raw: unknown): Planned {
  const parsed = parseAgentInput(researchCompanyInput, raw);
  if (!parsed.ok) return refuse(inputRefusal(parsed));
  const domain = parsed.data.company;
  const company = toolRequestFor("company", { domain });
  if (!company.ok) return refuse(inputRefusal({ ...company, invalid: company.invalid.map((issue) => ({ ...issue, field: "company" })), fields: Object.keys(researchCompanyInput.shape) }));
  const brief = toolRequestFor("website", { url: domain });
  if (!brief.ok) return refuse(inputRefusal({ ...brief, invalid: brief.invalid.map((issue) => ({ ...issue, field: "company" })), fields: Object.keys(researchCompanyInput.shape) }));
  const steps: PlanStep[] = [
    { kind: "tool", key: "company", capability: "company", request: company.request },
    { kind: "tool", key: "brief", capability: "website", request: brief.request },
  ];
  return {
    ok: true,
    plan: plan("company", steps, domain, { shape: "research", columns: ["name", "industry", "employees", "whatTheyDo"] }),
    common: common(parsed.data),
    canonical: { tool: "gtm_research_company", ...canonicalOf(parsed.data) },
  };
}

export function planFindSignals(raw: unknown): Planned {
  const parsed = parseAgentInput(findSignalsInput, raw);
  if (!parsed.ok) return refuse(inputRefusal(parsed));
  const { role, location, company, limit } = parsed.data;
  return singleTool("signals", { role, location, company, limit }, common(parsed.data), { tool: "gtm_find_signals", ...canonicalOf(parsed.data) },
    `${role}${location ? ` in ${location}` : ""}${company ? ` at ${company}` : ""}`);
}

const isProfile = (value: unknown): value is string => typeof value === "string" && /^https:\/\/(www\.)?linkedin\.com\/in\//.test(value);

/** Emails (lookup engine), mobiles and mailbox checks (job tools) for a set of people. */
export async function planContacts(raw: unknown, ctx: PlanContext, source: OutcomeToolName = "gtm_find_contacts"): Promise<Planned> {
  const parsed = parseAgentInput(findContactsInput, raw);
  if (!parsed.ok) return refuse(inputRefusal(parsed));
  const data = parsed.data;
  const fields = Object.keys(findContactsInput.shape);
  if ([data.people, data.run_id, data.named].filter((given) => given !== undefined).length !== 1) return refuse({ reason: "invalid_input", summary: "Nothing was sent: give one of people, named or a run_id from gtm_build_list.", fields });
  const find = data.find ?? ["email"];
  const emails = find.includes("email");
  const phones = find.includes("phone");
  if (data.verify && !emails) return refuse({ reason: "invalid_input", summary: "Nothing was sent: verify checks found emails, so include email in find.", fields });
  if (data.named) {
    // Profiles first, one charged profile-finder job per person; the contact steps follow for the profiles found.
    // Duplicates collapse onto the first spelling given.
    const unique = new Map<string, { name: string; company: string }>();
    for (const pair of data.named) {
      const key = `${pair.name.trim().toLowerCase()}|${pair.company.trim().toLowerCase()}`;
      if (!unique.has(key)) unique.set(key, { name: pair.name.trim(), company: pair.company.trim() });
    }
    const pairs = [...unique.values()];
    const steps: PlanStep[] = [];
    for (const [index, pair] of pairs.entries()) {
      const request = toolRequestFor("profile-finder", pair);
      if (!request.ok) return refuse({ reason: "invalid_input", summary: `Nothing was sent: "${short(pair.name)}" needs a name and a company.`, fields: ["named"] });
      steps.push({ kind: "tool", key: `find:${index}`, capability: "profile-finder", request: request.request, subject: `${pair.name} at ${pair.company}`, about: pair });
    }
    const perPerson = (emails ? CAPABILITIES["email-finder"].price.credits : 0) + (data.verify ? CAPABILITIES["verify-email"].price.credits : 0) + (phones ? CAPABILITIES["phone-pilot"].price.credits : 0);
    const columns = emails ? ["name", "email", "verdict", ...(phones ? ["phone"] : [])] : ["name", "phone", "type"];
    return {
      ok: true,
      plan: plan(emails ? "email-finder" : "phone-pilot", steps, `${pairs.length} ${pairs.length === 1 ? "person" : "people"}`, {
        shape: "contacts", label: "contacts", columns, emails, phones, verify: data.verify === true,
        named: { tenantId: ctx.tenantId, resolved: false, deferredQuote: pairs.length * perPerson },
      }),
      common: common(data),
      canonical: { tool: source, named: pairs, find: [...find].sort(), verify: data.verify === true },
    };
  }
  let people = data.people ?? [];
  const context = new Map<string, PersonContext>();
  if (data.run_id) {
    const source = await ctx.runRows(data.run_id);
    if (!source) return refuse({ reason: "run_not_found", summary: "Nothing was sent: no finished run with that id on this account.", fields: ["run_id"] });
    const rows = source.rows;
    for (const row of rows) {
      if (!isProfile(row.url)) continue;
      const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
      context.set(row.url, { name: text(row.name), title: text(row.title), company: source.company });
    }
    people = rows.map((row) => row.url).filter(isProfile);
    if (!people.length) return refuse({ reason: "no_profiles", summary: "Nothing was sent: that run has no LinkedIn profiles to enrich.", fields: ["people"] });
  }
  if (people.length > MAX_PEOPLE) return refuse({ reason: "too_many_people", summary: `Nothing was sent: split this into batches of at most ${MAX_PEOPLE} people.`, fields: ["people"] });
  const keys: LookupKey[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const person of people) {
    const key = await toLookupKey(person, ctx.cacheNamespace);
    if (!key) invalid += 1;
    else if (!seen.has(key.urlHash)) { seen.add(key.urlHash); keys.push(key); }
  }
  if (invalid) return refuse({ reason: "invalid_input", summary: `Nothing was sent: ${invalid} of the people ${invalid > 1 ? "are" : "is"} not a LinkedIn profile URL or handle.`, fields: ["people"] });
  const steps: PlanStep[] = [];
  if (emails) {
    steps.push({ kind: "lookup", tenantId: ctx.tenantId, urls: keys.map((key) => key.url), chargeAfterChecks: true });
  }
  const known: Record<string, PersonContext> = {};
  for (const [person, about] of context) {
    const key = await toLookupKey(person, ctx.cacheNamespace);
    if (key) known[key.url] = about;
  }
  if (phones) {
    keys.forEach((key, index) => {
      const request = toolRequestFor("phone-pilot", { profile: key.url });
      if (request.ok) steps.push({ kind: "tool", key: `phone:${index}`, capability: "phone-pilot", request: request.request, subject: key.url });
    });
  }
  const columns = emails ? ["name", "email", "verdict", ...(phones ? ["phone"] : [])] : ["url", "phone", "type"];
  return {
    ok: true,
    plan: plan(emails ? "email-finder" : "phone-pilot", steps, `${keys.length} ${keys.length === 1 ? "person" : "people"}`, {
      shape: "contacts", label: "contacts", columns, emails, phones, verify: data.verify === true,
      ...(Object.keys(known).length ? { people: known } : {}),
    }),
    common: common(data),
    canonical: { tool: source, people: keys.map((key) => key.url), find: [...find].sort(), verify: data.verify === true },
  };
}
