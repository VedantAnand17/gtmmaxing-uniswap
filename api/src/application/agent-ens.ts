import { AGENT_ENS_RECORD_KEY } from "@found/contracts";
import type { AgentRecord, AgentStore } from "../store/agents.js";

/** Default mainnet endpoints; ETH_RPC_URL takes precedence. */
const PUBLIC_RPC_URLS = ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"];
/** How long a confirmed record answers before the chain is read again. */
export const ENS_FRESH_MS = 30_000;
/** How long the last confirmed answer stands while the chain cannot be read. */
export const ENS_OUTAGE_GRACE_MS = 60 * 60_000;

/** The chain could not be read, which says nothing about the record. */
export class EnsUnavailableError extends Error {}

export interface EnsReader {
  /** The text record, or null when the name or record does not exist. Throws EnsUnavailableError when the chain cannot answer. */
  text(name: string, key: string): Promise<string | null>;
}

/**
 * Reads through the ENS Universal Resolver, which walks the ENSv2 registries
 * and falls back to ENSv1 for names that have not migrated. viem loads only
 * when a linked name is actually read.
 */
export function createEnsReader(rpcUrl?: string): EnsReader {
  return {
    async text(name, key) {
      const [{ ContractFunctionRevertedError, createPublicClient, fallback, http }, { mainnet }] = await Promise.all([import("viem"), import("viem/chains")]);
      const urls = rpcUrl ? [rpcUrl] : PUBLIC_RPC_URLS;
      const client = createPublicClient({ chain: mainnet, transport: fallback(urls.map((url) => http(url, { timeout: 5_000, retryCount: 0 }))) });
      try {
        return await client.getEnsText({ name, key, strict: true });
      } catch (error) {
        // A revert is the chain answering: this name does not resolve. Anything else is a failed read.
        if (error instanceof Error && "walk" in error && (error as { walk(fn: (e: unknown) => boolean): unknown }).walk((e) => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) return null;
        throw new EnsUnavailableError(error instanceof Error ? error.message : "ens_read_failed");
      }
    },
  };
}

/** Valid ENS form with the standard normalization, or null. Names may be any dot-separated domain, not only .eth. */
export async function normalizeEnsName(input: string): Promise<string | null> {
  const { normalize } = await import("viem/ens");
  try {
    const name = normalize(input.trim());
    return name.includes(".") && !name.startsWith(".") && !name.endsWith(".") ? name : null;
  } catch {
    return null;
  }
}

export type AgentEnsStatus = "active" | "stopped" | "unknown";

/**
 * An owner links an agent to an ENS name by writing the agent's id into the
 * name's com.gtmmaxing.agent record, and clearing or changing that record
 * stops the agent's new spending. Anyone the name's resolver lets edit that
 * one record can stop the agent without a GTMMAXING login, and nobody else
 * can start one.
 */
export class AgentEnsGuard {
  constructor(private readonly deps: { agents: AgentStore; reader: EnsReader; now: () => number }) {}

  /** Current standing of a linked agent; null when it has no name. */
  async status(agent: AgentRecord): Promise<AgentEnsStatus | null> {
    if (!agent.ensName) return null;
    const now = this.deps.now();
    const known = agent.ensStoppedAt === null ? "active" as const : "stopped" as const;
    const checkedAt = agent.ensCheckedAt ?? 0;
    if (now - checkedAt < ENS_FRESH_MS) return known;
    let value: string | null;
    try {
      value = await this.deps.reader.text(agent.ensName, AGENT_ENS_RECORD_KEY);
    } catch (error) {
      if (!(error instanceof EnsUnavailableError)) throw error;
      return now - checkedAt <= ENS_OUTAGE_GRACE_MS ? known : "unknown";
    }
    const matches = value === agent.id;
    await this.deps.agents.recordEnsCheck(agent.id, { checkedAt: now, stoppedAt: matches ? null : agent.ensStoppedAt ?? now });
    return matches ? "active" : "stopped";
  }
}
