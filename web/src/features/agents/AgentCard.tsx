import { useId, useState } from "react";
import type { AgentSummary, CapPeriod } from "@found/contracts";
import { useAgentMutations } from "./agentQueries";
import { CapFields } from "./CapFields";
import { EnsName } from "./EnsName";
import { FirstTask } from "./TaskPrompts";
import { credits, KIND_LABEL, lastUsed, MAX_CAP, parseCap, PERIOD_LABEL, PERIOD_WINDOW } from "./format";

/**
 * One connected agent: what it is, when it last ran, what it spent against
 * its cap, whether it may use code mode, and a confirmed way to cut it off.
 */
export function AgentCard({ agent, email }: { agent: AgentSummary; email: string }) {
  const id = useId();
  const { update, revoke } = useAgentMutations(email);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(agent.credit_cap));
  const [period, setPeriod] = useState<CapPeriod>(agent.cap_period);
  const [capError, setCapError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const used = Math.min(100, (agent.spent / agent.credit_cap) * 100);
  const removeLabel = agent.kind === "token" ? "Revoke" : "Disconnect";
  const busy = update.isPending || revoke.isPending;

  const startEditing = () => {
    setAmount(String(agent.credit_cap));
    setPeriod(agent.cap_period);
    setCapError(null);
    setEditing(true);
  };
  const saveCap = () => {
    const cap = parseCap(amount);
    if (cap === null) {
      setCapError(`Enter a cap from 1 to ${MAX_CAP.toLocaleString("en-US")} credits.`);
      return;
    }
    update.mutate({ id: agent.id, patch: { credit_cap: cap, cap_period: period } }, { onSuccess: () => setEditing(false) });
  };

  return (
    <article className="agent-card" aria-labelledby={`${id}-name`}>
      <header className="agent-card-head">
        <div className="agent-card-title">
          <h3 id={`${id}-name`}>{agent.name}</h3>
          <p>
            <span className="agent-kind">{KIND_LABEL[agent.kind]}</span>
            {agent.client && <span className="agent-client">{agent.client}</span>}
          </p>
        </div>
        <p className="agent-last-used">{lastUsed(agent.last_used_at)}</p>
      </header>

      <div className="agent-card-body">
        {agent.last_used_at === null && agent.kind !== "token" && <FirstTask lead={`${agent.name} is connected but hasn’t run anything yet. Try pasting this into it:`} />}
        <div className="agent-spend">
          <p>{`${agent.spent.toLocaleString("en-US")} of ${credits(agent.credit_cap)} used ${PERIOD_WINDOW[agent.cap_period]}`}</p>
          <div className="metric-meter" aria-hidden="true"><div style={{ width: `${used}%` }} /></div>
        </div>

        {editing ? (
          <form className="agent-cap-editor" noValidate onSubmit={(event) => { event.preventDefault(); saveCap(); }}>
            <CapFields id={`${id}-cap`} amount={amount} period={period} onAmount={(value) => { setAmount(value); setCapError(null); }} onPeriod={setPeriod} invalid={capError !== null} disabled={update.isPending} />
            <div className="agent-actions">
              <button type="submit" className="workspace-button workspace-button-sm" disabled={update.isPending}>{update.isPending ? "Saving…" : "Save cap"}</button>
              <button type="button" className="workspace-button workspace-button-ghost workspace-button-sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
            {capError && <p role="alert" className="agent-error">{capError}</p>}
          </form>
        ) : (
          <div className="agent-cap-row">
            <p>Cap <strong>{credits(agent.credit_cap)} {PERIOD_LABEL[agent.cap_period]}</strong></p>
            <button type="button" className="workspace-button workspace-button-secondary workspace-button-sm" onClick={startEditing} disabled={busy}>Change cap</button>
          </div>
        )}

        <div className="agent-switch-row">
          <div>
            <p id={`${id}-execute`} className="agent-switch-label">Code mode <code>gtm_execute</code></p>
            <p id={`${id}-execute-hint`} className="agent-hint">Lets this agent run code that calls GTMMAXING tools. Each run still stops at its credit limit.</p>
          </div>
          <button
            type="button"
            role="switch"
            className="agent-switch"
            aria-checked={agent.allow_execute}
            aria-labelledby={`${id}-execute`}
            aria-describedby={`${id}-execute-hint`}
            disabled={busy}
            onClick={() => update.mutate({ id: agent.id, patch: { allow_execute: !agent.allow_execute } })}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <EnsName agent={agent} email={email} />
        <div className="agent-switch-row">
          <div>
            <p id={`${id}-topup`} className="agent-switch-label">Buy credits from its own wallet</p>
            <p id={`${id}-topup-hint`} className="agent-hint">Lets this agent pay through Uniswap when it runs out, up to $50 a payment. It still stops at its credit limit.</p>
          </div>
          <button
            type="button"
            role="switch"
            className="agent-switch"
            aria-checked={agent.allow_topup}
            aria-labelledby={`${id}-topup`}
            aria-describedby={`${id}-topup-hint`}
            disabled={busy}
            onClick={() => update.mutate({ id: agent.id, patch: { allow_topup: !agent.allow_topup } })}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        {update.isError && !editing && <p role="alert" className="agent-error">That change didn’t save. Please try again.</p>}
      </div>

      <footer className="agent-card-foot">
        {confirming ? (
          <div className="agent-confirm" role="group" aria-label={`${removeLabel} ${agent.name}?`}>
            <p>{agent.kind === "token" ? `Anything using ${agent.name} stops working right away.` : `${agent.name} stops working right away. You can connect it again later.`}</p>
            <div className="agent-actions">
              <button type="button" className="workspace-button workspace-button-danger workspace-button-sm" disabled={revoke.isPending} onClick={() => revoke.mutate(agent.id)}>
                {revoke.isPending ? `${removeLabel === "Revoke" ? "Revoking" : "Disconnecting"}…` : `${removeLabel} ${agent.name}`}
              </button>
              <button type="button" className="workspace-button workspace-button-ghost workspace-button-sm" disabled={revoke.isPending} onClick={() => setConfirming(false)}>Keep it</button>
            </div>
            {revoke.isError && <p role="alert" className="agent-error">{`Couldn’t ${removeLabel.toLowerCase()} ${agent.name}. Please try again.`}</p>}
          </div>
        ) : (
          <button type="button" className="workspace-button workspace-button-ghost workspace-button-sm agent-remove" disabled={busy} onClick={() => setConfirming(true)}>{removeLabel}</button>
        )}
      </footer>
    </article>
  );
}
