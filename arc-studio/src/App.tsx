import { ConnectKitButton } from 'connectkit'
import { TestBanner } from '@/components/TestBanner'
import { CheckoutCard } from '@/components/CheckoutCard'

export default function App() {
  return (
    <div className="min-h-dvh px-4 pb-24 pt-6">
      <div className="mx-auto max-w-md">
        <header className="mb-5 flex items-center justify-between gap-3">
          <div>
            <div className="display text-xl font-bold">GTMMAXING</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>Data credits checkout</div>
          </div>
          <ConnectKitButton showBalance={false} />
        </header>

        <div className="space-y-4">
          <TestBanner />
          <CheckoutCard />
        </div>

        <p className="mt-6 text-center text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
          Test mode on Arc Testnet. Network fees are paid in test USDC.
        </p>
      </div>
    </div>
  )
}
