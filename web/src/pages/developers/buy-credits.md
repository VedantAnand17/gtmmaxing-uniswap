---
layout: ../../layouts/DeveloperDoc.astro
path: /developers/buy-credits
heading: "Let your agent buy its own credits"
eyebrow: "Developers"
---

An agent with a wallet doesn't have to stop when it runs out of credits.
It pays through Uniswap with whatever token it holds, on the network it's already on, and repeats its call.
We receive USDC on Base.

## Before it can buy

Switch on **Buy credits from its own wallet** for this agent on [Usage](/usage/).
It's off by default, each payment is limited to $50, and the agent's credit limit still applies to what it spends.

## How it works

1. A paid call refuses with `reason: "insufficient_credits"` and a `top_up` field holding the URL and the credits needed.
2. `GET /v1/agent/topups/options` lists networks and tokens, and the `account` your wallet signs for.
3. `POST /v1/agent/topups` with the signed message, token and amount returns a payment whose `action` says what the wallet does next.
4. Do that action, then `POST /v1/agent/topups/{id}/next` with the `tx_hash` or `signature`.
   Repeat until `status` is `credited`.
5. Repeat the original call with the same `idempotency_key`.

Send `rail: "auto"` to let us choose: a payment that fits goes to our Uniswap Token Jar as one plain transfer, for 5% less credit, and anything larger is swapped.
Payments are at least $1.

## Full example

[`agent-buys-credits.mjs`](/developers/agent-buys-credits.mjs) does all of this with [viem](https://viem.sh).
Run it with `GTM_TOKEN`, `WALLET_KEY` and how much to spend:

```bash
npm install viem
GTM_TOKEN=fnd_.. WALLET_KEY=0x.. node agent-buys-credits.mjs --chain 8453 --token 0x0000000000000000000000000000000000000000 --amount 500000000000000
```

Full field details are in the [OpenAPI spec](/openapi.json), and prices are in [`/pricing.json`](/pricing.json).
