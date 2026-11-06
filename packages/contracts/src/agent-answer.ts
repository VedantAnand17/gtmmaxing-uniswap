import { z } from "zod";

/**
 * One answer shape for every agent surface: a speakable one-sentence summary,
 * at most five preview rows, a run handle, cost, balance and a suggested next
 * step, under 1 KB as structured JSON and as TOON-style text. Full rows stay
 * on the server (gtm_results pages them and links a CSV).
 */
export const AGENT_ANSWER_MAX_BYTES = 1024;
export const AGENT_PREVIEW_ROWS = 5;
const SUMMARY_MAX_WORDS = 24;
const SUMMARY_MAX_CHARS = 200;

export const agentAnswerStatusSchema = z.enum(["completed", "not_found", "running", "refused", "quote", "error"]);
export const agentCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const agentNextSchema = z.object({ tool: z.string().max(40), args: z.record(z.string(), z.unknown()) }).strict();

export const agentAnswerSchema = z.object({
  status: agentAnswerStatusSchema,
  summary: z.string().min(1).max(SUMMARY_MAX_CHARS),
  /** Machine-readable refusal or error reason, e.g. over_agent_cap. */
  reason: z.string().max(40).optional(),
  run_id: z.string().max(64).nullable(),
  /** Credits this call charged. Replays, results, quotes and refusals cost 0. */
  cost: z.number().int().nonnegative(),
  /** Credits the run has charged in total, when it differs from this call's cost. */
  run_cost: z.number().int().nonnegative().optional(),
  /** Whole credits left on the account, when known. */
  balance: z.number().int().nonnegative().nullable(),
  /** Most credits the request could cost. */
  quote: z.number().int().nonnegative().optional(),
  /** Rows kept on the server for this run. */
  total: z.number().int().nonnegative(),
  label: z.string().min(1).max(24),
  columns: z.array(z.string().max(32)).max(6),
  rows: z.array(z.array(agentCellSchema)).max(AGENT_PREVIEW_ROWS),
  next: agentNextSchema,
  /** Refusals: the fields the call does accept. */
  fields: z.array(z.string().max(40)).max(12).optional(),
  /** Download link, e.g. a run's CSV. */
  link: z.string().max(512).optional(),
  /** Out of credits, and the owner lets this agent pay from its own wallet: where to buy them, and how many it needs. */
  top_up: z.object({ url: z.string().max(256), credits: z.number().int().positive() }).optional(),
  replayed: z.literal(true).optional(),
}).strict();

/** The answer shape as JSON Schema, for generated docs and client types. */
export function agentAnswerJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(agentAnswerSchema) as Record<string, unknown>;
  return schema;
}

export type AgentAnswerStatus = z.infer<typeof agentAnswerStatusSchema>;
export type AgentCell = z.infer<typeof agentCellSchema>;
export type AgentNext = z.infer<typeof agentNextSchema>;
export type AgentAnswer = z.infer<typeof agentAnswerSchema>;

