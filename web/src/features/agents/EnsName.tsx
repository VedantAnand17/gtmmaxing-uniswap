import { useId, useState } from "react";
import type { AgentSummary } from "@found/contracts";
import { useAgentMutations } from "./agentQueries";
import { AgentEnsMismatchError } from "./agentsClient";

const STATUS: Record<NonNullable<AgentSummary["ens"]>["status"], { label: string; hint: string }> = {
  active: { label: "Active", hint: "This agent can spend while the name’s record names it. Clear the record from any wallet allowed to edit it, and new spending stops." },
  stopped: { label: "Stopped onchain", hint: "The name’s record no longer names this agent, so it can’t start paid work. Set the record again to resume it." },
  unknown: { label: "Can’t confirm", hint: "Ethereum can’t be read right now, so this agent can’t start paid work until the record is confirmed." },
};

/** Links the agent to an ENS name its owner controls, so that name's record decides whether the agent may spend. */
export function EnsName({ agent, email }: { agent: AgentSummary; email: string }) {
  const id = useId();
  const { linkEns, unlinkEns } = useAgentMutations(email);
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);

  if (agent.ens) {
    const status = STATUS[agent.ens.status];
    return (
      <div className="agent-ens">
        <div className="agent-switch-row agent-ens-row">
          <div>
            <p className="agent-switch-label">ENS name <code>{agent.ens.name}</code></p>
            <p className="agent-hint">{status.hint}</p>
          </div>
          <span className={`agent-ens-status agent-ens-status-${agent.ens.status}`}>{status.label}</span>
        </div>
        <button type="button" className="workspace-button workspace-button-ghost workspace-button-sm" disabled={unlinkEns.isPending} onClick={() => unlinkEns.mutate(agent.id)}>
          {unlinkEns.isPending ? "Unlinking…" : "Unlink name"}
        </button>
        {unlinkEns.isError && <p role="alert" className="agent-error">That didn’t save. Please try again.</p>}
      </div>
    );
  }

  const needed = linkEns.error instanceof AgentEnsMismatchError ? linkEns.error.needed : null;
  const copy = () => {
    if (!needed) return;
    void navigator.clipboard.writeText(needed.value).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className="agent-ens">
      <form className="agent-ens-form" noValidate onSubmit={(event) => { event.preventDefault(); if (name.trim()) linkEns.mutate({ id: agent.id, name: name.trim() }); }}>
        <div className="agent-ens-field">
          <label htmlFor={`${id}-ens`} className="agent-switch-label">ENS name</label>
          <p className="agent-hint">Give this agent a public name, and stop its spending from your wallet.</p>
          <input id={`${id}-ens`} value={name} placeholder="research.yourname.eth" autoComplete="off" spellCheck={false} disabled={linkEns.isPending} onChange={(event) => { setName(event.target.value); linkEns.reset(); setCopied(false); }} />
        </div>
        <button type="submit" className="workspace-button workspace-button-secondary workspace-button-sm" disabled={linkEns.isPending || !name.trim()}>{linkEns.isPending ? "Checking…" : "Link name"}</button>
      </form>
      {needed && (
        <div role="alert" className="agent-ens-needed">
          <p>Add this text record to <strong>{needed.name}</strong>, then link it again:</p>
          <dl>
            <div><dt>Key</dt><dd><code>{needed.key}</code></dd></div>
            <div><dt>Value</dt><dd><code>{needed.value}</code></dd></div>
          </dl>
          <div className="agent-actions">
            <button type="button" className="workspace-button workspace-button-ghost workspace-button-sm" onClick={copy}>{copied ? "Copied" : "Copy value"}</button>
            <a className="workspace-button workspace-button-ghost workspace-button-sm" href={`https://app.ens.domains/${encodeURIComponent(needed.name)}`} target="_blank" rel="noreferrer">Open in ENS</a>
          </div>
        </div>
      )}
      {linkEns.isError && !needed && <p role="alert" className="agent-error">{linkEns.error && "status" in linkEns.error && linkEns.error.status === 400 ? "That isn’t a valid ENS name." : "Couldn’t check that name. Please try again."}</p>}
    </div>
  );
}
