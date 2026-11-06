import { BASE_CHAIN_ID, BASE_USDC, NATIVE_TOKEN, creditsForMicros, type TopupOptions, type TopupView } from "@found/contracts";
import type { TopupsClient } from "../features/topup/topupClient";

const OPTIONS: TopupOptions = {
  enabled: true, micros_per_credit: 15_000, min_micros: 1_000_000, max_micros: 500_000_000,
  chains: [
    { id: BASE_CHAIN_ID, name: "Base", tokens: [{ symbol: "ETH", address: NATIVE_TOKEN, decimals: 18, jar: true }, { symbol: "USDC", address: BASE_USDC, decimals: 6 }] },
    { id: 42161, name: "Arbitrum", tokens: [{ symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 }] },
  ],
  jar: { chain_id: BASE_CHAIN_ID, address: "0x00000000000000000000000000000000000000bb", max_micros: 2_000_000, available_micros: 2_000_000, haircut_bps: 500 },
};

const view = (over: Partial<TopupView>): TopupView => ({
  id: "tp_mock", rail: "swap", routing: "CHAINED", status: "open", estimated_credits: creditsForMicros(5_000_000), minimum_credits: creditsForMicros(4_900_000),
  credits: null, settlement_tx: null, error: null, action: { kind: "none" }, ...over,
});

/** Simulates a quote, one wallet step and a delivery; the wallet itself is the browser's. */
export const mockTopups: TopupsClient = {
  options: async () => OPTIONS,
  create: async () => view({ action: { kind: "send_tx", label: "Confirm the payment", tx: { chain_id: BASE_CHAIN_ID, to: BASE_USDC, data: "0x", value: "0" } } }),
  next: async () => view({ status: "credited", credits: 333, settlement_tx: `0x${"ab".repeat(32)}` }),
};