export interface AgentAnswerDraft {
  status: AgentAnswerStatus;
  summary: string;
  reason?: string;
  label?: string;
  /** Preview columns; defaults to the first row's keys. */
  columns?: readonly string[];
  /** Full rows; only a preview is kept. */
  rows?: readonly Record<string, unknown>[];
  total?: number;
  run_id?: string | null;
  cost?: number;
  run_cost?: number;
  balance?: number | null;
  quote?: number;
  next: AgentNext;
  fields?: readonly string[];
  link?: string;
  top_up?: { url: string; credits: number };
  replayed?: boolean;
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;
const DEFAULT_NEXT: AgentNext = { tool: "gtm_account", args: {} };

/** One plain sentence under 25 words, safe to read aloud. */
export function speakable(value: string): string {
  // Markdown marks go; underscores stay because field names like max_credits must survive.
  // A shortened phrase inside a sentence template must not end in "…." either.
  const plain = value.replace(/[*`#>|~]/g, "").replace(/\s+/g, " ").replace(/…[.!?]+/g, "…").trim();
  const first = plain.match(/^.*?(?:[.!?…](?=\s|$)|$)/)?.[0].trim() ?? plain;
  const words = first.split(" ").filter(Boolean);
  let sentence = words.length > SUMMARY_MAX_WORDS ? `${words.slice(0, SUMMARY_MAX_WORDS - 1).join(" ")}…` : words.join(" ");
  if (sentence.length > SUMMARY_MAX_CHARS) sentence = `${sentence.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  if (!sentence) return "Done.";
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
}

function cell(value: unknown, max: number): AgentCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const flat = (typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}

function build(draft: AgentAnswerDraft, rowCount: number, columnCount: number, cellMax: number): AgentAnswer {
  const allColumns = (draft.columns ?? Object.keys(draft.rows?.[0] ?? {})).slice(0, 6);
  const columns = allColumns.slice(0, columnCount);
  const rows = (draft.rows ?? []).slice(0, rowCount).map((row) => columns.map((column) => cell(row[column], cellMax)));
  return {
    status: draft.status,
    summary: speakable(draft.summary),
    ...(draft.reason ? { reason: draft.reason.slice(0, 40) } : {}),
    run_id: draft.run_id ?? null,
    cost: draft.cost ?? 0,
    ...(draft.run_cost !== undefined && draft.run_cost !== (draft.cost ?? 0) ? { run_cost: draft.run_cost } : {}),
    balance: draft.balance ?? null,
    ...(draft.quote !== undefined ? { quote: draft.quote } : {}),
    total: draft.total ?? draft.rows?.length ?? 0,
    label: (draft.label ?? "rows").slice(0, 24),
    columns: rows.length ? columns : [],
    rows,
    next: draft.next ?? DEFAULT_NEXT,
    ...(draft.fields?.length ? { fields: draft.fields.slice(0, 12).map((field) => field.slice(0, 40)) } : {}),
    ...(draft.link ? { link: draft.link } : {}),
    ...(draft.top_up ? { top_up: draft.top_up } : {}),
    ...(draft.replayed ? { replayed: true as const } : {}),
  };
}

const fits = (answer: AgentAnswer) =>
  byteLength(JSON.stringify(answer)) <= AGENT_ANSWER_MAX_BYTES && byteLength(answerText(answer)) <= AGENT_ANSWER_MAX_BYTES;

/** Builds the answer, shortening cells, then dropping rows, then columns until both forms fit in 1 KB. */
export function shapeAnswer(draft: AgentAnswerDraft): AgentAnswer {
  const columnCount = Math.min(6, (draft.columns ?? Object.keys(draft.rows?.[0] ?? {})).length);
  const next = draft.next ?? DEFAULT_NEXT;
  for (let rowCount = AGENT_PREVIEW_ROWS; rowCount >= 1; rowCount -= 1) {
    for (const cellMax of [48, 32, 24, 16]) {
      const answer = build(draft, rowCount, columnCount, cellMax);
      if (fits(answer)) return answer;
    }
  }
  for (let columns = columnCount - 1; columns >= 1; columns -= 1) {
    const answer = build(draft, 1, columns, 16);
    if (fits(answer)) return answer;
  }
  const bare = build({ ...draft, rows: [], next: byteLength(JSON.stringify(next)) < 200 ? next : DEFAULT_NEXT }, 0, 0, 16);
  if (fits(bare)) return bare;
  return build({ ...draft, rows: [], next: DEFAULT_NEXT, fields: [], summary: draft.summary.slice(0, 120) }, 0, 0, 16);
}

/* TOON-style text: key: value lines and one tabular array of preview rows. */

const NEEDS_QUOTES = /^$|^\s|\s$|[,"\\:\n[\]{}]|^-|^(?:true|false|null)$|^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
function toonCell(value: AgentCell): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  return NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value;
}

/** Text form of an answer for models; the same data as the structured form. */
export function answerText(answer: AgentAnswer): string {
  const lines = [`summary: ${answer.summary}`, `status: ${answer.status}`];
  if (answer.reason) lines.push(`reason: ${answer.reason}`);
  if (answer.run_id) lines.push(`run_id: ${answer.run_id}`);
  lines.push(`cost: ${answer.cost}`);
  if (answer.run_cost !== undefined) lines.push(`run_cost: ${answer.run_cost}`);
  if (answer.balance !== null) lines.push(`balance: ${answer.balance}`);
  if (answer.quote !== undefined) lines.push(`quote: ${answer.quote}`);
  if (answer.replayed) lines.push("replayed: true");
  if (answer.total || answer.rows.length) lines.push(`total: ${answer.total}`);
  if (answer.rows.length) {
    lines.push(`${answer.label}[${answer.rows.length}]{${answer.columns.join(",")}}:`);
    for (const row of answer.rows) lines.push(`  ${row.map(toonCell).join(",")}`);
  }
  if (answer.fields?.length) lines.push(`fields[${answer.fields.length}]: ${answer.fields.join(",")}`);
  if (answer.link) lines.push(`link: ${answer.link}`);
  if (answer.top_up) lines.push(`top_up: ${answer.top_up.credits} credits at ${answer.top_up.url}`);
  if (answer.next) lines.push(`next: ${answer.next.tool}(${JSON.stringify(answer.next.args)})`);
  return lines.join("\n");
}
