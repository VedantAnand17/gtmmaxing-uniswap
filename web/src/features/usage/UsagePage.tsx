import type { Session } from "../../lib/session";
import { ConnectedAgents } from "../agents/ConnectedAgents";
import { useUsageQuery } from "./usageQueries";

export function UsagePage({ session }: { session: Session }) {
  const usage = useUsageQuery(session.user.email, Boolean(session));

  return (
    <section className="workspace-activity-page">
      <div className="mb-8">
        <h1 className="workspace-activity-title">Usage</h1>
        <p className="workspace-activity-description">
          A clear view of your free credits and lookup activity.{" "}
          <a href="/topup/">Add credits</a>
        </p>
      </div>

      {usage.isLoading && <p role="status">Loading your usage…</p>}
      {usage.isError && (
        <div role="alert" className="workspace-card p-5">
          <p className="font-semibold">Usage is unavailable right now.</p>
          <button type="button" className="workspace-button workspace-button-secondary workspace-button-sm mt-4" onClick={() => usage.refetch()}>
            Try again
          </button>
        </div>
      )}
      {usage.data && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="workspace-card p-6 sm:col-span-2">
            <p className="metric-label">Credits remaining</p>
            <p className="metric-value metric-value-lg">{usage.data.credits.remaining}</p>
            <p className="sr-only">{`${usage.data.credits.remaining} ${usage.data.credits.remaining === 1 ? "credit" : "credits"} remaining`}</p>
            <div className="metric-meter" aria-hidden="true">
              <div
                style={{ width: `${usage.data.credits.granted > 0 ? Math.min(100, (usage.data.credits.remaining / usage.data.credits.granted) * 100) : 0}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted">{`${usage.data.credits.granted} credits granted at sign-up`}</p>
          </div>
          {usage.data.tools && <><Metric label="Tool runs" value={usage.data.tools.total} /><Metric label="Tool credits used" value={usage.data.tools.creditsUsed} /><Metric label="Completed tool runs" value={usage.data.tools.completed} /><Metric label="Pending tool runs" value={usage.data.tools.pending} /></>}
          <Metric label="Profiles looked up" value={usage.data.lookups.total} />
          <Metric label="Found" value={usage.data.lookups.found} />
          <Metric label="Not found" value={usage.data.lookups.notFound} />
          <Metric label="Errors" value={usage.data.lookups.errors} />
        </div>
      )}
      <ConnectedAgents session={session} />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="workspace-card p-5">
      <p className="metric-label">{formatMetric(label, value)}</p>
      <p className="metric-value" aria-hidden="true">{value}</p>
    </div>
  );
}

function formatMetric(label: string, value: number): string {
  if (label === "Profiles looked up") return `${value} ${value === 1 ? "profile" : "profiles"} looked up`;
  if (label === "Errors") return `${value} ${value === 1 ? "error" : "errors"}`;
  return `${value} ${label.toLowerCase()}`;
}
