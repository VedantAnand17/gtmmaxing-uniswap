import { FlaskConical } from 'lucide-react'

export function TestBanner() {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-2xl p-4"
      style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', color: 'var(--warn-ink)' }}
    >
      <FlaskConical className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="text-sm leading-snug">
        <p className="display text-base font-bold">Test checkout. No real credits.</p>
        <p className="mt-1 text-pretty">
          This page runs on Arc Testnet and uses test USDC, which has no monetary value. Paying here does not add any
          GTMMAXING credits to an account.
        </p>
      </div>
    </div>
  )
}
