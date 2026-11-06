import { arcTestnet } from 'viem/chains'
import { getUsdc } from '@/onchain-facts'

export const CHAIN_ID = arcTestnet.id

/** Treasury that receives checkout payments (provided by GTMMAXING). */
export const TREASURY = '0x8B8D9F145935D05AfE1453F4Dc495f35346613ba' as const

const usdc = getUsdc(CHAIN_ID)
if (!usdc) {
  throw new Error(`USDC is not registered for chain ${CHAIN_ID}`)
}
export const USDC_ADDRESS = usdc.address as `0x${string}`

export const QUICK_AMOUNTS = ['10', '50', '100'] as const

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function parseCheckoutError(error: unknown): { message: string; silent: boolean } {
  const e = error as { message?: string; code?: number; shortMessage?: string } | null
  const text = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`.toLowerCase()
  if (e?.code === 4001 || text.includes('user rejected') || text.includes('user denied')) {
    return { message: 'Payment cancelled.', silent: true }
  }
  if (text.includes('insufficient funds') || text.includes('exceeds balance')) {
    return { message: 'Insufficient test USDC. Get more with "Get test USDC" in the sidebar and try again.', silent: false }
  }
  if (text.includes('reverted')) {
    return { message: 'The transfer was rejected onchain. Please try again.', silent: false }
  }
  if (text.includes('network') || text.includes('timeout') || text.includes('fetch')) {
    return { message: 'Network issue. Check your connection and try again.', silent: false }
  }
  return { message: 'Something went wrong. Please try again.', silent: false }
}
