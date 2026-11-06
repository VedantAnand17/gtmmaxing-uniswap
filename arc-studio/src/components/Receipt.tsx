import { CheckCircle2, ExternalLink } from 'lucide-react'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '@/onchain-facts'
import { CHAIN_ID, TREASURY, shortAddress } from '@/lib/checkout'

export interface ReceiptData {
  hash: `0x${string}`
  amount: string
  from: `0x${string}`
  blockNumber: bigint
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
        {label}
      </dt>
      <dd className="min-w-0 text-right text-sm font-medium" style={{ color: 'var(--ink)' }}>
        {children}
      </dd>
    </div>
  )
}

export function Receipt({ receipt, onReset }: { receipt: ReceiptData; onReset: () => void }) {
  const txUrl = buildTxExplorerUrl(CHAIN_ID, receipt.hash)

  return (
    <section
      className="overflow-hidden rounded-3xl"
      style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(18,45,69,0.08)' }}
      aria-live="polite"
    >
      <div className="p-5">
        <div className="flex items-center gap-2" style={{ color: 'var(--success)' }}>
          <CheckCircle2 className="size-5" aria-hidden />
          <span className="text-sm font-semibold">Payment confirmed (test)</span>
        </div>

        <div className="mt-4 flex items-baseline gap-1.5">
          <span className="display text-4xl font-bold tabular-nums">{receipt.amount}</span>
          <span className="text-lg font-medium" style={{ color: 'var(--subtle)' }}>test USDC</span>
        </div>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          No credits were added. This receipt only confirms a test transfer on Arc Testnet.
        </p>

        <dl className="mt-4 divide-y rounded-2xl px-4" style={{ background: 'var(--surface-muted)', borderColor: 'var(--border)' }}>
          <Row label="Amount">
            <span className="tabular-nums">{receipt.amount} USDC</span>
          </Row>
          <Row label="Sender">
            <a
              href={buildAddressExplorerUrl(CHAIN_ID, receipt.from)}
              target="_blank"
              rel="noopener noreferrer"
              className="mono text-xs underline-offset-2 hover:underline"
              title={receipt.from}
            >
              {shortAddress(receipt.from)}
            </a>
          </Row>
          <Row label="Treasury">
            <span className="mono text-xs" title={TREASURY}>{shortAddress(TREASURY)}</span>
          </Row>
          <Row label="Block">
            <span className="tabular-nums">{receipt.blockNumber.toString()}</span>
          </Row>
        </dl>

        <a
          href={txUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
          style={{ background: 'var(--accent)' }}
        >
          View transaction on Arc explorer <ExternalLink className="size-4" aria-hidden />
        </a>
        <button
          onClick={onReset}
          className="mt-2 min-h-11 w-full rounded-2xl text-sm font-semibold transition-colors hover:bg-black/5"
          style={{ color: 'var(--accent-hover)' }}
        >
          Make another test payment
        </button>
      </div>
    </section>
  )
}
