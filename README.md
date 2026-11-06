# GTMMAXING: Uniswap as the checkout for people and AI agents

[GTMMAXING](https://gtmmaxing.com) gives people and AI agents B2B data: contacts, lead lists and company research, paid for in credits.
Buying credits used to mean a card and a monthly plan, and an agent that ran out simply stopped.

Now Uniswap is the checkout on both sides of the pricing page:

- **People** buy any plan with almost any token, on the chain it's already on. We receive USDC on Base.
- **Agents** that run out are told where to buy, pay from their own wallet once the owner allows it, and repeat the call.
- **Small payments** go into a Uniswap Token Jar as one plain transfer, and an hourly keeper clears it for USDC when that's profitable.

Try it at [gtmmaxing.com/outboundmaxing](https://gtmmaxing.com/outboundmaxing/#plans), or read the prices as data at [gtmmaxing.com/pricing.json](https://gtmmaxing.com/pricing.json).

## What this repository is

This is a curated excerpt of a private production codebase, published for the ETHGlobal Mumbai Uniswap prize.
It isn't a full application and won't build by itself, because the server wiring, database schema and product code around it stay private.
The first commit holds the public files as they stood before the hackathon. Each later commit replays a real commit from our private repository, with its original message and timestamp, limited to these files.

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
| Agent refusal that says where to buy | [`api/src/application/agent-gateway/index.ts#L211`](api/src/application/agent-gateway/index.ts#L211) |
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

## License

[MIT](LICENSE)
