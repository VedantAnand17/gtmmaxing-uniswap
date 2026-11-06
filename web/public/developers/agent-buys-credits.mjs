#!/usr/bin/env node
// An agent buying GTMMAXING credits from its own wallet, through Uniswap.
// Usage: GTM_TOKEN=.. WALLET_KEY=0x.. node agent-buys-credits.mjs --chain 8453 --token 0x.. --amount <smallest units> [--rail auto]
// Needs `npm install viem`. The owner must first switch this on for the agent on the Usage page.
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";

const API = process.env.GTM_API ?? "https://api.gtmmaxing.com";
const { values } = parseArgs({ options: { chain: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, rail: { type: "string", default: "auto" } } });
const account = privateKeyToAccount(process.env.WALLET_KEY);
const headers = { authorization: `Bearer ${process.env.GTM_TOKEN}`, "content-type": "application/json" };

async function call(path, body) {
  const response = await fetch(`${API}${path}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const parsed = await response.json();
  if (!response.ok) throw new Error(parsed.error ?? `HTTP ${response.status}`);
  return parsed;
}

const options = await call("/v1/agent/topups/options");
if (!options.allowed) throw new Error("The account owner has not switched on buying credits for this agent.");

const issuedAt = Date.now();
const wallet = account.address.toLowerCase();
const signature = await account.signMessage({ message: `GTMMAXING credit top-up\nAccount: ${options.account.toLowerCase()}\nWallet: ${wallet}\nIssued: ${issuedAt}` });
let { topup } = await call("/v1/agent/topups", { wallet, signature, issued_at: issuedAt, chain_id: Number(values.chain), token: values.token, amount: values.amount, rail: values.rail });
console.log(`${topup.rail}: about ${topup.estimated_credits} credits, at least ${topup.minimum_credits}`);

const clientFor = (id) => {
  const chain = Object.values(chains).find((candidate) => candidate.id === id);
  return { chain, reader: createPublicClient({ chain, transport: http() }), writer: createWalletClient({ account, chain, transport: http() }) };
};

while (topup.status === "open") {
  const { action } = topup;
  console.log(action.label ?? action.kind);
  if (action.kind === "send_tx") {
    const { reader, writer } = clientFor(action.tx.chain_id);
    const hash = await writer.sendTransaction({ to: action.tx.to, data: action.tx.data, value: BigInt(action.tx.value) });
    await reader.waitForTransactionReceipt({ hash });
    ({ topup } = await call(`/v1/agent/topups/${topup.id}/next`, { tx_hash: hash }));
  } else if (action.kind === "sign_typed_data") {
    const { EIP712Domain: _domain, ...types } = action.typed_data.types;
    const signed = await account.signTypedData({ ...action.typed_data, types });
    ({ topup } = await call(`/v1/agent/topups/${topup.id}/next`, { signature: signed }));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    ({ topup } = await call(`/v1/agent/topups/${topup.id}/next`, {}));
  }
}
console.log(topup.status === "credited" ? `Added ${topup.credits} credits. Repeat your call.` : `Stopped: ${topup.status} ${topup.error ?? ""}`);
