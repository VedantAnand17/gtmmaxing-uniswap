import { useEffect, useState } from "react";
import type { Turn, TurnNotice, TurnRow } from "../lib/types";
import { toCsv, toEmailsOnly, toJson } from "../lib/exports";
import {
  avatarStyle,
  displayName,
  foundCount,
  initialsOf,
  resolvedRows,
} from "../lib/urls";
import { CopyButton } from "./CopyButton";
import { AlertIcon, FileIcon, GoogleIcon, PersonIcon } from "./icons";

/** One submitted batch: user bubble + results card, in paste order. */
export function TurnView({
  turn,
  onSignIn,
  onVerifyEmail,
}: {
  turn: Turn;
  onSignIn: () => void;
  onVerifyEmail?: (email: string) => void;
}) {
  const total = turn.rows.length;
  const resolved = resolvedRows(turn.rows).length;
  const found = foundCount(turn.rows);
  const complete = resolved === total;
  // The workspace looks profiles up one at a time, in paste order, so the first pending row is the one being searched.
  const activeIndex = turn.rows.findIndex((row) => row.status === "pending");
  const hasPending = activeIndex !== -1;

  return (
    <section className="mt-6 row-in">
      <UserBubble turn={turn} />
      <div className="lookup-results mt-3 app-panel-radius bg-surface overflow-hidden">
        <div className="lookup-results-heading flex items-center justify-between px-4 py-3 border-b border-line">
          <span className="text-xs text-muted font-medium">Results</span>
          <span className="text-xs tabular-nums text-muted">
            {turn.notice
              ? `${total} ${total === 1 ? "profile" : "profiles"}`
              : complete
                ? `${found} / ${total} found`
                : `${resolved} / ${total}`}
          </span>
        </div>
        {hasPending && <LookupProgress resolved={resolved} total={total} />}
        <div className="divide-y divide-line">
          {turn.rows.map((row, i) => (
            <ResultRow key={row.key} row={row} index={i} active={i === activeIndex} {...(onVerifyEmail ? { onVerifyEmail } : {})} />
          ))}
        </div>
        {turn.notice ? (
          <NoticeStrip notice={turn.notice} onSignIn={onSignIn} />
        ) : (
          complete && <SummaryBar turn={turn} found={found} total={total} />
        )}
      </div>
    </section>
  );
}

function UserBubble({ turn }: { turn: Turn }) {
  const first = turn.rows[0];
  if (!first) return null;
  if (turn.rows.length === 1) {
    return (
      <div className="flex justify-end">
        <div className="bg-primary-soft text-ink rounded-2xl rounded-br-md px-4 py-2.5 max-w-[85%]">
          <div className="mono text-[13px] break-all">{first.urlDisplay}</div>
        </div>
      </div>
    );
  }
  const capped = turn.detectedCount > turn.rows.length;
  return (
    <div className="flex justify-end">
      <div className="bg-primary-soft text-ink rounded-2xl rounded-br-md px-4 py-2.5 max-w-[85%]">
        <div className="flex items-center gap-2 text-sm">
          <FileIcon size={15} className="text-muted" />
          <span>
            <strong>{turn.rows.length} profiles detected</strong>
            {capped && (
              <span className="text-muted"> (first {turn.rows.length})</span>
            )}
          </span>
        </div>
        <details className="mt-1">
          <summary className="text-xs text-muted cursor-pointer select-none">
            Show pasted list
          </summary>
          <pre className="mono text-xs text-muted mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap">
            {turn.inputText}
          </pre>
        </details>
      </div>
    </div>
  );
}

