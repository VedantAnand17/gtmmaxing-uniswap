import { topupAuthorization, type TopupAction, type TopupWalletTx } from "@found/contracts";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export class WalletError extends Error {
  constructor(readonly code: "no_wallet" | "rejected" | "wrong_chain" | "reverted" | "failed") {
    super(code);
  }
}

const provider = (): Eip1193 => {
  const injected = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!injected) throw new WalletError("no_wallet");
  return injected;
};

async function ask<T>(method: string, params?: unknown[]): Promise<T> {
  try {
    return await provider().request(params ? { method, params } : { method }) as T;
  } catch (error) {
    if (error instanceof WalletError) throw error;
    if ((error as { code?: number }).code === 4001) throw new WalletError("rejected");
    throw new WalletError("failed");
  }
}

const hexChain = (chainId: number) => `0x${chainId.toString(16)}`;
const hexValue = (value: string) => `0x${BigInt(value).toString(16)}`;
const utf8Hex = (text: string) => `0x${[...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

export async function connectWallet(): Promise<string> {
  const accounts = await ask<string[]>("eth_requestAccounts");
  if (!accounts[0]) throw new WalletError("failed");
  return accounts[0];
}

export async function useChain(chainId: number): Promise<void> {
  try {
    await provider().request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChain(chainId) }] });
  } catch (error) {
    if (error instanceof WalletError) throw error;
    throw new WalletError((error as { code?: number }).code === 4001 ? "rejected" : "wrong_chain");
  }
}

/** The signature that lets a transfer from this wallet credit this account. */
export async function authorizeWallet(account: string, wallet: string): Promise<{ signature: string; issued_at: number }> {
  const issued_at = Date.now();
  const signature = await ask<string>("personal_sign", [utf8Hex(topupAuthorization({ account, wallet, issuedAt: issued_at })), wallet]);
  return { signature, issued_at };
}

/** A pasted token's decimals and symbol, read through the wallet's own connection. */
export async function readToken(chainId: number, address: string): Promise<{ decimals: number; symbol: string }> {
  await useChain(chainId);
  const call = (data: string) => ask<string>("eth_call", [{ to: address, data }, "latest"]);
  const decimals = Number(BigInt(await call("0x313ce567")));
  if (!Number.isInteger(decimals) || decimals > 36) throw new WalletError("failed");
  const raw = await call("0x95d89b41").catch(() => "0x");
  return { decimals, symbol: decodeSymbol(raw) };
}

function decodeSymbol(raw: string): string {
  const hex = raw.slice(2);
  if (hex.length < 192) return "Token";
  const length = parseInt(hex.slice(64, 128), 16);
  const bytes = hex.slice(128, 128 + length * 2).match(/../g) ?? [];
  return new TextDecoder().decode(Uint8Array.from(bytes.map((byte) => parseInt(byte, 16)))) || "Token";
}

export function parseAmount(text: string, decimals: number): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const raw = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  return raw > 0n ? raw.toString() : null;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendAndWait(wallet: string, tx: TopupWalletTx): Promise<string> {
  await useChain(tx.chain_id);
  const hash = await ask<string>("eth_sendTransaction", [{ from: wallet, to: tx.to, data: tx.data, value: hexValue(tx.value) }]);
  for (;;) {
    const receipt = await ask<{ status?: string } | null>("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (receipt) {
      if (receipt.status === "0x0") throw new WalletError("reverted");
      return hash;
    }
    await pause(2000);
  }
}

/** Does the one wallet step the server asked for and returns its proof. */
export async function performAction(wallet: string, action: Extract<TopupAction, { kind: "send_tx" | "sign_typed_data" }>): Promise<{ tx_hash?: string; signature?: string }> {
  if (action.kind === "send_tx") return { tx_hash: await sendAndWait(wallet, action.tx) };
  await useChain(action.chain_id);
  return { signature: await ask<string>("eth_signTypedData_v4", [wallet, JSON.stringify(action.typed_data)]) };
}
