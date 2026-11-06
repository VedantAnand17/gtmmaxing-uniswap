import { BASE_CHAIN_ID, BASE_USDC, NATIVE_TOKEN, type TopupChain } from "@found/contracts";

const native = (symbol: string) => ({ symbol, address: NATIVE_TOKEN, decimals: 18 });
const usdc = (address: string, decimals = 6) => ({ symbol: "USDC", address, decimals });

/**
 * The tokens the page suggests. A payer can also paste any other token address:
 * on the swap rail only the USDC that reaches the treasury earns credits, so the
 * token itself needs no vetting. `jar: true` marks the jar rail's allowlist,
 * where a token IS priced before it is converted.
 */
export const TOPUP_CHAINS: TopupChain[] = [
  { id: BASE_CHAIN_ID, name: "Base", tokens: [
    { ...native("ETH"), jar: true },
    usdc(BASE_USDC),
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, jar: true },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, jar: true },
    { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18, jar: true },
  ] },
  { id: 42161, name: "Arbitrum", tokens: [
    native("ETH"), usdc("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
  ] },
  { id: 1, name: "Ethereum", tokens: [
    native("ETH"), usdc("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
  ] },
  { id: 10, name: "Optimism", tokens: [
    native("ETH"), usdc("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
    { symbol: "OP", address: "0x4200000000000000000000000000000000000042", decimals: 18 },
  ] },
  { id: 137, name: "Polygon", tokens: [
    native("POL"), usdc("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
  ] },
  { id: 56, name: "BNB Chain", tokens: [
    native("BNB"), usdc("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18),
    { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  ] },
  { id: 130, name: "Unichain", tokens: [native("ETH"), usdc("0x078D782b760474a361dDA0AF3839290b0EF57AD6")] },
  { id: 43114, name: "Avalanche", tokens: [native("AVAX"), usdc("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E")] },
];

export const isTopupChain = (chainId: number) => TOPUP_CHAINS.some((chain) => chain.id === chainId);

export const isJarToken = (token: string) =>
  TOPUP_CHAINS.find((chain) => chain.id === BASE_CHAIN_ID)!.tokens.some((entry) => entry.jar && entry.address.toLowerCase() === token.toLowerCase());
