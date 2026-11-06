import { useEffect, useMemo, useState } from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'
import { ConnectKitButton } from 'connectkit'
import { TokenUSDC } from '@web3icons/react'
import { erc20Abi, parseEventLogs } from 'viem'
import {
  useAccount,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { Amount, usdcDecimalsFor } from '@/onchain-money'
import { CHAIN_ID, QUICK_AMOUNTS, TREASURY, USDC_ADDRESS, parseCheckoutError } from '@/lib/checkout'
import { Receipt, type ReceiptData } from '@/components/Receipt'

const DECIMALS = usdcDecimalsFor(CHAIN_ID)

export function CheckoutCard() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { writeContract, data: hash, isPending, error: writeError, reset } = useWriteContract()
  const {
    data: txReceipt,
    isLoading: isConfirming,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash, chainId: CHAIN_ID })

  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState<{ amount: Amount; from: `0x${string}` } | null>(null)

  const { data: balanceRaw, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(address) },
  })
  const balance = balanceRaw !== undefined ? Amount.fromRaw(balanceRaw, DECIMALS) : undefined

  const parsed = useMemo(() => {
    if (input === '' || input === '.') return { amount: undefined, error: undefined }
    try {
      const amount = Amount.parse(input, DECIMALS)
      return { amount, error: amount.isPositive() ? undefined : 'Enter an amount greater than 0.' }
    } catch {
      return { amount: undefined, error: 'Enter a valid amount with up to 6 decimals.' }
    }
  }, [input])

  const wrongChain = isConnected && chainId !== CHAIN_ID
  const insufficient = Boolean(parsed.amount && balance && parsed.amount.gt(balance))

  const receipt: ReceiptData | null = useMemo(() => {
    if (!txReceipt || txReceipt.status !== 'success' || !submitted) return null
    const transfer = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: txReceipt.logs }).find(
      (log) => log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && log.args.to.toLowerCase() === TREASURY.toLowerCase(),
    )
    const amount = transfer ? Amount.fromRaw(transfer.args.value, DECIMALS) : submitted.amount
    return {
      hash: txReceipt.transactionHash,
      amount: amount.toString(),
      from: transfer?.args.from ?? submitted.from,
      blockNumber: txReceipt.blockNumber,
    }
  }, [txReceipt, submitted])

  useEffect(() => {
    if (receipt) void refetchBalance()
  }, [receipt, refetchBalance])

  const reverted = txReceipt?.status === 'reverted'
  const failure = writeError ?? receiptError
  const parsedFailure = failure ? parseCheckoutError(failure) : undefined

  const handleReset = () => {
    reset()
    setSubmitted(null)
    setInput('')
  }

  const handlePay = () => {
    if (!address || !parsed.amount || parsed.error) return
    if (wrongChain) {
      switchChain({ chainId: CHAIN_ID })
      return
    }
    setSubmitted({ amount: parsed.amount, from: address })
    writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [TREASURY, parsed.amount.raw],
      chainId: CHAIN_ID,
    })
  }

  if (receipt) return <Receipt receipt={receipt} onReset={handleReset} />

  const busy = isPending || isConfirming
  const canPay = isConnected && Boolean(parsed.amount) && !parsed.error && !insufficient && !busy

  return (
    <section
      className="overflow-hidden rounded-3xl"
      style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(18,45,69,0.08)' }}
    >
      <div className="p-5">
        <label htmlFor="amount" className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
          Test credits purchase
        </label>

        <div className="mt-3 rounded-2xl p-4" style={{ background: 'var(--surface-muted)' }}>
          <div className="flex items-center gap-2">
            <input
              id="amount"
              inputMode="decimal"
              autoComplete="off"
              value={input}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value
                if (v === '' || /^\d*\.?\d{0,6}$/.test(v)) setInput(v)
              }}
              placeholder="0.00"
              className="display w-full min-w-0 bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-slate-300 disabled:opacity-50"
              style={{ color: 'var(--ink)' }}
            />
            <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>
              <TokenUSDC variant="branded" size={22} /> USDC
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex gap-1.5">
              {QUICK_AMOUNTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={busy}
                  onClick={() => setInput(q)}
                  className="min-h-8 rounded-full px-3 text-xs font-semibold tabular-nums transition-colors hover:bg-white disabled:opacity-40"
                  style={{ border: '1px solid var(--border)', color: 'var(--ink-2)' }}
                >
                  {q}
                </button>
              ))}
            </div>
            <span className="text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
              {isConnected ? (balance ? `Balance: ${balance.toFixed(2)} USDC` : 'Balance: ...') : 'Connect to see balance'}
            </span>
          </div>
        </div>

        {parsed.error && (
          <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{parsed.error}</p>
        )}
        {insufficient && (
          <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
            Not enough test USDC. Use "Get test USDC" in the sidebar to top up.
          </p>
        )}

        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt style={{ color: 'var(--muted)' }}>Network</dt>
            <dd className="font-medium">Arc Testnet</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt style={{ color: 'var(--muted)' }}>Pay to</dt>
            <dd className="mono text-xs font-medium" title={TREASURY}>GTMMAXING treasury</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt style={{ color: 'var(--muted)' }}>Credits added</dt>
            <dd className="font-medium">None (test only)</dd>
          </div>
        </dl>

        <div className="mt-5">
          {!isConnected ? (
            <ConnectKitButton.Custom>
              {({ show, isConnecting }) => (
                <button
                  onClick={show}
                  className="min-h-12 w-full rounded-2xl text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
                  style={{ background: 'var(--accent)' }}
                >
                  {isConnecting ? 'Connecting...' : 'Connect wallet'}
                </button>
              )}
            </ConnectKitButton.Custom>
          ) : (
            <button
              disabled={wrongChain ? isSwitching : !canPay}
              onClick={handlePay}
              className="min-h-12 w-full rounded-2xl text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
              style={{ background: 'var(--accent)' }}
            >
              {wrongChain ? (
                isSwitching ? 'Switching...' : 'Switch to Arc Testnet'
              ) : isPending ? (
                <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirm in wallet...</span>
              ) : isConfirming ? (
                <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirming...</span>
              ) : parsed.amount && !parsed.error ? (
                `Pay ${parsed.amount.toString()} test USDC`
              ) : (
                'Enter an amount'
              )}
            </button>
          )}
        </div>

        {parsedFailure && !parsedFailure.silent && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-xs" style={{ color: 'var(--danger)' }}>
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {parsedFailure.message}
          </p>
        )}
        {reverted && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-xs" style={{ color: 'var(--danger)' }}>
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> The transaction was reverted. No test USDC was moved.
          </p>
        )}
      </div>
    </section>
  )
}
