# GTMMAXING: OpenRouter for GTM tools, now with agentic commerce on Uniswap, ENS and Arc

[GTMMAXING](https://gtmmaxing.com) is OpenRouter for GTM tools.
One account and one credit balance give people and AI agents contact enrichment, lead lists, web research and social listening, from the browser, MCP, a CLI or an API.

GTMMAXING was live before ETHGlobal Mumbai, so this is a Continuity Track entry.
The gap we closed at the event: an agent that ran out of credits simply stopped until a person found a card, and nobody outside the product could see or stop what an agent was allowed to spend.

- **Uniswap is the checkout.** People buy any plan with almost any token, on the chain it's already on, and we receive USDC on Base. Agents that run out are told where to buy and pay from their own wallets. Small payments collect in a Token Jar.
- **ENSv2 is the off switch.** An agent's public name holds one record that decides whether it may start paid work, and a limited wallet can flip only that record.
- **Arc is the simplest payment.** On Arc Testnet, USDC is both the money and the gas, so one transfer is the whole checkout. It's a test path and never grants credits.

Try it: [pricing page](https://gtmmaxing.com/outboundmaxing/#plans), [Arc test checkout](https://gtmmaxing.com/arc/), [prices as data](https://gtmmaxing.com/pricing.json).

## What this repository is

This is the open-source part of a private production codebase: the Uniswap, ENS and Arc work, under the MIT license.
The rest of the product, including our data suppliers and the server wiring and database schema around this code, stays private, so this repository doesn't build into the full app.
The first commit holds the public files as they stood before the hackathon. Later commits replay our real commits from the private repository, limited to these files, and commits from the end of the event onward are new here.

## Try it yourself

Dry-run the Token Jar keeper against our live jar. It only reads, and needs a [Uniswap API key](https://developers.uniswap.org):

```bash
cd packages/tjar-keeper && npm install
JAR=0x4D7483e6D6FC402e8b128a92581d68a4947f71D0 UNISWAP_API_KEY=your_key node src/cli.ts
```

An agent can buy credits from its own wallet with [`agent-buys-credits.mjs`](web/public/developers/agent-buys-credits.mjs), once its owner switches that on. The steps are in the [developer guide](https://gtmmaxing.com/developers/buy-credits/).

## Where Uniswap is used

| What | Where |
| --- | --- |
| Quote, approval, swap and plan calls to the Uniswap API | [`api/src/payments/uniswap.ts#L85-L95`](api/src/payments/uniswap.ts#L85-L95) |
| Server state machine that decides each wallet action | [`api/src/application/topups/index.ts#L207`](api/src/application/topups/index.ts#L207) |
| Sizing a plan payment so the worst delivery covers its price | [`api/src/application/topups/index.ts#L150`](api/src/application/topups/index.ts#L150) |
| Plan credits, with any overpayment returned as credits | [`packages/contracts/src/topups.ts#L45`](packages/contracts/src/topups.ts#L45) |
| Settling a cross-chain plan | [`api/src/application/topups/index.ts#L331`](api/src/application/topups/index.ts#L331) |
| Crediting only USDC seen arriving on Base | [`api/src/application/topups/index.ts#L364`](api/src/application/topups/index.ts#L364) |
| Converting Uniswap permit data for wallets | [`api/src/application/topups/index.ts#L441`](api/src/application/topups/index.ts#L441) |
| Token Jar deposits, the per-round cap, and choosing the jar or a swap | [`api/src/application/topups/index.ts#L196`](api/src/application/topups/index.ts#L196), [`api/src/application/topups/index.ts#L342`](api/src/application/topups/index.ts#L342), [`api/src/application/topups/index.ts#L175`](api/src/application/topups/index.ts#L175) |
| Atomic credit grant | [`api/migrations/0028_crypto_topups.sql#L39`](api/migrations/0028_crypto_topups.sql#L39) |
| Open-source Token Jar keeper | [`packages/tjar-keeper/src/keeper.ts#L68`](packages/tjar-keeper/src/keeper.ts#L68), [`packages/tjar-keeper/src/decide.ts#L34`](packages/tjar-keeper/src/decide.ts#L34) |
| Agent refusal that says where to buy | [`api/src/application/agent-gateway/index.ts#L218`](api/src/application/agent-gateway/index.ts#L218) |
| Agents buying from their own wallet | [`api/src/routes/agent-gateway.ts#L156`](api/src/routes/agent-gateway.ts#L156), [`agent-buys-credits.mjs`](web/public/developers/agent-buys-credits.mjs) |
| Pay with crypto on the pricing page | [`web/src/features/outboundmaxing/PricingPlans.tsx#L94`](web/src/features/outboundmaxing/PricingPlans.tsx#L94) |
| Checkout page | [`web/src/features/topup/TopupPage.tsx`](web/src/features/topup/TopupPage.tsx) |
| Machine-readable prices | [`web/src/pages/pricing.json.ts`](web/src/pages/pricing.json.ts) |

Read [`docs/wallet-topups.md`](docs/wallet-topups.md) for the design and [`FEEDBACK.md`](FEEDBACK.md) for our feedback on the Uniswap developer tools.

## Three ways to pay

| Rail | When | How the money arrives |
| --- | --- | --- |
| `usdc` | USDC on Base | Plain transfer |
| `swap` | Other tokens on 8 chains, or a pasted token address | Uniswap API route (`CLASSIC`, `BRIDGE` or `CHAINED`) with our treasury as the fixed recipient |
| `jar` | Small payments in allowlisted Base tokens | Plain transfer into our [Token Jar](https://basescan.org/address/0x4D7483e6D6FC402e8b128a92581d68a4947f71D0), cleared later for USDC by anyone running the keeper |

## Proof on mainnet

**Cross-chain payment:** 0.001 ETH on Arbitrum became $2.21 USDC on Base and 147 credits.

- [Bridge step on Arbitrum](https://arbiscan.io/tx/0x370738057e8dcfa76baf3bfe21c357458000f89b81c8754b0239772e6547dc08)
- [Swap step on Base, paying the treasury](https://basescan.org/tx/0xf5458eb1b8a807d14f5a979465e1e8b11aeabaab12410d22d29b83277d3434fa)

**Token Jar round:** two small payments earned 128 credits, then the keeper cleared the jar, paying the treasury $2.00 USDC.

- [Jar deployment through the TJAR Factory](https://basescan.org/tx/0x8a0e3e4c75df3233f5b3510a057866b40e50e8948d2071133baccfc9f23754b2)
- [First payment, 0.00048 ETH](https://basescan.org/tx/0xd4269deeead167a0b9b034465d81f31d1935b577c89133a61356c01b8d808381)
- [Second payment, 0.00046 ETH](https://basescan.org/tx/0x5413d1d1890852c1356d4fd86cf82a3f8bbc30e7581292220de8965242a2899d)
- [Keeper clears the jar](https://basescan.org/tx/0x3365ea1cf3ceba59477698f2f8aa4a2c9d832638bf25e2661fd405c0ad2493c0)
- [Keeper swaps the ETH through the Uniswap API](https://basescan.org/tx/0x2044539736cf609e57a3ae0d74aa243091cbbdaf78eae4dc18d216ee01b8496e)

**An agent buying its own credits:** an agent paid 0.00048 ETH from its own wallet, using [the example script](web/public/developers/agent-buys-credits.mjs), and received 66 credits on its owner's account.

- [The agent's payment into the jar](https://basescan.org/tx/0x425234406858179c0a7aeea60df90fea8de53813af41975e857873f38c1091d7)

**A live payment on the site:** 0.0005 ETH from Arbitrum became $1.10 USDC on Base and 73 credits, through a bridge and then a swap.

- [Swap step on Base](https://basescan.org/tx/0x7744e6c38c8aafa73ad3cd64524235280c7973a5a295d835eb8e30273b8cb033)

## ENSv2: an agent's public name is its off switch

An owner links an agent to an ENS name, and one text record on that name decides whether the agent may start paid work. Removing the record stops the agent, and setting it again resumes it. On an ENSv2 Permissioned Resolver, Enhanced Access Control lets another account hold only the right to edit this key.

Live on production: `research.gtmmaxing.eth` [points at a production agent](https://etherscan.io/tx/0xa1376d237b54314dcdb2af005adaeb704fba7490db3ee524d15fb948b94812e6), written by a wallet limited to this one key. Stopping and resuming were tested on a local build against real mainnet ENS.

| What | Where |
| --- | --- |
| Reading the record through the ENS Universal Resolver | [`api/src/application/agent-ens.ts#L24`](api/src/application/agent-ens.ts#L24) |
| The guard that decides | [`api/src/application/agent-ens.ts#L61`](api/src/application/agent-ens.ts#L61) |
| The check before paid work | [`api/src/application/agent-gateway/index.ts#L203`](api/src/application/agent-gateway/index.ts#L203) |
| Linking a name | [`api/src/routes/agents.ts#L86`](api/src/routes/agents.ts#L86) |
| Design | [`docs/agent-ens-names.md`](docs/agent-ens-names.md) |

## Arc: USDC as money and gas

| What | Where |
| --- | --- |
| Design and architecture diagram | [`docs/arc-integration.md`](docs/arc-integration.md) |
| Rules, including never granting credits | [`api/src/application/arc-checkout.ts`](api/src/application/arc-checkout.ts) |
| Reading receipts on Arc | [`api/src/payments/arc.ts`](api/src/payments/arc.ts) |
| Checkout page | [`web/src/features/arc/ArcPage.tsx`](web/src/features/arc/ArcPage.tsx) |
| Arc Studio project | [Open in Arc Studio](https://studio.arc.io/share/gtmmaxing-usdc-credit-checkout-2kif6xoiet), [deployed app](https://arc-studio-ca8f39474dfb448abe4cbc25.vercel.app/) |
| Live test payment | [1 test USDC on the Arc explorer](https://explorer.testnet.arc.io/tx/0xab63a1f729ef7eb3e0f18e4b20722f29859928f80e74b22ef7cc66902386e88a) |

## License

[MIT](LICENSE)