/** Elapsed seconds since this component mounted, ticking once a second. */
function useElapsedSeconds(): number {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Lookup stage copy, keyed off how long the current profile has gone unanswered.
 * The search tries sources one after another and then checks the mailbox; the
 * server does not stream which source it is on, so the copy stays honest about
 * the process without naming a supplier or a step it cannot see.
 */
export function lookupStage(secondsOnProfile: number): { label: string; hint: string } {
  if (secondsOnProfile < 8) return { label: "Checking email sources", hint: "Usually under 30 seconds per profile." };
  if (secondsOnProfile < 25) return { label: "Still searching more sources", hint: "Each source is tried in turn, then the mailbox is checked." };
  return { label: "Taking longer than usual", hint: "A source is slow to answer. We'll keep going - you're only charged if an email is found." };
}

/**
 * Live progress for a running batch: a status line that changes with the work,
 * a ticking timer, and a bar that is determinate for batches and sweeps for a
 * single profile. Stage text is the only announced content; the timer is not.
 */
function LookupProgress({ resolved, total }: { resolved: number; total: number }) {
  const elapsed = useElapsedSeconds();
  // Time on the current profile, so a batch's stage copy resets as each result lands.
  const [profileStart, setProfileStart] = useState({ resolved, at: 0 });
  if (profileStart.resolved !== resolved) setProfileStart({ resolved, at: elapsed });
  const stage = lookupStage(elapsed - profileStart.at);
  const batch = total > 1;
  const percent = batch ? Math.round((resolved / total) * 100) : null;

  return (
    <div data-result-loading className="lookup-progress border-b border-line" role="status" aria-label="Finding emails, in progress">
      <div className="lookup-progress-line">
        <span className="lookup-progress-label">
          <span className="lookup-progress-dot" aria-hidden="true" />
          <span aria-live="polite">{stage.label}</span>
        </span>
        <span className="lookup-progress-time" aria-hidden="true">{formatElapsed(elapsed)}</span>
      </div>
      <div
        className="lookup-progress-track"
        {...(percent === null
          ? { "data-indeterminate": "" }
          : { role: "progressbar", "aria-label": "Profiles looked up", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": resolved })}
      >
        <span className="lookup-progress-fill" style={percent === null ? undefined : { width: `${Math.max(percent, 4)}%` }} />
      </div>
      <p className="lookup-progress-hint">{stage.hint}</p>
    </div>
  );
}

function ResultRow({ row, index, active, onVerifyEmail }: { row: TurnRow; index: number; active: boolean; onVerifyEmail?: (email: string) => void }) {
  const name = row.name ?? displayName(row.url);
  return (
    <div data-result-row data-result-status={row.status} data-active={active || undefined} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3.5 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:items-center">
      <span
        aria-hidden="true"
        className={`flex items-center justify-center w-9 h-9 rounded-full text-xs font-semibold shrink-0 ${avatarStyle(index)}`}
      >
        {initialsOf(name)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold text-sm">{name}</span>
          {row.title && (
            <span className="text-xs text-muted truncate">
              {row.title}
            </span>
          )}
        </div>
        <div className="mono text-xs text-muted truncate mt-0.5">
          {row.urlDisplay}
        </div>
      </div>
      <div className="col-start-2 min-w-0 sm:col-start-3 sm:max-w-sm">
        <RowState row={row} active={active} />
        {row.email && onVerifyEmail && <button type="button" className="tool-verify-action" onClick={() => onVerifyEmail(row.email!)}>Verify address</button>}
      </div>
    </div>
  );
}

function RowState({ row, active }: { row: TurnRow; active: boolean }) {
  if (row.status === "pending") {
    return active ? (
      <span className="row-searching">
        <span className="row-skeleton" aria-hidden="true" />
        <span className="text-xs text-muted">Searching</span>
      </span>
    ) : (
      <span className="text-xs text-muted">Queued</span>
    );
  }
  if (row.email) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <code className="mono email-pill">
          {row.email}
        </code>
        <CopyButton text={row.email} label="Copy" ariaLabel="Copy email address" />
      </div>
    );
  }
  if (row.status === "unresolved") {
    return (
      <span className="text-xs text-muted">Not looked up</span>
    );
  }
  if (row.status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        <AlertIcon size={13} />
        Lookup failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <PersonIcon size={13} />
      Not found
    </span>
  );
}

/**
 * Why a batch never ran, in place of the summary bar. Calm by design -
 * neither state is an error to shout about. The credits case shows the 402
 * pre-flight math (needed vs have); the need is an upper bound because
 * repeats are free.
 */
function NoticeStrip({
  notice,
  onSignIn,
}: {
  notice: TurnNotice;
  onSignIn: () => void;
}) {
  if (notice.kind === "signin") {
    return (
      <div
        role="status"
        data-notice-signin
        className="result-footer"
      >
        <span className="text-sm text-muted">
          Sign in to run this lookup.
        </span>
        <button
          type="button"
          onClick={onSignIn}
          className="workspace-button workspace-button-sm"
        >
          <GoogleIcon size={14} />
          Sign in with Google
        </button>
      </div>
    );
  }
  return (
    <div
      role="status"
      data-notice-credits
      className="result-footer"
    >
      <span className="text-sm text-muted">
        You&apos;re out of credits - this run needs up to {notice.needed}{" "}
        fresh {notice.needed === 1 ? "credit" : "credits"}, you have{" "}
        {notice.remaining}. Repeats are free - nothing ran, nothing was
        debited.{" "}
        <a href={`/topup/?credits=${Math.max(1, notice.needed - notice.remaining)}`}>Add credits</a>
      </span>
    </div>
  );
}

function SummaryBar({
  turn,
  found,
  total,
}: {
  turn: Turn;
  found: number;
  total: number;
}) {
  const rows = turn.rows;
  const failed = rows.filter((row) => row.status === "error").length;
  return (
    <div className="result-footer">
      <span className="text-sm">
        {turn.streamError ? (
          <span className="text-muted">{turn.streamError}</span>
        ) : failed > 0 ? (
          <span data-batch-error className="text-muted">
            {found === 0 && failed === total
              ? "Lookup temporarily failed. Please try again. No credits were used."
              : `${found} of ${total} found. ${failed} ${failed === 1 ? "lookup" : "lookups"} failed. Please try again; failed lookups use no credits.`}
          </span>
        ) : found === 0 ? (
          <span data-batch-miss className="text-muted">
            {total === 1
              ? "This profile may not have a public email in our data sources."
              : "These profiles may not have public emails in our data sources."}
          </span>
        ) : (
          <>
            <strong>{found}</strong>&nbsp;of&nbsp;{total} found
          </>
        )}
      </span>
      <div className="flex flex-wrap gap-2">
        <CopyButton
          text={toCsv(rows)}
          label="Copy CSV"
          ariaLabel="Copy all results as CSV"
          iconSize={12}
        />
        <CopyButton
          text={toJson(rows)}
          label="Copy JSON"
          ariaLabel="Copy all results as JSON"
          iconSize={12}
        />
        <CopyButton
          text={toEmailsOnly(rows)}
          label="Emails only"
          ariaLabel="Copy found email addresses only"
          iconSize={12}
        />
      </div>
    </div>
  );
}
